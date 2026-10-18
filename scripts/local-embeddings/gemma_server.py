#!/usr/bin/env python3
"""Offline Gemma 2 text/media encoder; media paths stay inside an explicit inbox."""
from __future__ import annotations

import argparse
from collections import OrderedDict
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import signal
import socket
from socketserver import TCPServer
import subprocess
import sys
import threading
import time

ALIAS = 'embeddinggemma2'
DIMENSIONS = 768


def runtime_config(torch, device, cuda_limit_mb=4096, mps_limit_mb=4096):
    """Select a real available backend; explicitly requested GPUs never fall back."""
    if device not in ('auto', 'cpu', 'cuda', 'mps'):
        raise ValueError('Unknown inference device')
    cuda_available = torch.cuda.is_available()
    mps_backend = getattr(torch.backends, 'mps', None)
    mps_available = mps_backend is not None and mps_backend.is_available()
    if device == 'auto':
        device = 'cuda' if cuda_available else 'mps' if mps_available else 'cpu'
    if device == 'cuda' and not cuda_available:
        raise ValueError('CUDA was requested but is not available')
    if device == 'mps' and not mps_available:
        raise ValueError('MPS was requested but is not available')
    precision = 'bf16' if device == 'cuda' and torch.cuda.is_bf16_supported() else 'fp32'
    if device == 'cuda':
        total = torch.cuda.get_device_properties(0).total_memory
        torch.cuda.set_per_process_memory_fraction(min(1, cuda_limit_mb*1024**2/total), 0)
    elif device == 'mps':
        recommended = torch.mps.recommended_max_memory()
        if recommended <= 0:
            raise ValueError('MPS did not report a valid recommended memory limit')
        torch.mps.set_per_process_memory_fraction(min(1, mps_limit_mb*1024**2/recommended))
    return device, precision, torch.bfloat16 if precision == 'bf16' else torch.float32


def modality_config(mode):
    if mode == 'all':
        return ['text', 'image', 'video', 'audio'], {}
    if mode == 'vision':
        return ['text', 'image', 'video'], {'audio_config': None}
    if mode == 'audio':
        return ['text', 'audio'], {'vision_config': None}
    if mode == 'text':
        return ['text'], {'vision_config': None, 'audio_config': None}
    raise ValueError('Unknown encoder modalities')


def offline_guard():
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
                      HF_HUB_DISABLE_TELEMETRY='1', DO_NOT_TRACK='1')
    def denied(*_args, **_kwargs):
        raise OSError('Offline Gemma runtime forbids outbound connections')
    socket.socket.connect = denied
    socket.socket.connect_ex = denied
    socket.create_connection = denied
    socket.getaddrinfo = denied


def validate_vectors(rows, count):
    if not isinstance(rows, list) or len(rows) != count:
        raise ValueError('Embedding count mismatch')
    for row in rows:
        if not isinstance(row, list) or len(row) != DIMENSIONS:
            raise ValueError('Embedding dimension mismatch')
        if any(isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) for x in row):
            raise ValueError('Invalid embedding values')
        if abs(sum(x*x for x in row)-1) > 0.01:
            raise ValueError('Embedding is not normalized')
    return rows


def media_item(item, root, modalities=None):
    root = root.resolve()
    if not isinstance(item, dict) or not item or set(item)-{'text', 'image', 'audio', 'video'}:
        raise ValueError('Each item accepts text, image, audio and video only')
    disabled = set(item) - set(modalities if modalities is not None else ('text', 'image', 'audio', 'video'))
    if disabled:
        raise ValueError(f'{", ".join(sorted(disabled))} encoder is disabled')
    result = {}
    for key, value in item.items():
        if not isinstance(value, str) or not value.strip():
            raise ValueError('Item fields must be nonempty strings')
        if key == 'text':
            if len(value) > 8192: raise ValueError('Text exceeds 8192 characters')
            result[key] = value
            continue
        path = (root / value).resolve()
        if root not in path.parents or not path.is_file():
            raise ValueError('Media must be a file inside the configured inbox')
        if path.stat().st_size > 32*1024*1024:
            raise ValueError('Media exceeds 32 MiB; split into short clips first')
        if key in ('audio','video'):
            # Keep FFmpeg probing out of this process. Importing PyAV's bundled
            # FFmpeg alongside TorchCodec's system FFmpeg duplicates ObjC classes
            # on macOS and can destabilize decoding.
            try:
                probe = subprocess.run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe',
                                        '-format_whitelist', 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,wav,mp3,flac,ogg,aac',
                                        '-show_entries', 'format=duration',
                                        '-of', 'json', str(path)], capture_output=True, text=True,
                                       timeout=10, check=True)
                duration = float(json.loads(probe.stdout)['format']['duration'])
            except (OSError, subprocess.SubprocessError, ValueError, TypeError, KeyError) as error:
                raise ValueError('Cannot determine local media duration with ffprobe') from error
            if not math.isfinite(duration) or not 0 < duration <= (60 if key=='audio' else 8):
                raise ValueError('Use audio clips up to 60 seconds or video clips up to 8 seconds')
        result[key] = str(path)
    if 'text' in result:
        for key in ('image','audio','video'):
            if key in result and f'<|{key}|>' not in result['text']:
                result['text'] += f' <|{key}|>'
    return result


class GemmaEncoder:
    def __init__(self, manifest, root, device, max_length, cuda_limit_mb,
                 modalities='all', mps_limit_mb=4096, precision=None):
        if precision not in (None, 'fp32'):
            raise ValueError('Explicit encoder precision must be fp32')
        if Path('/proc/meminfo').is_file():
            available = next(int(line.split()[1])*1024 for line in Path('/proc/meminfo').read_text().splitlines()
                             if line.startswith('MemAvailable:'))
            if available < 6*1024**3:
                raise MemoryError('Need at least 6 GiB currently available before loading Gemma')
        entry = json.loads(manifest.read_text())['models'][ALIAS]
        path = Path(entry['path']).resolve()
        if not path.is_dir() or not (path/'config.json').is_file():
            raise ValueError('Prepared local model snapshot is missing')
        self.version = f"{ALIAS}@{entry['revision']}"
        self.revision = entry['revision']
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.cache = OrderedDict()
        self.ready = False
        import torch
        from sentence_transformers import SentenceTransformer
        torch.set_num_threads(2)
        self.torch = torch
        self.device, self.precision, dtype = runtime_config(torch, device, cuda_limit_mb, mps_limit_mb)
        # The shared on-demand scheduler advertises a stable profile before
        # importing Torch. Its worker requests FP32 on every backend, while the
        # standalone HTTP server retains automatic CUDA BF16 / MPS FP32.
        if precision == 'fp32':
            self.precision, dtype = 'fp32', torch.float32
        self.modalities, config_kwargs = modality_config(modalities)
        self.mps_limit_mb = mps_limit_mb if self.device == 'mps' else None
        self.encoding = f'dreammate.gemma2.v1:{self.precision}:max{max_length}:dim768'
        self.model = SentenceTransformer(str(path), device=self.device, local_files_only=True,
            trust_remote_code=False, config_kwargs=config_kwargs,
            model_kwargs={'torch_dtype': dtype, 'attn_implementation': 'sdpa'})
        self.model.max_seq_length = max_length
        self.loaded_parameters = sum(parameter.numel() for parameter in self.model.parameters())
        self.loaded_dtype = str(next(self.model.parameters()).dtype)
        self.model_device = str(next(self.model.parameters()).device)
        if next(self.model.parameters()).device.type != self.device:
            raise RuntimeError('Loaded model device does not match requested inference device')
        self.encode_texts(['Find a relevant tool'], 'query')
        self.ready = True

    def provider(self):
        return {'protocol':'dreammate.embedding.v1','model':ALIAS,'revision':self.revision,
                'dimensions':DIMENSIONS,'encoding':self.encoding,'ready':self.ready}

    def payload(self, rows):
        return {'model':self.version,'alias':ALIAS,'revision':self.revision,
                'dimensions':DIMENSIONS,'encoding':self.encoding,'embeddings':rows}

    def memory_snapshot(self):
        return {
            'cuda_allocated_bytes': self.torch.cuda.memory_allocated() if self.device == 'cuda' else 0,
            'cuda_peak_allocated_bytes': self.torch.cuda.max_memory_allocated() if self.device == 'cuda' else 0,
            'mps_allocated_bytes': self.torch.mps.current_allocated_memory() if self.device == 'mps' else 0,
            'mps_driver_allocated_bytes': self.torch.mps.driver_allocated_memory() if self.device == 'mps' else 0,
            'mps_recommended_max_bytes': self.torch.mps.recommended_max_memory() if self.device == 'mps' else 0,
            'mps_limit_mb': self.mps_limit_mb,
            'mps_fallback_enabled': self.device == 'mps' and os.environ.get('PYTORCH_ENABLE_MPS_FALLBACK') == '1',
        }

    def encode_texts(self, texts, role):
        if role not in ('query','document') or not isinstance(texts, list) or not 1 <= len(texts) <= 64:
            raise ValueError('Expected query/document and 1..64 texts')
        if any(not isinstance(s,str) or not s.strip() or len(s)>8192 for s in texts):
            raise ValueError('Expected nonempty texts of at most 8192 characters')
        with self.lock:
            keys = [hashlib.sha256(s.encode()).hexdigest() for s in texts]
            missing = list(dict.fromkeys(k for k in keys if role == 'query' or k not in self.cache))
            if missing:
                lookup = dict(zip(keys,texts))
                values = self.model.encode([lookup[k] for k in missing], prompt_name='SearchQuery' if role=='query' else 'Document',
                    batch_size=1, normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False).tolist()
                validate_vectors(values,len(missing))
                fresh = dict(zip(missing,values))
                if role == 'document':
                    self.cache.update(fresh)
                    while len(self.cache)>4096: self.cache.popitem(last=False)
            else: fresh = {}
            return [fresh[k] if k in fresh else self.cache[k] for k in keys]

    def encode_media(self, items):
        if not isinstance(items,list) or not 1 <= len(items) <= 4:
            raise ValueError('Expected 1..4 media items')
        converted = [media_item(item,self.root,self.modalities) for item in items]
        rows = []
        with self.lock:
            for item in converted:
                result = self.model.encode(item, batch_size=1, normalize_embeddings=True,
                    convert_to_numpy=True, show_progress_bar=False).tolist()
                rows.append(result if result and isinstance(result[0],(float,int)) else result[0])
        return validate_vectors(rows,len(items))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest',type=Path,required=True)
    parser.add_argument('--media-root',type=Path,required=True)
    parser.add_argument('--port',type=int,default=8767)
    parser.add_argument('--device',choices=['auto','cpu','cuda','mps'],default='auto')
    parser.add_argument('--modalities',choices=['all','text','vision','audio'],default='all')
    parser.add_argument('--max-length',type=int,default=2048)
    parser.add_argument('--cuda-limit-mb',type=int,default=4096)
    parser.add_argument('--mps-limit-mb',type=int,default=4096)
    args=parser.parse_args()
    if not 1024<=args.max_length<=8192 or not 1024<=args.cuda_limit_mb<=16384 or not 1024<=args.mps_limit_mb<=16384 or not 1<=args.port<=65535:
        parser.error('Invalid input or memory limits')
    offline_guard()
    encoder=GemmaEncoder(args.manifest,args.media_root,args.device,args.max_length,args.cuda_limit_mb,
                         args.modalities,args.mps_limit_mb)

    class Handler(BaseHTTPRequestHandler):
        def reply(self,status,payload):
            data=json.dumps(payload,ensure_ascii=False,allow_nan=False).encode()
            self.send_response(status);self.send_header('Content-Type','application/json')
            self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)

        def do_GET(self):
            if self.path!='/health': return self.reply(404,{'error':'Not found'})
            self.reply(200,{'status':'ok','pid':os.getpid(),'models':[ALIAS],'loaded_model':ALIAS,
                'device':encoder.device,'precision':encoder.precision,'batch_size':1,
                'loaded_parameters':encoder.loaded_parameters,'loaded_dtype':encoder.loaded_dtype,
                'model_device':encoder.model_device, **encoder.memory_snapshot(),
                'modalities':encoder.modalities,'embedding_provider':encoder.provider(),
                'document_cache_entries':len(encoder.cache),'outbound_network':'blocked'})

        def do_POST(self):
            started=time.perf_counter()
            try:
                size=int(self.headers.get('Content-Length','0'))
                if not 1<=size<=262144: return self.reply(413,{'error':'Invalid request size'})
                self.connection.settimeout(10)
                data=json.loads(self.rfile.read(size))
                if not isinstance(data,dict): raise ValueError('Expected JSON object')
                if self.path=='/embed':
                    if set(data)-{'model','texts','input_type'} or data.get('model',ALIAS)!=ALIAS:
                        raise ValueError('Invalid text embedding request')
                    result=encoder.payload(encoder.encode_texts(data.get('texts'),data.get('input_type')))
                elif self.path=='/invoke':
                    params=data.get('params',{})
                    if not isinstance(params,dict): raise ValueError('Expected params object')
                    method=data.get('method')
                    if method=='embedding.encode_text':
                        result=encoder.payload(encoder.encode_texts(params.get('texts'),params.get('input_type','document')))
                    elif method=='embedding.encode_media':
                        result=encoder.payload(encoder.encode_media(params.get('items')))
                    elif method=='embedding.compare':
                        query=encoder.encode_texts([params.get('query')],'query')[0]
                        rows=encoder.encode_media(params.get('items'))
                        result={'model':encoder.version,'encoding':encoder.encoding,
                            'scores':[sum(a*b for a,b in zip(query,row)) for row in rows]}
                    else: return self.reply(404,{'error':'Unknown method'})
                else: return self.reply(404,{'error':'Not found'})
                result['elapsed_ms']=round((time.perf_counter()-started)*1000,1)
                self.reply(200,result)
            except (ValueError,TypeError,KeyError) as error:
                self.reply(400,{'error':str(error)[:200]})
            except (BrokenPipeError,ConnectionResetError): pass
            except Exception as error:
                print(f'Gemma inference failed: {type(error).__name__}: {error}',file=sys.stderr,flush=True)
                if isinstance(error,encoder.torch.OutOfMemoryError) or 'out of memory' in str(error).lower():
                    if encoder.device == 'cuda': encoder.torch.cuda.empty_cache()
                    elif encoder.device == 'mps': encoder.torch.mps.empty_cache()
                self.reply(503,{'error':'Local Gemma encoding failed'})

        def log_message(self,*_args): pass

    class LocalServer(ThreadingHTTPServer):
        daemon_threads=True
        def server_bind(self):
            TCPServer.server_bind(self)
            self.server_name='127.0.0.1';self.server_port=self.server_address[1]
    def stop(_signum, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    with LocalServer(('127.0.0.1',args.port),Handler) as server:
        print(json.dumps({'ready':True,'device':encoder.device,'precision':encoder.precision}),flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__=='__main__': main()

#!/usr/bin/env python3
"""Private offline JSON-lines Gemma worker for the exclusive model scheduler."""
from __future__ import annotations

import argparse
from contextlib import redirect_stdout
import importlib.util
import json
import math
import os
from pathlib import Path
import signal
import sys
import time

ALIAS = 'embeddinggemma2'
DIMENSIONS = 768
MAX_LINE_BYTES = 263168
PUBLIC_ERRORS = frozenset({
    'Expected a worker request object', 'Invalid worker request ID',
    'Invalid Gemma text embedding request', 'Unknown Gemma worker operation',
    'Invalid Gemma media request', 'Invalid comparison scores',
    'Expected query/document and 1..64 texts',
    'Expected nonempty texts of at most 8192 characters', 'Expected 1..4 media items',
    'Each item accepts text, image, audio and video only', 'Item fields must be nonempty strings',
    'Text exceeds 8192 characters', 'Media must be a file inside the configured inbox',
    'Media exceeds 32 MiB; split into short clips first',
    'Cannot determine local media duration with ffprobe',
    'Use audio clips up to 60 seconds or video clips up to 8 seconds',
    'Embedding count mismatch', 'Embedding dimension mismatch',
    'Invalid embedding values', 'Embedding is not normalized',
})


def provider_metadata(manifest, max_length=2048):
    """Read the fixed FP32 profile without importing Torch or allocating a model."""
    entry = json.loads(Path(manifest).read_text())['models'][ALIAS]
    revision = entry.get('revision')
    if not isinstance(revision, str) or not revision.strip():
        raise ValueError('Prepared Gemma revision is missing')
    return {'protocol': 'dreammate.embedding.v1', 'model': ALIAS,
            'revision': revision, 'dimensions': DIMENSIONS,
            'encoding': f'dreammate.gemma2.v1:fp32:max{max_length}:dim768',
            'ready': True}


def send(stream, payload):
    stream.write(json.dumps(payload, ensure_ascii=False, allow_nan=False) + '\n')
    stream.flush()


def handle_request(request, encoder, validate_vectors):
    if not isinstance(request, dict):
        raise ValueError('Expected a worker request object')
    request_id = request.get('id')
    if not isinstance(request_id, str) or not 1 <= len(request_id) <= 100:
        raise ValueError('Invalid worker request ID')
    operation = request.get('operation', 'embed')
    if operation == 'embed':
        if set(request) != {'id', 'model', 'texts', 'input_type'} or request['model'] != ALIAS:
            raise ValueError('Invalid Gemma text embedding request')
        rows = encoder.encode_texts(request['texts'], request['input_type'])
        return encoder.payload(validate_vectors(rows, len(request['texts'])))
    if operation not in ('media', 'compare'):
        raise ValueError('Unknown Gemma worker operation')
    expected = {'id', 'operation', 'items'} | ({'query'} if operation == 'compare' else set())
    if set(request) != expected:
        raise ValueError('Invalid Gemma media request')
    if operation == 'media':
        rows = encoder.encode_media(request['items'])
        return encoder.payload(validate_vectors(rows, len(request['items'])))
    query = validate_vectors(encoder.encode_texts([request['query']], 'query'), 1)[0]
    rows = validate_vectors(encoder.encode_media(request['items']), len(request['items']))
    scores = [sum(a * b for a, b in zip(query, row)) for row in rows]
    if any(not math.isfinite(score) for score in scores):
        raise ValueError('Invalid comparison scores')
    return {'model': encoder.version, 'alias': ALIAS, 'revision': encoder.revision,
            'dimensions': DIMENSIONS, 'encoding': encoder.encoding, 'scores': scores}


def serve(source, output, encoder, validate_vectors):
    while True:
        line = source.readline(MAX_LINE_BYTES + 2)
        if not line:
            return
        if len(line) > MAX_LINE_BYTES or not line.endswith(b'\n'):
            # Do not consume an unbounded line or interpret its tail as another
            # command. The supervisor can restart this worker after a bad frame.
            raise ValueError('Worker request line exceeds 263168 bytes or is incomplete')
        request_id = None
        try:
            request = json.loads(line)
            if isinstance(request, dict):
                candidate = request.get('id')
                if isinstance(candidate, str) and 1 <= len(candidate) <= 100:
                    request_id = candidate
            result = handle_request(request, encoder, validate_vectors)
            send(output, {'type': 'result', 'id': request_id, 'result': result})
        except (ValueError, TypeError, KeyError) as error:
            # Expose known validation messages only; a decoder/tokenizer may also
            # throw ValueError containing private text or local file paths.
            print(f'Gemma request rejected: {type(error).__name__}', file=sys.stderr, flush=True)
            message = str(error)
            disabled = message.endswith(' encoder is disabled') and all(
                key in ('text', 'image', 'audio', 'video')
                for key in message.removesuffix(' encoder is disabled').split(', '))
            if message not in PUBLIC_ERRORS and not disabled:
                message = 'Invalid Gemma worker request' if isinstance(error, (TypeError, KeyError)) else 'Local Gemma inference failed'
            send(output, {'type': 'error', 'id': request_id, 'error': message})
        except Exception as error:
            print(f'Gemma inference failed: {type(error).__name__}', file=sys.stderr, flush=True)
            send(output, {'type': 'error', 'id': request_id, 'error': 'Local Gemma inference failed'})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--model', choices=(ALIAS,), default=ALIAS)
    parser.add_argument('--device', choices=('auto', 'cpu', 'mps', 'cuda'), default='auto')
    parser.add_argument('--max-length', type=int, default=2048)
    parser.add_argument('--media-root', type=Path, required=True)
    parser.add_argument('--modalities', choices=('vision', 'all', 'text', 'audio'), default='vision')
    parser.add_argument('--mps-limit-mb', type=int, default=4096)
    parser.add_argument('--cuda-limit-mb', type=int, default=4096)
    args = parser.parse_args()
    if (not 1024 <= args.max_length <= 8192 or not args.media_root.is_absolute()
            or not 1024 <= args.mps_limit_mb <= 16384
            or not 1024 <= args.cuda_limit_mb <= 16384):
        parser.error('Invalid max-length, memory limits or absolute media-root')

    def stop(_signum, _frame):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, stop)
    expected = provider_metadata(args.manifest.resolve(), args.max_length)
    # Keep a private duplicate for protocol writes, then redirect both Python
    # output and native-library stdout to stderr for the process lifetime.
    output = os.fdopen(os.dup(sys.stdout.fileno()), 'w', encoding='utf-8', buffering=1)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    started = time.perf_counter()
    with output, redirect_stdout(sys.stderr):
        spec = importlib.util.spec_from_file_location('dreammate_gemma_encoder',
                                                     Path(__file__).with_name('gemma_server.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.offline_guard()
        encoder = module.GemmaEncoder(args.manifest.resolve(), args.media_root.resolve(),
                                      args.device, args.max_length, args.cuda_limit_mb,
                                      args.modalities, args.mps_limit_mb, precision='fp32')
        provider = encoder.provider()
        if provider != expected:
            raise ValueError('Loaded Gemma provider does not match the fixed FP32 profile')
        print(json.dumps({'event': 'gemma_encoder_ready',
                          'startup_ms': round((time.perf_counter() - started) * 1000, 1),
                          'device': encoder.device, 'modalities': encoder.modalities}),
              file=sys.stderr, flush=True)
        send(output, {'type': 'ready', 'provider': provider})
        serve(sys.stdin.buffer, output, encoder, module.validate_vectors)


if __name__ == '__main__':
    main()

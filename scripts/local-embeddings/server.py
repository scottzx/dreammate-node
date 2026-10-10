#!/usr/bin/env python3
"""Local-only adapter for the gateway /embed protocol. Prepare weights first."""
from __future__ import annotations

import argparse
from array import array
from collections import OrderedDict
import gc
import hashlib
import json
import math
import os
from pathlib import Path
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Set these before importing model libraries. Serving never downloads anything.
os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
                  HF_HUB_DISABLE_TELEMETRY="1", DO_NOT_TRACK="1",
                  TOKENIZERS_PARALLELISM="false")

DOCUMENT_CACHE_LIMIT = 4096
VECTOR_DIMENSION_LIMIT = 4096


def deny_outbound(*_args, **_kwargs):
    raise OSError("Local embedding runtime forbids outbound network connections")


# This process accepts inbound HTTP, but cannot initiate connections or DNS lookups.
socket.socket.connect = deny_outbound
socket.socket.connect_ex = deny_outbound
socket.create_connection = deny_outbound
socket.getaddrinfo = deny_outbound


class Encoder:
    def __init__(self, manifest: Path, device: str, batch_size: int | None, max_length: int,
                 serve_model: str | None = None):
        self.manifest = json.loads(manifest.read_text())
        prepared = self.manifest["models"]
        self.models = {alias: entry for alias, entry in prepared.items() if alias == "qwen3"} if isinstance(prepared, dict) else {}
        if not isinstance(self.models, dict) or not self.models:
            raise ValueError("manifest.models must contain pre-downloaded models")
        if serve_model is not None and serve_model not in self.models:
            raise ValueError(f"Unknown prepared serving model: {serve_model}")
        self.serve_model = serve_model
        self.device = device
        self.batch_size = batch_size
        self.effective_batch_size = batch_size or 1
        self.max_length = max_length
        self.lock = threading.Lock()
        self.current = None
        self.encoder = None
        # The sidecar survives short-lived CLI processes. Cache only hashes of
        # document texts; versions isolate models and refreshed snapshots.
        self.document_cache: OrderedDict[tuple[str, bytes], array] = OrderedDict()
        self.dimensions: dict[str, int] = {}

    def load(self, alias: str):
        if self.serve_model is not None and alias != self.serve_model:
            raise ValueError(f"This provider only serves {self.serve_model}")
        if alias != "qwen3" or alias not in self.models:
            raise ValueError(f"Unknown prepared model: {alias}")
        entry = self.models[alias]
        model_path = Path(entry["path"]).expanduser().resolve()
        if not model_path.is_dir() or not (model_path / "config.json").is_file():
            raise ValueError(f"Missing local snapshot: {model_path}")
        revision = entry.get("revision", "")
        if not isinstance(revision, str) or not revision:
            raise ValueError("Each prepared model must record its exact revision")
        if self.current == alias:
            return f"{alias}@{revision}"
        self.encoder = None
        self.current = None
        gc.collect()
        import torch
        from sentence_transformers import SentenceTransformer
        device = self.device
        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
        self.effective_batch_size = self.batch_size or (1 if device == "cpu" else 8)
        kwargs = {"device": device, "local_files_only": True,
                  "trust_remote_code": False, "model_kwargs": {"torch_dtype": torch.float32}}
        self.encoder = SentenceTransformer(str(model_path), **kwargs)
        self.encoder.max_seq_length = self.max_length
        self.encoder.tokenizer.padding_side = "left"
        self.current = alias
        return f"{alias}@{revision}"

    def encoding_profile(self, dimensions: int) -> str:
        return f"dreammate.tool-search.v1:fp32:max{self.max_length}:dim{dimensions}"

    def embedding_provider(self):
        # Inference can take longer than the agent's health deadline on a CPU.
        # Read the fixed model's published state without queueing behind its lock.
        current, encoder = self.current, self.encoder
        if current is not None and encoder is not None:
            revision = self.models[current].get("revision")
            dimensions = self.dimensions.get(f"{current}@{revision}")
            if dimensions is not None and self.current == current and self.encoder is encoder:
                return {"protocol": "dreammate.embedding.v1", "model": current,
                        "revision": revision, "dimensions": dimensions,
                        "encoding": self.encoding_profile(dimensions), "ready": True}
        return {"protocol": "dreammate.embedding.v1", "ready": False}

    def validate_vectors(self, model_version: str, rows, count: int) -> list[array]:
        if not isinstance(rows, list) or len(rows) != count:
            raise ValueError("Local model returned the wrong embedding count")
        dimension = self.dimensions.get(model_version)
        get_dimension = getattr(self.encoder, "get_embedding_dimension", None)
        if not callable(get_dimension):
            get_dimension = getattr(self.encoder, "get_sentence_embedding_dimension", None)
        if dimension is None and callable(get_dimension):
            dimension = get_dimension()
        checked = []
        for row in rows:
            if not isinstance(row, list) or not 1 <= len(row) <= VECTOR_DIMENSION_LIMIT:
                raise ValueError("Local model returned an invalid embedding dimension")
            if dimension is None:
                dimension = len(row)
            if len(row) != dimension:
                raise ValueError("Local model changed embedding dimension")
            if any(isinstance(value, bool) or not isinstance(value, (int, float))
                   or not math.isfinite(value) for value in row):
                raise ValueError("Local model returned a non-finite or non-numeric embedding")
            if abs(sum(value * value for value in row) - 1.0) > 0.01:
                raise ValueError("Local model returned a non-unit embedding")
            checked.append(array("f", row))
        # Do not pin dimensions or cache a partial batch when any row is bad.
        self.dimensions[model_version] = dimension
        return checked

    def encode_inputs(self, alias: str, texts: list[str], input_type: str, model_version: str) -> list[array]:
        # Explicit prefixes avoid dependency on changing default prompts.
        prefix = "Instruct: Given a user task, retrieve relevant tool descriptions that can accomplish the task\nQuery: "
        inputs = [prefix + text for text in texts] if input_type == "query" else texts
        vectors = self.encoder.encode(inputs, prompt="", batch_size=self.effective_batch_size,
                                      normalize_embeddings=True, show_progress_bar=False,
                                      convert_to_numpy=True)
        return self.validate_vectors(model_version, vectors.tolist(), len(texts))

    def encode(self, alias: str, texts: list[str], input_type: str):
        if alias is None:
            alias = self.serve_model or (next(iter(self.models)) if len(self.models) == 1 else None)
        if self.serve_model is not None and alias != self.serve_model:
            raise ValueError(f"This provider only serves {self.serve_model}")
        if input_type not in ("query", "document"):
            raise ValueError("input_type must be query or document")
        if not isinstance(texts, list) or not 1 <= len(texts) <= 64:
            raise ValueError("texts must contain 1..64 strings")
        if any(not isinstance(text, str) or not text.strip() or len(text) > 8192 for text in texts):
            raise ValueError("Each text must contain 1..8192 characters")
        with self.lock:
            model_version = self.load(alias)
            if input_type == "query":
                vectors = self.encode_inputs(alias, texts, input_type, model_version)
            else:
                keys = [(model_version, hashlib.sha256(text.encode("utf-8")).digest()) for text in texts]
                # Each unique missing document is encoded once, then restored
                # to the original request order, including duplicate entries.
                available = {}
                missing = {}
                for key, text in zip(keys, texts):
                    cached = self.document_cache.get(key)
                    if cached is not None:
                        available[key] = cached
                        self.document_cache.move_to_end(key)
                    elif key not in missing:
                        missing[key] = text
                if missing:
                    encoded = self.encode_inputs(alias, list(missing.values()), input_type, model_version)
                    for key, vector in zip(missing, encoded):
                        available[key] = vector
                        self.document_cache[key] = vector
                        self.document_cache.move_to_end(key)
                        while len(self.document_cache) > DOCUMENT_CACHE_LIMIT:
                            self.document_cache.popitem(last=False)
                vectors = [available[key] for key in keys]
            dimensions = len(vectors[0])
            return {"model": model_version, "alias": alias, "revision": model_version.rsplit("@", 1)[-1],
                    "dimensions": dimensions, "encoding": self.encoding_profile(dimensions),
                    "embeddings": [vector.tolist() for vector in vectors]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=Path(".local/tool-search/manifest.json"))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--device", choices=("auto", "cpu", "mps", "cuda"), default="auto")
    parser.add_argument("--batch-size", type=int, help="Inference batch size (default CPU: 1, GPU: 8)")
    parser.add_argument("--max-length", type=int, default=512)
    parser.add_argument("--warmup", choices=("qwen3",), help="Load the chosen model before accepting HTTP")
    parser.add_argument("--serve-model", choices=("qwen3",),
                        help="Serve only this alias, default requests to it and warm it before HTTP")
    parser.add_argument("--self-test", action="store_true", help="Encode one pair per model without starting HTTP")
    args = parser.parse_args()
    if (args.batch_size is not None and not 1 <= args.batch_size <= 64) or not 64 <= args.max_length <= 8192 or not 1 <= args.port <= 65535:
        parser.error("Invalid batch-size, max-length or port")
    if args.serve_model and args.warmup and args.warmup != args.serve_model:
        parser.error("--serve-model and --warmup must select the same alias")
    if args.serve_model:
        args.warmup = args.serve_model
    encoder = Encoder(args.manifest.resolve(), args.device, args.batch_size, args.max_length, args.serve_model)
    if args.self_test:
        import resource
        for alias in ([args.serve_model] if args.serve_model else encoder.models):
            start = time.perf_counter()
            query = encoder.encode(alias, ["把会议录音转换为文字"], "query")
            document = encoder.encode(alias, ["Transcribe local audio into text and timed subtitles"], "document")
            vector = query["embeddings"][0]
            if not all(math.isfinite(value) for value in vector) or abs(sum(value * value for value in vector) - 1) > 0.01:
                raise RuntimeError("Self-test returned a non-unit or non-finite embedding")
            peak_rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            print(json.dumps({"model": query["model"], "dimensions": len(vector),
                              "device": str(encoder.encoder.device),
                              "loaded_parameters": sum(parameter.numel() for parameter in encoder.encoder.parameters()),
                              "similarity": sum(a * b for a, b in zip(vector, document["embeddings"][0])),
                              "load_and_encode_seconds": round(time.perf_counter() - start, 3),
                              "cumulative_peak_process_rss_mib": round(peak_rss / (1024 * 1024 if sys.platform == "darwin" else 1024), 1),
                              "outbound_network": "blocked"}), flush=True)
        try:
            socket.create_connection(("example.com", 443))
        except OSError:
            print("Outbound connection guard verified", flush=True)
        else:
            raise RuntimeError("Outbound guard failed")
        return

    if args.warmup:
        encoder.encode(args.warmup, ["Find a relevant tool for the user task"], "query")

    class Handler(BaseHTTPRequestHandler):
        def send_json(self, status, payload):
            data = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path != "/health":
                return self.send_json(404, {"error": "Not found"})
            self.send_json(200, {"status": "ok", "models": list(encoder.models),
                                 "loaded_model": encoder.current, "pid": os.getpid(),
                                 "batch_size": encoder.effective_batch_size,
                                 "embedding_provider": encoder.embedding_provider(),
                                 "outbound_network": "blocked"})

        def do_POST(self):
            if self.path != "/embed":
                return self.send_json(404, {"error": "Not found"})
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 1 <= size <= 262144:
                    return self.send_json(413, {"error": "Request must contain 1..262144 bytes"})
                self.connection.settimeout(10)
                request = json.loads(self.rfile.read(size))
                if not isinstance(request, dict):
                    raise ValueError("Expected a JSON object")
                alias = request.get("model")
                if alias is None and len(encoder.models) == 1:
                    alias = next(iter(encoder.models))
                result = encoder.encode(alias, request.get("texts"), request.get("input_type"))
                self.send_json(200, result)
            except (ValueError, TypeError, KeyError) as error:
                self.send_json(400, {"error": str(error)[:240]})
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as error:
                self.send_json(503, {"error": f"Local model unavailable: {str(error)[:200]}"})

        def log_message(self, *_args):
            pass  # Queries and tool descriptions are not request logs.

    class LocalServer(ThreadingHTTPServer):
        daemon_threads = True

        def server_bind(self):
            # HTTPServer's default reverse-DNS lookup is unnecessary for this adapter.
            socket.socket.bind(self.socket, self.server_address)
            self.server_name, self.server_port = self.server_address[:2]

    server = LocalServer((args.host, args.port), Handler)
    print(json.dumps({"listening": f"http://{args.host}:{args.port}",
                      "models": list(encoder.models), "outbound_network": "blocked"}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

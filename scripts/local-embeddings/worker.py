#!/usr/bin/env python3
"""Private JSON-lines encoder worker. Own no HTTP ports; never download weights."""
from __future__ import annotations

import argparse
from contextlib import redirect_stdout
import importlib.util
import json
from numbers import Integral
from pathlib import Path
import sys
import time

from vector_cache import load_document_cache, save_document_cache


def send(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, allow_nan=False) + "\n")
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--device", choices=("auto", "cpu", "mps", "cuda"), default="auto")
    parser.add_argument("--batch-size", type=int)
    parser.add_argument("--max-length", type=int, default=512)
    parser.add_argument("--model", choices=("qwen3",), default="qwen3")
    args = parser.parse_args()
    if ((args.batch_size is not None and not 1 <= args.batch_size <= 64)
            or not 64 <= args.max_length <= 8192):
        parser.error("Invalid batch-size or max-length")

    started = time.perf_counter()
    # Library progress/logging must never corrupt the stdout protocol. Importing
    # server also installs its offline flags and outbound-network guard.
    with redirect_stdout(sys.stderr):
        spec = importlib.util.spec_from_file_location("dreammate_local_encoder", Path(__file__).with_name("server.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        encoder = module.Encoder(args.manifest.resolve(), args.device, args.batch_size, args.max_length, args.model)
        version = encoder.load(args.model)
        dimension = getattr(encoder.encoder, "get_embedding_dimension", None)
        if not callable(dimension):
            dimension = getattr(encoder.encoder, "get_sentence_embedding_dimension", None)
        if not callable(dimension):
            raise ValueError("Loaded model does not expose its embedding dimension")
        dimensions = dimension()
        if isinstance(dimensions, bool) or not isinstance(dimensions, Integral) or not 1 <= dimensions <= 4096:
            raise ValueError("Loaded model reports an invalid embedding dimension")
        # Use real loaded model metadata for readiness. The first actual query
        # still validates finite/unit vectors, without an extra warmup inference.
        encoder.dimensions[version] = int(dimensions)
        provider = encoder.embedding_provider()
        restored = load_document_cache(encoder, args.model)
        print(json.dumps({"event": "encoder_ready", "startup_ms": round((time.perf_counter() - started) * 1000, 1),
                          "restored_document_vectors": restored}), file=sys.stderr, flush=True)
    send({"type": "ready", "provider": provider})

    while True:
        # The public body limit excludes our private request ID/envelope.
        line = sys.stdin.buffer.readline(263170)
        if not line:
            return
        if len(line) > 263168 or not line.endswith(b"\n"):
            raise ValueError("Worker request line exceeds 263168 bytes")
        request_id = None
        try:
            request = json.loads(line)
            if (not isinstance(request, dict) or set(request) != {"id", "model", "texts", "input_type"}
                    or not isinstance(request["id"], str) or not 1 <= len(request["id"]) <= 100):
                raise ValueError("Invalid worker request")
            request_id = request["id"]
            with redirect_stdout(sys.stderr):
                result = encoder.encode(request["model"], request["texts"], request["input_type"])
                if request["input_type"] == "document":
                    save_document_cache(encoder, args.model)
            send({"type": "result", "id": request_id, "result": result})
        except Exception as error:
            # Do not echo request text or local file paths into client errors.
            print(f"Encoder request failed: {type(error).__name__}", file=sys.stderr, flush=True)
            send({"type": "error", "id": request_id, "error": "Local model inference failed"})


if __name__ == "__main__":
    main()

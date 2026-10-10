#!/usr/bin/env python3
"""Explicit online setup for offline local tool-search embeddings.

Only this preparation command downloads files. The HTTP server must read the
resulting manifest and local directories with local_files_only=True.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import venv

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_HOME = ROOT / ".local" / "tool-search"
MODELS = {
    "qwen3": "Qwen/Qwen3-Embedding-0.6B",
}


def prepare(home: Path, aliases: list[str], install: bool, download_only: bool = False) -> None:
    home = home.resolve()
    home.mkdir(parents=True, exist_ok=True)
    local_env = home / "venv"
    python = local_env / "bin" / "python"
    if download_only:
        # Use an already available huggingface_hub for weights while the isolated
        # inference dependencies are being installed in a separate process.
        python = Path(sys.executable)
    env = os.environ.copy()
    env.update({
        "HF_HOME": str(home / "hf-cache"),
        "XDG_CACHE_HOME": str(home / "cache"),
        "PIP_CACHE_DIR": str(home / "pip-cache"),
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "DO_NOT_TRACK": "1",
        "TOKENIZERS_PARALLELISM": "false",
    })
    # Explicit preparation is the only online phase; inherited offline flags
    # must not silently turn this command into a failed partial setup.
    env.pop("HF_HUB_OFFLINE", None)
    env.pop("TRANSFORMERS_OFFLINE", None)
    if install and not download_only:
        if not python.is_file():
            print(f"Creating isolated Python environment: {local_env}", flush=True)
            venv.EnvBuilder(with_pip=True).create(local_env)
        subprocess.run([
            str(python), "-m", "pip", "install", "--disable-pip-version-check",
            "-r", str(Path(__file__).with_name("requirements.txt")),
        ], env=env, check=True)
    elif not python.is_file():
        raise SystemExit("No task-local venv. Run prepare.py without --skip-install first.")

    if not download_only:
        freeze = subprocess.run([str(python), "-m", "pip", "freeze"], env=env, check=True, capture_output=True, text=True)
        (home / "requirements.resolved.txt").write_text(freeze.stdout)
    worker = r'''
import datetime, fcntl, json, os, pathlib, sys
from huggingface_hub import HfApi, snapshot_download
home = pathlib.Path(sys.argv[1])
models = json.loads(sys.argv[2])
manifest_path = home / "manifest.json"
manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"format": 1, "models": {}}
api = HfApi()
failures = []
for alias, repo in models.items():
    try:
        info = api.model_info(repo)
        revision = info.sha
        if not revision:
            raise RuntimeError("Model API omitted immutable revision: " + repo)
        # Failed updates must not change a previously prepared snapshot.
        destination = home / "models" / alias / revision
        print(json.dumps({"phase": "downloading", "model": alias, "repo": repo, "revision": revision, "path": str(destination)}), flush=True)
        snapshot_download(repo_id=repo, revision=revision, local_dir=str(destination),
            allow_patterns=["*.json", "*.safetensors", "*.model", "*.txt", "*.jinja", "*.tiktoken"],
            ignore_patterns=["onnx/*", "openvino/*", "*.onnx", "*.bin", "*.gguf"], max_workers=4)
        # Re-read under a short local lock after the long download. Separate
        # preparation workers must preserve each other's completed aliases.
        with (home / "manifest.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"format": 1, "models": {}}
            manifest["models"] = {name: entry for name, entry in manifest["models"].items() if name == "qwen3"}
            manifest["models"][alias] = {"repo": repo, "revision": revision, "path": str(destination),
                "prepared_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}
            temporary = manifest_path.with_suffix(f".json.{os.getpid()}.tmp")
            temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
            temporary.replace(manifest_path)
        print(json.dumps({"phase": "ready", "model": alias, "revision": revision}), flush=True)
    except Exception as error:
        failures.append(alias)
        print(json.dumps({"phase": "failed", "model": alias, "error": str(error)[:500]}), flush=True)
if failures:
    raise SystemExit("Model preparation failed: " + ", ".join(failures))
'''
    subprocess.run([str(python), "-c", worker, str(home), json.dumps({a: MODELS[a] for a in aliases})], env=env, check=True)
    print(f"Offline models ready: {home / 'manifest.json'}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=DEFAULT_HOME)
    parser.add_argument("--models", default=",".join(MODELS), help="Comma-separated model aliases")
    parser.add_argument("--skip-install", action="store_true")
    parser.add_argument("--download-only", action="store_true", help="Use this Python's existing huggingface_hub to prepare weights only")
    args = parser.parse_args()
    aliases = args.models.split(",")
    if not aliases or any(a not in MODELS for a in aliases):
        parser.error("--models must contain qwen3")
    prepare(args.home, aliases, not args.skip_install, args.download_only)


if __name__ == "__main__":
    main()

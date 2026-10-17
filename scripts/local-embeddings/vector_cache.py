"""Bounded persistent document-vector cache; never stores document/query text."""
from __future__ import annotations

from array import array
import base64
from collections import OrderedDict
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import sys
import tempfile

FORMAT = 1
ENTRY_LIMIT = 4096
FILE_LIMIT = 64 * 1024 * 1024
HASH = re.compile(r"[0-9a-f]{64}\Z")


def fingerprint(model: str, encoding: str, dimensions: int) -> dict:
    if (not isinstance(model, str) or not model or model != model.strip() or len(model) > 240
            or not isinstance(encoding, str) or not encoding or encoding != encoding.strip() or len(encoding) > 200
            or isinstance(dimensions, bool) or not isinstance(dimensions, int) or not 1 <= dimensions <= 4096):
        raise ValueError("Invalid vector-cache fingerprint")
    return {"model": model, "encoding": encoding, "dimensions": dimensions}


def cache_path(identity: dict, cache_dir: Path | None = None) -> Path:
    identity = fingerprint(identity["model"], identity["encoding"], identity["dimensions"])
    key = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    directory = Path(cache_dir) if cache_dir is not None else Path.home() / ".1agents" / "cache" / "embeddings"
    return directory / f"{key}.json"


def _identity(encoder, alias: str) -> dict:
    version = f"{alias}@{encoder.models[alias]['revision']}"
    dimensions = encoder.dimensions[version]
    return fingerprint(version, encoder.encoding_profile(dimensions), dimensions)


def _vector(value, dimensions: int) -> array:
    if not isinstance(value, array) or value.typecode != "f" or len(value) != dimensions:
        raise ValueError("Invalid cached vector dimensions")
    if any(not math.isfinite(item) for item in value) or abs(math.fsum(item * item for item in value) - 1) > 0.01:
        raise ValueError("Invalid cached vector values")
    return value


def _pack(value: array) -> str:
    portable = array("f", value)
    if portable.itemsize != 4:
        raise ValueError("Runtime does not support float32 arrays")
    if sys.byteorder != "little":
        portable.byteswap()
    return base64.b64encode(portable.tobytes()).decode("ascii")


def _unpack(encoded: str, dimensions: int) -> array:
    if not isinstance(encoded, str) or len(encoded) != ((dimensions * 4 + 2) // 3) * 4:
        raise ValueError("Invalid cached vector encoding length")
    raw = base64.b64decode(encoded, validate=True)
    if len(raw) != dimensions * 4:
        raise ValueError("Invalid cached vector byte length")
    value = array("f")
    if value.itemsize != 4:
        raise ValueError("Runtime does not support float32 arrays")
    value.frombytes(raw)
    if sys.byteorder != "little":
        value.byteswap()
    return _vector(value, dimensions)


def _read(file: Path) -> dict:
    # No symlink/FIFO/device reads, and never allocate from an unbounded file.
    if file.parent.is_symlink():
        raise ValueError("Cache directory must not be a symlink")
    os.chmod(file.parent, 0o700)
    descriptor = os.open(file, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > FILE_LIMIT:
            raise ValueError("Cache file is not a bounded regular file")
        os.fchmod(stream.fileno(), 0o600)
        data = stream.read(FILE_LIMIT + 1)
        if len(data) > FILE_LIMIT:
            raise ValueError("Cache file exceeds size limit")
    return json.loads(data)


def _notice(action: str, error: Exception):
    # A local path or model input can contain sensitive content. Log only type.
    print(f"Document vector cache {action}: {type(error).__name__}", file=sys.stderr, flush=True)


def load_document_cache(encoder, alias: str, cache_dir: Path | None = None) -> int:
    """Restore a complete validated snapshot after model warmup; failure is optional."""
    try:
        identity = _identity(encoder, alias)
        file = cache_path(identity, cache_dir)
        payload = _read(file)
        if (not isinstance(payload, dict) or set(payload) != {"format", "model", "encoding", "dimensions", "entries"}
                or type(payload["format"]) is not int or payload["format"] != FORMAT
                or any(payload[field] != value for field, value in identity.items())
                or type(payload["dimensions"]) is not int
                or not isinstance(payload["entries"], list) or len(payload["entries"]) > ENTRY_LIMIT):
            raise ValueError("Incompatible vector-cache schema or fingerprint")
        restored = OrderedDict()
        for entry in payload["entries"]:
            if (not isinstance(entry, list) or len(entry) != 2
                    or not isinstance(entry[0], str) or not HASH.fullmatch(entry[0])):
                raise ValueError("Invalid cached document hash")
            key = (identity["model"], bytes.fromhex(entry[0]))
            if key in restored:
                raise ValueError("Duplicate cached document hash")
            restored[key] = _unpack(entry[1], identity["dimensions"])
        # Commit only after the complete file passes validation.
        encoder.document_cache.update(restored)
        while len(encoder.document_cache) > ENTRY_LIMIT:
            encoder.document_cache.popitem(last=False)
        encoder.dimensions[identity["model"]] = identity["dimensions"]
        return len(restored)
    except FileNotFoundError:
        return 0
    except Exception as error:
        _notice("ignored", error)
        return 0


def save_document_cache(encoder, alias: str, cache_dir: Path | None = None) -> bool:
    """Atomically save bounded LRU rows as little-endian FP32; failures are nonfatal."""
    temporary = None
    try:
        identity = _identity(encoder, alias)
        file = cache_path(identity, cache_dir)
        if file.parent.is_symlink():
            raise ValueError("Cache directory must not be a symlink")
        file.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        os.chmod(file.parent, 0o700)
        # Encode at most the latest LRU entries and stop before the file budget.
        entries = []
        payload = {"format": FORMAT, **identity, "entries": entries}
        size = len(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
        for (version, digest), vector in reversed(encoder.document_cache.items()):
            if version != identity["model"]:
                continue
            if not isinstance(digest, bytes) or len(digest) != 32:
                raise ValueError("Invalid cached document hash")
            entry = [digest.hex(), _pack(_vector(vector, identity["dimensions"]))]
            entry_size = len(json.dumps(entry, separators=(",", ":")).encode("utf-8")) + (1 if entries else 0)
            if len(entries) >= ENTRY_LIMIT or size + entry_size > FILE_LIMIT:
                break
            entries.append(entry)
            size += entry_size
        entries.reverse()
        data = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode("utf-8")
        if len(data) > FILE_LIMIT:
            raise ValueError("Cache file exceeds size limit")
        descriptor, temporary = tempfile.mkstemp(prefix=".vectors-", suffix=".tmp", dir=file.parent)
        with os.fdopen(descriptor, "wb") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, file)
        temporary = None
        return True
    except Exception as error:
        _notice("save skipped", error)
        return False
    finally:
        if temporary is not None:
            try:
                os.unlink(temporary)
            except OSError:
                pass

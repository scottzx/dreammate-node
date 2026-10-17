"""Persistent-vector tests run without Torch, model weights, HTTP or downloads."""
from array import array
import base64
from collections import OrderedDict
from contextlib import redirect_stderr
import hashlib
import io
import json
import math
import os
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import vector_cache as cache


class VectorCacheTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name) / "vectors"
        self.identity = cache.fingerprint("qwen3@fixture-sha", "fixture-encoding:dim2", 2)
        self.file = cache.cache_path(self.identity, self.directory)
        self.encoder = self.make_encoder()

    def make_encoder(self):
        return SimpleNamespace(models={"qwen3": {"revision": "fixture-sha"}},
                               dimensions={"qwen3@fixture-sha": 2},
                               encoding_profile=lambda _dimensions: "fixture-encoding:dim2",
                               document_cache=OrderedDict())

    def add(self, encoder, text, vector=None):
        key = ("qwen3@fixture-sha", hashlib.sha256(text.encode()).digest())
        encoder.document_cache[key] = array("f", vector or [0.6, 0.8])
        return key

    def read(self):
        return json.loads(self.file.read_text())

    def write(self, payload):
        self.directory.mkdir(mode=0o700, exist_ok=True)
        self.file.write_text(json.dumps(payload))

    def test_roundtrip_preserves_lru_and_float32_but_never_stores_plaintext_or_queries(self):
        first = self.add(self.encoder, "Private document A")
        second = self.add(self.encoder, "Private document B")
        self.encoder.document_cache.move_to_end(first)
        self.assertTrue(cache.save_document_cache(self.encoder, "qwen3", self.directory))
        data = self.file.read_text()
        self.assertNotIn("Private document", data)
        self.assertNotIn("query", data)
        self.assertEqual(stat.S_IMODE(self.file.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.directory.stat().st_mode), 0o700)
        restored = self.make_encoder()
        self.assertEqual(cache.load_document_cache(restored, "qwen3", self.directory), 2)
        self.assertEqual(list(restored.document_cache), [second, first])
        self.assertEqual(restored.document_cache[first].tobytes(), self.encoder.document_cache[first].tobytes())
        self.assertEqual(set(self.read()), {"format", "model", "encoding", "dimensions", "entries"})

    def test_exact_model_profile_and_dimensions_isolate_files(self):
        other = {**self.identity, "model": "qwen3@new-revision"}
        self.assertNotEqual(cache.cache_path(other, self.directory), self.file)
        self.assertNotEqual(cache.cache_path({**self.identity, "encoding": "other"}, self.directory), self.file)
        self.assertNotEqual(cache.cache_path({**self.identity, "dimensions": 3}, self.directory), self.file)
        self.add(self.encoder, "document")
        self.assertTrue(cache.save_document_cache(self.encoder, "qwen3", self.directory))
        original = self.read()
        for field, value in [("model", "qwen3@new"), ("encoding", "other"), ("dimensions", 3),
                             ("dimensions", 2.0), ("format", 1.0), ("format", True), ("format", 2)]:
            with self.subTest(field=field, value=value), redirect_stderr(io.StringIO()) as logs:
                self.write({**original, field: value})
                restored = self.make_encoder()
                self.assertEqual(cache.load_document_cache(restored, "qwen3", self.directory), 0)
                self.assertEqual(len(restored.document_cache), 0)
                self.assertIn("ignored", logs.getvalue())

    def test_corrupt_rows_ignore_entire_file_without_partial_restore(self):
        self.add(self.encoder, "one")
        self.add(self.encoder, "two")
        self.assertTrue(cache.save_document_cache(self.encoder, "qwen3", self.directory))
        original = self.read()
        bad_rows = [["not-a-hash", original["entries"][0][1]],
                    [original["entries"][1][0], "invalid-base64"],
                    [original["entries"][1][0], base64.b64encode(array("f", [1]).tobytes()).decode()],
                    [original["entries"][1][0], base64.b64encode(array("f", [0, 0]).tobytes()).decode()],
                    [original["entries"][1][0], base64.b64encode(array("f", [math.nan, 1]).tobytes()).decode()],
                    original["entries"][0]]
        for bad in bad_rows:
            with self.subTest(row=bad), redirect_stderr(io.StringIO()):
                self.write({**original, "entries": [original["entries"][0], bad]})
                restored = self.make_encoder()
                self.assertEqual(cache.load_document_cache(restored, "qwen3", self.directory), 0)
                self.assertEqual(len(restored.document_cache), 0)

    def test_missing_or_invalid_json_is_nonfatal_and_never_logs_content(self):
        self.assertEqual(cache.load_document_cache(self.encoder, "qwen3", self.directory), 0)
        self.directory.mkdir()
        self.file.write_text("sensitive invalid content")
        with redirect_stderr(io.StringIO()) as logs:
            self.assertEqual(cache.load_document_cache(self.encoder, "qwen3", self.directory), 0)
        self.assertNotIn("sensitive", logs.getvalue())
        self.assertIn("JSONDecodeError", logs.getvalue())

    def test_entry_and_byte_limits_preserve_most_recent_lru_rows(self):
        for name in ["first", "second", "third"]:
            self.add(self.encoder, name)
        with mock.patch.object(cache, "ENTRY_LIMIT", 2):
            self.assertTrue(cache.save_document_cache(self.encoder, "qwen3", self.directory))
        payload = self.read()
        self.assertEqual([entry[0] for entry in payload["entries"]],
                         [hashlib.sha256(name.encode()).hexdigest() for name in ["second", "third"]])
        single_size = len(json.dumps({**payload, "entries": payload["entries"][-1:]}, separators=(",", ":")).encode())
        with mock.patch.object(cache, "FILE_LIMIT", single_size):
            self.assertTrue(cache.save_document_cache(self.encoder, "qwen3", self.directory))
        self.assertEqual(self.file.stat().st_size, single_size)
        self.assertEqual(self.read()["entries"], payload["entries"][-1:])

    def test_oversized_files_are_rejected_before_json_read(self):
        self.directory.mkdir()
        self.file.write_bytes(b" " * 1000)
        with mock.patch.object(cache, "FILE_LIMIT", 100), redirect_stderr(io.StringIO()):
            self.assertEqual(cache.load_document_cache(self.encoder, "qwen3", self.directory), 0)
        self.assertEqual(len(self.encoder.document_cache), 0)

    def test_atomic_failure_keeps_old_snapshot_and_removes_temporary(self):
        self.add(self.encoder, "old")
        self.assertTrue(cache.save_document_cache(self.encoder, "qwen3", self.directory))
        original = self.file.read_bytes()
        self.add(self.encoder, "new")
        with mock.patch.object(cache.os, "replace", side_effect=OSError("private path")), redirect_stderr(io.StringIO()) as logs:
            self.assertFalse(cache.save_document_cache(self.encoder, "qwen3", self.directory))
        self.assertEqual(self.file.read_bytes(), original)
        self.assertEqual(list(self.directory.iterdir()), [self.file])
        self.assertNotIn("private path", logs.getvalue())

    def test_symlink_cache_file_cannot_be_read_or_modify_its_target(self):
        target = self.directory.parent / "private"
        target.write_text("private data")
        original_mode = stat.S_IMODE(target.stat().st_mode)
        self.directory.mkdir()
        self.file.symlink_to(target)
        with redirect_stderr(io.StringIO()):
            self.assertEqual(cache.load_document_cache(self.encoder, "qwen3", self.directory), 0)
        self.assertEqual(target.read_text(), "private data")
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), original_mode)

    def test_saves_exclude_other_models_and_never_publish_invalid_vectors(self):
        self.add(self.encoder, "current")
        self.encoder.document_cache[("different@revision", b"x" * 32)] = array("f", [1, 0])
        self.assertTrue(cache.save_document_cache(self.encoder, "qwen3", self.directory))
        self.assertEqual(len(self.read()["entries"]), 1)
        original = self.file.read_bytes()
        self.add(self.encoder, "bad", [float("inf"), 0])
        with redirect_stderr(io.StringIO()):
            self.assertFalse(cache.save_document_cache(self.encoder, "qwen3", self.directory))
        self.assertEqual(self.file.read_bytes(), original)

    def test_cache_permissions_are_repaired_on_load(self):
        self.add(self.encoder, "document")
        self.assertTrue(cache.save_document_cache(self.encoder, "qwen3", self.directory))
        self.file.chmod(0o644)
        self.directory.chmod(0o755)
        self.assertEqual(cache.load_document_cache(self.make_encoder(), "qwen3", self.directory), 1)
        self.assertEqual(stat.S_IMODE(self.file.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.directory.stat().st_mode), 0o700)


if __name__ == "__main__":
    unittest.main()

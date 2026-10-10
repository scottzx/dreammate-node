"""Adapter contract checks; does not import torch or require model weights."""
import json
from pathlib import Path
import socket
import tempfile
import unittest
from unittest import mock

from server import Encoder


class Array:
    def __init__(self, rows):
        self.rows = rows

    def tolist(self):
        return self.rows


class FakeModel:
    def __init__(self):
        self.calls = []
        self.rows = None

    def encode(self, inputs, **kwargs):
        self.inputs = inputs
        self.options = kwargs
        self.calls.append(list(inputs))
        return Array(self.rows if self.rows is not None else [[1.0, 0.0] for _ in inputs])


class AdapterTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        manifest = Path(self.directory.name) / "manifest.json"
        self.manifest_path = manifest
        manifest.write_text(json.dumps({"models": {alias: {"path": str(Path(self.directory.name) / alias), "revision": "fixture-sha"}
                                                   for alias in ("qwen3",)}}))
        self.encoder = Encoder(manifest, "cpu", 8, 512)
        self.fake = FakeModel()
        self.encoder.encoder = self.fake

    def use_fake(self):
        def load(alias):
            self.encoder.current = alias
            return f"{alias}@fixture-sha"
        self.encoder.load = load

    def test_provider_is_advertised_only_after_successful_encoding_with_actual_profile(self):
        self.use_fake()
        self.assertEqual(self.encoder.embedding_provider(), {"protocol": "dreammate.embedding.v1", "ready": False})
        self.encoder.max_length = 256
        encoded = self.encoder.encode("qwen3", ["read file"], "query")
        self.assertEqual(encoded["model"], "qwen3@fixture-sha")
        self.assertEqual(encoded["alias"], "qwen3")
        self.assertEqual(encoded["revision"], "fixture-sha")
        self.assertEqual(encoded["dimensions"], 2)
        self.assertEqual(encoded["encoding"], "dreammate.tool-search.v1:fp32:max256:dim2")
        self.assertEqual(self.encoder.embedding_provider(), {
            "protocol": "dreammate.embedding.v1", "model": "qwen3", "revision": "fixture-sha",
            "dimensions": 2, "encoding": "dreammate.tool-search.v1:fp32:max256:dim2", "ready": True})

    def test_fixed_serving_alias_defaults_and_rejects_other_models_before_loading(self):
        self.encoder = Encoder(self.manifest_path, "cpu", 8, 512, serve_model="qwen3")
        self.encoder.encoder = self.fake
        self.use_fake()
        encoded = self.encoder.encode(None, ["read file"], "query")
        self.assertEqual(encoded["alias"], "qwen3")
        with self.assertRaisesRegex(ValueError, "only serves qwen3"):
            self.encoder.encode("embeddinggemma2", ["read file"], "query")
        self.assertEqual(len(self.fake.calls), 1)
        with self.assertRaisesRegex(ValueError, "Unknown prepared serving model"):
            Encoder(self.manifest_path, "cpu", 8, 512, serve_model="cloud")

    def test_failed_initial_encoding_never_advertises_readiness(self):
        self.use_fake()
        self.fake.rows = [[0.0, 0.0]]
        with self.assertRaises(ValueError):
            self.encoder.encode("qwen3", ["read file"], "query")
        self.assertEqual(self.encoder.embedding_provider(), {"protocol": "dreammate.embedding.v1", "ready": False})

    def test_removed_model_is_rejected_without_loading_or_caching_vectors(self):
        with self.assertRaisesRegex(ValueError, "Unknown prepared model"):
            self.encoder.encode("embeddinggemma2", ["转文字"], "query")
        self.assertEqual(len(self.fake.calls), 0)
        self.assertEqual(len(self.encoder.document_cache), 0)

    def test_qwen_instruct_only_applies_to_queries(self):
        self.use_fake()
        self.encoder.encode("qwen3", ["转文字"], "query")
        self.assertTrue(self.fake.inputs[0].startswith("Instruct: "))
        self.assertTrue(self.fake.inputs[0].endswith("\nQuery: 转文字"))
        self.encoder.encode("qwen3", ["Transcribe audio"], "document")
        self.assertEqual(self.fake.inputs, ["Transcribe audio"])

    def test_invalid_input_is_rejected_before_loading(self):
        self.encoder.load = lambda _alias: self.fail("Invalid input must not load a model")
        for texts in (None, [], [""], [123], ["x" * 8193], ["x"] * 65):
            with self.subTest(texts=str(texts)[:30]), self.assertRaises(ValueError):
                self.encoder.encode("qwen3", texts, "query")
        with self.assertRaises(ValueError):
            self.encoder.encode("qwen3", ["text"], "invalid")

    def test_missing_snapshot_is_rejected_without_remote_loading(self):
        with self.assertRaisesRegex(ValueError, "Missing local snapshot"):
            self.encoder.load("qwen3")

    def test_runtime_cannot_start_outbound_connections_or_dns(self):
        with self.assertRaisesRegex(OSError, "forbids outbound"):
            socket.create_connection(("example.com", 443))
        with socket.socket() as connection:
            with self.assertRaisesRegex(OSError, "forbids outbound"):
                connection.connect(("127.0.0.1", 9))
        with self.assertRaisesRegex(OSError, "forbids outbound"):
            socket.getaddrinfo("example.com", 443)

    def test_document_cache_survives_repeated_requests_but_queries_always_encode(self):
        self.use_fake()
        first = self.encoder.encode("qwen3", ["Transcribe audio"], "document")
        second = self.encoder.encode("qwen3", ["Transcribe audio"], "document")
        self.assertEqual(first, second)
        self.assertEqual(len(self.fake.calls), 1)
        self.encoder.encode("qwen3", ["Transcribe audio"], "query")
        self.encoder.encode("qwen3", ["Transcribe audio"], "query")
        self.assertEqual(len(self.fake.calls), 3)
        self.assertEqual(len(self.encoder.document_cache), 1)
        for (version, digest), vector in self.encoder.document_cache.items():
            self.assertEqual(version, "qwen3@fixture-sha")
            self.assertIsInstance(digest, bytes)
            self.assertEqual(len(digest), 32)
            self.assertEqual(vector.typecode, "f")

    def test_document_cache_encodes_only_unique_missing_texts_and_restores_order(self):
        self.use_fake()
        self.fake.rows = [[1.0, 0.0]]
        self.encoder.encode("qwen3", ["first"], "document")
        self.fake.rows = [[0.0, 1.0], [-1.0, 0.0]]
        result = self.encoder.encode("qwen3", ["second", "first", "second", "third", "first"], "document")
        self.assertEqual(self.fake.calls, [["first"], ["second", "third"]])
        self.assertEqual(result["embeddings"], [[0.0, 1.0], [1.0, 0.0], [0.0, 1.0], [-1.0, 0.0], [1.0, 0.0]])
        self.encoder.encode("qwen3", ["third", "second"], "document")
        self.assertEqual(len(self.fake.calls), 2)

    def test_document_cache_isolates_model_revisions(self):
        self.use_fake()
        self.encoder.encode("qwen3", ["same text"], "document")
        self.encoder.load = lambda alias: f"{alias}@new-sha"
        self.encoder.encode("qwen3", ["same text"], "document")
        self.assertEqual(len(self.fake.calls), 2)
        self.use_fake()
        self.encoder.encode("qwen3", ["same text"], "document")
        self.assertEqual(len(self.fake.calls), 2)
        self.assertEqual(len(self.encoder.document_cache), 2)

    def test_document_cache_evicts_least_recently_used_entries(self):
        self.use_fake()
        with mock.patch("server.DOCUMENT_CACHE_LIMIT", 2):
            self.encoder.encode("qwen3", ["first", "second"], "document")
            self.encoder.encode("qwen3", ["first"], "document")
            self.encoder.encode("qwen3", ["third"], "document")
            self.encoder.encode("qwen3", ["first"], "document")
            self.assertEqual(self.fake.calls, [["first", "second"], ["third"]])
            self.encoder.encode("qwen3", ["second"], "document")
            self.assertEqual(self.fake.calls[-1], ["second"])
            self.assertEqual(len(self.encoder.document_cache), 2)

    def test_invalid_vectors_are_never_cached(self):
        self.use_fake()
        self.encoder.encode("qwen3", ["valid"], "document")
        invalid_rows = [[], [0.0, 0.0], [float("nan"), 0.0], [float("inf"), 0.0],
                        [1.0], [True, 0.0], ["1", 0.0], [1.0] + [0.0] * 4096]
        for row in invalid_rows:
            with self.subTest(row=str(row)[:30]):
                self.fake.rows = [row]
                with self.assertRaises(ValueError):
                    self.encoder.encode("qwen3", ["invalid"], "document")
                self.assertEqual(len(self.encoder.document_cache), 1)
        self.fake.rows = [[1.0, 0.0], [0.0, 0.0]]
        with self.assertRaises(ValueError):
            self.encoder.encode("qwen3", ["new valid", "invalid"], "document")
        self.assertEqual(len(self.encoder.document_cache), 1)
        self.fake.rows = None
        self.encoder.encode("qwen3", ["new valid", "invalid"], "document")
        self.assertEqual(self.fake.calls[-1], ["new valid", "invalid"])

    def test_wrong_embedding_count_is_rejected_before_cache_insertion(self):
        self.use_fake()
        self.fake.rows = [[1.0, 0.0]]
        with self.assertRaisesRegex(ValueError, "wrong embedding count"):
            self.encoder.encode("qwen3", ["first", "second"], "document")
        self.assertEqual(len(self.encoder.document_cache), 0)


if __name__ == "__main__":
    unittest.main()

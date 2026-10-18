"""Exercise the real JSON-lines worker with fake libraries; no model is loaded."""
import importlib.util
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest.mock import patch

WORKER = Path(__file__).with_name('gemma_worker.py')
spec = importlib.util.spec_from_file_location('gemma_worker', WORKER)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

FAKE_TORCH = '''
from types import SimpleNamespace
float32='float32'
bfloat16='bfloat16'
cuda=SimpleNamespace(is_available=lambda:True,is_bf16_supported=lambda:True,
    get_device_properties=lambda n:SimpleNamespace(total_memory=8*1024**3),
    set_per_process_memory_fraction=lambda *args:None)
backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda:False))
def set_num_threads(count): assert count==2
'''

FAKE_SENTENCE_TRANSFORMERS = '''
import os
import socket
from types import SimpleNamespace
print('fake-library Python stdout')
os.write(1,b'fake-library native stdout\\n')
class Array:
    def __init__(self, rows): self.rows=rows
    def tolist(self): return self.rows
class SentenceTransformer:
    def __init__(self, path, device, local_files_only, trust_remote_code, config_kwargs, model_kwargs):
        assert os.environ['HF_HUB_OFFLINE']=='1'
        assert os.environ['TRANSFORMERS_OFFLINE']=='1'
        try: socket.create_connection(('example.invalid',443))
        except OSError: pass
        else: raise AssertionError('offline guard missing before model construction')
        assert local_files_only and not trust_remote_code
        assert model_kwargs['torch_dtype']=='float32', 'worker must force FP32 even on CUDA'
        assert model_kwargs['attn_implementation']=='sdpa'
        self.parameter=SimpleNamespace(numel=lambda:42,dtype='float32',device=SimpleNamespace(type=device))
    def parameters(self): return iter([self.parameter])
    def encode(self, inputs, **kwargs):
        print('fake inference stdout')
        texts=inputs if isinstance(inputs,list) else [inputs.get('text','image')]
        if 'private-error' in texts: raise ValueError('/private/path/secret user text')
        rows=[[float('nan')]+[0.0]*767 if text=='bad-vector' else [1.0]+[0.0]*767 for text in texts]
        return Array(rows if isinstance(inputs,list) else rows[0])
'''


class GemmaWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name).resolve()
        self.model_path = self.folder / 'model'
        self.model_path.mkdir()
        (self.model_path / 'config.json').write_text('{}')
        self.root = self.folder / 'inbox'
        self.root.mkdir()
        (self.root / 'ok.png').write_bytes(b'fake local image')
        self.manifest = self.folder / 'manifest.json'
        self.manifest.write_text(json.dumps({'models': {'embeddinggemma2': {
            'path': str(self.model_path), 'revision': 'fake-revision'}}}))
        self.libraries = self.folder / 'libraries'
        self.libraries.mkdir()
        (self.libraries / 'torch.py').write_text(textwrap.dedent(FAKE_TORCH))
        (self.libraries / 'sentence_transformers.py').write_text(textwrap.dedent(FAKE_SENTENCE_TRANSFORMERS))

    def arguments(self, *extra):
        return [sys.executable, str(WORKER), '--manifest', str(self.manifest),
                '--model', 'embeddinggemma2', '--device', 'cuda',
                '--media-root', str(self.root), *extra]

    def environment(self):
        return {**os.environ, 'PYTHONPATH': str(self.libraries)}

    def run_requests(self, requests, *extra):
        completed = subprocess.run(self.arguments(*extra),
                                   input=''.join(json.dumps(r) + '\n' for r in requests),
                                   capture_output=True, text=True, env=self.environment(), timeout=10)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return [json.loads(line) for line in completed.stdout.splitlines()], completed.stderr

    def assert_profile(self, result):
        self.assertEqual(result['model'], 'embeddinggemma2@fake-revision')
        self.assertEqual(result['alias'], 'embeddinggemma2')
        self.assertEqual(result['revision'], 'fake-revision')
        self.assertEqual(result['dimensions'], 768)
        self.assertEqual(result['encoding'], 'dreammate.gemma2.v1:fp32:max2048:dim768')

    def test_provider_metadata_is_readable_without_torch(self):
        with patch.dict(sys.modules, {'torch': None, 'sentence_transformers': None}):
            provider = module.provider_metadata(self.manifest)
        self.assertEqual(provider, {
            'protocol': 'dreammate.embedding.v1', 'model': 'embeddinggemma2',
            'revision': 'fake-revision', 'dimensions': 768,
            'encoding': 'dreammate.gemma2.v1:fp32:max2048:dim768', 'ready': True})

    def test_ready_then_embed_media_and_compare_have_clean_stdout(self):
        requests = [
            {'id': 'text', 'model': 'embeddinggemma2', 'texts': ['眼镜'], 'input_type': 'query'},
            {'id': 'media', 'operation': 'media', 'items': [{'image': 'ok.png'}]},
            {'id': 'compare', 'operation': 'compare', 'query': '眼镜', 'items': [{'image': 'ok.png'}]},
        ]
        rows, logs = self.run_requests(requests)
        self.assertEqual(len(rows), 4)
        self.assertEqual(rows[0], {'type': 'ready', 'provider': module.provider_metadata(self.manifest)})
        for request, response in zip(requests, rows[1:]):
            self.assertEqual((response['type'], response['id']), ('result', request['id']))
            self.assert_profile(response['result'])
        self.assertEqual(len(rows[1]['result']['embeddings'][0]), 768)
        self.assertEqual(rows[3]['result']['scores'], [1.0])
        self.assertIn('fake-library Python stdout', logs)
        self.assertIn('fake-library native stdout', logs)
        self.assertIn('fake inference stdout', logs)

    def test_disabled_media_is_explicit_and_never_switched_to_another_model(self):
        requests = [
            {'id': 'audio', 'operation': 'media', 'items': [{'audio': 'absent.wav'}]},
            {'id': 'qwen', 'model': 'qwen3', 'texts': ['hello'], 'input_type': 'query'},
            {'id': 'valid', 'model': 'embeddinggemma2', 'texts': ['hello'], 'input_type': 'document'},
        ]
        rows, _ = self.run_requests(requests)
        self.assertEqual(rows[1]['error'], 'audio encoder is disabled')
        self.assertEqual(rows[2]['error'], 'Invalid Gemma text embedding request')
        self.assertEqual(rows[3]['type'], 'result')
        self.assert_profile(rows[3]['result'])
        rows, _ = self.run_requests([{'id': 'image', 'operation': 'media',
                                      'items': [{'image': 'ok.png'}]}], '--modalities', 'text')
        self.assertEqual(rows[1]['error'], 'image encoder is disabled')

    def test_bad_vectors_and_library_errors_cannot_leak_private_details(self):
        requests = [{'id': text, 'model': 'embeddinggemma2', 'texts': [text], 'input_type': 'query'}
                    for text in ['bad-vector', 'private-error', 'valid']]
        rows, logs = self.run_requests(requests)
        self.assertEqual(rows[1]['error'], 'Invalid embedding values')
        self.assertEqual(rows[2]['error'], 'Local Gemma inference failed')
        self.assertEqual(rows[3]['type'], 'result')
        self.assertNotIn('/private/path', json.dumps(rows) + logs)

    def test_media_keeps_inbox_and_symlink_boundaries(self):
        (self.folder / 'secret.png').write_bytes(b'secret')
        (self.root / 'outside.png').symlink_to(self.folder / 'secret.png')
        requests = [{'id': str(i), 'operation': 'media', 'items': [{'image': value}]}
                    for i, value in enumerate(['../secret.png', 'outside.png', 'https://example.invalid/image.png'])]
        rows, _ = self.run_requests(requests)
        for row in rows[1:]:
            self.assertEqual(row['error'], 'Media must be a file inside the configured inbox')

    def test_invalid_envelopes_do_not_break_next_request(self):
        requests = [None, {'id': 3}, {'id': 'unknown', 'operation': 'other'},
                    {'id': 'media', 'operation': 'media', 'items': [{'image': 'ok.png'}], 'extra': 1},
                    {'id': 'compare', 'operation': 'compare', 'query': 'hello'},
                    {'id': 'valid', 'model': 'embeddinggemma2', 'texts': ['hello'], 'input_type': 'query'}]
        rows, _ = self.run_requests(requests)
        self.assertTrue(all(row['type'] == 'error' for row in rows[1:-1]))
        self.assertEqual(rows[-1]['type'], 'result')

    def test_oversized_or_unterminated_frames_stop_instead_of_parsing_the_tail(self):
        for frame in [b' ' * (module.MAX_LINE_BYTES + 1) + b'\n', b'{"id":"unfinished"}']:
            with self.subTest(size=len(frame)):
                completed = subprocess.run(self.arguments(), input=frame,
                                           capture_output=True, env=self.environment(), timeout=10)
                self.assertNotEqual(completed.returncode, 0)
                self.assertEqual(len(completed.stdout.splitlines()), 1)
                self.assertEqual(json.loads(completed.stdout)['type'], 'ready')
                self.assertIn(b'263168', completed.stderr)

    def test_exact_line_limit_is_accepted(self):
        request = json.dumps({'id': 'valid', 'model': 'embeddinggemma2',
                              'texts': ['hello'], 'input_type': 'query'}).encode()
        frame = request + b' ' * (module.MAX_LINE_BYTES - 1 - len(request)) + b'\n'
        completed = subprocess.run(self.arguments(), input=frame,
                                   capture_output=True, env=self.environment(), timeout=10)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(json.loads(completed.stdout.splitlines()[-1])['type'], 'result')

    def test_eof_and_sigterm_exit_cleanly(self):
        rows, _ = self.run_requests([])
        self.assertEqual([row['type'] for row in rows], ['ready'])
        process = subprocess.Popen(self.arguments(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, env=self.environment())
        try:
            ready, _, _ = select.select([process.stdout], [], [], 10)
            self.assertTrue(ready, 'Worker did not become ready')
            self.assertEqual(json.loads(process.stdout.readline())['type'], 'ready')
            process.send_signal(signal.SIGTERM)
            stdout, stderr = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 0, stderr)
            self.assertEqual(stdout, b'')
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()

    def test_invalid_configuration_rejects_before_importing_libraries(self):
        for extra in [('--media-root', 'relative'), ('--mps-limit-mb', '0'), ('--model', 'qwen3')]:
            with self.subTest(extra=extra):
                completed = subprocess.run(self.arguments(*extra), input='', capture_output=True,
                                           text=True, env=self.environment(), timeout=10)
                self.assertNotEqual(completed.returncode, 0)
                self.assertEqual(completed.stdout, '')
                self.assertNotIn('fake-library', completed.stderr)


if __name__ == '__main__':
    unittest.main()

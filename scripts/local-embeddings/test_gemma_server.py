import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec=importlib.util.spec_from_file_location('gemma_server',Path(__file__).with_name('gemma_server.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


def fake_torch(cuda=False, mps=False, bf16=False, cuda_memory=8*1024**3,
               mps_memory=8*1024**3):
    """Describe available hardware without importing torch or allocating weights."""
    return SimpleNamespace(
        float32=object(), bfloat16=object(),
        cuda=SimpleNamespace(
            is_available=Mock(return_value=cuda),
            is_bf16_supported=Mock(return_value=bf16),
            get_device_properties=Mock(return_value=SimpleNamespace(total_memory=cuda_memory)),
            set_per_process_memory_fraction=Mock(),
        ),
        backends=SimpleNamespace(mps=SimpleNamespace(is_available=Mock(return_value=mps))),
        mps=SimpleNamespace(
            recommended_max_memory=Mock(return_value=mps_memory),
            set_per_process_memory_fraction=Mock(),
        ),
    )


class GemmaContracts(unittest.TestCase):
    def test_auto_prefers_cuda_then_mps_then_cpu_without_cpu_fallback(self):
        for cuda, mps, expected in [(True, True, 'cuda'), (True, False, 'cuda'),
                                    (False, True, 'mps'), (False, False, 'cpu')]:
            with self.subTest(cuda=cuda, mps=mps):
                torch=fake_torch(cuda=cuda, mps=mps)
                device, precision, dtype=module.runtime_config(torch, 'auto')
                self.assertEqual((device, precision), (expected, 'fp32'))
                self.assertIs(dtype, torch.float32)
                self.assertEqual(torch.cuda.set_per_process_memory_fraction.call_count, int(expected=='cuda'))
                self.assertEqual(torch.mps.set_per_process_memory_fraction.call_count, int(expected=='mps'))

    def test_explicit_accelerator_must_be_available(self):
        for requested, torch in [('mps', fake_torch(cuda=True)),
                                 ('cuda', fake_torch(mps=True))]:
            with self.subTest(requested=requested):
                with self.assertRaises(ValueError):module.runtime_config(torch, requested)
                torch.cuda.set_per_process_memory_fraction.assert_not_called()
                torch.mps.set_per_process_memory_fraction.assert_not_called()

    def test_explicit_cpu_stays_fp32_even_when_accelerators_exist(self):
        torch=fake_torch(cuda=True, mps=True, bf16=True)
        device, precision, dtype=module.runtime_config(torch, 'cpu')
        self.assertEqual((device, precision), ('cpu', 'fp32'))
        self.assertIs(dtype, torch.float32)
        torch.cuda.is_bf16_supported.assert_not_called()
        torch.cuda.set_per_process_memory_fraction.assert_not_called()
        torch.mps.set_per_process_memory_fraction.assert_not_called()

    def test_cuda_keeps_bf16_support_and_applies_its_own_memory_cap(self):
        for bf16 in [True, False]:
            with self.subTest(bf16=bf16):
                torch=fake_torch(cuda=True, bf16=bf16)
                device, precision, dtype=module.runtime_config(torch, 'cuda', cuda_limit_mb=2048)
                self.assertEqual((device, precision), ('cuda', 'bf16' if bf16 else 'fp32'))
                self.assertIs(dtype, torch.bfloat16 if bf16 else torch.float32)
                torch.cuda.set_per_process_memory_fraction.assert_called_once_with(.25, 0)
                torch.mps.set_per_process_memory_fraction.assert_not_called()

    def test_mps_uses_fp32_and_caps_fraction_at_one(self):
        for limit, expected_fraction in [(2048, .25), (16384, 1)]:
            with self.subTest(limit=limit):
                torch=fake_torch(mps=True, bf16=True)
                device, precision, dtype=module.runtime_config(torch, 'mps', mps_limit_mb=limit)
                self.assertEqual((device, precision), ('mps', 'fp32'))
                self.assertIs(dtype, torch.float32)
                torch.mps.set_per_process_memory_fraction.assert_called_once_with(expected_fraction)
                torch.cuda.is_bf16_supported.assert_not_called()
                torch.cuda.set_per_process_memory_fraction.assert_not_called()

    def test_cuda_memory_fraction_cannot_exceed_one(self):
        torch=fake_torch(cuda=True, cuda_memory=2*1024**3)
        module.runtime_config(torch, 'cuda', cuda_limit_mb=4096)
        torch.cuda.set_per_process_memory_fraction.assert_called_once_with(1, 0)

    def test_cpu_or_cuda_remain_usable_without_an_mps_backend(self):
        for cuda, expected in [(False,'cpu'), (True,'cuda')]:
            with self.subTest(cuda=cuda):
                torch=fake_torch(cuda=cuda);torch.backends=SimpleNamespace();del torch.mps
                self.assertEqual(module.runtime_config(torch,'auto')[0], expected)
                with self.assertRaises(ValueError):module.runtime_config(torch,'mps')

    def test_invalid_mps_memory_recommendation_cannot_disable_the_cap(self):
        for recommended in [0,-1]:
            with self.subTest(recommended=recommended):
                torch=fake_torch(mps=True,mps_memory=recommended)
                with self.assertRaises(ValueError):module.runtime_config(torch,'mps')
                torch.mps.set_per_process_memory_fraction.assert_not_called()

    def test_unknown_device_and_subset_are_rejected(self):
        with self.assertRaises(ValueError):module.runtime_config(fake_torch(),'metal')
        with self.assertRaises(ValueError):module.modality_config('images')

    def test_memory_health_only_queries_the_active_accelerator(self):
        for device in ['cpu','cuda','mps']:
            with self.subTest(device=device):
                torch=fake_torch()
                torch.cuda.memory_allocated=Mock(return_value=100)
                torch.cuda.max_memory_allocated=Mock(return_value=200)
                torch.mps.current_allocated_memory=Mock(return_value=300)
                torch.mps.driver_allocated_memory=Mock(return_value=400)
                encoder=module.GemmaEncoder.__new__(module.GemmaEncoder)
                encoder.torch=torch;encoder.device=device
                encoder.mps_limit_mb=4096 if device=='mps' else None
                with patch.dict(module.os.environ,{'PYTORCH_ENABLE_MPS_FALLBACK':'1'}):
                    health=encoder.memory_snapshot()
                self.assertEqual(health['cuda_allocated_bytes'],100 if device=='cuda' else 0)
                self.assertEqual(health['mps_allocated_bytes'],300 if device=='mps' else 0)
                self.assertEqual(health['mps_driver_allocated_bytes'],400 if device=='mps' else 0)
                self.assertEqual(health['mps_fallback_enabled'],device=='mps')
                self.assertEqual(torch.cuda.memory_allocated.call_count,int(device=='cuda'))
                self.assertEqual(torch.mps.current_allocated_memory.call_count,int(device=='mps'))
                self.assertEqual(torch.mps.recommended_max_memory.call_count,int(device=='mps'))

    def test_encoder_subset_disables_only_unneeded_towers(self):
        expected={
            'all': ({'text','image','video','audio'}, {}),
            'vision': ({'text','image','video'}, {'audio_config':None}),
            'audio': ({'text','audio'}, {'vision_config':None}),
            'text': ({'text'}, {'vision_config':None,'audio_config':None}),
        }
        for mode, (modalities, kwargs) in expected.items():
            with self.subTest(mode=mode):
                actual_modalities, actual_kwargs=module.modality_config(mode)
                self.assertEqual(set(actual_modalities), modalities)
                self.assertEqual(len(actual_modalities), len(modalities))
                self.assertEqual(actual_kwargs, kwargs)

    def test_disabled_media_is_rejected_before_any_file_access(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for item, modalities in [({'audio':'missing.wav'}, ['text','image','video']),
                                     ({'image':'missing.png'}, ['text']),
                                     ({'video':'missing.mp4'}, ['text','audio']),
                                     ({'image':'ok.png','audio':'missing.wav'}, ['text','image','video'])]:
                with self.subTest(item=item), patch.object(Path,'is_file',side_effect=AssertionError('must reject before file lookup')):
                    with self.assertRaises(ValueError):module.media_item(item,root,modalities)

    def test_enabled_subset_allows_text_and_image_with_placeholder(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder).resolve();(root/'ok.png').write_bytes(b'test')
            self.assertEqual(module.media_item({'text':'a portrait','image':'ok.png'},root,['text','image','video']),
                             {'text':'a portrait <|image|>','image':str(root/'ok.png')})
            self.assertEqual(module.media_item({'text':'a portrait <|image|>','image':'ok.png'},root,['text','image']),
                             {'text':'a portrait <|image|>','image':str(root/'ok.png')})

    def test_short_media_uses_bounded_ffprobe_without_a_shell(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder).resolve();path=root/'clip with spaces.mp4';path.write_bytes(b'test')
            for kind in ['video','audio']:
                with self.subTest(kind=kind), patch.object(module.subprocess,'run',
                        return_value=SimpleNamespace(stdout=json.dumps({'format':{'duration':'6'}}))) as run:
                    self.assertEqual(module.media_item({kind:path.name},root),{kind:str(path)})
                    argv=run.call_args.args[0]
                    self.assertIsInstance(argv,list)
                    self.assertEqual(Path(argv[0]).name,'ffprobe')
                    self.assertEqual(argv[argv.index('-protocol_whitelist')+1],'file,pipe')
                    self.assertNotIn('hls',argv[argv.index('-format_whitelist')+1].split(','))
                    self.assertNotIn('concat',argv[argv.index('-format_whitelist')+1].split(','))
                    self.assertEqual(argv[-1],str(path))
                    self.assertEqual(run.call_args.kwargs.get('capture_output'),True)
                    self.assertEqual(run.call_args.kwargs.get('text'),True)
                    self.assertEqual(run.call_args.kwargs.get('timeout'),10)
                    self.assertEqual(run.call_args.kwargs.get('check'),True)
                    self.assertFalse(run.call_args.kwargs.get('shell',False))

    def test_media_duration_limits_are_inclusive_and_do_not_allow_long_clips(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder).resolve();(root/'clip').write_bytes(b'test')
            for kind,maximum in [('video',8),('audio',60)]:
                for duration,allowed in [(maximum,True),(maximum+.01,False)]:
                    with self.subTest(kind=kind,duration=duration), patch.object(module.subprocess,'run',
                            return_value=SimpleNamespace(stdout=json.dumps({'format':{'duration':str(duration)}}))):
                        if allowed:self.assertEqual(module.media_item({kind:'clip'},root),{kind:str(root/'clip')})
                        else:
                            with self.assertRaises(ValueError):module.media_item({kind:'clip'},root)

    def test_invalid_unknown_or_nonfinite_durations_are_not_allowed(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder).resolve();(root/'clip').write_bytes(b'test')
            for duration in ['N/A','not-a-number','NaN','Infinity','-Infinity','0','-1',0,-1,None,'']:
                with self.subTest(duration=duration), patch.object(module.subprocess,'run',
                        return_value=SimpleNamespace(stdout=json.dumps({'format':{'duration':duration}}))):
                    with self.assertRaises(ValueError):module.media_item({'video':'clip'},root)
            for output in ['{}','{"format":{}}','{"format":null}','not json']:
                with self.subTest(output=output), patch.object(module.subprocess,'run',
                        return_value=SimpleNamespace(stdout=output)):
                    with self.assertRaises(ValueError):module.media_item({'video':'clip'},root)

    def test_missing_failed_or_timed_out_ffprobe_does_not_admit_media(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder).resolve();(root/'clip').write_bytes(b'test')
            for error in [FileNotFoundError('ffprobe'),subprocess.CalledProcessError(1,['ffprobe']),
                          subprocess.TimeoutExpired(['ffprobe'],10)]:
                with self.subTest(error=type(error).__name__), patch.object(module.subprocess,'run',side_effect=error):
                    with self.assertRaises(ValueError):module.media_item({'video':'clip'},root)

    def test_media_path_boundaries_are_checked_before_starting_ffprobe(self):
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder).resolve();root=base/'inbox';root.mkdir()
            (base/'secret.mp4').write_bytes(b'private');(root/'link.mp4').symlink_to(base/'secret.mp4')
            for value in ['../secret.mp4','link.mp4','missing.mp4','https://example.com/video.mp4']:
                with self.subTest(value=value), patch.object(module.subprocess,'run') as run:
                    with self.assertRaises(ValueError):module.media_item({'video':value},root)
                    run.assert_not_called()

    def test_vectors_reject_nonfinite_wrong_shape_and_nonunit(self):
        good=[1.0]+[0.0]*767
        self.assertEqual(module.validate_vectors([good],1),[good])
        for rows in [[[1.0]],[[float('nan')]+good[1:]],[[0.0]*768],[[True]+good[1:]]]:
            with self.assertRaises(ValueError):module.validate_vectors(rows,1)

    def test_media_paths_stay_inside_inbox_even_through_symlinks(self):
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder).resolve();root=base/'inbox';root.mkdir()
            (root/'ok.png').write_bytes(b'test');(base/'secret').write_bytes(b'private')
            (root/'link').symlink_to(base/'secret')
            self.assertEqual(module.media_item({'image':'ok.png'},root),{'image':str(root/'ok.png')})
            for value in ['../secret','link','https://example.com/image.png']:
                with self.assertRaises(ValueError):module.media_item({'image':value},root)

if __name__=='__main__':unittest.main()

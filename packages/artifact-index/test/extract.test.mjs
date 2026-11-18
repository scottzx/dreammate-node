import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctor, extractArtifact } from '../src/extract.mjs';
import { SUPPORTED_EXTENSIONS } from '../src/scan.mjs';

test('extractor doctor reports local dependencies without model imports', async () => {
  const output = await doctor();
  assert.equal(output.parser_version, 'artifact-local-v2');
  assert.equal(typeof output.capabilities.video, 'boolean');
  assert.equal(typeof output.modules.openpyxl, 'boolean');
  assert.equal(output.capabilities.docx, true);
  assert.equal(output.capabilities.text, true);
});

test('the scanner and the local parser agree on supported extensions', async () => {
  const output = await doctor();
  const published = Object.values(output.extensions).flat().map(extension => extension.toLowerCase());
  assert.deepEqual([...SUPPORTED_EXTENSIONS].sort(), published.sort());
});

test('extractor rejects remote URLs, relative caches, unsupported files and explicit file budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'artifact-extract-'));
  try {
    const source = join(directory, 'input.bin');
    await writeFile(source, 'Keep the original');
    await assert.rejects(extractArtifact('https://example.com/input.pdf'), /local file/);
    await assert.rejects(extractArtifact(source, { cacheDir: 'relative' }), /absolute/);
    await assert.rejects(extractArtifact(source, { maxFileBytes: 1 }), /file size budget/);
    await assert.rejects(extractArtifact(source, { cacheDir: join(directory, 'cache') }), /Unsupported artifact/);
    await assert.rejects(doctor({ python: join(directory, 'missing-python') }), /ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('markdown and plain text files become addressable blocks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'artifact-text-'));
  try {
    const source = join(directory, 'resume.md');
    await writeFile(source, '# 张三的简历\n\n姓名：张三\n\n## 工作经历\n\n2021-2025 某某科技公司 产品经理\n');
    const output = await extractArtifact(source, { cacheDir: join(directory, 'cache') });
    assert.equal(output.kind, 'text');
    assert.equal(output.units[0].locator.block, 1);
    assert.equal(output.units[0].text, '张三的简历');
    assert.ok(output.units.some(unit => unit.text.includes('某某科技公司')));
    assert.ok(output.units.every(unit => unit.representations.every(rep => rep.modality === 'text')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctor, extractArtifact } from '../src/extract.mjs';

test('extractor doctor reports local dependencies without model imports', async () => {
  const output = await doctor();
  assert.equal(output.parser_version, 'artifact-local-v1');
  assert.equal(typeof output.capabilities.video, 'boolean');
  assert.equal(typeof output.modules.openpyxl, 'boolean');
});

test('extractor rejects remote URLs, relative caches, unsupported files and explicit file budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'artifact-extract-'));
  try {
    const source = join(directory, 'input.txt');
    await writeFile(source, 'Keep the original');
    await assert.rejects(extractArtifact('https://example.com/input.pdf'), /local file/);
    await assert.rejects(extractArtifact(source, { cacheDir: 'relative' }), /absolute/);
    await assert.rejects(extractArtifact(source, { maxFileBytes: 1 }), /file size budget/);
    await assert.rejects(extractArtifact(source, { cacheDir: join(directory, 'cache') }), /Unsupported artifact/);
    await assert.rejects(doctor({ python: join(directory, 'missing-python') }), /ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

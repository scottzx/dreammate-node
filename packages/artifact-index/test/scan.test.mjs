import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectArtifacts } from '../src/scan.mjs';

async function tree(t) {
  const dir = await mkdtemp(join(tmpdir(), 'artifact-scan-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'notes'), { recursive: true });
  await mkdir(join(dir, '.hidden'), { recursive: true });
  await mkdir(join(dir, 'skipme'), { recursive: true });
  await writeFile(join(dir, 'resume.md'), '# 张三的简历\n');
  await writeFile(join(dir, 'notes', 'plan.txt'), '计划\n');
  await writeFile(join(dir, 'notes', 'deck.pptx'), 'pptx');
  await writeFile(join(dir, 'notes', 'photo.png'), 'png');
  await writeFile(join(dir, '.hidden', 'secret.md'), 'secret');
  await writeFile(join(dir, 'skipme', 'ignore.md'), 'ignore');
  await writeFile(join(dir, '.dotfile.md'), 'dot');
  return dir;
}

test('a directory walk collects supported formats and reports the rest', async t => {
  const dir = await tree(t);
  const result = await collectArtifacts([dir], {});
  const names = result.files.map(path => path.slice(dir.length + 1)).sort();
  assert.deepEqual(names, ['notes/deck.pptx', 'notes/plan.txt', 'resume.md', 'skipme/ignore.md']);
  assert.ok(result.skipped.some(item => item.reason === 'unsupported_extension' && item.path.endsWith('photo.png')));
  assert.ok(result.directories.length >= 2);
  assert.equal(result.truncated, false);
});

test('hidden entries and excluded paths stay out of the walk', async t => {
  const dir = await tree(t);
  const hidden = await collectArtifacts([dir], { includeHidden: true });
  assert.ok(hidden.files.some(path => path.endsWith('.dotfile.md')));
  assert.ok(hidden.files.some(path => path.includes('.hidden')));
  const excluded = await collectArtifacts([dir], { exclude: ['skipme', '*.txt'] });
  const names = excluded.files.map(path => path.slice(dir.length + 1)).sort();
  assert.deepEqual(names, ['notes/deck.pptx', 'resume.md']);
});

test('an explicit file is always attempted even when its format is unsupported', async t => {
  const dir = await tree(t);
  const result = await collectArtifacts([join(dir, 'notes', 'photo.png')], {});
  assert.equal(result.files.length, 1);
  assert.ok(result.files[0].endsWith('photo.png'));
});

test('a missing explicit source is reported instead of disappearing', async t => {
  const dir = await tree(t);
  const result = await collectArtifacts([join(dir, 'gone.pdf')], {});
  assert.equal(result.files.length, 1);
  assert.ok(result.files[0].endsWith('gone.pdf'));
});

test('the walk stops at the file budget and says so', async t => {
  const dir = await tree(t);
  const result = await collectArtifacts([dir], { fileLimit: 1 });
  assert.equal(result.files.length, 1);
  assert.equal(result.truncated, true);
});

test('excludeKeywords drops matching paths case-insensitively', async t => {
  const dir = await tree(t);
  // Add code-ecosystem style noise.
  await mkdir(join(dir, 'vendor_lib', 'CHANGELOG.d'), { recursive: true });
  await writeFile(join(dir, 'vendor_lib', 'CHANGELOG.md'), 'changelog');
  await writeFile(join(dir, 'vendor_lib', 'SKILL.md'), 'skill');
  await writeFile(join(dir, 'vendor_lib', 'notes.md'), 'keep me');
  const result = await collectArtifacts([dir], { excludeKeywords: ['changelog', 'skill.md'] });
  const names = result.files.map(path => path.slice(dir.length + 1)).sort();
  assert.ok(names.includes('vendor_lib/notes.md'), 'unrelated file must be kept');
  assert.ok(!names.some(n => n.toLowerCase().includes('changelog')));
  assert.ok(!names.some(n => n.toLowerCase().includes('skill.md')));
});

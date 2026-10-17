import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SkillSourceError, SkillSourceManager } from '../src/index.js';

function fixture(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-sources-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function skill(dir: string, name = path.basename(dir), description = 'Use this skill for a task'): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nPrivate source instructions for ${name}.\n`);
}

function status(expected: number): (error: unknown) => boolean {
  return error => error instanceof SkillSourceError && error.status === expected;
}

test('project sources discover only conventional roots, deduplicate aliases, and expose summaries without paths or bodies', async t => {
  const dir = fixture(t);
  skill(path.join(dir, '.agents/skills/alpha'));
  skill(path.join(dir, 'skills/beta'));
  skill(path.join(dir, 'unrelated/hidden'));
  skill(path.join(dir, 'node_modules/ignored'));
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.symlinkSync('../.agents/skills', path.join(dir, '.claude/skills'));
  const manager = new SkillSourceManager({ storagePath: false });
  const added = await manager.add({ name: 'project', project: dir });
  assert.equal(added.id, 'skills-project');
  assert.equal(added.type, 'project');
  assert.equal(added.status, 'ready');
  assert.equal(added.skill_count, 2);
  const catalog = await manager.catalog();
  assert.deepEqual(catalog.skills.map(item => item.name).sort(), ['alpha', 'beta']);
  assert.deepEqual(catalog.diagnostics, []);
  assert.doesNotMatch(JSON.stringify(catalog), /Private source instructions/);
  assert.ok(!JSON.stringify(catalog).includes(dir));
  assert.deepEqual((await manager.list()).map(item => item.skill_count), [2]);
});

test('single directories and nested skill roots have stable IDs even with duplicate names', async t => {
  const dir = fixture(t);
  skill(path.join(dir, 'first'), 'same');
  skill(path.join(dir, 'group/second'), 'same');
  const manager = new SkillSourceManager({ storagePath: false });
  await manager.add({ name: 'root', dir });
  await manager.add({ name: 'single', dir: path.join(dir, 'first') });
  const first = await manager.catalog();
  assert.equal(first.skills.length, 3);
  assert.equal(new Set(first.skills.map(item => item.id)).size, 3);
  assert.deepEqual((await manager.refresh()).skills, first.skills);
  for (const item of first.skills) assert.match((await manager.read(item.id, item.revision)).content, /Private source instructions/);
});

test('metadata parsing supports folded, literal, quoted and plain multiline fields without reading nested metadata as top-level fields', async t => {
  const dir = fixture(t);
  skill(dir);
  fs.writeFileSync(path.join(dir, 'SKILL.remote.md'), `---
name: 'remote''s skill'
description: >-
  Find the best
  matching resources.
compatibility: |
  Requires node.
  Runs on macOS.
metadata:
  name: nested-name
  description: nested-description
---
Remote instructions.
`);
  const manager = new SkillSourceManager({ storagePath: false });
  await manager.add({ name: 'remote', dir });
  const item = (await manager.catalog()).skills[0]!;
  assert.equal(item.name, "remote's skill");
  assert.equal(item.description, 'Find the best matching resources.');
  assert.equal(item.compatibility, 'Requires node.\nRuns on macOS.');
  const read = await manager.read(item.id, item.revision);
  assert.equal(read.resource, 'SKILL.remote.md');
  assert.match(read.content, /Remote instructions/);
  fs.writeFileSync(path.join(dir, 'SKILL.remote.md'), '---\nname: "quoted"\ndescription: ordinary first line\n  with a continuation\nmetadata:\n  description: ignored\n---\nbody');
  const changed = (await manager.catalog()).skills[0]!;
  assert.equal(changed.name, 'quoted');
  assert.equal(changed.description, 'ordinary first line with a continuation');
  fs.writeFileSync(path.join(dir, 'SKILL.remote.md'), '---\nname: "quoted"\ndescription: "A # character inside a quote" # trailing comment\n---\nbody');
  assert.equal((await manager.catalog()).skills[0]!.description, 'A # character inside a quote');
});

test('invalid metadata is diagnosed per package while valid sibling skills remain discoverable', async t => {
  const dir = fixture(t);
  skill(path.join(dir, 'valid'));
  skill(path.join(dir, 'missing'));
  fs.writeFileSync(path.join(dir, 'missing/SKILL.md'), '---\nname: missing\nmetadata:\n  description: nested value is not the description\n---\nbody');
  skill(path.join(dir, 'long-description'), 'long-description', 'd'.repeat(4097));
  skill(path.join(dir, 'long-name'), 'n'.repeat(129));
  skill(path.join(dir, 'long-compatibility'));
  fs.writeFileSync(path.join(dir, 'long-compatibility/SKILL.md'), `---\nname: compatibility\ndescription: Valid description\ncompatibility: ${'c'.repeat(1025)}\n---\nbody`);
  const manager = new SkillSourceManager({ storagePath: false });
  await manager.add({ name: 'metadata', dir });
  const catalog = await manager.catalog();
  assert.deepEqual(catalog.skills.map(item => item.name), ['valid']);
  assert.equal(catalog.diagnostics.length, 1);
  assert.match(catalog.diagnostics[0]!.error, /description.*name.*compatibility|compatibility.*description.*name/);
});

test('catalog and refresh observe additions, edits and deletions; revision covers every published resource', async t => {
  const dir = fixture(t);
  skill(path.join(dir, 'one'));
  const manager = new SkillSourceManager({ storagePath: false });
  await manager.add({ name: 'fresh', dir });
  const original = (await manager.catalog()).skills[0]!;
  fs.mkdirSync(path.join(dir, 'one/references'));
  fs.writeFileSync(path.join(dir, 'one/references/detail.md'), 'reference one');
  const withReference = (await manager.refresh('skills-fresh')).skills[0]!;
  assert.equal(withReference.id, original.id);
  assert.notEqual(withReference.revision, original.revision);
  await assert.rejects(manager.read(original.id, original.revision), status(409));
  fs.writeFileSync(path.join(dir, 'one/references/detail.md'), 'reference two');
  const changed = (await manager.catalog()).skills[0]!;
  assert.notEqual(changed.revision, withReference.revision);
  fs.unlinkSync(path.join(dir, 'one/references/detail.md'));
  assert.equal((await manager.catalog()).skills[0]!.revision, original.revision);
  skill(path.join(dir, 'two'));
  assert.equal((await manager.refresh()).skills.length, 2);
  fs.rmSync(path.join(dir, 'one'), { recursive: true });
  assert.deepEqual((await manager.catalog()).skills.map(item => item.name), ['two']);
  await assert.rejects(manager.read(original.id, original.revision), status(404));
});

test('a resource changed and restored between the initial package hash and its read is rejected', async t => {
  const dir = fixture(t);
  skill(dir);
  const entry = path.join(dir, 'SKILL.md');
  const originalContent = fs.readFileSync(entry);
  const manager = new SkillSourceManager({ storagePath: false });
  await manager.add({ name: 'race', dir });
  const item = (await manager.catalog()).skills[0]!;
  const originalRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = ((file: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
    reads++;
    if (reads !== 2) return originalRead(file, options);
    fs.writeFileSync(entry, 'Different content during the requested resource read.');
    try { return originalRead(file, options); }
    finally { fs.writeFileSync(entry, originalContent); }
  }) as typeof fs.readFileSync;
  try { await assert.rejects(manager.read(item.id, item.revision), status(409)); }
  finally { fs.readFileSync = originalRead; }
  assert.equal((await manager.catalog()).skills[0]!.revision, item.revision);
});

test('reads text and binary on demand with a resource manifest, never runs a script', async t => {
  const dir = fixture(t);
  skill(dir);
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'scripts/danger.sh'), 'touch EXECUTED');
  const binary = Buffer.from([0, 255, 0, 1, 2, 128]);
  fs.writeFileSync(path.join(dir, 'assets/image.png'), binary);
  fs.writeFileSync(path.join(dir, 'assets/z.txt'), 'ASCII path');
  fs.writeFileSync(path.join(dir, 'assets/é.txt'), 'Unicode path');
  const manager = new SkillSourceManager({ storagePath: false });
  await manager.add({ name: 'resources', dir });
  const item = (await manager.catalog()).skills[0]!;
  const script = await manager.read(item.id, item.revision, 'scripts/danger.sh');
  assert.equal(script.encoding, 'utf8');
  assert.equal(script.content, 'touch EXECUTED');
  const image = await manager.read(item.id, item.revision, 'assets/image.png');
  assert.equal(image.encoding, 'base64');
  assert.deepEqual(Buffer.from(image.content, 'base64'), binary);
  assert.deepEqual(image.resources.map(item => item.path), ['SKILL.md', 'assets/image.png', 'assets/z.txt', 'assets/é.txt', 'scripts/danger.sh']);
  assert.ok(!fs.existsSync(path.join(dir, 'EXECUTED')));
  await assert.rejects(manager.read(item.id, ''), status(400));
  await assert.rejects(manager.read(item.id, item.revision, 'missing.txt'), status(404));
});

test('resource access rejects traversal, credentials, hidden files and symlinks including project directory escapes', async t => {
  const dir = fixture(t);
  const packageDir = path.join(dir, 'package');
  skill(packageDir);
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'outside secret');
  fs.writeFileSync(path.join(packageDir, '.env'), 'hidden secret');
  fs.writeFileSync(path.join(packageDir, 'credentials.json'), 'credential secret');
  fs.writeFileSync(path.join(packageDir, 'private.key'), 'key secret');
  fs.symlinkSync('../outside.txt', path.join(packageDir, 'escaped.txt'));
  fs.symlinkSync('SKILL.md', path.join(packageDir, 'internal-link.md'));
  const manager = new SkillSourceManager({ storagePath: false });
  await manager.add({ name: 'bounds', dir: packageDir });
  const item = (await manager.catalog()).skills[0]!;
  for (const resource of ['../outside.txt', '/etc/passwd', 'a/../../outside.txt', '.env', 'credentials.json', 'private.key', 'a\\b', 'C:/file', './SKILL.md']) {
    await assert.rejects(manager.read(item.id, item.revision, resource), status(400));
  }
  await assert.rejects(manager.read(item.id, item.revision, 'escaped.txt'), status(404));
  await assert.rejects(manager.read(item.id, item.revision, 'internal-link.md'), status(404));
  const read = await manager.read(item.id, item.revision);
  assert.deepEqual(read.resources.map(item => item.path), ['SKILL.md']);
  fs.writeFileSync(path.join(packageDir, '.env'), 'changed hidden secret');
  assert.equal((await manager.catalog()).skills[0]!.revision, item.revision);
  const project = path.join(dir, 'project');
  fs.mkdirSync(project);
  fs.symlinkSync(packageDir, path.join(project, 'skills'));
  await manager.add({ name: 'escaping-project', project });
  const catalog = await manager.catalog();
  assert.equal(catalog.skills.length, 1);
  assert.match(catalog.diagnostics[0]!.error, /leaves its project/);
  assert.ok(!JSON.stringify(catalog).includes(dir));
});

test('source configuration alone persists with owner-only permissions and restarts without a content cache', async t => {
  const dir = fixture(t);
  const sourceDir = path.join(dir, 'source');
  const storagePath = path.join(dir, 'config/skill-sources.json');
  skill(sourceDir, 'private-name', 'private-description');
  const manager = new SkillSourceManager({ storagePath });
  await manager.add({ name: 'persistent', dir: sourceDir });
  const item = (await manager.catalog()).skills[0]!;
  await manager.read(item.id, item.revision);
  const saved = fs.readFileSync(storagePath, 'utf8');
  assert.match(saved, /persistent/);
  assert.doesNotMatch(saved, /private-name|private-description|instructions|revision|content/);
  assert.equal(fs.statSync(storagePath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(storagePath)), ['skill-sources.json']);
  const restored = new SkillSourceManager({ storagePath });
  assert.deepEqual((await restored.catalog()).skills, (await manager.catalog()).skills);
  await restored.remove('skills-persistent');
  assert.deepEqual(await new SkillSourceManager({ storagePath }).list(), []);
});

test('damaged configuration is diagnosed and protected from mutations', async t => {
  const dir = fixture(t);
  const storagePath = path.join(dir, 'skill-sources.json');
  fs.writeFileSync(storagePath, '{damaged');
  const manager = new SkillSourceManager({ storagePath });
  const catalog = await manager.catalog();
  assert.deepEqual(catalog.skills, []);
  assert.match(catalog.diagnostics[0]!.error, /configuration could not be read/);
  await assert.rejects(manager.list(), status(500));
  await assert.rejects(manager.read('unknown', 'revision'), status(500));
  await assert.rejects(manager.add({ name: 'new', dir }), status(500));
  await assert.rejects(manager.remove('skills-new'), status(500));
  assert.equal(fs.readFileSync(storagePath, 'utf8'), '{damaged');
  fs.writeFileSync(storagePath, JSON.stringify({ version: 1, sources: [{ name: 'valid', dir }, { name: '../invalid', dir }] }));
  const partiallyInvalid = new SkillSourceManager({ storagePath });
  assert.deepEqual((await partiallyInvalid.catalog()).skills, []);
  await assert.rejects(partiallyInvalid.add({ name: 'overwrite', dir }), status(500));
});

test('unavailable and oversized packages report safe diagnostics while healthy sources remain available', async t => {
  const dir = fixture(t);
  skill(path.join(dir, 'healthy'));
  skill(path.join(dir, 'large'));
  const large = fs.openSync(path.join(dir, 'large/large.bin'), 'w');
  fs.ftruncateSync(large, 8 * 1024 * 1024 + 1);
  fs.closeSync(large);
  const manager = new SkillSourceManager({ storagePath: false });
  await manager.add({ name: 'healthy', dir: path.join(dir, 'healthy') });
  await manager.add({ name: 'large', dir: path.join(dir, 'large') });
  await manager.add({ name: 'missing', dir: path.join(dir, 'missing') });
  const catalog = await manager.catalog();
  assert.equal(catalog.skills.length, 1);
  assert.equal(catalog.diagnostics.length, 2);
  assert.ok(catalog.diagnostics.some(item => /size limit/.test(item.error)));
  assert.ok(!JSON.stringify(catalog).includes(dir));
  assert.equal((await manager.list()).filter(item => item.status === 'error').length, 2);
});

test('validates source inputs, rejects duplicate names and reports unknown IDs', async t => {
  const dir = fixture(t);
  const manager = new SkillSourceManager({ storagePath: false });
  for (const input of [null, {}, { name: '../bad', dir }, { name: 'a', dir, project: dir }, { name: 'a' }, { name: 'a', dir: 3 }, { name: 'a', dir, unexpected: true }]) {
    await assert.rejects(manager.add(input), status(400));
  }
  await manager.add({ name: 'valid', dir });
  await assert.rejects(manager.add({ name: 'valid', dir }), status(409));
  await assert.rejects(manager.remove('unknown'), status(404));
  await assert.rejects(manager.refresh('unknown'), status(404));
  await assert.rejects(manager.read('unknown', 'revision'), status(404));
  await manager.remove('skills-valid');
  assert.deepEqual(await manager.list(), []);
});

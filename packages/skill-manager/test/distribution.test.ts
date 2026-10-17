import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  archiveSkill,
  installSkillPackage,
  listSkillArchive,
  loadSkillsFromDir,
  parseSkillMarkdown,
} from '../src/index.js';

function fixture(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-distribution-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function archive(options: Parameters<typeof archiveSkill>[0]): Promise<Buffer> {
  const result = archiveSkill(options);
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  } finally {
    result.cleanup();
  }
}

test('legacy Markdown parsing preserves plain bodies, quoted fields and CRLF frontmatter', () => {
  assert.deepEqual(parseSkillMarkdown('  # A plain guide\n '), { data: {}, sop: '# A plain guide' });
  assert.deepEqual(parseSkillMarkdown([
    '---',
    '# a comment',
    'name: "archive-guide"',
    "description: 'Read and install guides'",
    'compatibility: node:22',
    '---',
    '',
    '# Guide',
    '',
  ].join('\r\n')), {
    data: { name: 'archive-guide', description: 'Read and install guides', compatibility: 'node:22' },
    sop: '# Guide',
  });
});

test('legacy directory loading supports direct packages and remote guide precedence', t => {
  const root = fixture(t);
  const alpha = path.join(root, 'alpha');
  const beta = path.join(root, 'beta');
  fs.mkdirSync(alpha);
  fs.mkdirSync(beta);
  fs.writeFileSync(path.join(alpha, 'SKILL.md'), '---\nname: local\n---\nLocal SOP');
  fs.writeFileSync(path.join(alpha, 'SKILL.remote.md'), '---\nname: remote\ndescription: Remote guide\n---\nRemote SOP');
  fs.writeFileSync(path.join(beta, 'skill.md'), '# Fallback-name SOP');
  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'not a directory');

  const skills = loadSkillsFromDir(root);
  assert.deepEqual(Object.keys(skills).sort(), ['beta', 'remote']);
  assert.deepEqual(skills.remote, {
    name: 'remote', description: 'Remote guide', sop: 'Remote SOP', source_dir: alpha,
  });
  assert.equal(skills.beta?.name, 'beta');
  assert.equal(skills.beta?.description, '');
  assert.deepEqual(loadSkillsFromDir(alpha), { remote: skills.remote });
  assert.deepEqual(loadSkillsFromDir(path.join(root, 'missing')), {});
  assert.deepEqual(loadSkillsFromDir(path.join(root, 'unrelated.txt')), {});
});

test('source archives retain nested scripts and binary assets when installed', async t => {
  const root = fixture(t);
  const source = path.join(root, 'source', 'sample');
  fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(source, 'assets'));
  const guide = '---\nname: sample\ndescription: A packaged skill\n---\n# Instructions\n';
  const binary = Buffer.from([0, 255, 128, 10, 13]);
  fs.writeFileSync(path.join(source, 'SKILL.md'), guide);
  fs.writeFileSync(path.join(source, 'scripts', 'run.mjs'), 'console.log("hello");\n');
  fs.writeFileSync(path.join(source, 'assets', 'data.bin'), binary);

  const skill = loadSkillsFromDir(source).sample!;
  const buffer = await archive({ skill, skillName: 'sample' });
  const files = await listSkillArchive(buffer);
  assert.ok(files.includes('sample/SKILL.md'));
  assert.ok(files.includes('sample/scripts/run.mjs'));
  assert.ok(files.includes('sample/assets/data.bin'));
  const installed = await installSkillPackage(buffer, path.join(root, 'installed'), 'sample');
  assert.equal(installed, path.join(root, 'installed', 'sample'));
  assert.equal(fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8'), guide);
  assert.deepEqual(fs.readFileSync(path.join(installed, 'assets', 'data.bin')), binary);
});

test('SOP-only skills produce an installable standard guide without a source directory', async t => {
  const root = fixture(t);
  const buffer = await archive({
    skillName: 'portable',
    skill: { name: 'portable', description: 'A portable guide', sop: '# Follow these steps\n\nUse the tool.' },
  });
  assert.ok((await listSkillArchive(buffer)).includes('portable/SKILL.md'));
  const installed = await installSkillPackage(buffer, root, 'portable');
  const result = loadSkillsFromDir(installed).portable!;
  assert.equal(result.description, 'A portable guide');
  assert.equal(result.sop, '# Follow these steps\n\nUse the tool.');
});

test('invalid archives report listing and extraction failures', async t => {
  const root = fixture(t);
  const invalid = Buffer.from('not a gzip archive');
  await assert.rejects(listSkillArchive(invalid), /tar listing failed/);
  await assert.rejects(installSkillPackage(invalid, root, 'invalid'), /tar extraction failed/);
});

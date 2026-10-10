import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { detectProfile, installSkill, skillRoots } from '../scripts/install-skills.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(packageRoot, 'scripts/install-skills.mjs');
const sourceSkill = profile => fs.readFileSync(path.join(packageRoot, 'skills', profile, 'dreammate-node/SKILL.md'), 'utf8');

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dreammate-skills-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  return dir;
}

function run(home, args = [], overrides = {}) {
  return execFileSync(process.execPath, [script, ...args], {
    env: { ...process.env, HOME: home, CODEX_HOME: '', DREAMMATE_SKILLS_DIR: '',
      DREAMMATE_SKILL_PROFILE: '', DREAMMATE_SKIP_SKILLS: '', ...overrides },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  });
}

test('detects iSH by kernel release or proc marker, never by Linux or Alpine alone', () => {
  const none = () => false;
  assert.equal(detectProfile({ platform: 'linux', release: '4.20.69-ish', exists: none }), 'ish');
  assert.equal(detectProfile({ platform: 'linux', release: 'custom', exists: p => p === '/proc/ish' }), 'ish');
  for (const release of ['6.6.1-0-lts', '6.1-alpine', '6.1-fish', '6.1-wishlist']) {
    assert.equal(detectProfile({ platform: 'linux', release, exists: none }), 'terminal');
  }
  assert.equal(detectProfile({ platform: 'darwin', release: '25.0.0', exists: none }), 'terminal');
  assert.equal(detectProfile({ platform: 'win32', release: '10.0', exists: none }), 'terminal');
});

test('default roots include canonical directory and only existing agent skill roots', t => {
  const home = temporary(t);
  const primary = path.join(home, '.agents/skills');
  assert.deepEqual(skillRoots({ home, env: {} }), [primary]);
  const claude = path.join(home, '.claude/skills');
  const codex = path.join(home, 'custom-codex/skills');
  const gemini = path.join(home, '.gemini/skills');
  for (const root of [claude, codex, gemini]) fs.mkdirSync(root, { recursive: true });
  assert.deepEqual(skillRoots({ home, env: { CODEX_HOME: path.dirname(codex) } }), [primary, claude, codex, gemini]);
  assert.deepEqual(skillRoots({ home, env: {}, dir: '~/only-skills' }), [path.join(home, 'only-skills')]);
  assert.throws(() => skillRoots({ home, env: {}, dir: 'relative' }), /绝对路径/);
});

test('fresh install, repeat install and profile switch keep exactly one active skill', t => {
  const root = temporary(t);
  const file = installSkill(root, 'ish');
  assert.equal(fs.readFileSync(file, 'utf8'), sourceSkill('ish'));
  installSkill(root, 'ish');
  installSkill(root, 'terminal');
  assert.equal(fs.readFileSync(file, 'utf8'), sourceSkill('terminal'));
  assert.deepEqual(fs.readdirSync(root), ['dreammate-node']);
  const marker = JSON.parse(fs.readFileSync(path.join(root, 'dreammate-node/.dreammate-node-install.json'), 'utf8'));
  assert.equal(marker.profile, 'terminal');
  assert.equal(marker.owner, '@1agents/dreammate-node');
});

test('preserves user modifications and unmanaged skills on upgrade', t => {
  const root = temporary(t);
  const file = installSkill(root, 'ish');
  fs.appendFileSync(file, '\n用户补充\n');
  assert.throws(() => installSkill(root, 'terminal'), /修改过/);
  assert.match(fs.readFileSync(file, 'utf8'), /用户补充/);
  fs.unlinkSync(path.join(root, 'dreammate-node/.dreammate-node-install.json'));
  assert.throws(() => installSkill(root, 'terminal'), /用户自建/);
});

test('does not follow skill directory or SKILL.md symlinks', t => {
  const root = temporary(t);
  const target = path.join(root, 'user-data');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'SKILL.md'), 'user skill');
  fs.symlinkSync(target, path.join(root, 'dreammate-node'));
  assert.throws(() => installSkill(root, 'ish'), /非普通目录/);
  fs.unlinkSync(path.join(root, 'dreammate-node'));
  fs.mkdirSync(path.join(root, 'dreammate-node'));
  fs.symlinkSync(path.join(target, 'SKILL.md'), path.join(root, 'dreammate-node/SKILL.md'));
  assert.throws(() => installSkill(root, 'ish'), /非普通文件/);
  assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), 'user skill');
});

test('postinstall uses built-in modules, explicit profiles, and no other home state', t => {
  const home = temporary(t);
  run(home, ['--postinstall'], { DREAMMATE_SKILL_PROFILE: 'ish' });
  const file = path.join(home, '.agents/skills/dreammate-node/SKILL.md');
  assert.equal(fs.readFileSync(file, 'utf8'), sourceSkill('ish'));
  run(home, ['--postinstall', '--profile', 'terminal'], { DREAMMATE_SKILL_PROFILE: 'ish' });
  assert.equal(fs.readFileSync(file, 'utf8'), sourceSkill('terminal'));
  assert.deepEqual(fs.readdirSync(home), ['.agents']);
});

test('automatic detection selects the current environment without an override', t => {
  const home = temporary(t);
  // Empty values are absent configuration for a shell that unsets overrides.
  run(home, ['--postinstall']);
  assert.equal(fs.readFileSync(path.join(home, '.agents/skills/dreammate-node/SKILL.md'), 'utf8'), sourceSkill(detectProfile()));
});

test('skip affects only postinstall, manual installation supports custom targets', t => {
  const home = temporary(t);
  run(home, ['--postinstall'], { DREAMMATE_SKIP_SKILLS: '1' });
  assert.deepEqual(fs.readdirSync(home), []);
  run(home, ['--profile', 'ish', '--dir', path.join(home, 'manual')], {
    DREAMMATE_SKIP_SKILLS: '1', DREAMMATE_SKILLS_DIR: path.join(home, 'ignored'),
  });
  assert.equal(fs.readFileSync(path.join(home, 'manual/dreammate-node/SKILL.md'), 'utf8'), sourceSkill('ish'));
  assert.deepEqual(fs.readdirSync(home), ['manual']);
});

test('read-only or conflicting destinations do not fail npm; manual install reports failure', t => {
  const home = temporary(t);
  const blocker = path.join(home, 'blocked');
  fs.writeFileSync(blocker, 'not a directory');
  const args = ['--profile', 'terminal', '--dir', blocker];
  run(home, ['--postinstall', ...args]);
  assert.throws(() => run(home, args), e => e.status === 1 && /安装未完成/.test(e.stderr));
  run(home, ['--postinstall', '--profile', 'unknown']);
  assert.throws(() => run(home, ['--profile', 'unknown']), e => e.status === 1);
  assert.equal(fs.readFileSync(blocker, 'utf8'), 'not a directory');
});

test('npm manifest ships both skill variants and a postinstall independent of dist', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.postinstall, 'node scripts/install-skills.mjs --postinstall');
  assert.ok(pkg.files.includes('scripts/install-skills.mjs'));
  for (const profile of ['ish', 'terminal']) {
    assert.ok(pkg.files.includes(`skills/${profile}/dreammate-node/SKILL.md`));
    assert.match(sourceSkill(profile), /^---\nname: dreammate-node\n/);
    assert.match(sourceSkill(profile), new RegExp(`profile: ${profile}`));
  }
});

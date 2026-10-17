import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { discoverSkillDirectories, PROJECT_SKILL_ROOTS } from '../src/discovery.js';

async function temporary(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-discovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function mkdir(directory: string): Promise<string> {
  await fs.mkdir(directory, { recursive: true });
  return fs.realpath(directory);
}

async function skill(directory: string): Promise<string> {
  const real = await mkdir(directory);
  await fs.writeFile(path.join(directory, 'SKILL.md'), '---\nname: fixture\ndescription: A fixture skill\n---\nWorkflow.\n');
  return real;
}

async function fakeCommand(directory: string, body: string): Promise<string> {
  const command = path.join(directory, 'fake 1session;touch injected');
  await fs.writeFile(command, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return command;
}

const pagedProvider = `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(args) + '\\n');
const page = Number(args[args.indexOf('--page') + 1]);
const pages = JSON.parse(process.env.FIXTURE_PAGES);
process.stdout.write(JSON.stringify(pages[page - 1]));
`;

async function recordedCalls(log: string): Promise<string[][]> {
  return (await fs.readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]);
}

async function waitForFile(file: string): Promise<void> {
  for (let attempts = 0; attempts < 200; attempts++) {
    if (await fs.stat(file).then(() => true, () => false)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Fixture process did not start');
}

async function assertProcessStopped(pid: number): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts++) {
    try { process.kill(pid, 0); }
    catch { return; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Fixture process ${pid} survived cancellation`);
}

test('skill discovery: existing shared roots honor each agent environment and deduplicate physical directories', async t => {
  const home = await temporary(t);
  const shared = await mkdir(path.join(home, '.agents', 'skills'));
  const claude = await mkdir(path.join(home, 'custom-claude', 'skills'));
  const codex = await mkdir(path.join(home, 'custom-codex', 'skills'));
  const gemini = await mkdir(path.join(home, 'gemini-home', '.gemini', 'skills'));
  const antigravity = await mkdir(path.join(home, '.gemini', 'config', 'skills'));
  const legacyAntigravity = await mkdir(path.join(home, '.gemini', 'antigravity', 'skills'));
  const grok = await mkdir(path.join(home, 'custom-grok', 'skills'));
  const dsh = await mkdir(path.join(home, 'custom-dsh', 'skills'));
  const switched = await mkdir(path.join(home, '.cc-switch', 'skills'));
  const ownedShared = await mkdir(path.join(home, '.1agents', 'skill-manager', 'shared'));
  const system = await mkdir(path.join(home, 'ProgramData', '1agents', 'skills'));
  const managedClaude = await mkdir(path.join(home, 'ProgramFiles', 'ClaudeCode', '.claude', 'skills'));
  const bundled = await mkdir(path.join(home, 'bundled-skills'));
  const oldCodex = await mkdir(path.join(home, '.codex', 'skills'));
  const result = await discoverSkillDirectories({
    home, platform: 'win32', projects: false,
    env: {
      CLAUDE_CONFIG_DIR: path.dirname(claude), CODEX_HOME: path.dirname(codex), GEMINI_CLI_HOME: path.join(home, 'gemini-home'),
      GROK_HOME: path.dirname(grok), DSH_HOME: path.dirname(dsh), DSH_AGENTS_HOME: path.join(home, '.agents'),
      PROGRAMDATA: path.join(home, 'ProgramData'), ProgramFiles: path.join(home, 'ProgramFiles'), DSH_BUNDLED_SKILL_DIR: bundled,
    },
  });
  assert.equal(result.project_status, 'skipped');
  assert.equal(result.workspace_count, 0);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(new Set(result.directories.map(item => item.dir)), new Set([
    shared, claude, codex, gemini, antigravity, legacyAntigravity, grok, dsh, switched, ownedShared, system, managedClaude, bundled,
  ]));
  assert.equal(result.directories.some(item => item.dir === oldCodex), false, 'CODEX_HOME replaces the default home');
  assert.equal(result.directories.filter(item => item.dir === shared).length, 1);
  assert.equal(result.directories.find(item => item.dir === system)?.scope, 'system');
  assert.ok(result.directories.every(item => item.origin === 'shared'));
  assert.equal(await fs.stat(path.join(home, '.claude')).then(() => true, () => false), false, 'discovery must not create missing roots');
});

test('skill discovery: whitespace environment overrides use defaults and linked packages are resolved without following package resources', async t => {
  const home = await temporary(t);
  const shared = await mkdir(path.join(home, '.agents', 'skills'));
  const claude = await mkdir(path.join(home, '.claude', 'skills'));
  const realPackage = await skill(path.join(home, 'package-store', 'real-skill'));
  const nestedPackage = await skill(path.join(home, 'package-store', 'nested-skill'));
  const internalPackage = await skill(path.join(home, 'package-store', 'do-not-publish-resource'));
  await fs.symlink(realPackage, path.join(shared, 'linked-skill'), 'dir');
  await fs.symlink(realPackage, path.join(claude, 'same-skill'), 'dir');
  await mkdir(path.join(shared, 'vendor'));
  await fs.symlink(nestedPackage, path.join(shared, 'vendor', 'linked-skill'), 'dir');
  await fs.symlink(internalPackage, path.join(realPackage, 'resource-link'), 'dir');
  const result = await discoverSkillDirectories({ home, env: { CLAUDE_CONFIG_DIR: '   ', CODEX_HOME: '' }, platform: 'win32', projects: false });
  assert.ok(result.directories.some(item => item.dir === claude));
  assert.equal(result.directories.filter(item => item.dir === realPackage).length, 1);
  assert.equal(result.directories.filter(item => item.dir === nestedPackage).length, 1);
  assert.equal(result.directories.some(item => item.dir === internalPackage), false);
  assert.equal(new Set(result.directories.map(item => item.dir)).size, result.directories.length);
});

test('skill discovery: all project pages preserve historical workspaces and recover each clone or worktree repository root', { timeout: 20000 }, async t => {
  const home = await temporary(t);
  const first = await mkdir(path.join(home, 'first-clone'));
  const second = await mkdir(path.join(home, 'second-clone'));
  const worktree = await mkdir(path.join(home, 'worktree'));
  await mkdir(path.join(first, '.git'));
  await mkdir(path.join(second, '.git'));
  await fs.writeFile(path.join(worktree, '.git'), 'gitdir: ../first-clone/.git/worktrees/fixture\n');
  const firstSrc = await mkdir(path.join(first, 'src'));
  const secondSrc = await mkdir(path.join(second, 'src', 'viewer'));
  const worktreeSrc = await mkdir(path.join(worktree, 'src'));
  const direct = await mkdir(path.join(home, 'non-git-project'));
  const expected = [
    await mkdir(path.join(first, '.agents', 'skills')),
    await mkdir(path.join(second, '.claude', 'skills')),
    await mkdir(path.join(worktree, '.grok', 'skills')),
    await mkdir(path.join(secondSrc, '.gemini', 'skills')),
    await mkdir(path.join(direct, '.agent', 'skills')),
  ];
  const log = path.join(home, 'provider-calls.jsonl');
  const command = await fakeCommand(home, pagedProvider);
  const pages = [
    { page: 1, limit: 1000, total: 2, projects: [{ workspace: first, workspaces: [firstSrc, secondSrc] }], hasMore: true, nextPage: 2 },
    { page: 2, limit: 1000, total: 2, projects: [{ workspace: direct, workspaces: [worktreeSrc, direct, firstSrc, path.join(home, 'deleted-project'), 'relative-project', 'ssh://host/remote'] }], hasMore: false },
  ];
  const result = await discoverSkillDirectories({ home, env: { FIXTURE_LOG: log, FIXTURE_PAGES: JSON.stringify(pages) }, platform: 'win32', sessionCommand: command });
  assert.equal(result.project_status, 'ok', JSON.stringify(result.diagnostics));
  assert.equal(result.workspace_count, 5);
  assert.deepEqual(new Set(result.directories.filter(item => item.origin === 'session-reader').map(item => item.dir)), new Set(expected));
  assert.equal(result.directories.find(item => item.dir === expected[1])?.project, second);
  assert.equal(result.directories.find(item => item.dir === expected[2])?.project, worktree);
  assert.deepEqual(await recordedCalls(log), [
    ['projects', '--global', '--json', '--limit', '1000', '--page', '1'],
    ['projects', '--global', '--json', '--limit', '1000', '--page', '2'],
  ]);
  assert.equal(await fs.stat(path.join(home, 'injected')).then(() => true, () => false), false, 'provider executable names are not shell commands');
  assert.ok(PROJECT_SKILL_ROOTS.includes('.agents/skills'));
});

test('skill discovery: missing providers and invalid output retain shared candidates with fixed diagnostics', async t => {
  const home = await temporary(t);
  const shared = await mkdir(path.join(home, '.agents', 'skills'));
  const cases = [
    { command: path.join(home, 'not-installed') },
    { body: 'process.stdout.write("not JSON PRIVATE_TRANSCRIPT_VALUE");' },
    { body: 'process.stdout.write(JSON.stringify({ projects: [], hasMore: true, nextPage: 1 }));' },
    { body: 'process.stdout.write(JSON.stringify({ projects: [{ workspaces: [3] }], hasMore: false }));' },
  ];
  for (const fixture of cases) {
    const command = fixture.command ?? await fakeCommand(home, fixture.body!);
    const result = await discoverSkillDirectories({ home, env: {}, platform: 'win32', sessionCommand: command });
    assert.equal(result.project_status, 'unavailable');
    assert.equal(result.workspace_count, 0);
    assert.deepEqual(result.directories.map(item => item.dir), [shared]);
    assert.equal(result.diagnostics[0]?.source_id, 'session-reader');
    assert.doesNotMatch(JSON.stringify(result.diagnostics), /PRIVATE_TRANSCRIPT_VALUE|not-installed|fake 1session/);
  }
});

test('skill discovery: repository discovery includes intermediate project ancestors and stops at its boundary', async t => {
  const home = await temporary(t);
  const repository = await mkdir(path.join(home, 'container', 'repo'));
  await mkdir(path.join(home, 'container', '.agents', 'skills'));
  await mkdir(path.join(repository, '.git'));
  const car = await mkdir(path.join(repository, 'packages', 'car'));
  const workspace = await mkdir(path.join(car, 'src'));
  const carSkills = await mkdir(path.join(car, '.agents', 'skills'));
  const repositorySkills = await mkdir(path.join(repository, '.claude', 'skills'));
  const nonGitParent = await mkdir(path.join(home, 'ordinary-parent'));
  const nonGitWorkspace = await mkdir(path.join(nonGitParent, 'child'));
  const unrelatedAncestorSkills = await mkdir(path.join(nonGitParent, '.agents', 'skills'));
  const log = path.join(home, 'provider-calls.jsonl');
  const command = await fakeCommand(home, pagedProvider);
  const result = await discoverSkillDirectories({
    home, env: { FIXTURE_LOG: log, FIXTURE_PAGES: JSON.stringify([
      { projects: [{ workspace, workspaces: [workspace, nonGitWorkspace] }], hasMore: false },
    ]) }, platform: 'win32', sessionCommand: command,
  });
  assert.equal(result.project_status, 'ok');
  assert.equal(result.workspace_count, 2);
  assert.deepEqual(new Set(result.directories.map(item => item.dir)), new Set([carSkills, repositorySkills]));
  assert.equal(result.directories.find(item => item.dir === carSkills)?.project, car);
  assert.equal(result.directories.some(item => item.dir === unrelatedAncestorSkills), false, 'without a repository only the observed cwd is eligible');
});

test('skill discovery: pagination and output budgets stop an unbounded project provider', { timeout: 20000 }, async t => {
  const home = await temporary(t);
  const shared = await mkdir(path.join(home, '.agents', 'skills'));
  const log = path.join(home, 'provider-calls.jsonl');
  const endless = await fakeCommand(home, `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(args) + '\\n');
const page = Number(args[args.indexOf('--page') + 1]);
process.stdout.write(JSON.stringify({ projects: [], hasMore: true, nextPage: page + 1 }));
`);
  const result = await discoverSkillDirectories({ home, env: { FIXTURE_LOG: log }, platform: 'win32', sessionCommand: endless });
  assert.equal(result.project_status, 'unavailable');
  assert.equal((await recordedCalls(log)).length, 20);
  assert.deepEqual(result.directories.map(item => item.dir), [shared]);
  const oversized = await fakeCommand(home, 'process.stdout.write("X".repeat(5 * 1024 * 1024));');
  const large = await discoverSkillDirectories({ home, env: {}, platform: 'win32', sessionCommand: oversized });
  assert.equal(large.project_status, 'unavailable');
  assert.deepEqual(large.directories.map(item => item.dir), [shared]);
  assert.ok(JSON.stringify(large.diagnostics).length < 500);
});

test('skill discovery: the project deadline spans every provider page and terminates its running process', { timeout: 10000 }, async t => {
  const home = await temporary(t);
  const shared = await mkdir(path.join(home, '.agents', 'skills'));
  const log = path.join(home, 'provider-calls.jsonl');
  const pidFile = path.join(home, 'provider.pid');
  const command = await fakeCommand(home, `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.FIXTURE_PID, String(process.pid));
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(args) + '\\n');
const page = Number(args[args.indexOf('--page') + 1]);
if (page === 1) process.stdout.write(JSON.stringify({ projects: [], hasMore: true, nextPage: 2 }));
else setInterval(() => {}, 1000);
`);
  const started = Date.now();
  const result = await discoverSkillDirectories({ home, env: { FIXTURE_PID: pidFile, FIXTURE_LOG: log }, platform: 'win32', sessionCommand: command, timeoutMs: 1500 });
  assert.equal(result.project_status, 'unavailable');
  assert.deepEqual(result.directories.map(item => item.dir), [shared]);
  assert.ok((await recordedCalls(log)).length > 1, 'deadline must span more than one individually successful request');
  assert.ok(Date.now() - started < 4000);
  await assertProcessStopped(Number(await fs.readFile(pidFile, 'utf8')));
});

test('skill discovery: cancellation stops the provider and already-aborted discovery does not start one', { timeout: 10000 }, async t => {
  const home = await temporary(t);
  const pidFile = path.join(home, 'provider.pid');
  const command = await fakeCommand(home, `
require('node:fs').writeFileSync(process.env.FIXTURE_PID, String(process.pid));
setInterval(() => {}, 1000);
`);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const pending = discoverSkillDirectories({ home, env: { FIXTURE_PID: pidFile }, platform: 'win32', sessionCommand: command, signal: controller.signal });
  await waitForFile(pidFile);
  const pid = Number(await fs.readFile(pidFile, 'utf8'));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await assertProcessStopped(pid);
  await fs.rm(pidFile);
  await assert.rejects(discoverSkillDirectories({ home, env: { FIXTURE_PID: pidFile }, platform: 'win32', sessionCommand: command, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(await fs.stat(pidFile).then(() => true, () => false), false);
});

test('skill discovery: inaccessible shared directories produce diagnostics instead of appearing absent', async t => {
  const home = await temporary(t);
  const shared = await mkdir(path.join(home, '.agents', 'skills'));
  const denied = path.join(home, '.claude', 'skills');
  await mkdir(denied);
  const realpath = fs.realpath;
  t.mock.method(fs, 'realpath', async (target: Parameters<typeof fs.realpath>[0]) => {
    if (String(target) === denied) throw Object.assign(new Error('PRIVATE_PATH_PERMISSION'), { code: 'EACCES' });
    return realpath(target);
  });
  const result = await discoverSkillDirectories({ home, env: {}, platform: 'win32', projects: false });
  assert.deepEqual(result.directories.map(item => item.dir), [shared]);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.source_id, 'shared');
  assert.doesNotMatch(JSON.stringify(result.diagnostics), /PRIVATE_PATH_PERMISSION/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { SkillSourceError, SkillSourceManager, type SkillDiscoveryOptions } from '../src/index.js';

function fixture(t: TestContext): { dir: string; home: string; discovery: SkillDiscoveryOptions } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-manager-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, home, discovery: { home, env: {}, platform: 'win32', projects: false } };
}

function skill(dir: string, name = path.basename(dir)): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Use ${name} for its specific workflow.\n---\nInstructions for ${name}.\n`);
}

function provider(dir: string, workspace: string, delay = 0): { command: string; calls: () => number } {
  const command = path.join(dir, 'session-provider.mjs');
  const calls = path.join(dir, 'provider-calls.txt');
  fs.writeFileSync(command, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(calls)}, 'call\\n');\nsetTimeout(() => process.stdout.write(JSON.stringify(${JSON.stringify({ projects: [{ workspace }], hasMore: false })})), ${delay});\n`, { mode: 0o755 });
  return { command, calls: () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').length : 0 };
}

async function eventually(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Skill manager state did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function status(code: number): (error: unknown) => boolean {
  return error => error instanceof SkillSourceError && error.status === code;
}

test('the standalone package imports from another working directory without the gateway or a running provider', t => {
  const { dir } = fixture(t);
  const entry = new URL('../src/index.ts', import.meta.url).href;
  const script = `const library = await import(${JSON.stringify(entry)}); process.stdout.write(JSON.stringify({ manager: typeof library.SkillSourceManager, discovery: typeof library.discoverSkillDirectories, cli: typeof library.runSkillManagerCli }));`;
  const output = execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', script], { cwd: dir, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), { manager: 'function', discovery: 'function', cli: 'undefined' });
  const packageFile = fileURLToPath(new URL('../package.json', import.meta.url));
  const packageData = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as { name: string; dependencies?: Record<string, string> };
  assert.equal(packageData.name, '@1agents/skill-manager');
  assert.deepEqual(packageData.dependencies ?? {}, {});
});

test('automatic sources are idempotent and manual IDs win when auto roots contain the same real packages', async t => {
  const { dir, home, discovery } = fixture(t);
  const root = path.join(home, '.agents/skills');
  skill(path.join(root, 'alpha'));
  skill(path.join(root, 'beta'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.symlinkSync(root, path.join(home, '.claude/skills'));
  const manager = new SkillSourceManager({ storagePath: false, discovery });
  await manager.add({ name: 'manual-alpha', dir: path.join(root, 'alpha') });
  const manual = (await manager.catalog()).skills[0]!;
  const first = await manager.discover();
  assert.equal(first.added, 1);
  assert.equal(first.directory_count, 1);
  const repeated = await manager.discover();
  assert.equal(repeated.added, 0);
  assert.equal(repeated.existing, 1);
  const catalog = await manager.catalog();
  assert.equal(catalog.skills.length, 2);
  assert.equal(catalog.skills.find(item => item.name === 'alpha')!.id, manual.id);
  assert.equal(catalog.skills.find(item => item.name === 'beta')!.scope, 'user');
  const sources = await manager.list();
  assert.deepEqual(sources.map(source => source.origin), ['manual', 'shared']);
  assert.match(sources[1]!.name, /^auto-user-[a-f0-9]{20}$/);
  await manager.add({ name: 'manual-root', dir: root });
  assert.ok((await manager.list()).every(source => source.origin === 'manual'));
  assert.equal((await manager.catalog()).skills.length, 3); // Existing manual–manual duplicates remain compatible.
  assert.equal((await manager.discover()).added, 0);
  const collision = new SkillSourceManager({ storagePath: false, discovery });
  const outside = path.join(dir, 'manual-collision');
  skill(outside);
  await collision.add({ name: sources[1]!.name, dir: outside });
  const conflicting = await collision.discover();
  assert.ok(conflicting.diagnostics.some(item => /conflicts/.test(item.error)));
  assert.deepEqual((await collision.catalog()).skills.map(item => item.name), ['manual-collision']);
  assert.equal((await collision.list())[0]!.origin, 'manual');
});

test('auto discovery can load top-level external skill links while package-internal links remain excluded', async t => {
  const { dir, home, discovery } = fixture(t);
  const external = path.join(dir, 'external-skill');
  skill(external);
  const root = path.join(home, '.agents/skills');
  fs.mkdirSync(root, { recursive: true });
  fs.symlinkSync(external, path.join(root, 'linked-skill'));
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'private');
  fs.symlinkSync(path.join(dir, 'outside.txt'), path.join(external, 'outside.txt'));
  const manager = new SkillSourceManager({ storagePath: false, discovery });
  await manager.discover();
  const catalog = await manager.catalog();
  assert.equal(catalog.skills.length, 1);
  const item = catalog.skills[0]!;
  assert.match((await manager.read(item.id, item.revision)).content, /Instructions for external-skill/);
  await assert.rejects(manager.read(item.id, item.revision, 'outside.txt'), status(404));
});

test('removed auto sources remain excluded after discovery and restart; manual removal permits later auto discovery', async t => {
  const { dir, home, discovery } = fixture(t);
  const root = path.join(home, '.agents/skills');
  skill(path.join(root, 'alpha'));
  const storagePath = path.join(dir, 'skill-sources.json');
  const manager = new SkillSourceManager({ storagePath, discovery });
  await manager.discover();
  await manager.remove((await manager.list())[0]!.id);
  assert.equal((await manager.discover()).excluded, 1);
  assert.deepEqual((await manager.catalog()).skills, []);
  const restored = new SkillSourceManager({ storagePath, discovery });
  assert.equal((await restored.discover()).excluded, 1);
  assert.deepEqual(await restored.list(), []);
  const persisted = fs.readFileSync(storagePath, 'utf8');
  assert.match(persisted, /excluded_dirs/);
  assert.doesNotMatch(persisted, /Instructions|revision|content/);
  const manual = new SkillSourceManager({ storagePath: false, discovery });
  await manual.add({ name: 'manual', dir: root });
  await manual.remove('skills-manual');
  assert.equal((await manual.discover()).added, 1);
  fs.rmSync(root, { recursive: true });
  assert.equal((await manual.discover()).removed, 1);
  assert.deepEqual(await manual.list(), []);
});

test('incomplete discovery retains existing automatic sources after a temporary directory permission failure', async t => {
  const { home, discovery } = fixture(t);
  const root = path.join(home, '.agents/skills');
  skill(path.join(root, 'alpha'));
  const manager = new SkillSourceManager({ storagePath: false, discovery });
  await manager.discover();
  const id = (await manager.list())[0]!.id;
  const originalRealpath = fsp.realpath;
  fsp.realpath = (async (candidate: Parameters<typeof fsp.realpath>[0], options?: Parameters<typeof fsp.realpath>[1]) => {
    if (String(candidate) === root) throw Object.assign(new Error('Temporary permission failure'), { code: 'EACCES' });
    return originalRealpath(candidate, options);
  }) as typeof fsp.realpath;
  try {
    const partial = await manager.discover();
    assert.equal(partial.removed, 0);
    assert.ok(partial.diagnostics.length > 0);
    assert.deepEqual((await manager.list()).map(source => source.id), [id]);
  } finally { fsp.realpath = originalRealpath; }
  assert.deepEqual((await manager.catalog()).skills.map(item => item.name), ['alpha']);
  assert.ok((await manager.catalog()).diagnostics.length > 0);
  await manager.discover();
  assert.deepEqual((await manager.catalog()).diagnostics, []);
});

test('lifecycle publishes shared sources first, diagnoses pending projects, and queries do not spawn project providers', async t => {
  const { dir, home, discovery } = fixture(t);
  skill(path.join(home, '.agents/skills/shared'));
  const project = path.join(dir, 'project');
  skill(path.join(project, '.codex/skills/project'));
  fs.mkdirSync(path.join(project, '.git'));
  const session = provider(dir, project, 250);
  const manager = new SkillSourceManager({ storagePath: false, autoDiscover: true,
    discovery: { ...discovery, projects: true, sessionCommand: session.command }, discoveryIntervalMs: 60_000 });
  t.after(() => manager.stop());
  assert.deepEqual((await manager.catalog()).skills, []);
  assert.equal(session.calls(), 0);
  await manager.start();
  const pending = await manager.catalog();
  assert.deepEqual(pending.skills.map(item => item.name), ['shared']);
  assert.ok(pending.diagnostics.some(item => /pending/.test(item.error)));
  await eventually(() => session.calls() === 1);
  const shared = pending.skills[0]!;
  await Promise.all([manager.list(), manager.catalog(), manager.refresh(), manager.read(shared.id, shared.revision)]);
  assert.equal(session.calls(), 1);
  await Promise.all([manager.discover(), manager.discover()]);
  assert.equal(session.calls(), 1);
  const complete = await manager.catalog();
  assert.deepEqual(complete.skills.map(item => item.name).sort(), ['project', 'shared']);
  assert.deepEqual(complete.diagnostics, []);
  assert.ok((await manager.list()).some(source => source.origin === 'session-reader' && source.scope === 'project'));
});

test('stop aborts background project discovery and its scheduler without late configuration writes', async t => {
  const { dir, home, discovery } = fixture(t);
  skill(path.join(home, '.agents/skills/shared'));
  const project = path.join(dir, 'project');
  skill(path.join(project, 'skills/project'));
  const session = provider(dir, project, 2000);
  const storagePath = path.join(dir, 'skill-sources.json');
  const manager = new SkillSourceManager({ storagePath, autoDiscover: true,
    discovery: { ...discovery, projects: true, sessionCommand: session.command }, discoveryIntervalMs: 20 });
  await manager.start();
  await eventually(() => session.calls() === 1);
  const beforeStop = fs.readFileSync(storagePath, 'utf8');
  await manager.stop();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(fs.readFileSync(storagePath, 'utf8'), beforeStop);
  assert.equal(session.calls(), 1);
  assert.deepEqual((await manager.catalog()).skills.map(item => item.name), ['shared']);
  assert.ok(!(await manager.catalog()).diagnostics.some(item => /pending/.test(item.error)));
});

test('unavailable project providers retain previously discovered project sources and keep partial diagnostics', async t => {
  const { dir, home, discovery } = fixture(t);
  skill(path.join(home, '.agents/skills/shared'));
  const project = path.join(dir, 'project');
  skill(path.join(project, 'skills/project'));
  const session = provider(dir, project);
  const manager = new SkillSourceManager({ storagePath: false, discovery });
  assert.equal((await manager.discover({ projects: true, sessionCommand: session.command })).project_status, 'ok');
  const failed = await manager.discover({ projects: true, sessionCommand: path.join(dir, 'missing-provider') });
  assert.equal(failed.project_status, 'unavailable');
  assert.deepEqual((await manager.catalog()).skills.map(item => item.name).sort(), ['project', 'shared']);
  assert.ok((await manager.catalog()).diagnostics.length > 0);
  await manager.discover({ projects: false });
  assert.ok((await manager.catalog()).diagnostics.length > 0);
  await manager.discover({ projects: true, sessionCommand: session.command });
  assert.deepEqual((await manager.catalog()).diagnostics, []);
});

test('external CLI configuration changes reload at query boundaries, damaged edits preserve state and block overwrites', async t => {
  const { dir } = fixture(t);
  const storagePath = path.join(dir, 'skill-sources.json');
  skill(path.join(dir, 'alpha'));
  skill(path.join(dir, 'beta'));
  skill(path.join(dir, 'gamma'));
  const gateway = new SkillSourceManager({ storagePath });
  await gateway.add({ name: 'alpha', dir: path.join(dir, 'alpha') });
  const cli = new SkillSourceManager({ storagePath });
  await cli.add({ name: 'beta', dir: path.join(dir, 'beta') });
  const updated = await gateway.catalog();
  assert.deepEqual(updated.skills.map(item => item.name), ['alpha', 'beta']);
  const beta = updated.skills.find(item => item.name === 'beta')!;
  assert.match((await gateway.read(beta.id, beta.revision)).content, /Instructions for beta/);
  const before = fs.readFileSync(storagePath, 'utf8');
  fs.writeFileSync(storagePath, '{damaged external edit');
  const damaged = await gateway.catalog();
  assert.deepEqual(damaged.skills.map(item => item.name), ['alpha', 'beta']);
  assert.match(damaged.diagnostics[0]!.error, /configuration could not be read/);
  await assert.rejects(gateway.add({ name: 'gamma', dir: path.join(dir, 'gamma') }), status(500));
  assert.equal(fs.readFileSync(storagePath, 'utf8'), '{damaged external edit');
  const temporary = path.join(dir, 'repaired.json');
  fs.writeFileSync(temporary, before);
  fs.renameSync(temporary, storagePath);
  assert.deepEqual((await gateway.catalog()).diagnostics, []);
  await gateway.add({ name: 'gamma', dir: path.join(dir, 'gamma') });
  assert.equal((await cli.list()).length, 3);
  await cli.remove('skills-alpha');
  assert.deepEqual((await gateway.refresh()).skills.map(item => item.name), ['beta', 'gamma']);
});

test('an asynchronous provider merges externally added manual sources and persisted auto exclusions before saving', async t => {
  const { dir, home, discovery } = fixture(t);
  skill(path.join(home, '.agents/skills/shared'));
  skill(path.join(dir, 'manual'));
  const project = path.join(dir, 'project');
  skill(path.join(project, 'skills/project'));
  const session = provider(dir, project, 200);
  const storagePath = path.join(dir, 'skill-sources.json');
  const gateway = new SkillSourceManager({ storagePath, discovery });
  await gateway.discover();
  const job = gateway.discover({ projects: true, sessionCommand: session.command });
  await eventually(() => session.calls() === 1);
  const cli = new SkillSourceManager({ storagePath });
  const sharedSource = (await cli.list())[0]!;
  await cli.add({ name: 'manual', dir: path.join(dir, 'manual') });
  await cli.remove(sharedSource.id);
  const result = await job;
  assert.equal(result.excluded, 1);
  assert.deepEqual((await gateway.catalog()).skills.map(item => item.name).sort(), ['manual', 'project']);
  assert.deepEqual((await cli.catalog()).skills.map(item => item.name).sort(), ['manual', 'project']);
  assert.match(fs.readFileSync(storagePath, 'utf8'), /excluded_dirs/);
});

test('two real processes cannot both succeed while one replaces the other configuration; a busy writer can retry', async t => {
  const { dir } = fixture(t);
  skill(path.join(dir, 'alpha'));
  skill(path.join(dir, 'beta'));
  const storagePath = path.join(dir, 'skill-sources.json');
  const ready = path.join(dir, 'alpha.ready');
  const release = path.join(dir, 'release');
  const managerUrl = new URL('../src/manager.ts', import.meta.url).href;
  const worker = `
    import fs from 'node:fs';
    import { SkillSourceManager } from ${JSON.stringify(managerUrl)};
    const name = process.env.SKILL_TEST_NAME;
    const root = process.env.SKILL_TEST_ROOT;
    const config = process.env.SKILL_TEST_CONFIG;
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to === config && process.env.SKILL_TEST_BARRIER === '1') {
        fs.writeFileSync(root + '/alpha.ready', '');
        const deadline = Date.now() + 5000;
        while (!fs.existsSync(root + '/release')) {
          if (Date.now() > deadline) throw new Error('Timed out waiting to replace config');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      return rename(from, to);
    };
    const manager = new SkillSourceManager({ storagePath: config, autoDiscover: false });
    try {
      await manager.add({ name, dir: root + '/' + name });
      process.stdout.write(JSON.stringify({ status: 200 }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ status: error.status, message: error.message }));
      process.exitCode = error.status === 409 ? 73 : 1;
    }
  `;
  const launch = (name: string, barrier = false) => {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', worker], {
      env: { ...process.env, SKILL_TEST_NAME: name, SKILL_TEST_ROOT: dir, SKILL_TEST_CONFIG: storagePath, SKILL_TEST_BARRIER: barrier ? '1' : '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => { child.kill(); });
    const completion = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += String(chunk); });
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      child.on('error', reject);
      child.on('close', code => resolve({ code, stdout, stderr }));
    });
    return completion;
  };
  const alpha = launch('alpha', true);
  await eventually(() => fs.existsSync(ready));
  const lock = `${storagePath}.lock`;
  const owner = JSON.parse(fs.readFileSync(lock, 'utf8')) as { pid: number };
  assert.ok(Number.isSafeInteger(owner.pid));
  const beta = await launch('beta');
  fs.writeFileSync(release, '');
  const first = await alpha;
  assert.equal(first.code, 0, first.stderr || first.stdout);
  assert.equal(beta.code, 73, beta.stderr || beta.stdout);
  assert.equal((JSON.parse(beta.stdout) as { status: number }).status, 409);
  assert.deepEqual((await new SkillSourceManager({ storagePath }).list()).map(source => source.name), ['alpha']);
  assert.ok(!fs.existsSync(lock));
  const retry = await launch('beta');
  assert.equal(retry.code, 0, retry.stderr || retry.stdout);
  assert.deepEqual((await new SkillSourceManager({ storagePath }).list()).map(source => source.name), ['alpha', 'beta']);
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp') || name.endsWith('.lock')), []);
});

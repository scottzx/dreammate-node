import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const executable = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const loader = import.meta.resolve('tsx');

function fixture(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-manager-cli-'));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home, bin, config: path.join(root, 'config/sources.json'), readerLog: path.join(root, 'reader-calls.jsonl') };
}

type Fixture = ReturnType<typeof fixture>;

function skill(dir: string, name: string, description = 'Use this skill to improve a rendering workflow') {
  fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\nRead the complete guide and references.\n`);
  fs.writeFileSync(path.join(dir, 'references/stages.md'), 'Plan, capture, review, and repair.\n');
}

async function cli(f: Fixture, args: string[], options: { defaultConfig?: boolean; payload?: unknown; entry?: string } = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(process.execPath, ['--import', loader, options.entry ?? executable, ...args,
      ...(options.defaultConfig ? [] : ['--config', f.config])], {
      env: { ...process.env, HOME: f.home, PATH: f.bin, CODEX_HOME: '', CLAUDE_CONFIG_DIR: '', GEMINI_CLI_HOME: '',
        GROK_HOME: '', DSH_HOME: '', DSH_AGENTS_HOME: '', DSH_BUNDLED_SKILL_DIR: '',
        DREAMMATE_AGENT_URL: 'http://127.0.0.1:1', TSX_DISABLE_CACHE: '1',
        FAKE_PROJECT_PAYLOAD: JSON.stringify(options.payload ?? { projects: [], hasMore: false }), FAKE_READER_LOG: f.readerLog },
      timeout: 15_000,
    }, (error, stdout, stderr) => {
      if (error && (error.killed || typeof error.code !== 'number')) return reject(error);
      resolve({ code: error?.code as number ?? 0, stdout, stderr });
    });
    child.stdin!.end();
  });
}

function installFakeReader(f: Fixture): void {
  fs.writeFileSync(path.join(f.bin, '1session'), `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(process.env.FAKE_READER_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.stdout.write(process.env.FAKE_PROJECT_PAYLOAD);\n`, { mode: 0o755 });
}

function calls(f: Fixture): string[][] {
  return fs.existsSync(f.readerLog) ? fs.readFileSync(f.readerLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}

test('independent skills CLI help and read-only empty listings need no gateway or configuration writes', async t => {
  const f = fixture(t);
  installFakeReader(f);
  const help = await cli(f, ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /无需 DreamMate 网关/);
  const sources = await cli(f, ['sources']);
  assert.equal(sources.code, 0, sources.stdout);
  assert.deepEqual(JSON.parse(sources.stdout), { sources: [] });
  const listing = await cli(f, ['list']);
  assert.equal(listing.code, 0, listing.stdout);
  assert.deepEqual(JSON.parse(listing.stdout), { skills: [], diagnostics: [] });
  assert.equal(fs.existsSync(f.config), false);
  assert.deepEqual(calls(f), []);
});

test('independent CLI registers, versions, reads and removes a source without editing or executing its files', async t => {
  const f = fixture(t);
  const source = path.join(f.root, 'visual');
  skill(source, 'visual');
  fs.mkdirSync(path.join(source, 'scripts'));
  const executionMarker = path.join(f.root, 'executed');
  fs.writeFileSync(path.join(source, 'scripts/helper.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(executionMarker)}, 'executed');\n`);
  const original = fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8');
  const added = await cli(f, ['add', '--name', 'visual', '--dir', path.relative(process.cwd(), source)]);
  assert.equal(added.code, 0, added.stdout);
  assert.equal(JSON.parse(added.stdout).id, 'skills-visual');
  assert.equal(JSON.parse(added.stdout).dir, source);
  const sources = JSON.parse((await cli(f, ['sources'])).stdout).sources;
  assert.equal(sources[0].skill_count, 1);
  const listing = await cli(f, ['list']);
  assert.equal(listing.code, 0, listing.stdout);
  const summary = JSON.parse(listing.stdout).skills[0];
  assert.match(summary.revision, /^[a-f0-9]{64}$/);
  assert.ok(!listing.stdout.includes('Read the complete guide'));
  const read = await cli(f, ['read', '--skill', summary.id, '--revision', summary.revision]);
  assert.equal(read.code, 0, read.stdout);
  assert.equal(JSON.parse(read.stdout).content, original);
  const reference = await cli(f, ['read', '--skill', summary.id, '--revision', summary.revision, '--resource', 'references/stages.md']);
  assert.equal(reference.code, 0, reference.stdout);
  assert.equal(JSON.parse(reference.stdout).content, 'Plan, capture, review, and repair.\n');
  const script = await cli(f, ['read', '--skill', summary.id, '--revision', summary.revision, '--resource', 'scripts/helper.mjs']);
  assert.equal(script.code, 0, script.stdout);
  assert.match(JSON.parse(script.stdout).content, /writeFileSync/);
  assert.equal(fs.existsSync(executionMarker), false);
  assert.equal(fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8'), original);
  const removed = await cli(f, ['remove', 'skills-visual']);
  assert.equal(removed.code, 0, removed.stdout);
  assert.deepEqual(JSON.parse(removed.stdout), { removed: 'skills-visual' });
  assert.deepEqual(JSON.parse((await cli(f, ['list'])).stdout).skills, []);
  assert.equal(fs.existsSync(path.join(source, 'SKILL.md')), true);
});

test('independent CLI accepts project and home paths and shares the default configuration location', async t => {
  const f = fixture(t);
  const project = path.join(f.home, 'tesla');
  skill(path.join(project, '.agents/skills/cad'), 'cad');
  const result = await cli(f, ['add', '--name', 'tesla', '--project', '~/tesla'], { defaultConfig: true });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).project, project);
  assert.equal(fs.existsSync(path.join(f.home, '.1agents/skill-sources.json')), true);
  assert.equal(fs.existsSync(f.config), false);
  const listing = await cli(f, ['list'], { defaultConfig: true });
  assert.equal(listing.code, 0, listing.stdout);
  assert.equal(JSON.parse(listing.stdout).skills[0].name, 'cad');
});

test('independent discover combines shared skills and fake session workspaces, while listings never invoke the reader', async t => {
  const f = fixture(t);
  installFakeReader(f);
  skill(path.join(f.home, '.agents/skills/shared'), 'shared');
  const project = path.join(f.root, 'tesla');
  skill(path.join(project, '.agents/skills/project-visual'), 'project-visual');
  fs.mkdirSync(path.join(project, '.git'));
  const payload = { projects: [{ workspace: project, workspaces: [project] }], hasMore: false, page: 1, limit: 1000, total: 1 };
  const discovered = await cli(f, ['discover'], { payload });
  assert.equal(discovered.code, 0, discovered.stdout);
  const result = JSON.parse(discovered.stdout);
  assert.equal(result.project_status, 'ok');
  assert.equal(result.workspace_count, 1);
  assert.ok(result.added >= 2);
  assert.deepEqual(calls(f), [['projects', '--global', '--json', '--limit', '1000', '--page', '1']]);
  const listing = await cli(f, ['list']);
  assert.equal(listing.code, 0, listing.stdout);
  const names = JSON.parse(listing.stdout).skills.map((item: { name: string }) => item.name);
  assert.ok(names.includes('shared'));
  assert.ok(names.includes('project-visual'));
  const sources = await cli(f, ['sources']);
  assert.equal(sources.code, 0, sources.stdout);
  assert.equal(calls(f).length, 1);
  const skipped = await cli(f, ['discover', '--no-projects']);
  assert.equal(skipped.code, 0, skipped.stdout);
  assert.equal(JSON.parse(skipped.stdout).project_status, 'skipped');
  assert.equal(calls(f).length, 1);
});

test('missing or malformed session reader results preserve successful shared discovery and return partial failure', async t => {
  const f = fixture(t);
  skill(path.join(f.home, '.agents/skills/shared'), 'shared');
  const missing = await cli(f, ['discover']);
  assert.equal(missing.code, 1, missing.stdout);
  assert.equal(JSON.parse(missing.stdout).project_status, 'unavailable');
  assert.ok(JSON.parse(missing.stdout).diagnostics.length > 0);
  const listing = await cli(f, ['list']);
  assert.equal(listing.code, 0, listing.stdout);
  assert.ok(JSON.parse(listing.stdout).skills.some((item: { name: string }) => item.name === 'shared'));
  installFakeReader(f);
  const malformed = await cli(f, ['discover'], { payload: { projects: 'invalid' } });
  assert.equal(malformed.code, 1, malformed.stdout);
  assert.equal(JSON.parse(malformed.stdout).project_status, 'unavailable');
  assert.ok(JSON.parse((await cli(f, ['list'])).stdout).skills.some((item: { name: string }) => item.name === 'shared'));
});

test('independent CLI validates commands before touching configuration or running discovery', async t => {
  const f = fixture(t);
  installFakeReader(f);
  const revision = 'a'.repeat(64);
  for (const args of [
    ['unknown'], ['sources', 'extra'], ['list', '--no-projects'], ['discover', '--dir', '.'],
    ['add'], ['add', '--name', 'visual', '--dir', '.', '--project', '.'], ['add', '--name', '../visual', '--dir', '.'],
    ['add', '--name', 'visual', '--dir', ''], ['add', '--name', 'visual', '--dir', '~someone/skills'],
    ['remove'], ['remove', '../source'], ['read'], ['read', '--skill', 'skills-visual:visual'],
    ['read', '--skill', 'skills-visual:visual', '--revision', 'old'],
    ['read', '--skill', 'skills-visual:visual', '--revision', revision, '--resource', '../outside'],
    ['read', '--skill', 'skills-visual:visual', '--revision', revision, '--resource', '/absolute'],
    ['read', '--skill', 'skills-visual:visual', '--revision', revision, '--resource', 'scripts\\helper.py'],
    ['read', '--skill', 'skills-visual:visual', '--revision', revision, '--project', '.'], ['list', '--unknown'],
    ['serve', '--port', '-1'], ['serve', '--port', '65536'], ['serve', '--port', '1.2'],
    ['serve', '--agent', 'http://example.com'], ['serve', '--agent', 'http://127.0.0.1:36908/path'],
    ['install', '--port', '0'], ['install', '--no-register'], ['uninstall', '--config', f.config], ['status', '--config', f.config],
  ]) {
    const result = await cli(f, args);
    assert.equal(result.code, 2, args.join(' '));
    assert.equal(JSON.parse(result.stdout).code, 'INVALID_ARGUMENT');
    assert.equal(JSON.parse(result.stderr).code, 'INVALID_ARGUMENT');
  }
  assert.equal(fs.existsSync(f.config), false);
  assert.deepEqual(calls(f), []);
});

test('independent CLI reports missing resources and stale revisions without changing the source', async t => {
  const f = fixture(t);
  const source = path.join(f.root, 'visual');
  skill(source, 'visual');
  assert.equal((await cli(f, ['add', '--name', 'visual', '--dir', source])).code, 0);
  const summary = JSON.parse((await cli(f, ['list'])).stdout).skills[0];
  const notFound = await cli(f, ['read', '--skill', summary.id, '--revision', summary.revision, '--resource', 'references/missing.md']);
  assert.equal(notFound.code, 1);
  assert.equal(JSON.parse(notFound.stdout).status, 404);
  fs.appendFileSync(path.join(source, 'references/stages.md'), 'Updated reference.\n');
  const stale = await cli(f, ['read', '--skill', summary.id, '--revision', summary.revision]);
  assert.equal(stale.code, 1);
  assert.equal(JSON.parse(stale.stdout).status, 409);
  const fresh = JSON.parse((await cli(f, ['list'])).stdout).skills[0];
  assert.notEqual(fresh.revision, summary.revision);
  assert.equal((await cli(f, ['read', '--skill', fresh.id, '--revision', fresh.revision])).code, 0);
});

test('independent CLI also runs through a symlinked package executable', async t => {
  const f = fixture(t);
  const link = path.join(f.root, 'dreammate-skills.ts');
  fs.symlinkSync(executable, link);
  const result = await cli(f, ['sources'], { entry: link });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { sources: [] });
});

test('serve CLI listens independently and exits cleanly on SIGTERM without invoking session discovery', { timeout: 15_000 }, async t => {
  const f = fixture(t);
  installFakeReader(f);
  const child = spawn(process.execPath, ['--import', loader, executable, 'serve', '--port', '0', '--agent', 'http://127.0.0.1:1',
    '--config', f.config, '--no-projects', '--no-register'], {
    env: { ...process.env, HOME: f.home, PATH: f.bin, CODEX_HOME: '', CLAUDE_CONFIG_DIR: '', GEMINI_CLI_HOME: '',
      GROK_HOME: '', DSH_HOME: '', DSH_AGENTS_HOME: '', DSH_BUNDLED_SKILL_DIR: '', TSX_DISABLE_CACHE: '1',
      FAKE_PROJECT_PAYLOAD: JSON.stringify({ projects: [], hasMore: false }), FAKE_READER_LOG: f.readerLog },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; });
  const started = await new Promise<{ service: string; url: string; registration: { registered: boolean } }>((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error(`CLI did not start: ${stderr}`)), 5000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`CLI exited before listening (${code}): ${stderr}`)); });
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      const line = stdout.split('\n')[0];
      if (!stdout.includes('\n')) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
    });
  });
  assert.equal(started.service, 'dreammate-skill-manager');
  assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(started.registration.registered, false);
  const health = await fetch(`${started.url}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(calls(f), []);
  child.kill('SIGTERM');
  assert.deepEqual(await exited, { code: 0, signal: null }, stderr);
  await assert.rejects(fetch(`${started.url}/health`));
  assert.deepEqual(calls(f), []);
});

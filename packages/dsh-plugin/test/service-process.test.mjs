import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { acquireService, resolveServiceOptions } from '../src/service-process.js';
import { endpoint, unused, health } from './helpers.mjs';

const options = serviceUrl => resolveServiceOptions({ serviceUrl, serviceHost: '127.0.0.1' });

test('starts a real node, shares concurrent leases, stops only on last release and can restart', { timeout: 30000 }, async t => {
  const url = await unused(t);
  const releases = await Promise.all([acquireService(options(url)), acquireService(options(url))]);
  t.after(async () => { for (const release of releases) await release(); });
  assert.equal((await (await health(url)).json()).service, 'node-agent');
  assert.equal(typeof (await (await fetch(`${url}/manifest`)).json()).node_id, 'string');
  await releases[0](); await releases[0]();
  assert.equal((await health(url)).status, 200);
  await releases[1]();
  await assert.rejects(health(url));
  const release = await acquireService(options(url));
  await release();
  await assert.rejects(health(url));
});

test('existing healthy service remains alive on plugin release', async t => {
  const fixture = await endpoint(t, (_req, res) => res.end(JSON.stringify({ service: 'node-agent', status: 'ok' })));
  const release = await acquireService(options(fixture.url));
  await release();
  assert.equal((await health(fixture.url)).status, 200);
});

test('external and remote URLs never start a local service', async t => {
  const url = await unused(t);
  await (await acquireService(resolveServiceOptions({ serviceUrl: url, serviceMode: 'external' })))();
  await assert.rejects(health(url));
  for (const serviceUrl of ['http://example.invalid', 'https://127.0.0.1', `${url}/gateway`]) {
    await (await acquireService(options(serviceUrl)))();
  }
});

test('foreign listeners, denied health, invalid JSON and health timeouts fail without spawning', async t => {
  const denied = await endpoint(t, (_req, res) => { res.writeHead(401); res.end(); });
  await assert.rejects(acquireService(options(denied.url)), /HTTP 401/);
  const foreign = await endpoint(t);
  await assert.rejects(acquireService(options(foreign.url)), /not a healthy DreamMate/);
  const invalid = await endpoint(t, (_req, res) => res.end('not JSON'));
  await assert.rejects(acquireService(options(invalid.url)), SyntaxError);
  const hanging = await endpoint(t, () => {});
  await assert.rejects(acquireService({ ...options(hanging.url), serviceStartupTimeoutMs: 50 }), /health check failed/);
});

test('child startup timeout releases its process and permits retry', { timeout: 30000 }, async t => {
  const url = await unused(t);
  await assert.rejects(acquireService({ ...options(url), serviceStartupTimeoutMs: 1 }));
  await assert.rejects(health(url));
  const release = await acquireService(options(url));
  t.after(release);
  assert.equal((await health(url)).status, 200);
});

test('worker exits after its DSH parent is killed', { timeout: 25000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dreammate-parent-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const url = await unused(t);
  const fixture = join(directory, 'parent.mjs');
  await writeFile(fixture, `import {acquireService,resolveServiceOptions} from ${JSON.stringify(new URL('../src/service-process.js', import.meta.url).href)};
await acquireService(resolveServiceOptions(${JSON.stringify(options(url))})); process.send('ready');`);
  const parent = fork(fixture, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
  const exited = once(parent, 'exit');
  t.after(async () => { parent.kill('SIGKILL'); await exited; });
  await Promise.race([once(parent, 'message'), exited.then(() => { throw new Error('Parent exited before readiness'); })]);
  assert.equal((await health(url)).status, 200);
  parent.kill('SIGKILL'); await exited;
  const deadline = Date.now() + 7000;
  while (true) {
    try { await health(url); } catch { break; }
    assert.ok(Date.now() < deadline, 'worker must not outlive its parent');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
});

test('validates configuration and normalizes localhost leases', () => {
  assert.equal(resolveServiceOptions({ serviceUrl: 'http://localhost:36908/' }).serviceUrl, 'http://127.0.0.1:36908');
  assert.equal(resolveServiceOptions({ serviceUrl: 'http://[::1]:36908' }).serviceHost, '::');
  for (const input of [{ serviceMode: 'bad' }, { serviceHost: 'example.com' }, { serviceStartupTimeoutMs: 0 },
    { serviceShutdownTimeoutMs: -1 }, { serviceStartupTimeoutMs: 2147483648 },
    { serviceUrl: 'file:///tmp/node' }, { serviceUrl: 'http://127.0.0.1:0' },
    { serviceUrl: 'http://user:pass@localhost:36908' }, { serviceUrl: 'http://localhost:36908?key=value' }]) {
    assert.throws(() => resolveServiceOptions(input));
  }
});

import assert from 'node:assert/strict';
import childProcess, { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { CACHE_MS, listNetworkNodes, nodeIdentity, resetBinCache, resetIdentityCache } from '../src/identity.js';
import { createAgent } from '../src/server.js';
import { ServiceRegistry } from '../src/registry.js';

const status = {
  BackendState: 'Running',
  Self: { ID: 'self-id', DNSName: 'test-mac.tail.test.', OS: 'macOS', Online: true, TailscaleIPs: ['100.64.0.1'] },
  Peer: { peer: { ID: 'peer-id', DNSName: 'test-peer.tail.test.', OS: 'linux', Online: true, TailscaleIPs: ['100.64.0.2'] } },
};

function fixture(t: TestContext) {
  const saved = { bin: process.env.DREAMMATE_TAILSCALE_BIN, id: process.env.DREAMMATE_NODE_ID, name: process.env.DREAMMATE_NODE_NAME };
  process.env.DREAMMATE_TAILSCALE_BIN = 'fixture-tailscale';
  delete process.env.DREAMMATE_NODE_ID;
  delete process.env.DREAMMATE_NODE_NAME;
  resetIdentityCache();
  resetBinCache();
  const calls: string[] = [];
  const kills: string[] = [];
  const timers: NodeJS.Timeout[] = [];
  let respond: (bin: string, done: (value: unknown) => void) => void = (_bin, done) => {
    timers.push(setTimeout(() => done(status), 25));
  };
  t.mock.method(childProcess, 'execFile', ((bin: string, _args: string[], _options: unknown,
    callback: (error: Error | null, stdout: string) => void) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(),
      kill: (signal: string) => { kills.push(signal); return true; },
    });
    if (_args[0] !== 'status') { queueMicrotask(() => callback(null, '')); return child as unknown as ChildProcess; }
    calls.push(bin);
    respond(bin, value => callback(null, JSON.stringify(value)));
    return child as unknown as ChildProcess;
  }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  t.after(() => {
    timers.forEach(clearTimeout);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const [key, value] of Object.entries({ DREAMMATE_TAILSCALE_BIN: saved.bin, DREAMMATE_NODE_ID: saved.id, DREAMMATE_NODE_NAME: saved.name })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    resetIdentityCache();
    resetBinCache();
  });
  return { calls, kills, setRespond: (next: typeof respond) => { respond = next; } };
}

test('concurrent cold identity and topology requests share one CLI snapshot', async t => {
  const f = fixture(t);
  const results = await Promise.all(Array.from({ length: 24 }, async (_, index) => {
    if (index % 2) {
      const nodes = await listNetworkNodes();
      assert.deepEqual(nodes.map(node => node.node_id), ['self-id', 'peer-id']);
      return nodes[0]!.node_id;
    }
    return (await nodeIdentity()).node_id;
  }));
  assert.ok(results.every(id => id === 'self-id'));
  assert.equal(f.calls.length, 1);
  const first = await listNetworkNodes();
  const second = await listNetworkNodes();
  assert.equal(first[0]!.network_checked_at, second[0]!.network_checked_at, 'cached timestamps describe the actual check');
  assert.equal(f.calls.length, 1);
});

test('expired identity does not block HTTP health, catalogs or registration during a stalled refresh', async t => {
  const f = fixture(t);
  await nodeIdentity();
  const now = Date.now() + CACHE_MS + 1;
  t.mock.method(Date, 'now', () => now);
  f.setRespond(() => {});
  const registry = new ServiceRegistry({ storagePath: false });
  const agent = createAgent({ registry, mcpSources: { storagePath: false } });
  await new Promise<void>(resolve => agent.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    agent.server.closeAllConnections();
    await new Promise<void>(resolve => agent.server.close(() => resolve()));
  });
  const base = `http://127.0.0.1:${(agent.server.address() as AddressInfo).port}`;
  const started = performance.now();
  const responses = await Promise.all(['/health', '/manifest', '/services'].map(async route => {
    const res = await fetch(base + route, { signal: AbortSignal.timeout(1000) });
    assert.equal(res.status, 200);
    return res.json() as Promise<{ node_id?: string }>;
  }));
  assert.equal(responses[0].node_id, 'self-id');
  const registered = await fetch(`${base}/services`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'still-registers', port: 12345 }), signal: AbortSignal.timeout(1000) });
  assert.equal(registered.status, 201);
  await registered.json();
  assert.ok(performance.now() - started < 1000);
  assert.equal(f.calls.length, 2, 'only one background refresh may run');
  // Join the in-flight refresh so it cannot outlive test cleanup.
  assert.equal((await nodeIdentity({ force: true })).node_id, 'self-id');
  assert.deepEqual(f.kills, ['SIGKILL']);
});

test('a CLI that never calls back is bounded and a transient failure preserves canonical identity', async t => {
  const f = fixture(t);
  await nodeIdentity();
  f.setRespond(() => {});
  const started = performance.now();
  const nodes = await listNetworkNodes({ force: true, timeoutMs: 100 });
  assert.ok(performance.now() - started < 500, 'deadline cannot depend on the child exit callback');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]!.node_id, 'self-id');
  assert.equal(nodes[0]!.network_online, null, 'cached identity does not prove network presence');
  assert.deepEqual(f.kills, ['SIGKILL']);
  assert.equal((await nodeIdentity()).node_id, 'self-id');
});

test('candidate failures share one total deadline and still allow a healthy fallback', async t => {
  const f = fixture(t);
  await nodeIdentity();
  delete process.env.DREAMMATE_TAILSCALE_BIN;
  resetBinCache();
  f.calls.length = 0;
  f.setRespond((bin, done) => { if (bin === '/Applications/Tailscale.app/Contents/MacOS/Tailscale') queueMicrotask(() => done(status)); });
  let started = performance.now();
  const recovered = await listNetworkNodes({ force: true, timeoutMs: 200 });
  assert.equal(recovered.length, 2);
  assert.ok(performance.now() - started < 450);
  assert.equal(f.calls.length, 5);
  resetBinCache();
  f.setRespond(() => {});
  started = performance.now();
  const failed = await listNetworkNodes({ force: true, timeoutMs: 200 });
  assert.equal(failed[0]!.network_online, null);
  assert.ok(performance.now() - started < 450, 'timeout is for the complete lookup, not each candidate');
});

test('a valid stopped Tailnet updates presence without reusing a running snapshot', async t => {
  const f = fixture(t);
  await nodeIdentity();
  f.setRespond((_bin, done) => queueMicrotask(() => done({ BackendState: 'Stopped' })));
  // Explicit IDs avoid writing a local fallback identity in this test.
  process.env.DREAMMATE_NODE_ID = 'local-id';
  process.env.DREAMMATE_NODE_NAME = 'local-name';
  const nodes = await listNetworkNodes({ force: true });
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]!.node_id, 'local-id');
  assert.equal(nodes[0]!.network_online, false);
});

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { createAgent } from '../src/server.js';
import { ServiceRegistry } from '../src/registry.js';

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server) {
  await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
}
async function gateway(t: TestContext) {
  const registry = new ServiceRegistry({ storagePath: false });
  const agent = createAgent({ registry, mcpSources: { storagePath: false } });
  const base = await listen(agent.server);
  t.after(async () => { await close(agent.server); await agent.mcpSources.stop(); });
  return { base, registry };
}

test('conditional deregistration preserves a replacement registered after a service snapshot was read', async t => {
  const { base, registry } = await gateway(t);
  registry.register({ id: 'conditional-service', port: 12345, execution: 'http' });
  const snapshot = await fetch(`${base}/services/conditional-service`);
  assert.equal(snapshot.status, 200);
  const etag = snapshot.headers.get('etag');
  assert.match(etag!, /^"[a-f0-9]{64}"$/);
  await snapshot.json();
  registry.register({ id: 'conditional-service', port: 12346, execution: 'http' });
  const stale = await fetch(`${base}/services/conditional-service`, { method: 'DELETE', headers: { 'if-match': etag! } });
  assert.equal(stale.status, 412);
  assert.equal(registry.get('conditional-service')?.port, 12346);
  const latest = await fetch(`${base}/services/conditional-service`);
  assert.notEqual(latest.headers.get('etag'), etag);
  const removed = await fetch(`${base}/services/conditional-service`, { method: 'DELETE', headers: { 'if-match': latest.headers.get('etag')! } });
  assert.equal(removed.status, 200);
  assert.equal(registry.get('conditional-service'), undefined);
});

test('unconditional deregistration remains compatible and conditional deletion of an absent snapshot fails', async t => {
  const { base, registry } = await gateway(t);
  registry.register({ id: 'legacy-service', port: 12345 });
  assert.equal((await fetch(`${base}/services/legacy-service`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${base}/services/legacy-service`, { method: 'DELETE', headers: { 'if-match': '"old"' } })).status, 412);
  assert.equal((await fetch(`${base}/services/legacy-service`, { method: 'DELETE' })).status, 404);
});

test('HTTP invocation honors bounded service timeouts while invalid advertisements retain the default budget', async t => {
  const { base, registry } = await gateway(t);
  const upstream = createServer((_req, res) => {
    setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); }, 40);
  });
  await listen(upstream);
  t.after(() => close(upstream));
  const port = (upstream.address() as AddressInfo).port;
  for (const [timeout, expected] of [[5, 504], [1000, 200], [-1, 200], [120001, 200], ['5', 200]] as const) {
    registry.register({ id: 'slow-http', port, execution: 'http', methods: { slow: { description: 'Delayed response', parameters: { type: 'object' } } },
      metadata: { invoke_timeout_ms: timeout } });
    for (const route of ['/services/slow-http/invoke', '/capabilities/slow/invoke']) {
      const result = await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"method":"slow"}' });
      assert.equal(result.status, expected, `${route} timeout=${timeout}`);
      if (expected === 504) assert.equal((await result.json() as { kind: string }).kind, 'timeout');
    }
  }
});

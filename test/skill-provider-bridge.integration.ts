import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { serveSkillService } from '@1agents/skill-manager';
import { createAgent } from '../src/server.js';
import { ServiceRegistry, type Registration } from '../src/registry.js';

async function listen(server: Server, port = 0): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server) {
  if (!server.listening) return;
  await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
}
function post(base: string, route: string, body: unknown) {
  return fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
async function gateway(t: TestContext) {
  const registry = new ServiceRegistry({ storagePath: false });
  const agent = createAgent({ registry, mcpSources: { storagePath: false } });
  const base = await listen(agent.server);
  t.after(async () => { await close(agent.server); await agent.mcpSources.stop(); });
  return { ...agent, base };
}
async function mockProvider(t: TestContext, marker: string) {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw);
    requests.push(payload);
    res.setHeader('content-type', 'application/json');
    if (payload.method === 'read') res.writeHead(409).end(JSON.stringify({ error: `Revision changed ${marker}` }));
    else res.end(JSON.stringify({ marker, skills: [], diagnostics: [], total: 0, has_more: false, next_offset: null }));
  });
  await listen(server);
  t.after(() => close(server));
  const descriptor: Registration = { id: 'custom-skills', port: (server.address() as AddressInfo).port, execution: 'http',
    metadata: { skill_provider: { protocol: 'dreammate.skills.v1' } } };
  return { descriptor, requests };
}

test('skill bridge reports an absent provider and never creates an embedded manager', async t => {
  const agent = await gateway(t);
  assert.equal('skillSources' in agent, false);
  for (const [route, method, body] of [
    ['/skills', 'GET', undefined], ['/skills/sources', 'GET', undefined],
    ['/skills/sources', 'POST', { name: 'fixture', dir: '/tmp' }],
    ['/skills/sources/refresh', 'POST', {}], ['/skills/sources/discover', 'POST', {}],
    [`/skills/fixture?revision=${'a'.repeat(64)}`, 'GET', undefined],
  ] as const) {
    const response = await fetch(`${agent.base}${route}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 503, `${method} ${route}`);
    assert.equal((await response.json() as { code: string }).code, 'SKILL_PROVIDER_UNAVAILABLE');
  }
  assert.deepEqual(agent.registry.list(), []);
});

test('skill bridge uses the advertised protocol, forwards request pages and observes provider re-registration', async t => {
  const { registry, base } = await gateway(t);
  const first = await mockProvider(t, 'first');
  const second = await mockProvider(t, 'second');
  registry.register(first.descriptor);
  const catalog = await (await fetch(`${base}/skills?limit=7&offset=3`)).json() as Record<string, unknown>;
  assert.equal(catalog.marker, 'first');
  assert.equal(typeof catalog.node, 'string');
  assert.deepEqual(first.requests, [{ method: 'catalog', params: { limit: 7, offset: 3 } }]);
  registry.register(second.descriptor);
  assert.equal((await (await fetch(`${base}/skills`)).json() as { marker: string }).marker, 'second');
  const stale = await fetch(`${base}/skills/fixture?revision=${'a'.repeat(64)}&resource=references%2Fguide.md`);
  assert.equal(stale.status, 409);
  assert.match((await stale.json() as { error: string }).error, /second/);
  assert.deepEqual(second.requests[1], { method: 'read', params: { skill_id: 'fixture', revision: 'a'.repeat(64), resource: 'references/guide.md' } });
  registry.register({ ...first.descriptor, id: 'another-skills' });
  const ambiguous = await fetch(`${base}/skills`);
  assert.equal(ambiguous.status, 409);
  assert.equal((await ambiguous.json() as { code: string }).code, 'SKILL_PROVIDER_AMBIGUOUS');
  registry.deregister('custom-skills');
  assert.equal((await (await fetch(`${base}/skills`)).json() as { marker: string }).marker, 'first');
});

test('skill bridge rejects invalid read requests and malformed local-only metadata before forwarding', async t => {
  const { registry, base } = await gateway(t);
  const provider = await mockProvider(t, 'unused');
  registry.register(provider.descriptor);
  for (const suffix of ['', '?revision=old', `?revision=${'a'.repeat(64)}&resource=..%2Fsecret`,
    `?revision=${'a'.repeat(64)}&resource=%2Ftmp%2Fsecret`, `?revision=${'a'.repeat(64)}&resource=C%3A%2Fsecret`]) {
    const result = await fetch(`${base}/skills/fixture${suffix}`);
    assert.equal(result.status, 400, suffix);
  }
  assert.deepEqual(provider.requests, []);
  const invalid = await post(base, '/services', { ...provider.descriptor, metadata: { local_only_methods: 'sources' } });
  assert.equal(invalid.status, 400);
});

test('an independently running provider registers again after Node restarts', { timeout: 10000 }, async t => {
  const first = await gateway(t);
  const port = (first.server.address() as AddressInfo).port;
  const provider = await serveSkillService({ port: 0, agentUrl: first.base, registrationIntervalMs: 30, registrationTimeoutMs: 200,
    managerOptions: { storagePath: false, autoDiscover: false } });
  t.after(() => provider.close());
  await provider.report();
  assert.equal((await fetch(`${first.base}/skills`)).status, 200);
  await close(first.server);
  const registry = new ServiceRegistry({ storagePath: false });
  const restarted = createAgent({ registry, mcpSources: { storagePath: false } });
  await listen(restarted.server, port);
  t.after(async () => { await close(restarted.server); await restarted.mcpSources.stop(); });
  for (let attempt = 0; attempt < 100 && registry.list().length === 0; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(registry.list().length, 1);
  assert.equal(registry.list()[0]!.id, provider.descriptor.id);
  assert.equal((await fetch(`${first.base}/skills`)).status, 200);
  assert.equal(provider.server.listening, true, 'Node shutdown must not stop the independent provider');
});

test('closing an old provider cannot withdraw a replacement registered between its GET and DELETE', async t => {
  const agent = await gateway(t);
  const old = await serveSkillService({ port: 0, agentUrl: agent.base, registrationIntervalMs: 10000,
    managerOptions: { storagePath: false, autoDiscover: false } });
  t.after(() => old.close());
  await old.report();
  const replacement = await serveSkillService({ port: 0, register: false,
    managerOptions: { storagePath: false, autoDiscover: false } });
  t.after(() => replacement.close());
  let replaced = false;
  agent.server.on('request', (req, res) => {
    if (req.method === 'GET' && req.url === `/services/${old.descriptor.id}`) {
      // Replace after the old descriptor/ETag was sent, before its client can DELETE.
      res.once('finish', () => { replaced = true; agent.registry.register(replacement.descriptor); });
    }
  });
  await old.close();
  assert.equal(replaced, true);
  assert.equal(agent.registry.get(replacement.descriptor.id)?.port, replacement.descriptor.port);
  assert.deepEqual(agent.registry.get(replacement.descriptor.id)?.metadata, replacement.descriptor.metadata);
  assert.equal((await fetch(`${agent.base}/skills`)).status, 200);
});

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { createAgent } from '../src/server.js';
import { ServiceRegistry, type Registration } from '../src/registry.js';

const advertisement = {
  protocol: 'dreammate.embedding.v1', model: 'qwen3', revision: 'sharing-fixture',
  dimensions: 2, encoding: 'float32', ready: true,
};
const payload = { texts: ['本机模型'], input_type: 'query' };
const answer = { model: 'qwen3@sharing-fixture', encoding: 'float32', embeddings: [[0.6, 0.8]] };

async function listen(server: Server, host = '127.0.0.1'): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => { server.off('error', reject); resolve(); });
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

async function fixture(t: TestContext) {
  const calls: { path: string; body: unknown }[] = [];
  const upstream = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    calls.push({ path: req.url!, body: JSON.parse(raw) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/embed' ? answer : { skills: [{ name: 'visible-skill' }] }));
  });
  const port = await listen(upstream);
  const registry = new ServiceRegistry({ storagePath: false });
  const agent = createAgent({ registry, mcpSources: { storagePath: false } });
  const agentPort = await listen(agent.server, '0.0.0.0');
  t.after(async () => { await close(agent.server); await close(upstream); });
  const base = `http://127.0.0.1:${agentPort}`;
  const address = Object.values(networkInterfaces()).flat()
    .find(entry => entry && !entry.internal && entry.family === 'IPv4')?.address;
  const remote = address ? `http://${address}:${agentPort}` : undefined;
  const registration: Registration = {
    id: 'on-demand-model', port, execution: 'http', reachability: 'localhost', sharing: 'local',
    capabilities: ['embed-model'],
    metadata: { embedding_provider: advertisement },
  };
  const register = (overrides: Partial<Registration> = {}) => request(base, '/services', 'POST', { ...registration, ...overrides });
  return { ...agent, base, remote, port, calls, registration, register };
}

function request(base: string, route: string, method: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${route}`, {
    method, headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function json(base: string, route: string): Promise<Record<string, any>> {
  const response = await fetch(`${base}${route}`);
  assert.equal(response.status, 200, route);
  return await response.json() as Record<string, any>;
}

test('generic service sharing defaults to network and remains independent of reachability', () => {
  const registry = new ServiceRegistry({ storagePath: false });
  const service = registry.register({ id: 'legacy', port: 8766, reachability: 'localhost' });
  assert.equal(service.sharing, 'network');
  const shared = registry.toServices('fixture') as { sharing?: string; reachability?: string }[];
  assert.equal(shared[0]!.sharing, 'network');
  assert.equal(shared[0]!.reachability, 'localhost');
  registry.register({ id: 'private', port: 8767, reachability: 'network', sharing: 'local' });
  assert.equal((registry.toServices('fixture') as { sharing?: string }[])[1]!.sharing, 'local');
});

test('generic HTTP registration validates sharing before updating an existing service', async t => {
  const f = await fixture(t);
  assert.equal((await f.register()).status, 201);
  for (const sharing of ['localhost', 'private', '', null, false, 1, [], {}]) {
    const response = await f.register({ sharing } as Partial<Registration>);
    assert.equal(response.status, 400, JSON.stringify(sharing));
    assert.match((await response.json() as { error: string }).error, /sharing/);
    assert.equal(f.registry.get('on-demand-model')!.sharing, 'local');
  }
  assert.equal((await f.register({ sharing: undefined })).status, 201);
  assert.equal(f.registry.get('on-demand-model')!.sharing, 'network');
  const health = await json(f.base, '/health');
  assert.equal(health.service_sharing, 'dreammate.service-sharing.v1');
});

test('local embedding services are hidden on every gateway route without waking the upstream', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  if (!f.remote) return t.skip('No non-loopback IPv4 interface is available');
  assert.equal((await f.register()).status, 201);
  f.registry.register({ id: 'legacy', port: f.port, reachability: 'localhost' });
  for (const [base, ids] of [[f.base, ['on-demand-model', 'legacy']], [f.remote, ['legacy']]] as const) {
    assert.equal((await json(base, '/health')).services, ids.length);
    for (const route of ['/services', '/manifest']) {
      assert.deepEqual((await json(base, route)).services.map((service: { id: string }) => service.id).sort(), [...ids].sort());
    }
  }
  const routes: [string, string, unknown?][] = [
    ['/services/on-demand-model', 'GET'],
    ['/services/on-demand-model/methods/embed-model', 'GET'],
    ['/services/on-demand-model/embed', 'POST', payload],
    ['/services/on-demand-model/invoke', 'POST', { method: 'embed-model' }],
    ['/capabilities/embed-model/invoke', 'POST', {}],
    ['/services/on-demand-model/start', 'POST'],
    ['/services/on-demand-model/stop', 'POST'],
    ['/services/on-demand-model/skills/private/archive', 'GET'],
    ['/services/on-demand-model', 'DELETE'],
  ];
  for (const [route, method, body] of routes) {
    const response = await request(f.remote, route, method, body, { 'X-Forwarded-For': '127.0.0.1' });
    assert.equal(response.status, 404, route);
    assert.equal(response.headers.get('etag'), null);
    await response.json();
  }
  assert.equal(f.calls.length, 0, 'hidden requests must never wake the model');
  const local = await request(f.base, '/services/on-demand-model/embed', 'POST', payload, { 'X-Forwarded-For': '198.51.100.7' });
  assert.equal(local.status, 200, 'loopback is shared by every local agent regardless of forwarded headers');
  assert.deepEqual(await local.json(), answer);
  assert.equal(f.calls.length, 1);
});

test('embedding sharing changes take effect immediately without changing the listening address', async t => {
  const f = await fixture(t);
  if (!f.remote) return t.skip('No non-loopback IPv4 interface is available');
  await f.register();
  assert.equal((await request(f.remote, '/services/on-demand-model/embed', 'POST', payload)).status, 404);
  await f.register({ sharing: 'network' });
  assert.equal((await request(f.remote, '/services/on-demand-model/embed', 'POST', payload)).status, 200);
  assert.equal(f.registry.get('on-demand-model')!.reachability, 'localhost');
  assert.equal((await request(f.remote, '/capabilities/embed-model/invoke', 'POST', {})).status, 200);
  assert.equal(f.calls.length, 2);
  await f.register({ sharing: 'local' });
  assert.equal((await request(f.remote, '/services/on-demand-model/embed', 'POST', payload)).status, 404);
  assert.equal((await request(f.remote, '/capabilities/embed-model/invoke', 'POST', {})).status, 404);
  assert.equal(f.calls.length, 2);
});

for (const revoke of ['local', 'delete'] as const) test(`a network embedding request cannot wake the model after ${revoke} revocation while reading its body`, { timeout: 15000 }, async t => {
  const f = await fixture(t);
  if (!f.remote) return t.skip('No non-loopback IPv4 interface is available');
  await f.register({ sharing: 'network' });
  let bodyReaderReady!: () => void;
  const reading = new Promise<void>(resolve => { bodyReaderReady = resolve; });
  f.server.on('request', req => {
    if (req.url === '/services/on-demand-model/embed') {
      req.on('newListener', event => { if (event === 'data') bodyReaderReady(); });
    }
  });
  let client!: ReturnType<typeof httpRequest>;
  const completed = new Promise<number>((resolve, reject) => {
    client = httpRequest(`${f.remote}/services/on-demand-model/embed`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
    }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode!));
    });
    client.on('error', reject);
    client.flushHeaders();
  });
  await reading;
  const body = JSON.stringify(payload);
  client.write(body.slice(0, -1));
  if (revoke === 'local') assert.equal((await f.register({ sharing: 'local' })).status, 201);
  else assert.equal((await request(f.base, '/services/on-demand-model', 'DELETE')).status, 200);
  client.end(body.slice(-1));
  assert.equal(await completed, 404);
  assert.equal(f.calls.length, 0);
});

test('skill aggregate aliases filter local providers before selection and ambiguity checks', async t => {
  const f = await fixture(t);
  if (!f.remote) return t.skip('No non-loopback IPv4 interface is available');
  const skill: Registration = {
    id: 'private-skills', port: f.port, execution: 'http', sharing: 'local',
    capabilities: ['catalog'], metadata: { skill_provider: { protocol: 'dreammate.skills.v1' } },
  };
  f.registry.register(skill);
  assert.equal((await fetch(`${f.base}/skills`)).status, 200);
  const before = f.calls.length;
  for (const route of ['/skills', `/skills/private?revision=${'a'.repeat(64)}`]) {
    const response = await fetch(`${f.remote}${route}`);
    assert.equal(response.status, 503, route);
    assert.doesNotMatch(JSON.stringify(await response.json()), /private-skills|visible-skill/);
  }
  assert.equal((await request(f.remote, '/capabilities/catalog/invoke', 'POST', {})).status, 404);
  assert.equal(f.calls.length, before, 'aggregate aliases cannot bypass local sharing');
  f.registry.register({ ...skill, id: 'published-skills', sharing: 'network' });
  assert.equal((await fetch(`${f.remote}/skills`)).status, 200, 'the hidden provider cannot create remote ambiguity');
  assert.equal((await fetch(`${f.base}/skills`)).status, 409, 'both providers remain visible locally');
});

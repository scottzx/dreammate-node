import assert from 'node:assert/strict';
import http, { type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { createAgent } from '../src/server.js';
import { ServiceRegistry, type Registration } from '../src/registry.js';

const advertisement = { protocol: 'dreammate.embedding.v1', model: 'qwen3', revision: 'fixture-sha',
  dimensions: 2, encoding: 'float32', ready: true };
const payload = { texts: ['读取文件'], input_type: 'query' };
const answer = { model: 'qwen3@fixture-sha', encoding: 'float32', embeddings: [[0.6, 0.8]] };

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function fixture(t: TestContext, handler?: RequestListener) {
  const received: unknown[] = [];
  const upstream = http.createServer(handler ?? ((req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/embed');
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      received.push(JSON.parse(raw));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(answer));
    });
  }));
  const port = await listen(upstream);
  t.after(() => close(upstream));
  const registry = new ServiceRegistry({ storagePath: false });
  const register = (override: Partial<Registration> = {}) => registry.register({ id: 'local-embedding', port,
    execution: 'http', reachability: 'localhost', metadata: { embedding_provider: advertisement }, ...override });
  register();
  const { server } = createAgent({ registry });
  const agentPort = await listen(server);
  t.after(() => close(server));
  const base = `http://127.0.0.1:${agentPort}`;
  const post = (body: unknown = payload, id = 'local-embedding') => fetch(`${base}/services/${encodeURIComponent(id)}/embed`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { received, registry, register, post, base, port };
}

test('embedding proxy exposes a localhost provider through only its registered gateway port', async t => {
  const f = await fixture(t);
  let response = await f.post();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), answer);
  assert.deepEqual(f.received, [{ ...payload, model: 'qwen3' }]);
  response = await f.post({ model: 'qwen3', texts: ['one', 'two'], input_type: 'document' });
  assert.equal(response.status, 502, 'Upstream batch size must match the request');
});

test('embedding proxy rejects absent, undeclared and malformed providers without forwarding', async t => {
  const f = await fixture(t);
  assert.equal((await f.post(payload, 'missing')).status, 404);
  f.register({ metadata: {} });
  assert.equal((await f.post()).status, 404);
  for (const invalid of [{ ...advertisement, protocol: 'other' }, { ...advertisement, dimensions: 0 },
    { ...advertisement, revision: '' }, { ...advertisement, encoding: '' }]) {
    f.register({ metadata: { embedding_provider: invalid } });
    assert.equal((await f.post()).status, 400);
  }
  assert.equal(f.received.length, 0);
});

test('embedding proxy refuses disabled, down, unready, CLI and missing-port services', async t => {
  const f = await fixture(t);
  f.register({ metadata: { enabled: false, embedding_provider: advertisement } });
  assert.equal((await f.post()).status, 503);
  const down = f.register();
  down.liveness = 'down';
  assert.equal((await f.post()).status, 503);
  f.register({ metadata: { embedding_provider: { ...advertisement, ready: false } } });
  assert.equal((await f.post()).status, 503);
  for (const invalid of [{ port: undefined }, { port: 1.5 }, { execution: 'cli' as const },
    { execution: 'hybrid' as const }, { execution: 'http' as const, command: 'must-never-run' }]) {
    f.register(invalid);
    assert.equal((await f.post()).status, 503);
  }
  assert.equal(f.received.length, 0);
});

test('embedding proxy ignores arbitrary advertised URLs and rejects non-embedding payloads', async t => {
  const f = await fixture(t);
  f.register({ metadata: { embedding_provider: { ...advertisement, url: 'http://external.invalid/embed',
    endpoint: 'http://external.invalid/invoke' } } });
  assert.equal((await f.post()).status, 200, 'Only the registry port is used');
  assert.equal(f.received.length, 1);
  for (const invalid of [null, [], { method: 'shell.exec', params: {} },
    { ...payload, model: 'other-model' }, { ...payload, input_type: 'invoke' }, { ...payload, texts: [] },
    { ...payload, texts: [''] }, { ...payload, texts: [1] }, { ...payload, texts: ['x'.repeat(8193)] },
    { ...payload, texts: Array(65).fill('text') }, { ...payload, url: 'http://external.invalid' }, { ...payload, method: 'run' }]) {
    assert.equal((await f.post(invalid)).status, 400);
  }
  const malformed = await fetch(`${f.base}/services/local-embedding/embed`, { method: 'POST', body: '{' });
  assert.equal(malformed.status, 400);
  assert.equal(f.received.length, 1);
});

test('embedding proxy bounds request bodies at 256 KiB before upstream forwarding', async t => {
  const f = await fixture(t);
  const response = await fetch(`${f.base}/services/local-embedding/embed`, { method: 'POST', body: 'x'.repeat(256 * 1024 + 1) });
  assert.equal(response.status, 413);
  assert.equal(f.received.length, 0);
});

test('embedding proxy does not follow upstream redirects', async t => {
  let calls = 0;
  const f = await fixture(t, (_req, res) => {
    calls++;
    res.writeHead(307, { location: 'http://external.invalid/embed' });
    res.end();
  });
  assert.equal((await f.post()).status, 502);
  assert.equal(calls, 1);
});

test('embedding proxy rejects upstream model/encoding drift and malformed JSON', async t => {
  let responseBody = JSON.stringify({ ...answer, model: 'qwen3@different-sha' });
  const f = await fixture(t, (_req, res) => { res.end(responseBody); });
  assert.equal((await f.post()).status, 502);
  responseBody = JSON.stringify({ ...answer, encoding: 'int8' });
  assert.equal((await f.post()).status, 502);
  responseBody = JSON.stringify({ ...answer, encoding: undefined });
  assert.equal((await f.post()).status, 502);
  responseBody = '{';
  assert.equal((await f.post()).status, 502);
});

test('embedding proxy aborts a stalled upstream when its client disconnects', async t => {
  let upstreamStarted!: () => void;
  let upstreamClosed!: () => void;
  const started = new Promise<void>(resolve => { upstreamStarted = resolve; });
  const closed = new Promise<void>(resolve => { upstreamClosed = resolve; });
  const f = await fixture(t, (_req, res) => {
    res.on('close', upstreamClosed);
    upstreamStarted();
  });
  const request = http.request(`${f.base}/services/local-embedding/embed`, { method: 'POST', headers: { 'content-type': 'application/json' } });
  request.on('error', () => {});
  request.end(JSON.stringify(payload));
  await started;
  request.destroy();
  await Promise.race([closed, new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Client disconnect did not abort the upstream request')), 1000);
    timer.unref();
    closed.then(() => clearTimeout(timer));
  })]);
});

test('embedding proxy total upstream deadline also bounds a stalled JSON response body', async t => {
  const f = await fixture(t);
  const originalFetch = globalThis.fetch;
  let readingBody!: () => void;
  const reading = new Promise<void>(resolve => { readingBody = resolve; });
  let upstreamSignal: AbortSignal | null | undefined;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) !== `http://127.0.0.1:${f.port}/embed`) return originalFetch(url, init);
    assert.equal(init?.redirect, 'error');
    upstreamSignal = init?.signal;
    return { ok: true, json: () => { readingBody(); return new Promise(() => {}); } } as unknown as Response;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = f.post();
  await reading;
  t.mock.timers.tick(60000);
  t.mock.timers.reset();
  const response = await pending;
  assert.equal(response.status, 504);
  assert.equal((await response.json() as { kind: string }).kind, 'timeout');
  assert.equal(upstreamSignal?.aborted, true);
});

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { callDreammateTool } from '../src/mcp.js';
import type { RegisteredService } from '../src/registry.js';

const localUrl = 'http://127.0.0.1:36908';
const remoteUrl = 'http://100.64.0.2:36908';
const providerId = 'embedding/model';
const endpoint = `${remoteUrl}/services/${encodeURIComponent(providerId)}/embed`;
const encoding = 'tools-v1|max_length=512|dtype=float32';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
const dataOf = (result: Awaited<ReturnType<typeof callDreammateTool>>) =>
  (result.structuredContent ?? JSON.parse((result.content[0] as { text: string }).text)) as Record<string, any>;
let fixtureNumber = 0;

function fixture(t: TestContext) {
  // Automatic discovery must not depend on the developer's explicit overrides.
  for (const name of ['DREAMMATE_EMBEDDING_URL', 'DREAMMATE_EMBEDDING_MODEL', 'DREAMMATE_EMBEDDING_MIN_SCORE']) {
    const previous = process.env[name];
    delete process.env[name];
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  const revision = `fixture-${++fixtureNumber}`;
  const local: RegisteredService = { id: 'project-files', name: '项目文件服务', port: 31000,
    registeredAt: '2026-10-10T00:00:00Z', liveness: 'up', failures: 0,
    methods: Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`files.read_${i}`, {
      description: '读取项目文件内容', parameters: { type: 'object', properties: {
        secretSchemaNeedle: { type: 'string', description: 'Full contract must stay out of discovery results' },
      } },
    }])) };
  const provider: RegisteredService = { id: providerId, port: 8766, execution: 'http', reachability: 'localhost',
    registeredAt: '2026-10-10T00:00:00Z', liveness: 'up', failures: 0, metadata: { embedding_provider: {
      protocol: 'dreammate.embedding.v1', model: 'qwen3', revision, dimensions: 2, encoding, ready: true,
      url: 'https://external.invalid/embed', endpoint: 'http://100.64.0.99:1234/embed',
    } } };
  const requests: { url: string; type?: string; model?: string }[] = [];
  let remoteStatus = 200;
  t.mock.method(globalThis, 'fetch', async (rawUrl: string | URL | Request, init?: RequestInit) => {
    const url = String(rawUrl);
    const request: { url: string; type?: string; model?: string } = { url };
    requests.push(request);
    if (url === `${localUrl}/nodes`) return json({ nodes: [
      { node_id: 'self', name: 'business-host', type: 'macos', is_self: true, online: true, network_online: true },
      { node_id: 'remote', name: 'model-host', type: 'linux', ipv4: '100.64.0.2', is_self: false, online: true },
    ] });
    if (url === `${localUrl}/services`) return json({ node: 'business-host', services: [local] });
    if (url === `${remoteUrl}/services`) return remoteStatus === 200
      ? json({ node: 'model-host', services: [provider] }) : json({ error: 'Gateway unavailable' }, remoteStatus);
    assert.equal(url, endpoint, 'Provider metadata must never nominate another host or bypass its gateway');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    const body = JSON.parse(String(init?.body)) as { model: string; texts: string[]; input_type: string };
    assert.equal(body.model, 'qwen3');
    assert.ok(['query', 'document'].includes(body.input_type));
    assert.ok(Array.isArray(body.texts) && body.texts.length > 0 && body.texts.length <= 16);
    Object.assign(request, { type: body.input_type, model: body.model });
    return json({ model: `qwen3@${revision}`, encoding, embeddings: body.texts.map(() => [1, 0]) });
  });
  const search = (args: Record<string, unknown> = {}) => callDreammateTool('dreammate_search_tools', {
    query: '读取项目文件', ...args,
  }, { agentUrl: localUrl, embeddingTimeoutMs: 200 });
  return { local, provider, revision, requests, search, failRemote: () => { remoteStatus = 503; } };
}

function boundedCards(body: Record<string, any>) {
  assert.equal(body.limit, 15);
  assert.equal(body.max_chars, 12000);
  assert.ok(body.returned > 0 && body.returned <= 15);
  assert.equal(body.returned, body.results.length);
  assert.ok(JSON.stringify(body, null, 2).length <= 12000);
  assert.doesNotMatch(JSON.stringify(body), /secretSchemaNeedle|"parameters"|"properties"|"embedding_provider"/);
}

test('MCP automatically discovers a remote localhost-only model service through its private gateway', async t => {
  const f = fixture(t);
  const result = await f.search();
  const body = dataOf(result);
  assert.equal(result.isError, undefined);
  assert.equal(body.scope, 'all');
  assert.equal(body.partial, false);
  assert.equal(body.search.mode, 'hybrid');
  assert.equal(body.search.semantic_status, 'ok');
  assert.equal(body.search.model, `qwen3@${f.revision}`);
  assert.equal(body.search.encoding, encoding);
  assert.deepEqual(body.search.provider, { source: 'discovered', node: 'model-host', service_id: providerId });
  assert.equal(body.search.provider_candidates, 1);
  assert.ok(f.requests.some(request => request.url === endpoint && request.type === 'query'));
  assert.ok(f.requests.some(request => request.url === endpoint && request.type === 'document'));
  assert.ok(body.results.every((card: any) => card.node === 'business-host' && card.service_id === f.local.id));
  boundedCards(body);
});

test('MCP business-service filtering retains providers discovered in the same node scope', async t => {
  const f = fixture(t);
  const body = dataOf(await f.search({ service_id: f.local.id }));
  assert.equal(body.scope, 'all');
  assert.equal(body.search.semantic_status, 'ok');
  assert.equal(body.search.provider.service_id, providerId);
  assert.equal(body.total_candidates, 24);
  assert.ok(body.results.every((card: any) => card.service_id === f.local.id));
  assert.ok(f.requests.some(request => request.url === endpoint && request.type === 'query'));
  boundedCards(body);
});

test('MCP explicit localhost scope cannot see a remote provider and keeps lexical results bounded', async t => {
  const f = fixture(t);
  const result = await f.search({ node: 'localhost' });
  const body = dataOf(result);
  assert.equal(result.isError, undefined);
  assert.equal(body.scope, 'localhost');
  assert.equal(body.partial, false);
  assert.equal(body.search.mode, 'lexical');
  assert.equal(body.search.semantic_status, 'no_provider');
  assert.equal(body.search.provider_candidates, 0);
  assert.deepEqual(f.requests.map(request => request.url), [`${localUrl}/services`]);
  boundedCards(body);
});

test('MCP excludes unready, down and disabled advertisements from automatic selection', async t => {
  for (const state of ['unready', 'down', 'disabled']) {
    await t.test(state, async child => {
      const f = fixture(child);
      if (state === 'unready') (f.provider.metadata!.embedding_provider as { ready: boolean }).ready = false;
      if (state === 'down') f.provider.liveness = 'down';
      if (state === 'disabled') f.provider.metadata!.enabled = false;
      const body = dataOf(await f.search());
      assert.equal(body.search.mode, 'lexical');
      assert.equal(body.search.semantic_status, 'no_provider');
      assert.equal(body.search.provider_candidates, 0);
      assert.ok(f.requests.every(request => !request.url.endsWith('/embed')));
      boundedCards(body);
    });
  }
});

test('MCP no_provider remains scoped evidence when an advertised peer gateway could not be scanned', async t => {
  const f = fixture(t);
  f.failRemote();
  const result = await f.search();
  const body = dataOf(result);
  assert.equal(result.isError, undefined, 'A failed peer must not erase the successful local catalog');
  assert.equal(body.scope, 'all');
  assert.equal(body.partial, true);
  assert.equal(body.search.semantic_status, 'no_provider');
  assert.match(body.search.fallback_reason, /本次可查询范围/);
  assert.equal(body.scan_count, 2);
  assert.equal(body.scan_status_counts.ok, 1);
  assert.equal(body.scan_status_counts.http_error, 1);
  assert.deepEqual(body.scans.map((scan: any) => scan.status), ['ok', 'http_error']);
  assert.ok(f.requests.every(request => !request.url.endsWith('/embed')));
  boundedCards(body);
});

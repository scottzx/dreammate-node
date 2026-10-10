import assert from 'node:assert/strict';
import test from 'node:test';
import { searchTools } from '../src/tool-search.js';
import type { EmbeddingProvider } from '../src/embedding-providers.js';
import type { RegisteredService } from '../src/registry.js';

interface EmbeddingRequest { model?: string; texts: string[]; input_type: 'query' | 'document' }
interface RecordedRequest { endpoint: string; body: EmbeddingRequest }

function provider(tag: string, dimensions = 2): EmbeddingProvider {
  return { endpoint: `http://127.0.0.1:8780/services/routing-${tag}/embed`, model: `routing-${tag}`,
    expectedModel: `routing-${tag}@revision-1`, dimensions, encoding: `routing-profile-${tag}`,
    node: `node-${tag}`, service_id: `service-${tag}`, priority: 0 };
}

function corpus(count = 30): (RegisteredService & { node: string })[] {
  return [{ id: 'routing-tools', node: 'tool-node', name: 'Utility tools', registeredAt: '', liveness: 'unknown', failures: 0,
    methods: Object.fromEntries([
      ['memory.lookup', { description: 'Retrieve named entities and their observations' }],
      ...Array.from({ length: count }, (_, i) => [`audio.action${i}`, { description: `音频处理工具 ${i}` }]),
    ]) }];
}

function response(selected: EmbeddingProvider, body: EmbeddingRequest) {
  const vector = (positive: boolean) => selected.dimensions === 2 ? [positive ? 1 : -1, 0] : [0, 0, positive ? 1 : -1];
  return { model: selected.expectedModel, encoding: selected.encoding, embeddings: body.texts.map(text =>
    vector(body.input_type === 'query' || text.includes('Method: memory.lookup'))) };
}

function request(rawUrl: unknown, init?: RequestInit): RecordedRequest {
  assert.ok(init?.body);
  assert.equal(init.redirect, 'error');
  return { endpoint: String(rawUrl), body: JSON.parse(init.body as string) as EmbeddingRequest };
}

const resultsOf = (value: Record<string, unknown>) => value.results as { method: string; semantic_score?: number }[];
const searchOf = (value: Record<string, unknown>) => value.search as Record<string, any>;

test('no discovered provider keeps lexical retrieval bounded without making model requests', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('no provider must mean no embedding request'); });
  const result = await searchTools(corpus(40), { query: '音频', limit: 2, max_chars: 3000 }, { embeddingProviders: [] });
  assert.equal(searchOf(result).mode, 'lexical');
  assert.equal(searchOf(result).semantic_status, 'no_provider');
  assert.equal(resultsOf(result).length, 2);
  assert.equal(result.total_matched, 40);
  assert.ok(JSON.stringify(result, null, 2).length <= 3000);
  assert.equal(fetch.mock.callCount(), 0);
});

test('one selected provider owns the query and all document batches; an unused backup is never queried', async t => {
  const first = provider('owner-first');
  const backup = provider('owner-backup', 3);
  const requests: RecordedRequest[] = [];
  t.mock.method(globalThis, 'fetch', async (rawUrl: unknown, init?: RequestInit) => {
    const recorded = request(rawUrl, init);
    requests.push(recorded);
    assert.equal(recorded.endpoint, first.endpoint);
    assert.equal(recorded.body.model, first.model);
    return Response.json(response(first, recorded.body));
  });
  const result = await searchTools(corpus(34), { query: '查找知识库中保存的实体' }, { embeddingProviders: [first, backup] });
  assert.equal(searchOf(result).semantic_status, 'ok');
  assert.equal(searchOf(result).model, first.expectedModel);
  assert.deepEqual(searchOf(result).provider, { source: 'discovered', node: first.node, service_id: first.service_id });
  assert.equal(requests.filter(r => r.body.input_type === 'query').length, 1);
  assert.deepEqual(requests.filter(r => r.body.input_type === 'document').map(r => r.body.texts.length), [16, 16, 3]);
  assert.equal(resultsOf(result)[0]?.method, 'memory.lookup');
});

test('a document failure after a validated batch restarts every document on the next provider without mixing vector spaces', async t => {
  const failed = provider('partial-first', 2);
  const backup = provider('partial-backup', 3);
  const requests: RecordedRequest[] = [];
  let failedDocumentBatches = 0;
  t.mock.method(globalThis, 'fetch', async (rawUrl: unknown, init?: RequestInit) => {
    const recorded = request(rawUrl, init);
    requests.push(recorded);
    if (recorded.endpoint === failed.endpoint) {
      if (recorded.body.input_type === 'document' && ++failedDocumentBatches === 2) return Response.json({ error: 'model process failed' }, { status: 503 });
      // The first model uses another dimension and coordinate system.
      return Response.json(response(failed, recorded.body));
    }
    assert.equal(recorded.endpoint, backup.endpoint);
    assert.equal(recorded.body.model, backup.model);
    return Response.json(response(backup, recorded.body));
  });
  const result = await searchTools(corpus(34), { query: '查找知识库中保存的实体' }, { embeddingProviders: [failed, backup] });
  assert.equal(searchOf(result).model, backup.expectedModel);
  assert.deepEqual(searchOf(result).provider_attempts.map((attempt: any) => attempt.status), ['failed', 'ok']);
  const backupRequests = requests.filter(r => r.endpoint === backup.endpoint);
  assert.equal(backupRequests.filter(r => r.body.input_type === 'query').length, 1);
  assert.deepEqual(backupRequests.filter(r => r.body.input_type === 'document').map(r => r.body.texts.length), [16, 16, 3],
    'all documents, including the first provider’s cached batch, must be embedded in the backup vector space');
  assert.deepEqual(resultsOf(result).map(card => card.method), ['memory.lookup']);
  assert.equal(resultsOf(result)[0]?.semantic_score, 1);
});

test('automatic failover attempts at most two providers', async t => {
  const candidates = [provider('bounded-first'), provider('bounded-second'), provider('bounded-third')];
  const endpoints: string[] = [];
  t.mock.method(globalThis, 'fetch', async (rawUrl: unknown, init?: RequestInit) => {
    const recorded = request(rawUrl, init);
    endpoints.push(recorded.endpoint);
    return Response.json({ error: 'offline model' }, { status: 503 });
  });
  const result = await searchTools(corpus(3), { query: '音频', limit: 2 }, { embeddingProviders: candidates });
  assert.equal(searchOf(result).semantic_status, 'unavailable');
  assert.deepEqual(searchOf(result).provider_attempts.map((attempt: any) => attempt.status), ['failed', 'failed']);
  assert.deepEqual(new Set(endpoints), new Set(candidates.slice(0, 2).map(candidate => candidate.endpoint)));
  assert.equal(resultsOf(result).length, 2);
});

test('two stalled providers share one total search deadline', async t => {
  const candidates = [provider('deadline-first'), provider('deadline-second')];
  const endpoints: string[] = [];
  t.mock.method(globalThis, 'fetch', async (rawUrl: unknown, init?: RequestInit) => {
    endpoints.push(request(rawUrl, init).endpoint);
    return { ok: true, json: () => new Promise(() => {}) } as unknown as Response;
  });
  const start = performance.now();
  const result = await searchTools(corpus(3), { query: '音频', limit: 1 }, { embeddingProviders: candidates, embeddingTimeoutMs: 50 });
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 150, `two attempts exceeded the shared 50 ms budget: ${elapsed.toFixed(1)} ms`);
  assert.equal(searchOf(result).semantic_status, 'unavailable');
  assert.equal(searchOf(result).provider_attempts.length, 2);
  assert.deepEqual(new Set(endpoints), new Set(candidates.map(candidate => candidate.endpoint)));
  assert.equal(resultsOf(result).length, 1);
});

test('explicit endpoint takes precedence and its failure does not invoke discovered providers', async t => {
  const automatic = provider('manual-backup');
  const endpoints: string[] = [];
  t.mock.method(globalThis, 'fetch', async (rawUrl: unknown, init?: RequestInit) => {
    endpoints.push(request(rawUrl, init).endpoint);
    return Response.json({ error: 'manual endpoint unavailable' }, { status: 503 });
  });
  const result = await searchTools(corpus(3), { query: '音频', limit: 1 }, {
    embeddingUrl: 'http://127.0.0.1:8781', embeddingModel: 'routing-manual', embeddingProviders: [automatic],
  });
  assert.equal(searchOf(result).semantic_status, 'unavailable');
  assert.ok(endpoints.length > 0);
  assert.ok(endpoints.every(endpoint => endpoint === 'http://127.0.0.1:8781/embed'));
  assert.equal(searchOf(result).provider, undefined);
  assert.equal(searchOf(result).provider_attempts, undefined);
});

test('an explicit empty endpoint disables automatic selection', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('automatic embeddings were explicitly disabled'); });
  const result = await searchTools(corpus(3), { query: '音频', limit: 1 }, {
    embeddingUrl: '', embeddingProviders: [provider('disabled-auto')],
  });
  assert.equal(searchOf(result).mode, 'lexical');
  assert.equal(searchOf(result).semantic_status, 'not_configured');
  assert.equal(fetch.mock.callCount(), 0);
});

test('the minimum time budget returns a settled fallback status rather than pending', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'offline' }, { status: 503 }));
  const result = await searchTools(corpus(3), { query: '音频', limit: 1 }, {
    embeddingTimeoutMs: 1, embeddingProviders: [provider('minimum-budget')],
  });
  assert.equal(searchOf(result).mode, 'lexical');
  assert.equal(searchOf(result).semantic_status, 'unavailable');
  assert.equal(resultsOf(result).length, 1);
});

test('revision, dimensions and encoding mismatches reject the candidate and recover with the backup', async t => {
  const cases = ['revision', 'dimensions', 'encoding', 'missing-encoding'] as const;
  const candidates = new Map<string, EmbeddingProvider>();
  for (const fault of cases) {
    const bad = provider(`mismatch-${fault}`, 2);
    const good = provider(`recovered-${fault}`, 3);
    candidates.set(bad.endpoint, bad);
    candidates.set(good.endpoint, good);
  }
  t.mock.method(globalThis, 'fetch', async (rawUrl: unknown, init?: RequestInit) => {
    const recorded = request(rawUrl, init);
    const selected = candidates.get(recorded.endpoint);
    assert.ok(selected);
    const body: Record<string, unknown> = response(selected, recorded.body);
    if (selected.model.startsWith('routing-mismatch-')) {
      const fault = selected.model.slice('routing-mismatch-'.length);
      if (fault === 'revision') body.model = `${selected.model}@unexpected-revision`;
      if (fault === 'dimensions') body.embeddings = recorded.body.texts.map(() => [0, 0, 1]);
      if (fault === 'encoding') body.encoding = 'unexpected-profile';
      if (fault === 'missing-encoding') delete body.encoding;
    }
    return Response.json(body);
  });
  for (const fault of cases) {
    const bad = candidates.get(provider(`mismatch-${fault}`).endpoint)!;
    const good = candidates.get(provider(`recovered-${fault}`).endpoint)!;
    const result = await searchTools(corpus(3), { query: '查找知识库中保存的实体' }, { embeddingProviders: [bad, good] });
    assert.equal(searchOf(result).model, good.expectedModel, `${fault} must not use unverified vectors`);
    assert.deepEqual(searchOf(result).provider_attempts.map((attempt: any) => attempt.status), ['failed', 'ok']);
    assert.deepEqual(resultsOf(result).map(card => card.method), ['memory.lookup']);
  }
});

test('document caches isolate revisions and encoding profiles even on the same provider endpoint', async t => {
  const initial = provider('cache-isolation');
  let active = initial;
  const documentBatches: number[] = [];
  t.mock.method(globalThis, 'fetch', async (rawUrl: unknown, init?: RequestInit) => {
    const recorded = request(rawUrl, init);
    assert.equal(recorded.endpoint, active.endpoint);
    if (recorded.body.input_type === 'document') documentBatches.push(recorded.body.texts.length);
    return Response.json(response(active, recorded.body));
  });
  const tools = corpus(5);
  const run = () => searchTools(tools, { query: '查找知识库中保存的实体' }, { embeddingProviders: [active] });
  await run();
  assert.deepEqual(documentBatches, [6]);
  await run();
  assert.deepEqual(documentBatches, [6], 'unchanged provider identity reuses document vectors');
  active = { ...initial, expectedModel: `${initial.model}@revision-2` };
  const newRevision = await run();
  assert.equal(searchOf(newRevision).model, active.expectedModel);
  assert.deepEqual(documentBatches, [6, 6], 'a new revision cannot reuse old document vectors');
  active = { ...active, encoding: `${initial.encoding}-new-profile` };
  const newProfile = await run();
  assert.equal(searchOf(newProfile).encoding, active.encoding);
  assert.deepEqual(documentBatches, [6, 6, 6], 'a new encoding profile cannot reuse same-model document vectors');
});

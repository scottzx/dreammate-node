import assert from 'node:assert/strict';
import test from 'node:test';
import { EMBEDDING_PROTOCOL, discoverEmbeddingProviders, parseEmbeddingAdvertisement, type EmbeddingService } from '../src/embedding-providers.js';

function service(overrides: Partial<EmbeddingService> = {}, advertisement: Record<string, unknown> = {}): EmbeddingService {
  return {
    id: 'local-embeddings', node: 'mac', gateway_url: 'http://100.64.0.2:36908', port: 8766,
    execution: 'http', reachability: 'localhost', registeredAt: '2026-10-10T00:00:00Z', failures: 0, liveness: 'up',
    metadata: { embedding_provider: {
      protocol: EMBEDDING_PROTOCOL, model: 'qwen3', revision: 'snapshot-v1', dimensions: 1024,
      encoding: 'tools-v1|max_length=512', ready: true, ...advertisement,
    } }, ...overrides,
  };
}

test('a valid opt-in advertisement yields one private gateway provider without requiring kind', () => {
  const registered = service();
  assert.equal(parseEmbeddingAdvertisement(registered)?.priority, 0);
  assert.deepEqual(discoverEmbeddingProviders([registered]), [{
    endpoint: 'http://100.64.0.2:36908/services/local-embeddings/embed', model: 'qwen3', expectedModel: 'qwen3@snapshot-v1',
    dimensions: 1024, encoding: 'tools-v1|max_length=512', node: 'mac', service_id: 'local-embeddings', priority: 0,
  }]);
  assert.equal(discoverEmbeddingProviders([service({ execution: undefined })]).length, 1);
  assert.deepEqual(discoverEmbeddingProviders([]), []);
  assert.deepEqual(discoverEmbeddingProviders([service({ metadata: undefined })]), []);
});

test('disabled, down, unready and unsafe execution services are not automatic providers', () => {
  const invalid = [
    service({ metadata: { ...service().metadata, enabled: false } }), service({ liveness: 'down' }),
    service({}, { ready: false }), service({ port: undefined }), service({ port: 0 }), service({ port: 65536 }),
    service({ port: 8766.5 }), service({ execution: 'cli' }), service({ execution: 'hybrid' }), service({ command: 'unexpected-command' }),
  ];
  for (const registered of invalid) {
    assert.deepEqual(discoverEmbeddingProviders([registered]), []);
  }
  assert.ok(parseEmbeddingAdvertisement(service({ liveness: 'down' })), 'metadata parsing remains independent of service health');
});

test('advertisement parsing validates versions, dimensions, encoding and bounded priority', () => {
  for (const embedding_provider of [undefined, null, [], {}, 'invalid']) {
    assert.equal(parseEmbeddingAdvertisement(service({ metadata: { embedding_provider } })), undefined);
  }
  for (const advertisement of [
    { protocol: 'another.protocol' }, { model: '' }, { model: ' qwen3' }, { model: 'embeddinggemma2' }, { revision: '' }, { revision: ' ' },
    { encoding: '' }, { encoding: 'x'.repeat(201) }, { dimensions: 0 }, { dimensions: 4097 }, { dimensions: 4.5 },
    { dimensions: '1024' }, { priority: NaN }, { priority: 1001 }, { priority: -1001 }, { priority: '0' }, { priority: null }, { ready: 1 },
  ]) assert.equal(parseEmbeddingAdvertisement(service({}, advertisement)), undefined);
  assert.equal(parseEmbeddingAdvertisement(service({}, { dimensions: 1, priority: -1000 }))?.dimensions, 1);
  assert.equal(parseEmbeddingAdvertisement(service({}, { dimensions: 4096, priority: 1000 }))?.priority, 1000);
});

test('automatic endpoints come only from scanned private gateways and encode the service ID', () => {
  const registered = service({ id: 'embedding/model #1', gateway_url: 'http://127.0.0.1:36908/' }, {
    url: 'https://external.example/embed', endpoint: 'http://100.64.0.99:8888/embed',
  });
  const [provider] = discoverEmbeddingProviders([registered]);
  assert.equal(provider?.endpoint, 'http://127.0.0.1:36908/services/embedding%2Fmodel%20%231/embed');
  for (const gateway_url of [undefined, 'https://public.example', 'http://8.8.8.8:36908', 'http://127.0.0.1.evil.test',
    'http://user:pass@127.0.0.1:36908', 'file:///tmp/agent', 'http://127.0.0.1:36908/?token=secret', 'http://127.0.0.1:36908/#fragment']) {
    assert.deepEqual(discoverEmbeddingProviders([service({ gateway_url })]), []);
  }
  assert.equal(discoverEmbeddingProviders([service({ gateway_url: 'http://[::1]:36908' })])[0]?.endpoint,
    'http://[::1]:36908/services/local-embeddings/embed');
  assert.equal(discoverEmbeddingProviders([service({ gateway_url: 'http://100.64.0.2:36908/internal/gateway/' })])[0]?.endpoint,
    'http://100.64.0.2:36908/internal/gateway/services/local-embeddings/embed');
});

test('multiple Qwen providers use priority then health and a stable endpoint order', () => {
  const candidates = [
    service({ gateway_url: 'http://100.64.0.8:36908', liveness: 'unknown' }),
    service({ gateway_url: 'http://100.64.0.7:36908' }),
    service({ gateway_url: 'http://100.64.0.6:36908' }, { model: 'embeddinggemma2' }),
    service({ gateway_url: 'http://100.64.0.5:36908' }, { priority: 1 }),
    service({ gateway_url: 'http://100.64.0.4:36908' }),
    service({ gateway_url: 'http://100.64.0.3:36908' }),
  ];
  const ordered = discoverEmbeddingProviders(candidates);
  assert.deepEqual(ordered.map(provider => new URL(provider.endpoint).hostname), [
    '100.64.0.5', '100.64.0.3', '100.64.0.4', '100.64.0.7', '100.64.0.8',
  ]);
  assert.deepEqual(discoverEmbeddingProviders([...candidates].reverse()), ordered);
  assert.deepEqual(discoverEmbeddingProviders(candidates, 'embeddinggemma2'), []);
  assert.ok(discoverEmbeddingProviders(candidates, 'qwen3').every(provider => provider.model === 'qwen3'));
  assert.deepEqual(discoverEmbeddingProviders(candidates, 'unavailable-model'), []);
});

test('exact advertisements deduplicate while model revisions and encoding profiles remain isolated', () => {
  const base = service();
  const providers = discoverEmbeddingProviders([
    base, { ...base }, service({}, { revision: 'snapshot-v2' }), service({}, { encoding: 'tools-v2|max_length=512' }),
    service({}, { model: 'embeddinggemma2' }),
  ]);
  assert.equal(providers.length, 3);
  assert.ok(providers.some(provider => provider.expectedModel === 'qwen3@snapshot-v2'));
  assert.ok(providers.some(provider => provider.encoding === 'tools-v2|max_length=512'));
  assert.ok(providers.every(provider => provider.model === 'qwen3'));
});

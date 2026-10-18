import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createEmbeddingClient, embeddingProfile, isPrivateAddress } from '../src/embeddings.mjs';

const doc = { model: 'qwen3', revision: 'qwen-sha', dimensions: 2, encoding: 'dreammate.artifact-search.v1:fp32:max512:dim2', task: 'document_search' };
const vision = { model: 'embeddinggemma2', revision: 'gemma-sha', dimensions: 2, encoding: 'dreammate.gemma2.v1:fp32:max2048:dim2' };
function service(id, profile, priority = 100) {
  return { id, port: 8766, execution: 'http', liveness: 'up', methods: { 'embedding.encode_text': {}, 'embedding.encode_media': {}, 'embedding.status': {} },
    metadata: { embedding_provider: { ...profile, encoding: profile.encoding.replace('artifact-search', 'tool-search'), protocol: 'dreammate.embedding.v1', ready: true, priority } } };
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'artifact-embedding-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inbox = path.join(directory, 'inbox'); await mkdir(inbox);
  const calls = [];
  const services = options.services ?? [service('qwen', doc), service('gemma', vision, -10)];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = body ? JSON.parse(body) : undefined;
    calls.push({ url: request.url, payload });
    if (options.redirect) { response.writeHead(302, { location: 'http://8.8.8.8/collect' }); response.end(); return; }
    let value;
    if (request.url === '/services') value = { services };
    else if (payload?.method === 'embedding.status') value = { embedding_profiles: options.legacy ? [] : [doc], media_input: { root: inbox } };
    else {
      const profile = request.url.includes('gemma') ? vision : doc;
      value = { ...profile, alias: profile.model, model: `${profile.model}@${profile.revision}`,
        embeddings: (payload.params.items ?? payload.params.texts).map(() => [0.6, 0.8]) };
      if (options.invalidResult) value.encoding = 'dreammate.tool-search.v1:fp32:max512:dim2';
      if (options.onEncode) await options.onEncode(payload, value);
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(value));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const agent = `http://127.0.0.1:${server.address().port}`;
  return { directory, inbox, agent, calls, client: createEmbeddingClient({ agent }) };
}

test('profile fingerprint is stable across endpoints, rejects forged IDs and tool profiles', () => {
  const profile = embeddingProfile(doc);
  assert.deepEqual(embeddingProfile(profile), profile);
  assert.equal(profile.id, createHash('sha256').update(JSON.stringify(['qwen3', 'qwen-sha', 2, doc.encoding, 'document_search'])).digest('hex'));
  assert.throws(() => embeddingProfile({ ...profile, id: 'forged' }), /fingerprint/);
  assert.throws(() => embeddingProfile({ ...doc, encoding: doc.encoding.replace('artifact-search', 'tool-search') }), /Unsupported/);
  assert.throws(() => embeddingProfile({ ...doc, dimensions: 3 }), /dimension/);
});

test('private gateways allow LAN/Tailscale but reject public, credentials and paths', () => {
  for (const address of ['127.0.0.1', '10.2.3.4', '192.168.4.5', '172.16.5.6', '100.115.178.96', '::1', 'fd12::1']) assert.equal(isPrivateAddress(address), true, address);
  for (const address of ['8.8.8.8', '100.128.0.1', '172.32.0.1', '2001:4860:4860::8888']) assert.equal(isPrivateAddress(address), false, address);
  for (const agent of ['https://8.8.8.8', 'http://user:pass@localhost', 'http://localhost/other', 'file:///tmp/x']) assert.throws(() => createEmbeddingClient({ agent }));
});

test('text batches preserve one provider/profile and query uses document task', async t => {
  const f = await fixture(t);
  const encoded = await f.client.embedText(Array.from({ length: 34 }, (_, i) => `section ${i}`));
  assert.equal(encoded.vectors.length, 34);
  assert.equal(encoded.profile.task, 'document_search');
  const encodeCalls = f.calls.filter(call => call.payload?.method === 'embedding.encode_text');
  assert.deepEqual(encodeCalls.map(call => call.payload.params.texts.length), [16, 16, 2]);
  assert.equal(new Set(encodeCalls.map(call => call.url)).size, 1);
  const query = await f.client.embedQuery('revenue', encoded.profile);
  assert.equal(query.profile.id, encoded.profile.id);
  assert.equal(f.calls.at(-1).payload.params.task, 'document_search');
  assert.equal(f.calls.at(-1).payload.params.input_type, 'query');
});

test('UTF-8 text batching respects bytes as well as the sixteen-item cap', async t => {
  const f = await fixture(t);
  const result = await f.client.embedText(Array.from({ length: 16 }, () => '文'.repeat(8192)));
  assert.equal(result.vectors.length, 16);
  const calls = f.calls.filter(call => call.payload?.method === 'embedding.encode_text');
  assert.ok(calls.length > 1);
  for (const call of calls) {
    assert.ok(call.payload.params.texts.length <= 16);
    assert.ok(Buffer.byteLength(JSON.stringify(call.payload)) <= 262144);
  }
});

test('old supervisors and incompatible result metadata fail explicitly for lexical fallback', async t => {
  const old = await fixture(t, { legacy: true });
  await assert.rejects(old.client.embedText(['document']), /does not support the document_search profile/);
  assert.equal(old.calls.some(call => call.payload?.method === 'embedding.encode_text'), false);
  const bad = await fixture(t, { invalidResult: true });
  await assert.rejects(bad.client.embedText(['document']), /incompatible embedding profile/);
});

test('media copies bytes into existing shared inbox, batches four, and Gemma text query stays in its space', async t => {
  const f = await fixture(t);
  const image = path.join(f.directory, 'source.png'); await writeFile(image, 'fixture-image');
  const encoded = await f.client.embedMedia(Array.from({ length: 5 }, () => ({ modality: 'image', path: image })));
  assert.equal(encoded.profile.alias, 'embeddinggemma2');
  assert.equal(encoded.vectors.length, 5);
  const mediaCalls = f.calls.filter(call => call.payload?.method === 'embedding.encode_media');
  assert.deepEqual(mediaCalls.map(call => call.payload.params.items.length), [4, 1]);
  const relative = mediaCalls[0].payload.params.items[0].image;
  assert.equal(relative.startsWith('artifact-index/'), true);
  assert.equal(await readFile(path.join(f.inbox, relative), 'utf8'), 'fixture-image');
  assert.equal((await readdir(path.join(f.inbox, 'artifact-index'))).length, 1);
  const query = await f.client.embedQuery('眼镜', encoded.profile);
  assert.equal(query.profile.id, encoded.profile.id);
  assert.equal(f.calls.at(-1).url, '/services/gemma/invoke');
  assert.equal(f.calls.at(-1).payload.params.task, undefined);
});

test('index query rejects a changed revision and invalid unit vectors', async t => {
  const f = await fixture(t);
  await assert.rejects(f.client.embedQuery('query', embeddingProfile({ ...doc, revision: 'other-revision' })), /not available/);
  const bad = await fixture(t, { onEncode(_payload, result) { result.embeddings = [[0, 0]]; } });
  await assert.rejects(bad.client.embedText(['document']), /invalid embedding vector/);
});

test('discovery honors priority and healthy providers, status is read-only', async t => {
  const f = await fixture(t, { services: [service('low', doc, -1), { ...service('high-down', doc, 999), liveness: 'down' }, service('preferred', doc, 300)] });
  const status = await f.client.status();
  assert.equal(status.profiles.text.task, 'document_search');
  assert.equal(f.calls.some(call => call.payload?.method === 'embedding.encode_text'), false);
  await f.client.embedText(['document']);
  assert.equal(f.calls.at(-1).url, '/services/preferred/invoke');
});

test('timeouts are bounded without loading another provider', async t => {
  const f = await fixture(t, { onEncode: () => new Promise(resolve => setTimeout(resolve, 100)) });
  const client = createEmbeddingClient({ agent: f.agent, timeoutMs: 20 });
  await assert.rejects(client.embedText(['document']), /timed out/);
  assert.ok(f.calls.filter(call => call.payload?.method === 'embedding.encode_text').length <= 1);
});

test('gateway redirects are rejected without following their destination', async t => {
  const f = await fixture(t, { redirect: true });
  await assert.rejects(f.client.discover(), /HTTP 302/);
  assert.equal(f.calls.length, 1);
});

test('aborting a shared-provider request closes it and pre-aborted calls never discover', async t => {
  const f = await fixture(t, { onEncode: () => new Promise(resolve => setTimeout(resolve, 100)) });
  const controller = new AbortController();
  const operation = f.client.embedText(['document'], { signal: controller.signal });
  const timer = setInterval(() => {
    if (f.calls.some(call => call.payload?.method === 'embedding.encode_text')) { clearInterval(timer); controller.abort(); }
  }, 1);
  t.after(() => clearInterval(timer));
  await assert.rejects(operation, /abort/i);
  const count = f.calls.length;
  await assert.rejects(f.client.getProfile('text', { signal: controller.signal }), /abort/i);
  assert.equal(f.calls.length, count);
});


test('explicit document profiles support Qwen and Gemma without query/document confusion', async t => {
  const f = await fixture(t);
  for (const alias of ['qwen3', 'embeddinggemma2']) {
    const profile = await f.client.getTextProfile(alias);
    assert.equal(profile.alias, alias);
    const docs = await f.client.embedDocuments(['中文说明', 'npm dependency'], profile);
    assert.equal(docs.profile.id, profile.id);
    assert.equal(docs.vectors.length, 2);
    const query = await f.client.embedQuery('相关说明', profile);
    assert.equal(query.profile.id, profile.id);
    const calls = f.calls.filter(c => c.payload?.method === 'embedding.encode_text');
    assert.equal(calls.at(-2).payload.params.input_type, 'document');
    assert.equal(calls.at(-1).payload.params.input_type, 'query');
    assert.ok(calls.at(-2).url.includes(alias === 'qwen3' ? 'qwen' : 'gemma'));
  }
});

test('document profile mismatch and invalid alias fail before encoding', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.client.getTextProfile('other'), /Unknown/);
  const expected = embeddingProfile({ ...vision, revision: 'not-installed' });
  await assert.rejects(() => f.client.embedDocuments(['text'], expected), /not available/);
  assert.equal(f.calls.filter(c => c.payload?.method === 'embedding.encode_text').length, 0);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(() => f.client.embedDocuments(['text'], embeddingProfile(doc), { signal: abort.signal }));
});

test('explicit documents reject incompatible service responses', async t => {
  const f = await fixture(t, { invalidResult: true });
  await assert.rejects(() => f.client.embedDocuments(['text'], embeddingProfile(doc)), /incompatible/);
});

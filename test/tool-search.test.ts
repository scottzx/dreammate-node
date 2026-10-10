import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { buildToolCards, localEmbeddingEndpoint, pageResponse, parsePageOptions, searchTools } from '../src/tool-search.js';
import type { RegisteredService } from '../src/registry.js';

function services(count = 40): (RegisteredService & { node: string })[] {
  return [{ id: 'audio', node: 'mac', name: '音频服务', registeredAt: '', liveness: 'unknown', failures: 0,
    methods: Object.fromEntries(Array.from({ length: count }, (_, i) => [`audio.method${i}`,
      { description: `音频转写方法 ${i}`, parameters: { type: 'object', properties: { private_schema_marker: { description: 'must never appear in a card' } } } }])) }];
}

test('method cards and bounded lexical pages never expose schemas or expand a matched service', async () => {
  const corpus = services();
  assert.equal(buildToolCards(corpus).length, 40);
  const response = await searchTools(corpus, { query: '音频', limit: 3, max_chars: 1500 });
  const cards = response.results as { method: string }[];
  assert.equal(cards.length, 3);
  assert.equal(response.total_matched, 40);
  assert.equal(response.next_offset, 3);
  assert.ok(JSON.stringify(response, null, 2).length <= 1500);
  assert.doesNotMatch(JSON.stringify(response), /private_schema_marker|parameters|must never appear/);
  const second = await searchTools(corpus, { query: '音频', limit: 3, offset: 3, max_chars: 1500 });
  assert.ok(!(second.results as { method: string }[]).some(card => cards.some(first => first.method === card.method)));
  const exact = await searchTools(corpus, { query: 'audio.method32' });
  assert.equal((exact.results as { method: string }[])[0]?.method, 'audio.method32');
});

test('page validation and complete JSON budgets reject invalid inputs and advance oversized cards', async () => {
  for (const args of [{ limit: 0 }, { limit: '6' }, { limit: 21 }, { offset: -1 }, { offset: Infinity }, { max_chars: 999 }]) {
    assert.throws(() => parsePageOptions(args));
  }
  for (const query of ['', '  ', null, 3, 'a'.repeat(2001)]) {
    await assert.rejects(searchTools(services(), { query }), /query/);
  }
  const response = pageResponse([{ text: 'x'.repeat(2000) }, { text: 'small' }], { limit: 2, max_chars: 1000 });
  assert.equal(response.omitted_oversized, 1);
  assert.deepEqual(response.results, [{ text: 'small' }]);
  assert.equal(response.has_more, false);
  assert.ok(JSON.stringify(response, null, 2).length <= 1000);
  assert.throws(() => pageResponse([], { max_chars: 1000 }, { error: 'x'.repeat(2000) }), /元数据/);
});

test('semantic retrieval can find a paraphrase and caches only unchanged documents', async t => {
  const requests: { model: string; texts: string[]; input_type: string }[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as typeof requests[number];
    requests.push(body);
    return Response.json({ model: 'fixture-paraphrase-v1', embeddings: body.texts.map(text =>
      body.input_type === 'query' || text.includes('asr.transcribe') ? [1, 0] : [-1, 0]) });
  });
  const corpus = services(0);
  corpus[0]!.methods = {
    'asr.transcribe': { description: 'Automatic speech recognition', parameters: { type: 'object' } },
    'audio.play': { description: 'Play sound through speakers' },
  };
  const options = { embeddingUrl: 'http://127.0.0.1:8766', embeddingModel: 'fixture-paraphrase' };
  const first = await searchTools(corpus, { query: '把会议录音变成文字' }, options);
  assert.equal((first.search as { mode: string }).mode, 'hybrid');
  assert.equal((first.results as { method: string }[])[0]!.method, 'asr.transcribe');
  assert.equal(first.total_matched, 1, 'an unrelated semantic candidate is below the similarity floor');
  const documentRequests = () => requests.filter(request => request.input_type === 'document');
  assert.equal(documentRequests().length, 1);
  await searchTools(corpus, { query: '把另外一段录音变成文字' }, options);
  assert.equal(documentRequests().length, 1);
  corpus[0]!.methods['audio.play']!.description = 'Updated speaker playback';
  await searchTools(corpus, { query: '把另一段录音变成文字' }, options);
  assert.equal(documentRequests().length, 2);
  assert.equal(documentRequests()[1]!.texts.length, 1, 'only the changed document is re-embedded');
});

test('embedding failure or malformed vectors degrade to bounded lexical search, never all tools', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ model: 'fixture-bad', embeddings: [[0, 0]] }));
  const response = await searchTools(services(70), { query: '音频', limit: 2 },
    { embeddingUrl: 'http://127.0.0.1:8767', embeddingModel: 'fixture-bad' });
  assert.equal((response.search as { mode: string }).mode, 'lexical');
  assert.equal((response.search as { semantic_status: string }).semantic_status, 'unavailable');
  assert.equal((response.results as unknown[]).length, 2);
  const empty = await searchTools(services(), { query: 'unrelated nebulous astronomy' });
  assert.deepEqual(empty.results, []);
  const disabled = services();
  disabled[0]!.metadata = { enabled: false };
  assert.deepEqual((await searchTools(disabled, { query: '音频' })).results, []);
});

test('a stalled embedding body has a deadline and does not block bounded fallback', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: () => new Promise(() => {}) }));
  const start = performance.now();
  const response = await searchTools(services(2), { query: '音频', limit: 1 },
    { embeddingUrl: 'http://127.0.0.1:8768', embeddingTimeoutMs: 25 });
  assert.ok(performance.now() - start < 1000);
  assert.equal((response.search as { semantic_status: string }).semantic_status, 'unavailable');
  assert.equal((response.results as unknown[]).length, 1);
});

test('changing a backend revision invalidates all cached cards for the next request', async t => {
  let revision = 'v1';
  let documents = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { texts: string[]; input_type: string };
    if (body.input_type === 'document') documents += body.texts.length;
    return Response.json({ model: revision, embeddings: body.texts.map(() => [1, 0]) });
  });
  const options = { embeddingUrl: 'http://127.0.0.1:8770', embeddingModel: 'fixture-revision' };
  await searchTools(services(5), { query: '音频' }, options);
  assert.equal(documents, 5);
  revision = 'v2';
  const changed = await searchTools(services(5), { query: '音频' }, options);
  assert.equal((changed.search as { semantic_status: string }).semantic_status, 'unavailable');
  const rebuilt = await searchTools(services(5), { query: '音频' }, options);
  assert.equal((rebuilt.search as { semantic_status: string }).semantic_status, 'ok');
  assert.equal(documents, 10, 'all stale cards must rebuild together');
});

test('a malformed document dimension cannot poison recovery after the backend is repaired', async t => {
  let broken = true;
  let documentCalls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { texts: string[]; input_type: string };
    if (body.input_type === 'document') documentCalls++;
    return Response.json({ model: 'fixture-dimension', embeddings: body.texts.map(() =>
      broken && body.input_type === 'document' ? [1, 0, 0] : [1, 0]) });
  });
  const options = { embeddingUrl: 'http://127.0.0.1:8771', embeddingModel: 'fixture-dimension' };
  const failed = await searchTools(services(3), { query: '音频' }, options);
  assert.equal((failed.search as { semantic_status: string }).semantic_status, 'unavailable');
  broken = false;
  const recovered = await searchTools(services(3), { query: '音频' }, options);
  assert.equal((recovered.search as { semantic_status: string }).semantic_status, 'ok');
  assert.equal(documentCalls, 2);
});

test('validated cold-index batches survive a later stalled batch and resume on the next request', async t => {
  const documentSizes: number[] = [];
  let stall = true;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { texts: string[]; input_type: string };
    if (body.input_type === 'document') {
      documentSizes.push(body.texts.length);
      if (stall && documentSizes.length === 2) return { ok: true, json: () => new Promise(() => {}) };
    }
    return Response.json({ model: 'fixture-progress', embeddings: body.texts.map(() => [1, 0]) });
  });
  const options = { embeddingUrl: 'http://127.0.0.1:8772', embeddingModel: 'fixture-progress', embeddingTimeoutMs: 30 };
  const cold = await searchTools(services(35), { query: '音频' }, options);
  assert.equal((cold.search as { semantic_status: string }).semantic_status, 'unavailable');
  assert.deepEqual(documentSizes, [16, 16]);
  stall = false;
  const resumed = await searchTools(services(35), { query: '音频' }, options);
  assert.equal((resumed.search as { semantic_status: string }).semantic_status, 'ok');
  assert.deepEqual(documentSizes, [16, 16, 16, 3], 'the first validated batch is retained');
});

test('local-only embeddings reject public providers, credentials and redirection before fetching', async t => {
  for (const url of ['https://api.example.com', 'http://127.0.0.1.evil.test', 'file:///tmp', 'http://user:pass@127.0.0.1', 'http://127.0.0.1/embed?token=secret']) {
    assert.throws(() => localEmbeddingEndpoint(url));
  }
  assert.equal(localEmbeddingEndpoint('http://127.0.0.1:8766'), 'http://127.0.0.1:8766/embed');
  assert.equal(localEmbeddingEndpoint('http://[::1]:8766/embed'), 'http://[::1]:8766/embed');
  assert.equal(localEmbeddingEndpoint('http://100.100.1.2:8766'), 'http://100.100.1.2:8766/embed');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    calls++;
    assert.equal(init.redirect, 'error');
    throw new Error('redirect rejected');
  });
  const blocked = await searchTools(services(2), { query: '音频' }, { embeddingUrl: 'https://api.example.com' });
  assert.equal(calls, 0);
  assert.equal((blocked.search as { semantic_status: string }).semantic_status, 'unavailable');
  await searchTools(services(2), { query: '音频' }, { embeddingUrl: 'http://127.0.0.1:8769' });
  assert.ok(calls > 0);
});

test('cross-language semantic matches outrank weak Chinese keyword noise', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { texts: string[]; input_type: string };
    return Response.json({ model: 'fixture-semantic-first', embeddings: body.texts.map(text => {
      if (body.input_type === 'query') return [1, 0];
      const cosine = text.includes('memory.open_nodes') ? 0.8389 : 0.6285;
      return [cosine, Math.sqrt(1 - cosine ** 2)];
    }) });
  });
  const corpus = services(0);
  corpus[0]!.name = 'Utility service';
  corpus[0]!.methods = {
    'memory.open_nodes': { description: 'Retrieve named entities and their observations from the knowledge graph' },
    'asr.transcribe': { description: '把音频转成文字并输出文稿' },
  };
  const response = await searchTools(corpus, { query: '打开知识图谱中指定实体，查看保存的文字信息' },
    { embeddingUrl: 'http://127.0.0.1:8773', embeddingModel: 'fixture-semantic-first' });
  const results = response.results as { method: string; score: number; semantic_score: number }[];
  assert.deepEqual(results.map(card => card.method), ['memory.open_nodes', 'asr.transcribe']);
  assert.ok(results[0]!.semantic_score > results[1]!.semantic_score);
  assert.equal(results[0]!.score, 1.8389);
  assert.equal((response.search as { ranking: string }).ranking, 'semantic_then_keywords');
  assert.match((response.search as { score_semantics: string }).score_semantics, /ranking only/);
  assert.doesNotMatch(JSON.stringify(results), /semanticMatch|lexicalScore|"exact"/);
});

test('semantic candidates stay ahead of lexical-only supplements and exact method names stay first', async t => {
  const cosines: Record<string, number> = {
    'memory.lookup': 0.9, 'translate.text': 0.6, 'audio.transcribe': 0.2, 'audio.delete': -0.2,
  };
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { texts: string[]; input_type: string };
    return Response.json({ model: 'fixture-semantic-groups', embeddings: body.texts.map(text => {
      if (body.input_type === 'query') return [1, 0];
      const name = Object.keys(cosines).find(method => text.includes(method));
      assert.ok(name);
      const cosine = cosines[name]!;
      return [cosine, Math.sqrt(1 - cosine ** 2)];
    }) });
  });
  const corpus = services(0);
  corpus[0]!.name = 'Utility service';
  corpus[0]!.methods = {
    'memory.lookup': { description: 'Retrieve named entities' },
    'translate.text': { description: 'Translate a document' },
    'audio.transcribe': { description: '转写录音并输出文字' },
    'audio.delete': { description: 'Delete an audio file' },
  };
  const options = { embeddingUrl: 'http://127.0.0.1:8774', embeddingModel: 'fixture-semantic-groups' };
  const semantic = await searchTools(corpus, { query: '把录音转写成文字' }, options);
  const cards = semantic.results as { method: string; score: number; semantic_score: number }[];
  assert.deepEqual(cards.map(card => card.method), ['memory.lookup', 'translate.text', 'audio.transcribe']);
  assert.ok(cards[1]!.score > 1 && cards[2]!.score < 1);
  assert.ok(cards[2]!.semantic_score < 0.35, 'a lexical supplement is retained below the semantic floor');
  const exact = await searchTools(corpus, { query: 'audio.transcribe' }, options);
  assert.equal((exact.results as { method: string }[])[0]!.method, 'audio.transcribe', 'an exact full method reference overrides semantic order');
  assert.ok((exact.results as { method: string }[]).some(card => card.method === 'memory.lookup'));
});

type SearchCard = { node: string; service_id: string; method: string; semantic_score?: number };

function rankedFixture(specs: { id: string; values: number[]; node?: string; description?: string }[]) {
  const cosines = new Map<string, number>();
  const corpus: (RegisteredService & { node: string })[] = specs.map(spec => ({
    id: spec.id, node: spec.node ?? 'mac', name: `Fixture ${spec.id}`, registeredAt: '', liveness: 'unknown', failures: 0,
    methods: Object.fromEntries(spec.values.map((cosine, i) => {
      const method = `${spec.id}.action${i}`;
      cosines.set(method, cosine);
      return [method, { description: spec.description ?? 'Retrieval candidate' }];
    })),
  }));
  return { corpus, cosines };
}

function mockRankedEmbeddings(t: TestContext, label: string, cosines: ReadonlyMap<string, number>) {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { texts: string[]; input_type: string };
    return Response.json({ model: `fixture-${label}-v1`, embeddings: body.texts.map(text => {
      if (body.input_type === 'query') return [1, 0];
      const method = /^Method: (.+)$/m.exec(text)?.[1];
      assert.ok(method && cosines.has(method), `unexpected embedded method: ${method}`);
      const cosine = cosines.get(method)!;
      return [cosine, Math.sqrt(1 - cosine ** 2)];
    }) });
  });
  return { embeddingUrl: 'http://127.0.0.1:8775', embeddingModel: `fixture-${label}` };
}

const cardIdentity = (card: SearchCard) => JSON.stringify([card.node, card.service_id, card.method]);

test('default search exposes fifteen methods across relevant tool sets while protecting the best three', async t => {
  const fixture = rankedFixture([
    { id: 'large', values: Array.from({ length: 24 }, (_, i) => 0.96 - i * 0.001) },
    { id: 'second', values: [0.93, 0.929, 0.928] },
    { id: 'third', values: [0.925, 0.924, 0.923] },
  ]);
  const options = mockRankedEmbeddings(t, 'balanced-default', fixture.cosines);
  const response = await searchTools(fixture.corpus, { query: 'Find tools for this task' }, options);
  const cards = response.results as SearchCard[];
  assert.equal(response.limit, 15);
  assert.equal(response.max_chars, 12000);
  assert.equal(cards.length, 15);
  assert.equal(response.total_matched, 30);
  assert.deepEqual(cards.slice(0, 3).map(card => card.method), ['large.action0', 'large.action1', 'large.action2']);
  assert.deepEqual(new Set(cards.slice(0, 5).map(card => card.service_id)), new Set(['large', 'second', 'third']),
    'a large service must not occupy every shortlist slot when other tool sets are similarly relevant');
  assert.ok(JSON.stringify(response, null, 2).length <= 12000);

  const exact = await searchTools(fixture.corpus, { query: 'large.action23', limit: 5 }, options);
  assert.equal((exact.results as SearchCard[])[0]!.method, 'large.action23',
    'diversity must not override an explicit full method reference');
});

test('a strong fourth tool set remains visible and weak tool sets are not inserted to meet a quota', async t => {
  const fixture = rankedFixture([
    { id: 'large', values: Array.from({ length: 24 }, (_, i) => 0.96 - i * 0.001) },
    { id: 'second', values: [0.93] },
    { id: 'third', values: [0.925] },
    { id: 'fourth', values: [0.92] },
    { id: 'weak', values: [0.5] },
  ]);
  const options = mockRankedEmbeddings(t, 'strong-fourth', fixture.cosines);
  const response = await searchTools(fixture.corpus, { query: 'Find tools for this task' }, options);
  const cards = response.results as SearchCard[];
  assert.ok(cards.some(card => card.service_id === 'fourth'), 'three focus services must not become a hard service filter');
  assert.ok(!cards.some(card => card.service_id === 'weak'), 'passing the semantic floor alone is insufficient for promotion');
  assert.equal(response.total_matched, 28, 'weaker candidates must still remain available on later pages');

  const oneRelevantSet = fixture.corpus.filter(service => ['large', 'weak'].includes(service.id));
  const single = await searchTools(oneRelevantSet, { query: 'Find tools for this task' }, options);
  assert.ok((single.results as SearchCard[]).every(card => card.service_id === 'large'),
    'a second service must not be forced into a shortlist without enough relevance');
});

test('cross-node replicas share a tool set, protect distinct actions and survive stable pagination', async t => {
  const values = Array.from({ length: 24 }, (_, i) => 0.96 - i * 0.001);
  const fixture = rankedFixture([
    { id: 'large', node: 'node-a', values },
    { id: 'large', node: 'node-b', values },
    { id: 'second', node: 'node-c', values: [0.93, 0.929, 0.928] },
    { id: 'third', node: 'node-c', values: [0.925, 0.924, 0.923] },
  ]);
  const options = mockRankedEmbeddings(t, 'replica-pages', fixture.cosines);
  const first = await searchTools(fixture.corpus, { query: 'Find tools for this task' }, options);
  const cards = first.results as SearchCard[];
  assert.deepEqual(cards.slice(0, 3).map(card => card.method), ['large.action0', 'large.action1', 'large.action2'],
    'replicas of one action must not consume every protected slot');
  assert.deepEqual(new Set(cards.slice(0, 5).map(card => card.service_id)), new Set(['large', 'second', 'third']));
  const diversity = (first.search as { diversity: { relevant_services: string[] } }).diversity;
  assert.deepEqual(new Set(diversity.relevant_services), new Set(['large', 'second', 'third']));
  assert.equal(diversity.relevant_services.length, 3, 'a second node must not count as a second tool set');

  const collect = async (limit: number) => {
    const collected: SearchCard[] = [];
    let offset: number | null = 0;
    do {
      const previousOffset = offset;
      const response = await searchTools(fixture.corpus, { query: 'Find tools for this task', limit, offset }, options);
      assert.ok(JSON.stringify(response, null, 2).length <= 12000);
      const page = response.results as SearchCard[];
      assert.ok(page.length > 0, 'pagination must advance until all candidates have been returned');
      collected.push(...page);
      offset = response.next_offset as number | null;
      assert.ok(offset === null || offset > previousOffset, 'the cursor must advance rather than repeat a page');
    } while (offset !== null);
    return collected;
  };
  const reference = (await collect(15)).map(cardIdentity);
  assert.deepEqual(reference.slice(0, 15), cards.map(cardIdentity));
  assert.equal(reference.length, 54);
  assert.equal(new Set(reference).size, reference.length, 'no node/service/method entry may repeat');
  assert.deepEqual(new Set(reference), new Set(buildToolCards(fixture.corpus).map(cardIdentity)),
    'every cross-node replica must remain available, including beyond the balanced prefix');
  for (const limit of [1, 5]) assert.deepEqual((await collect(limit)).map(cardIdentity), reference,
    `limit ${limit} must page through the same complete order as limit 15`);
});

test('protecting distinct actions never pulls a lexical-only tool ahead of semantic replicas', async t => {
  const fixture = rankedFixture([
    { id: 'alpha', node: 'node-a', values: [0.95] },
    { id: 'alpha', node: 'node-b', values: [0.95] },
    { id: 'beta', node: 'node-a', values: [0.92] },
    { id: 'beta', node: 'node-b', values: [0.92] },
    { id: 'lexical', values: [0.1], description: 'needle' },
  ]);
  const options = mockRankedEmbeddings(t, 'semantic-replicas', fixture.cosines);
  const response = await searchTools(fixture.corpus, { query: 'needle' }, options);
  const cards = response.results as SearchCard[];
  assert.equal(cards.length, 5);
  assert.ok(cards.slice(0, 4).every(card => card.service_id !== 'lexical'),
    'all semantic matches must precede the lexical supplement even when only two distinct semantic actions exist');
  assert.equal(cards[4]!.service_id, 'lexical');
  assert.deepEqual(new Set(cards.slice(0, 4).map(cardIdentity)),
    new Set(buildToolCards(fixture.corpus).filter(card => card.service_id !== 'lexical').map(cardIdentity)));
});

test('an explicit service scope keeps the selected tool set and its relevance order', async t => {
  const fixture = rankedFixture([
    { id: 'large', values: Array.from({ length: 24 }, (_, i) => 0.96 - i * 0.001) },
    { id: 'second', values: [0.95] },
    { id: 'third', values: [0.94] },
  ]);
  const options = mockRankedEmbeddings(t, 'service-scope', fixture.cosines);
  const response = await searchTools(fixture.corpus, { query: 'Find tools for this task', service_id: 'large' }, options);
  const cards = response.results as SearchCard[];
  assert.equal(cards.length, 15);
  assert.ok(cards.every(card => card.service_id === 'large'));
  assert.deepEqual(cards.map(card => card.method), Array.from({ length: 15 }, (_, i) => `large.action${i}`));
  assert.equal(response.total_candidates, 24);
  assert.equal((response.search as { diversity: { applied: boolean } }).diversity.applied, false);
});

test('lexical-only search also balances similarly relevant tool sets', async () => {
  const fixture = rankedFixture([
    { id: 'alpha', values: Array(24).fill(0), description: 'lookup' },
    { id: 'beta', values: [0], description: 'lookup' },
    { id: 'gamma', values: [0], description: 'lookup' },
  ]);
  const response = await searchTools(fixture.corpus, { query: 'lookup' }, { embeddingUrl: '' });
  const cards = response.results as SearchCard[];
  assert.equal((response.search as { mode: string }).mode, 'lexical');
  assert.equal(cards.length, 15);
  assert.ok(cards.slice(0, 3).every(card => card.service_id === 'alpha'));
  assert.deepEqual(new Set(cards.slice(0, 5).map(card => card.service_id)), new Set(['alpha', 'beta', 'gamma']));
});

test('a related distinct action stays in the short list ahead of the leading action replica', async t => {
  const fixture = rankedFixture([
    { id: 'git', node: 'mac', values: [0.8076, 0.7737, 0.7387, 0.7167] },
    { id: 'git', node: 'server', values: [0.8076, 0.7737, 0.7387, 0.7167] },
    { id: 'project', node: 'server', values: [0.7095] },
  ]);
  const options = mockRankedEmbeddings(t, 'distinct-before-replica', fixture.cosines);
  const response = await searchTools(fixture.corpus, { query: '查看项目工作区的改动', limit: 5 }, options);
  const cards = response.results as SearchCard[];
  assert.equal(new Set(cards.map(card => `${card.service_id}/${card.method}`)).size, 5,
    'a replica must not push the fourth related action out of a five-tool shortlist');
  assert.ok(cards.some(card => card.method === 'git.action3'));
  assert.ok(cards.some(card => card.service_id === 'project'));
});

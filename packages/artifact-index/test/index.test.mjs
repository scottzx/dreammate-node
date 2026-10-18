import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ArtifactIndex } from '../src/index.mjs';

const qwen = { id: 'qwen-r1', model: 'qwen3@revision-one', alias: 'qwen3', revision: 'revision-one', dimensions: 2, encoding: 'qwen:fp32:max512', task: 'document_search' };
const gemma = { id: 'gemma-r1', model: 'embeddinggemma2@revision-two', alias: 'embeddinggemma2', revision: 'revision-two', dimensions: 2, encoding: 'gemma:fp32:max2048', task: 'multimodal' };
const page = (number, text, visual = false) => ({ kind: 'page', locator: { page: number }, text, representations: [{ modality: 'text', text }, ...(visual ? [{ modality: 'image', path: '/tmp/fake.png', content_hash: `image-${number}` }] : [])] });

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'artifact-core-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = [join(dir, 'a.pdf'), join(dir, 'b.pdf'), join(dir, 'c.pdf')];
  await Promise.all(paths.map((path, index) => writeFile(path, `file-${index}`)));
  let parsed = { kind: 'pdf', mime: 'application/pdf', title: 'Test document', parser_version: 'fixture-v1', units: [page(1, '眼镜店产品手册')], warnings: [] };
  const calls = [];
  const embeddings = {
    getProfile: async kind => kind === 'text' ? qwen : gemma,
    embedText: async texts => { calls.push(['text', texts]); return { profile: qwen, vectors: texts.map(() => [1, 0]) }; },
    embedMedia: async items => { calls.push(['media', items]); return { profile: gemma, vectors: items.map(() => [0, 1]) }; },
    embedQuery: async (query, profile) => { calls.push(['query', profile.id]); return { profile, vectors: [profile.id === qwen.id ? [1, 0] : [0, 1]] }; },
  };
  const dbPath = join(dir, 'index.sqlite');
  const index = new ArtifactIndex({ dbPath, cacheDir: join(dir, 'cache'), sourceNode: 'test-node', extractor: async () => parsed, embeddings, ...options });
  t.after(() => index.close());
  return { index, dir, paths, dbPath, calls, embeddings, setParsed: value => { parsed = value; }, getParsed: () => parsed };
}

test('persisted resources retain PDF locators and complete profiles across reopen', async t => {
  const f = await fixture(t);
  const outcome = await f.index.index([f.paths[0]]);
  assert.equal(outcome.diagnostics.indexed, 1);
  assert.equal(outcome.diagnostics.vectorized_text, 1);
  const result = await f.index.search('眼镜');
  assert.equal(result.semantic_status, 'available');
  assert.deepEqual(result.results[0].locator, { page: 1 });
  const unitId = result.results[0].unit_id;
  f.index.close();
  const reopened = new ArtifactIndex({ dbPath: f.dbPath, embeddings: f.embeddings });
  t.after(() => reopened.close());
  const unit = reopened.read(unitId);
  assert.equal(unit.text, '眼镜店产品手册');
  assert.equal(unit.resource.sharing, 'local');
  assert.deepEqual(unit.representations[0].profile, qwen);
  assert.equal(reopened.stats().vectors, 1);
});

test('batch all text before media and deduplicate encoding without losing page positions', async t => {
  const f = await fixture(t);
  f.setParsed({ ...f.getParsed(), units: [page(1, '相同文字', true), page(2, '相同文字', true)] });
  await f.index.index(f.paths.slice(0, 2));
  assert.deepEqual(f.calls.map(call => call[0]), ['text', 'media']);
  assert.equal(f.calls[0][1].length, 1);
  assert.equal(f.calls[1][1].length, 2);
  assert.equal(f.index.stats().units, 4);
  assert.equal(f.index.stats().vectors, 3);
  const results = await f.index.search('相同', { mode: 'lexical' });
  assert.equal(results.results.length, 4);
});

test('same content reuses exact profile cache and retries missing vectors', async t => {
  const f = await fixture(t);
  let fail = true;
  const original = f.embeddings.embedMedia;
  f.embeddings.embedMedia = async items => { if (fail) throw new Error('MPS temporarily unavailable'); return original(items); };
  f.setParsed({ ...f.getParsed(), units: [page(1, '需要缓存的文字', true)] });
  const first = await f.index.index([f.paths[0]]);
  assert.equal(first.diagnostics.vectorized_text, 1);
  assert.equal(first.diagnostics.vectorized_visual, 0);
  assert.equal(first.resources[0].representations.pending, 1);
  fail = false;
  const second = await f.index.index([f.paths[0]]);
  assert.equal(second.diagnostics.cached_representations, 1);
  assert.equal(second.diagnostics.vectorized_visual, 1);
  assert.equal(f.calls.filter(call => call[0] === 'text').length, 1);
});

test('new model revision does not reuse the older vector namespace', async t => {
  const f = await fixture(t);
  await f.index.index([f.paths[0]]);
  const upgraded = { ...qwen, id: 'qwen-r2', model: 'qwen3@revision-new', revision: 'revision-new' };
  f.embeddings.getProfile = async () => upgraded;
  f.embeddings.embedText = async texts => ({ profile: upgraded, vectors: texts.map(() => [0, 1]) });
  const next = await f.index.index([f.paths[0]]);
  assert.equal(next.diagnostics.cached_representations, 0);
  assert.equal(f.index.stats().profiles, 1);
  const result = await f.index.search('眼镜', { mode: 'lexical' });
  assert.equal(f.index.read(result.results[0].unit_id).representations[0].profile.revision, 'revision-new');
});

test('version replacement removes old units and orphan vectors; remove cascades', async t => {
  const f = await fixture(t);
  await f.index.index([f.paths[0]]);
  const oldResult = await f.index.search('眼镜', { mode: 'lexical' });
  const resourceId = oldResult.results[0].resource_id;
  f.setParsed({ ...f.getParsed(), units: [page(2, '新的木马页面')] });
  await writeFile(f.paths[0], 'new-version');
  await f.index.index([f.paths[0]]);
  assert.equal(f.index.read(oldResult.results[0].unit_id), null);
  assert.equal(f.index.stats().units, 1);
  assert.equal(f.index.stats().vectors, 1);
  assert.deepEqual(f.index.remove(resourceId), { resource_id: resourceId, removed: true });
  assert.equal(f.index.stats().units, 0);
  assert.equal(f.index.stats().vectors, 0);
  assert.equal(f.index.stats().profiles, 0);
});

test('parse failure preserves the complete previous resource version', async t => {
  const f = await fixture(t);
  await f.index.index([f.paths[0]]);
  const previous = f.index.list().resources[0];
  f.index.extractor = async () => { throw new Error('PDF parser failed'); };
  await writeFile(f.paths[0], 'broken-source');
  const outcome = await f.index.index([f.paths[0]]);
  assert.equal(outcome.diagnostics.failed, 1);
  assert.equal(f.index.list().resources[0].revision, previous.revision);
  assert.equal(f.index.list().resources[0].status, 'stale');
  assert.equal((await f.index.search('眼镜', { mode: 'lexical' })).results.length, 0);
  const historical = await f.index.search('眼镜', { mode: 'lexical', includeStale: true });
  assert.equal(historical.results.length, 1);
  assert.equal(historical.results[0].status, 'stale');
});

test('invalid vectors are rejected with pending diagnostics and a lexical fallback', async t => {
  const f = await fixture(t);
  f.embeddings.embedText = async () => ({ profile: qwen, vectors: [[Infinity, 0]] });
  const indexed = await f.index.index([f.paths[0]]);
  assert.equal(indexed.diagnostics.vectorized_text, 0);
  assert.match(indexed.diagnostics.embedding_errors[0].error, /non-finite/);
  assert.equal(f.index.stats().vectors, 0);
  const found = await f.index.search('眼镜', { mode: 'semantic' });
  assert.equal(found.semantic_status, 'unavailable');
  assert.equal(found.fallback, true);
  assert.equal(found.results.length, 1);
});

test('profile collisions roll back resource replacement atomically', async t => {
  const f = await fixture(t);
  await f.index.index(f.paths.slice(0, 2));
  f.setParsed({ ...f.getParsed(), units: [page(2, 'new text')] });
  f.embeddings.embedText = async () => ({ profile: { ...qwen, revision: 'collision', model: 'qwen3@collision' }, vectors: [[1, 0]] });
  const outcome = await f.index.index([f.paths[0]], { reembed: true });
  assert.equal(outcome.diagnostics.failed, 1);
  assert.match(outcome.resources[0].error, /collision/);
  assert.equal(f.index.stats().units, 2);
  assert.equal((await f.index.search('眼镜', { mode: 'lexical' })).results.length, 2);
});

test('sharing and type filters apply before ranking, and list filters before pagination', async t => {
  const f = await fixture(t);
  await f.index.index([f.paths[0]], { sharing: 'network' });
  await f.index.index([f.paths[1]], { sharing: 'local' });
  const network = await f.index.search('眼镜', { sharing: 'network' });
  assert.equal(network.results.length, 1);
  assert.equal(network.results[0].sharing, 'network');
  assert.equal((await f.index.search('眼镜', { types: ['video'] })).results.length, 0);
  const listed = f.index.list({ sharing: 'network', limit: 1 });
  assert.equal(listed.total, 1);
  assert.equal(listed.resources[0].sharing, 'network');
  assert.equal((await f.index.search('眼镜')).results.length, 2);
});

test('rank fusion compares ranks inside each vector space rather than raw cosine', async t => {
  const f = await fixture(t);
  f.setParsed({ ...f.getParsed(), units: [page(1, 'text A', true), page(2, 'text B', true)] });
  f.embeddings.embedText = async () => ({ profile: qwen, vectors: [[0.4, Math.sqrt(0.84)], [0.3, Math.sqrt(0.91)]] });
  f.embeddings.embedMedia = async () => ({ profile: gemma, vectors: [[Math.sqrt(0.19), 0.9], [Math.sqrt(0.0199), 0.99]] });
  await f.index.index([f.paths[0]]);
  const result = await f.index.search('semantic only', { mode: 'semantic' });
  assert.equal(result.results.length, 2);
  // Each unit is first in one space, so their best rank scores tie even though
  // Gemma's raw cosines are much larger than Qwen's.
  assert.equal(result.results[0].score, result.results[1].score);
  assert.equal(result.diagnostics.successful_vector_spaces, 2);
});

test('a rank-one visual video outranks a PDF with rank-two evidence in two spaces', async t => {
  const f = await fixture(t);
  f.index.extractor = async file => file.endsWith('b.pdf')
    ? { ...f.getParsed(), kind: 'video', units: [{ kind: 'video_segment', locator: { start_ms: 0, end_ms: 6000 }, text: '', representations: [{ modality: 'video', path: '/tmp/fake.mp4', content_hash: 'visual-leader' }] }] }
    : { ...f.getParsed(), units: [page(1, 'Dual evidence PDF', true), page(2, 'Text leader', true)] };
  f.embeddings.embedText = async () => ({ profile: qwen, vectors: [[0.8, 0.6], [1, 0]] });
  f.embeddings.embedMedia = async () => ({ profile: gemma, vectors: [[0.6, 0.8], [0.8, 0.6], [0, 1]] });
  await f.index.index(f.paths.slice(0, 2));
  const result = await f.index.search('opaque');
  assert.equal(result.results[0].kind, 'video');
  const dual = result.results.find(item => item.kind === 'pdf' && item.locator.page === 1);
  assert.ok(result.results[0].score > dual.score);
  assert.equal(dual.matches.length, 2);
  assert.deepEqual(dual.matches.map(match => match.rank), [2, 2]);
});

test('additional vector and lexical evidence remains inspectable without increasing score', async t => {
  const f = await fixture(t);
  await f.index.index([f.paths[0]]);
  const textOnly = await f.index.search('眼镜', { modalities: ['text'] });
  assert.equal(textOnly.results[0].matches.length, 2);
  assert.equal(textOnly.results[0].score, 1 / 61);
  f.setParsed({ ...f.getParsed(), units: [page(1, '眼镜店产品手册', true)] });
  await f.index.index([f.paths[0]]);
  const multiple = await f.index.search('眼镜');
  assert.equal(multiple.results[0].matches.length, 3);
  assert.equal(multiple.results[0].score, textOnly.results[0].score);
});

test('each channel rank-one candidate stays ahead of lower ranks in stable channel order', async t => {
  const f = await fixture(t);
  f.setParsed({ ...f.getParsed(), units: [page(1, 'needle keyword leader', true), page(2, 'visual leader', true), page(3, 'semantic leader', true)] });
  f.embeddings.embedText = async () => ({ profile: qwen, vectors: [[0.6, 0.8], [0.8, 0.6], [1, 0]] });
  f.embeddings.embedMedia = async () => ({ profile: gemma, vectors: [[0.8, 0.6], [0, 1], [0.6, 0.8]] });
  await f.index.index([f.paths[0]]);
  const result = await f.index.search('needle');
  assert.deepEqual(result.results.map(item => item.locator.page), [1, 2, 3]);
  assert.ok(result.results.every(item => item.score === 1 / 61));
  const again = await f.index.search('needle');
  assert.deepEqual(again.results.map(item => item.unit_id), result.results.map(item => item.unit_id));
});

test('long documents cannot occupy every result and unrelated lexical items are absent', async t => {
  const f = await fixture(t);
  f.setParsed({ ...f.getParsed(), units: Array.from({ length: 20 }, (_, i) => page(i + 1, '眼镜与镜片')) });
  await f.index.index([f.paths[0]], { semantic: false });
  f.setParsed({ ...f.getParsed(), units: [page(1, '眼镜盒')] });
  await f.index.index([f.paths[1]], { semantic: false });
  const result = await f.index.search('眼镜', { mode: 'lexical', limit: 15 });
  assert.equal(result.results.length, 4);
  assert.equal(new Set(result.results.map(row => row.resource_id)).size, 2);
  assert.equal((await f.index.search('不存在的冰箱', { mode: 'lexical' })).results.length, 0);
});

test('visual-only records report unavailable semantics and never fake lexical hits', async t => {
  const f = await fixture(t, { embeddings: undefined });
  f.setParsed({ ...f.getParsed(), kind: 'video', units: [{ kind: 'segment', locator: { start_ms: 0, end_ms: 6000 }, text: '', representations: [{ modality: 'video', path: '/tmp/fake.mp4', content_hash: 'video-frame-hash' }] }] });
  const outcome = await f.index.index([f.paths[0]]);
  assert.equal(outcome.diagnostics.vectorized_visual, 0);
  const result = await f.index.search('戴眼镜的人');
  assert.equal(result.results.length, 0);
  assert.equal(result.semantic_status, 'unavailable');
  assert.equal(result.diagnostics.visual_search_unavailable, true);
});

test('spreadsheet cells, slides and video times preserve stable locators', async t => {
  const f = await fixture(t);
  const configurations = [
    { kind: 'spreadsheet', locator: { sheet: '销售明细', range: 'B3:H25' } },
    { kind: 'presentation', locator: { slide: 8 } },
    { kind: 'video', locator: { start_ms: 12000, end_ms: 18000 } },
  ];
  for (const [i, config] of configurations.entries()) {
    f.setParsed({ ...f.getParsed(), kind: config.kind, units: [{ kind: config.kind, locator: config.locator, text: '眼镜相关内容' }] });
    await f.index.index([f.paths[i]]);
  }
  const found = await f.index.search('眼镜', { mode: 'lexical' });
  assert.equal(found.results.length, 3);
  for (const config of configurations) assert.deepEqual(found.results.find(result => result.kind === config.kind).locator, config.locator);
});

test('typed spreadsheet cell metadata and presentation notes survive persistence', async t => {
  const f = await fixture(t);
  const cells = [{ coordinate: 'B3', value: 128.5, data_type: 'n' }, { coordinate: 'B4', value: '=SUM(B1:B3)', formula: '=SUM(B1:B3)', cached_value: 256 }];
  f.setParsed({ ...f.getParsed(), kind: 'spreadsheet', units: [{ kind: 'cell_range', locator: { sheet: '价格', range: 'B3:B4' }, text: '眼镜价格', cells, header_cells: [{ coordinate: 'B1', value: '价格' }], hidden: false }] });
  await f.index.index([f.paths[0]]);
  const unitId = (await f.index.search('眼镜', { mode: 'lexical' })).results[0].unit_id;
  assert.deepEqual(f.index.read(unitId).metadata.cells, cells);
  assert.equal(f.index.read(unitId).metadata.hidden, false);
});

test('a different query profile is rejected instead of comparing incompatible vectors', async t => {
  const f = await fixture(t);
  await f.index.index([f.paths[0]]);
  f.embeddings.embedQuery = async () => ({ profile: { ...qwen, revision: 'other', model: 'qwen3@other' }, vectors: [[1, 0]] });
  const result = await f.index.search('眼镜');
  assert.equal(result.semantic_status, 'unavailable');
  assert.match(result.diagnostics.errors[0].error, /does not match/);
  assert.equal(result.results.length, 1);
});

test('backend failure opens a circuit instead of waiting once per remaining batch', async t => {
  const f = await fixture(t);
  let calls = 0;
  f.setParsed({ ...f.getParsed(), units: Array.from({ length: 40 }, (_, i) => page(i + 1, `unique page ${i}`)) });
  f.embeddings.embedText = async () => { calls++; throw new Error('provider down'); };
  const result = await f.index.index([f.paths[0]], { textBatchSize: 1 });
  assert.equal(calls, 1);
  assert.equal(result.resources[0].representations.pending, 40);
  assert.equal(result.diagnostics.embedding_errors[0].circuit_open, true);
});

test('page text is split into overlapping vectors while its page locator stays intact', async t => {
  const f = await fixture(t);
  f.setParsed({ ...f.getParsed(), units: [page(12, `${'前文'.repeat(400)}尾段包含木马`)] });
  const result = await f.index.index([f.paths[0]]);
  assert.equal(result.resources[0].units, 1);
  assert.ok(result.resources[0].representations.vectorized_text > 1);
  assert.ok(f.calls[0][1].some(text => text.includes('尾段包含木马')));
  const search = await f.index.search('木马', { mode: 'lexical' });
  assert.deepEqual(search.results[0].locator, { page: 12 });
});

test('modality filters search only the requested vector backend', async t => {
  const f = await fixture(t);
  f.setParsed({ ...f.getParsed(), units: [page(1, '眼镜文字', true)] });
  await f.index.index([f.paths[0]]);
  f.calls.length = 0;
  const visual = await f.index.search('眼镜', { modalities: ['image', 'video'], mode: 'semantic' });
  assert.deepEqual(f.calls, [['query', gemma.id]]);
  assert.deepEqual(visual.results[0].matched_modality, ['image']);
  f.calls.length = 0;
  await f.index.search('眼镜', { modalities: ['text'] });
  assert.deepEqual(f.calls, [['query', qwen.id]]);
});

test('explicit reindex of a deleted source marks its old snapshot stale', async t => {
  const f = await fixture(t);
  await f.index.index([f.paths[0]]);
  const unit = (await f.index.search('眼镜', { mode: 'lexical' })).results[0];
  await rm(f.paths[0]);
  const refresh = await f.index.index([f.paths[0]]);
  assert.equal(refresh.resources[0].snapshot_status, 'stale');
  assert.equal(f.index.read(unit.unit_id).resource.status, 'stale');
  assert.equal((await f.index.search('眼镜', { mode: 'lexical' })).results.length, 0);
});

test('a source changed during embedding is never committed as a fresh snapshot', async t => {
  const f = await fixture(t);
  await f.index.index([f.paths[0]]);
  const original = f.embeddings.embedText;
  f.embeddings.embedText = async texts => {
    const result = await original(texts);
    await writeFile(f.paths[0], 'changed-during-embedding');
    return result;
  };
  f.setParsed({ ...f.getParsed(), units: [page(3, 'new parsed text')] });
  const outcome = await f.index.index([f.paths[0]], { reembed: true });
  assert.equal(outcome.diagnostics.failed, 1);
  assert.match(outcome.resources[0].error, /changed while/);
  assert.equal(f.index.list().resources[0].status, 'stale');
  assert.equal(f.index.stats().units, 1);
});

test('bounded provider timeout falls back to lexical results', async t => {
  const f = await fixture(t);
  await f.index.index([f.paths[0]]);
  f.embeddings.embedQuery = async () => new Promise(() => {});
  const start = Date.now();
  const result = await f.index.search('眼镜', { embeddingTimeoutMs: 20 });
  assert.ok(Date.now() - start < 500);
  assert.equal(result.semantic_status, 'unavailable');
  assert.equal(result.results.length, 1);
});

test('newer database schema is refused without rewriting user_version', async t => {
  const f = await fixture(t);
  f.index.close();
  const db = new DatabaseSync(f.dbPath);
  db.exec('PRAGMA user_version = 999');
  db.close();
  assert.throws(() => new ArtifactIndex({ dbPath: f.dbPath }), /newer/);
  const check = new DatabaseSync(f.dbPath);
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 999);
  check.close();
});

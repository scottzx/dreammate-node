/** Compare the actual gateway ranker against the same local registry and labelled requests.
 * node --import tsx scripts/benchmark-tool-search.ts --services FILE --out FILE
 *   [--cases FILE] [--limit 15] [--embedding-url http://127.0.0.1:8766 --models qwen3]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildToolCards, localEmbeddingEndpoint, searchTools } from '../src/tool-search.js';
import type { RegisteredService } from '../src/registry.js';

const { values } = parseArgs({ options: {
  services: { type: 'string' }, cases: { type: 'string' }, out: { type: 'string' },
  'embedding-url': { type: 'string' }, models: { type: 'string' },
  manifest: { type: 'string' },
  'timeout-ms': { type: 'string', default: '60000' },
  limit: { type: 'string', default: '5' },
} });
if (!values.services || !values.out) throw new Error('--services FILE and --out FILE are required');
const raw: unknown = JSON.parse(await fs.readFile(values.services, 'utf8'));
const list = Array.isArray(raw) ? raw : (raw as { services?: unknown })?.services;
if (!Array.isArray(list) || list.some(s => !s || typeof s.id !== 'string')) throw new Error('Expected a service registry array or {services: [...]}');
const services = list.map(s => ({ ...s, node: typeof s.node === 'string' ? s.node : 'local' })) as (RegisteredService & { node: string })[];
type Case = { query: string; expected: string[]; category: string };
const cases: Case[] = JSON.parse(await fs.readFile(values.cases ?? fileURLToPath(new URL('./tool-search-cases.json', import.meta.url)), 'utf8'));
if (!Array.isArray(cases) || cases.some(c => !c.query || !Array.isArray(c.expected))) throw new Error('Expected labelled query cases');
const catalog = new Set(buildToolCards(services).map(c => `${c.service_id}/${c.method}`));
const absent = cases.flatMap(c => c.expected.filter(key => !catalog.has(key)));
if (absent.length) throw new Error(`Labelled tools absent from registry: ${[...new Set(absent)].join(', ')}`);
const timeoutMs = Number(values['timeout-ms']);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('--timeout-ms must be 1..60000');
const limit = Number(values.limit);
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('--limit must be 1..20');
if (values['embedding-url']) localEmbeddingEndpoint(values['embedding-url']);
if (values.models && !values['embedding-url']) throw new Error('--models requires --embedding-url');
// An inherited backend must not change the lexical control condition.
delete process.env.DREAMMATE_EMBEDDING_URL;
delete process.env.DREAMMATE_EMBEDDING_MODEL;
const configurations = [{ label: 'lexical', model: undefined as string | undefined, url: undefined as string | undefined },
  ...(values.models?.split(',').filter(Boolean).map(model => ({ label: model, model, url: values['embedding-url'] })) ?? [])];
const manifest = values.manifest ? JSON.parse(await fs.readFile(values.manifest, 'utf8')) as { models: Record<string, { revision: string }> } : undefined;
const verifyModel = (model: string | undefined, response: Record<string, unknown>) => {
  if (!model) return;
  const search = response.search as { semantic_status?: string; model?: string };
  if (search.semantic_status !== 'ok') throw new Error(`${model} fell back: ${JSON.stringify(search)}`);
  if (manifest && search.model !== `${model}@${manifest.models[model]?.revision}`) throw new Error(`Wrong actual model for ${model}: ${search.model}`);
};
const percentile = (numbers: number[], q: number) => {
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] ?? 0;
};
const runs = [];
for (const config of configurations) {
  const options = { embeddingUrl: config.url, embeddingModel: config.model, embeddingTimeoutMs: timeoutMs };
  const coldStart = performance.now();
  const cold = await searchTools(services, { query: cases[0]!.query, limit }, options);
  const coldMs = performance.now() - coldStart;
  verifyModel(config.model, cold);
  const rows = [];
  for (const c of cases) {
    const started = performance.now();
    const response = await searchTools(services, { query: c.query, limit }, options);
    const elapsed = performance.now() - started;
    verifyModel(config.model, response);
    const results = response.results as { service_id: string; method: string; score: number; semantic_score?: number }[];
    const rank = results.findIndex(r => c.expected.includes(`${r.service_id}/${r.method}`));
    rows.push({ ...c, rank: rank < 0 ? null : rank + 1, latency_ms: Number(elapsed.toFixed(2)),
      response_chars: JSON.stringify(response).length,
      service_count: new Set(results.map(r => r.service_id)).size,
      diversity: (response.search as Record<string, unknown>).diversity,
      results: results.map(r => ({ tool: `${r.service_id}/${r.method}`, score: r.score, semantic_score: r.semantic_score })) });
  }
  const supported = rows.filter(r => r.expected.length > 0);
  const unsupported = rows.filter(r => r.expected.length === 0);
  runs.push({ label: config.label, model: (cold.search as { model?: string }).model ?? null,
    cold_index_and_query_ms: Number(coldMs.toFixed(2)),
    result_limit: limit,
    recall_at_k: supported.filter(r => r.rank !== null).length / supported.length,
    ...(limit >= 5 ? { recall_at_5: supported.filter(r => r.rank !== null && r.rank <= 5).length / supported.length } : {}),
    top1_accuracy: supported.filter(r => r.rank === 1).length / supported.length,
    mrr_at_k: supported.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / supported.length,
    ...(limit >= 5 ? { mrr_at_5: supported.reduce((sum, r) => sum + (r.rank && r.rank <= 5 ? 1 / r.rank : 0), 0) / supported.length } : {}),
    unsupported_empty_rate: unsupported.length ? unsupported.filter(r => !r.results.length).length / unsupported.length : null,
    warm_p50_ms: percentile(rows.map(r => r.latency_ms), 0.5), warm_p95_ms: percentile(rows.map(r => r.latency_ms), 0.95),
    mean_response_chars: Math.round(rows.reduce((sum, r) => sum + r.response_chars, 0) / rows.length), rows });
  console.log(JSON.stringify({ label: config.label, ...Object.fromEntries(Object.entries(runs.at(-1)!).filter(([key]) => key !== 'rows')) }));
  // Preserve completed conditions if a subsequent model cannot load.
  await fs.mkdir(path.dirname(values.out), { recursive: true });
  await fs.writeFile(values.out, JSON.stringify({ created_at: new Date().toISOString(),
    evidence: 'Real registered tool descriptions; manually authored synthetic queries, not production traffic. Retrieval only; no business method is invoked.',
    candidate_count: catalog.size, node_card_count: buildToolCards(services).length,
    node_count: new Set(services.map(s => s.node)).size, service_count: new Set(services.map(s => s.id)).size,
    case_count: cases.length, result_limit: limit,
    full_method_contract_chars: JSON.stringify(services.map(s => ({ id: s.id, methods: s.methods }))).length,
    min_similarity: Number(process.env.DREAMMATE_EMBEDDING_MIN_SCORE ?? 0.35), runs }, null, 2) + '\n');
}

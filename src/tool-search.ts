import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import type { RegisteredService } from './registry.js';
import { withRequestTimeout } from './request-timeout.js';
import type { EmbeddingProvider } from './embedding-providers.js';

export interface PageOptions { limit: number; offset: number; maxChars: number }

/** Runtime validation also protects direct library/MCP callers. */
export function parsePageOptions(args: Record<string, unknown>, defaults: { limit?: number; maxChars?: number } = {}): PageOptions {
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const value = args[key] ?? fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${key} 必须是 ${min}–${max} 之间的整数`);
    }
    return value;
  };
  return { limit: integer('limit', defaults.limit ?? 6, 1, 20), offset: integer('offset', 0, 0, 1_000_000),
    maxChars: integer('max_chars', defaults.maxChars ?? 6000, 1000, 12000) };
}

/** Budget covers the complete pretty-printed JSON content, including metadata. */
export function pageResponse<T>(items: readonly T[], args: Record<string, unknown>, base: Record<string, unknown> = {}, key = 'results'): Record<string, unknown> {
  const { limit, offset, maxChars } = parsePageOptions(args);
  const selected: T[] = [];
  let consumed = 0;
  let oversized = 0;
  const result = () => {
    const next = Math.min(items.length, offset + consumed);
    const hasMore = next < items.length;
    return { ...base, [key]: selected, total_matched: items.length, returned: selected.length, offset, limit,
      next_offset: hasMore ? next : null, has_more: hasMore, truncated: hasMore || oversized > 0,
      max_chars: maxChars, ...(oversized ? { omitted_oversized: oversized } : {}) };
  };
  if (JSON.stringify(result(), null, 2).length > maxChars) throw new Error('响应元数据超过 max_chars，请增加预算或缩小节点范围');
  while (offset + consumed < items.length && selected.length + oversized < limit) {
    selected.push(items[offset + consumed]!);
    consumed++;
    if (JSON.stringify(result(), null, 2).length > maxChars) {
      selected.pop();
      consumed--;
      if (selected.length > 0) break;
      // Explicit omission and cursor advancement prevent an oversized card trapping a page.
      consumed++;
      oversized++;
      if (JSON.stringify(result(), null, 2).length > maxChars) throw new Error('响应元数据超过 max_chars，请增加预算');
    }
  }
  return result();
}

export interface ToolCard {
  node: string;
  service_id: string;
  method: string;
  description: string;
}

interface IndexedCard { card: ToolCard; text: string; fields: [string, number][] }
interface RankedCard extends ToolCard {
  score: number; semantic_score?: number; exact: boolean; semanticMatch: boolean; lexicalScore: number;
}
type DiscoveredService = RegisteredService & { node: string };
const clip = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : '';

function indexCards(services: readonly DiscoveredService[], includeDisabled = false): IndexedCard[] {
  const result: IndexedCard[] = [];
  const seen = new Set<string>();
  for (const service of services) {
    if (!includeDisabled && service.metadata?.enabled === false) continue;
    const names = new Set([...Object.keys(service.methods ?? {}), ...(service.capabilities ?? [])]);
    for (const method of names) {
      const key = JSON.stringify([service.node, service.id, method]);
      if (seen.has(key)) continue;
      seen.add(key);
      const definition = service.methods?.[method];
      const description = clip(definition?.description, 480);
      const properties = definition?.parameters?.properties;
      const params = properties && typeof properties === 'object' && !Array.isArray(properties)
        ? Object.keys(properties).slice(0, 64).join(' ').slice(0, 600) : '';
      const fields: [string, number][] = [[method, 4], [service.id, 3], [service.name ?? '', 2],
        [description, 2], [service.kind ?? '', 0.5], [params, 0.5]];
      const card = { node: service.node, service_id: service.id, method, description };
      result.push({ card, fields, text: `Service: ${clip(service.name ?? service.id, 160)}\nMethod: ${method}\nPurpose: ${description}\nParameters: ${params}` });
    }
  }
  return result.sort((a, b) => JSON.stringify(a.card).localeCompare(JSON.stringify(b.card)));
}

/** Only names/descriptions/parameter names are indexed; full schemas never become cards. */
export function buildToolCards(services: readonly DiscoveredService[]): ToolCard[] {
  return indexCards(services).map(item => item.card);
}

const STOP_WORDS = new Set(['a', 'an', 'the', 'to', 'of', 'for', 'and', 'is', 'are', 'can', 'you', 'please', 'me', 'my', 'how', 'do', 'i']);
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
function terms(text: string): string[] {
  const normalized = text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  const tokens: string[] = [];
  for (const segment of segmenter.segment(normalized)) {
    if (segment.isWordLike && !STOP_WORDS.has(segment.segment)) tokens.push(segment.segment);
  }
  for (const run of normalized.match(/\p{Script=Han}+/gu) ?? []) {
    if (run.length > 1) for (let i = 0; i + 1 < run.length; i++) tokens.push(run.slice(i, i + 2));
  }
  return [...new Set(tokens)];
}

function lexicalScores(index: IndexedCard[], query: string): number[] {
  const queryTerms = terms(query);
  const documents = index.map(item => new Set(terms(item.text)));
  const frequency = new Map(queryTerms.map(term => [term, documents.filter(document => document.has(term)).length]));
  return index.map(item => {
    let score = 0;
    for (const [field, weight] of item.fields) {
      const tokens = new Set(terms(field));
      for (const term of queryTerms) if (tokens.has(term)) {
        score += weight * Math.log(1 + (index.length + 1) / ((frequency.get(term) ?? 0) + 1));
      }
    }
    const literal = query.toLowerCase();
    if (item.card.method.toLowerCase() === literal) score += 100;
    else if (item.card.method.toLowerCase().includes(literal)) score += 10;
    if (item.card.description.toLowerCase().includes(literal)) score += 5;
    return score;
  });
}

/** Prevent an optional local retriever from silently becoming a cloud dependency. */
export function localEmbeddingEndpoint(value: string): string {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const v4 = host.split('.').map(Number);
  const privateV4 = isIP(host) === 4 && (v4[0] === 127 || v4[0] === 10 ||
    (v4[0] === 192 && v4[1] === 168) || (v4[0] === 172 && v4[1]! >= 16 && v4[1]! <= 31) ||
    (v4[0] === 100 && v4[1]! >= 64 && v4[1]! <= 127));
  const privateV6 = isIP(host) === 6 && (host === '::1' || /^(fc|fd)/.test(host));
  const gatewayPath = /^\/(?:[^/]+\/)*services\/[^/]+\/embed$/.test(url.pathname);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
    !(host === 'localhost' || privateV4 || privateV6) || (!['/', '/embed'].includes(url.pathname) && !gatewayPath)) {
    throw new Error('embedding 地址必须是 localhost 或内网 IP 的 /embed 或固定服务 embedding 路由，不能使用外部 API');
  }
  if (!gatewayPath) url.pathname = '/embed';
  return url.toString();
}

interface CachedVector { vector: Float32Array; expires: number; model: string }
const vectorCache = new Map<string, CachedVector>();
const CACHE_LIMIT = 4096;
function unitVector(value: unknown): Float32Array {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4096 || value.some(n => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new Error('本地 embedding 返回了非法向量');
  }
  const norm = Math.hypot(...value as number[]);
  if (!Number.isFinite(norm) || norm === 0) throw new Error('本地 embedding 返回零向量');
  return Float32Array.from(value as number[], n => n / norm);
}

async function embed(endpoint: string, model: string | undefined, texts: string[], inputType: 'query' | 'document', timeoutMs: number, outerSignal: AbortSignal,
  onBatch?: (batch: { model: string; vectors: Float32Array[]; start: number }) => Promise<void>,
  expected?: Pick<EmbeddingProvider, 'expectedModel' | 'dimensions' | 'encoding'>): Promise<{ model: string; vectors: Float32Array[] }> {
  let returnedModel: string | undefined;
  const vectors: Float32Array[] = [];
  // Small batches bound inference allocations, including CPU-only deployments.
  const batchSize = 16;
  for (let start = 0; start < texts.length; start += batchSize) {
    outerSignal.throwIfAborted();
    const data = await withRequestTimeout(async signal => {
      const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, outerSignal]),
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, texts: texts.slice(start, start + batchSize), input_type: inputType }) });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`本地 embedding HTTP ${response.status}`); }
      return await response.json() as { model?: unknown; embeddings?: unknown; encoding?: unknown };
    }, timeoutMs);
    outerSignal.throwIfAborted();
    if (!data || !Array.isArray(data.embeddings) || data.embeddings.length !== Math.min(batchSize, texts.length - start)) throw new Error('本地 embedding 向量数量不匹配');
    if (typeof data.model !== 'string' || !data.model.trim()) throw new Error('本地 embedding 未返回模型版本');
    if (expected && (data.model !== expected.expectedModel || data.encoding !== expected.encoding)) {
      throw new Error('本地 embedding 与已发现的模型版本或编码配置不一致');
    }
    if (returnedModel && returnedModel !== data.model) throw new Error('本地 embedding 批次使用了不同模型');
    returnedModel = data.model;
    const batch = data.embeddings.map(unitVector);
    if (expected && batch.some(vector => vector.length !== expected.dimensions)) throw new Error('本地 embedding 与已发现的向量维度不一致');
    await onBatch?.({ model: returnedModel, vectors: batch, start });
    vectors.push(...batch);
  }
  return { model: returnedModel!, vectors };
}

export interface ToolSearchOptions {
  embeddingUrl?: string;
  embeddingModel?: string;
  embeddingTimeoutMs?: number;
  /** Already discovered infrastructure services; never model or weight downloads. */
  embeddingProviders?: readonly EmbeddingProvider[];
  responseBase?: Record<string, unknown>;
}

interface EmbeddingCandidate {
  endpoint: string;
  model?: string;
  provider?: EmbeddingProvider;
}

/** A provider owns the entire attempt, including query, documents and cache keys. */
async function semanticScores(index: IndexedCard[], query: string, candidate: EmbeddingCandidate, timeoutMs: number) {
  const endpoint = localEmbeddingEndpoint(candidate.endpoint);
  const { model, provider } = candidate;
  const keys = index.map(item => createHash('sha256').update(JSON.stringify([
    endpoint, model, provider?.expectedModel, provider?.dimensions, provider?.encoding, item.text,
  ])).digest('hex'));
  const cachedForRequest = new Map(keys.flatMap(key => {
    const cached = vectorCache.get(key);
    return cached && cached.expires >= Date.now() ? [[key, cached] as const] : [];
  }));
  const missing = keys.map((key, i) => ({ key, i })).filter(({ key }) => !cachedForRequest.has(key));
  const attempt = new AbortController();
  try {
    const [q, d] = await withRequestTimeout(signal => {
      const linked = AbortSignal.any([signal, attempt.signal]);
      const queryPromise = embed(endpoint, model, [query], 'query', timeoutMs, linked, undefined, provider);
      return Promise.all([queryPromise, missing.length ? embed(endpoint, model,
        missing.map(({ i }) => index[i]!.text), 'document', timeoutMs, linked, async batch => {
          const queryResult = await queryPromise;
          linked.throwIfAborted();
          if (queryResult.model !== batch.model) throw new Error('本地 embedding 查询与工具使用了不同模型');
          if (batch.vectors.some(vector => vector.length !== queryResult.vectors[0]!.length)) {
            throw new Error('本地 embedding 查询与工具向量维度不一致');
          }
          // Retain validated progress without leaking vectors into another provider.
          for (let i = 0; i < batch.vectors.length; i++) {
            if (vectorCache.size >= CACHE_LIMIT) vectorCache.delete(vectorCache.keys().next().value!);
            vectorCache.set(missing[batch.start + i]!.key,
              { vector: batch.vectors[i]!, expires: Date.now() + 300_000, model: batch.model });
          }
        }, provider) : undefined]);
    }, timeoutMs);
    if (d && q.model !== d.model) throw new Error('本地 embedding 查询与工具使用了不同模型');
    const queryVector = q.vectors[0]!;
    const fresh = new Map(missing.map(({ key }, i) => [key, d!.vectors[i]!]));
    const stale = keys.filter(key => !fresh.has(key) && (cachedForRequest.get(key)?.model !== q.model
      || cachedForRequest.get(key)?.vector.length !== queryVector.length));
    if (stale.length) {
      for (const key of stale) vectorCache.delete(key);
      throw new Error('本地 embedding 模型已变更，将重建工具索引');
    }
    const scores = keys.map(key => {
      const vector = fresh.get(key) ?? cachedForRequest.get(key)?.vector;
      if (!vector || vector.length !== queryVector.length) throw new Error('本地 embedding 查询与工具向量维度不一致');
      return vector.reduce((sum, n, i) => sum + n * queryVector[i]!, 0);
    });
    return { model: q.model, scores };
  } finally {
    attempt.abort();
  }
}

/** Diversify a stable prefix, never an independently re-ranked page. */
function balanceServices(ranked: RankedCard[], scoped: boolean) {
  const strategy = 'relevance_gated_service_balance';
  const bestSemantic = ranked.find(card => card.semanticMatch)?.semantic_score;
  const bestKeyword = ranked.reduce((best, card) => Math.max(best, card.lexicalScore), 0);
  const relevant = (card: RankedCard) => bestSemantic !== undefined
    ? card.semanticMatch && card.semantic_score! >= bestSemantic - 0.10
    : bestKeyword > 0 && card.lexicalScore >= bestKeyword * 0.65;
  const eligible = ranked.filter(relevant);
  // Each service contributes its best method, never the sum of all its methods.
  // Replicas on other nodes are still the same service, not extra diversity.
  const focus = [...new Set(eligible.map(card => card.service_id))].slice(0, 3);
  const metadata = { strategy, target_services: 3, relevant_services: focus.map(id => clip(id, 100)),
    relevance_window: bestSemantic !== undefined ? 'cosine within 0.10 of best' : 'keyword score at least 65% of best',
    applied: !scoped && focus.length > 1 && !ranked[0]?.exact };
  if (!metadata.applied) return { ranked, metadata };

  const selected: RankedCard[] = [];
  const chosen = new Set<RankedCard>();
  const serviceCounts = new Map<string, number>();
  const methodCounts = new Map<string, number>();
  const methodKey = (card: RankedCard) => JSON.stringify([card.service_id, card.method]);
  const take = (card: RankedCard) => {
    chosen.add(card); selected.push(card);
    serviceCounts.set(card.service_id, (serviceCounts.get(card.service_id) ?? 0) + 1);
    methodCounts.set(methodKey(card), (methodCounts.get(methodKey(card)) ?? 0) + 1);
  };
  // Keep the best three distinct actions. Replicas keep their node identity but
  // cannot occupy all protected slots with the very same action.
  for (const card of ranked) {
    if (bestSemantic !== undefined && !card.semanticMatch) continue;
    if (!methodCounts.has(methodKey(card))) take(card);
    if (selected.length === 3) break;
  }
  for (const service of focus) {
    if (!serviceCounts.has(service)) take(eligible.find(card => card.service_id === service)!);
  }
  const normalized = (card: RankedCard) => bestSemantic !== undefined
    ? card.semantic_score! : card.lexicalScore / bestKeyword;
  while (selected.length < 15) {
    let best: RankedCard | undefined;
    let bestScore = -Infinity;
    for (const card of eligible) {
      if (chosen.has(card)) continue;
      // A capped penalty preserves relevance. Strong fourth/fifth services
      // remain eligible instead of being hidden by a hard three-service cap.
      const score = normalized(card) - Math.min(0.05, 0.015 * (serviceCounts.get(card.service_id) ?? 0))
        - (focus.includes(card.service_id) ? 0 : 0.015)
        - Math.min(0.20, 0.12 * (methodCounts.get(methodKey(card)) ?? 0));
      if (score > bestScore) { best = card; bestScore = score; }
    }
    if (!best) break;
    take(best);
  }
  // Keep every unselected candidate, so offsets neither lose nor repeat cards.
  return { ranked: [...selected, ...ranked.filter(card => !chosen.has(card))], metadata };
}

export async function searchTools(services: readonly DiscoveredService[], args: Record<string, unknown>, options: ToolSearchOptions = {}): Promise<Record<string, unknown>> {
  args = { ...args, limit: args.limit ?? 15, max_chars: args.max_chars ?? 12000 };
  parsePageOptions(args);
  if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 2000) throw new Error('query 必须是 1–2000 字符的非空查询');
  const query = args.query.trim();
  const filtered = services.filter(service => (!args.service_id || service.id === args.service_id) && (!args.kind || service.kind === args.kind));
  const index = indexCards(filtered, args.include_disabled === true);
  const lexical = lexicalScores(index, query);
  const rawUrl = options.embeddingUrl ?? process.env.DREAMMATE_EMBEDDING_URL;
  const model = options.embeddingModel ?? process.env.DREAMMATE_EMBEDDING_MODEL;
  const automatic = rawUrl === undefined && options.embeddingProviders !== undefined;
  const providers = automatic ? options.embeddingProviders!.filter(provider => !model || provider.model === model) : [];
  const candidates: EmbeddingCandidate[] = rawUrl ? [{ endpoint: rawUrl, model }]
    : providers.slice(0, 2).map(provider => ({ endpoint: provider.endpoint, model: provider.model, provider }));
  const search: Record<string, unknown> = { mode: 'lexical', ranking: 'weighted_keywords', semantic_status: rawUrl ? 'pending' : 'not_configured' };
  if (automatic) Object.assign(search, { semantic_status: candidates.length ? 'pending' : 'no_provider', provider_candidates: providers.length,
    ...(!candidates.length ? { fallback_reason: '在本次可查询范围内未发现就绪的模型服务' } : {}) });
  let semantic: number[] | undefined;
  let minSimilarity = 0.35;
  if (candidates.length && index.length > 0) {
    try {
      const timeoutMs = options.embeddingTimeoutMs ?? Number(process.env.DREAMMATE_EMBEDDING_TIMEOUT_MS ?? 5000);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('embeddingTimeoutMs 必须是 1–60000');
      minSimilarity = Number(process.env.DREAMMATE_EMBEDDING_MIN_SCORE ?? 0.35);
      if (!Number.isFinite(minSimilarity) || minSimilarity < -1 || minSimilarity > 1) throw new Error('DREAMMATE_EMBEDDING_MIN_SCORE 必须是 -1–1');
      const started = performance.now();
      const attempts: Record<string, unknown>[] = [];
      if (automatic) search.provider_attempts = attempts;
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i]!;
        const remaining = Math.ceil(timeoutMs - (performance.now() - started));
        if (remaining <= 0) {
          Object.assign(search, { semantic_status: 'unavailable', fallback_reason: '本地 embedding 总时间预算已耗尽' });
          break;
        }
        // Reserve time for a warm backup without multiplying the total deadline.
        const budget = i === 0 && candidates.length > 1 ? Math.max(1, Math.floor(remaining * 0.7)) : remaining;
        const identity = candidate.provider ? { node: clip(candidate.provider.node, 40), service_id: clip(candidate.provider.service_id, 100) } : {};
        try {
          const retrieved = await semanticScores(index, query, candidate, budget);
          semantic = retrieved.scores;
          if (automatic) attempts.push({ ...identity, status: 'ok' });
          Object.assign(search, { mode: 'hybrid', ranking: 'semantic_then_keywords', semantic_status: 'ok', model: retrieved.model, min_similarity: minSimilarity,
            ...(automatic ? { provider: { source: 'discovered', ...identity }, encoding: candidate.provider!.encoding } : {}),
            score_semantics: 'ranking only: semantic = 1 + cosine; keyword-only = 1/(60 + rank); exact method first' });
          delete search.fallback_reason;
          break;
        } catch (error) {
          const reason = clip(error instanceof Error ? error.message : String(error), 160);
          if (automatic) attempts.push({ ...identity, status: 'failed', reason: clip(reason, 80) });
          Object.assign(search, { semantic_status: 'unavailable', fallback_reason: reason });
        }
      }
    } catch (error) {
      Object.assign(search, { semantic_status: 'unavailable', fallback_reason: clip(error instanceof Error ? error.message : String(error), 160) });
    }
  } else if (candidates.length) search.semantic_status = 'empty_catalog';
  const ranks = (scores: number[], floor: number) => new Map(scores.map((score, i) => ({ score, i }))
    .filter(item => item.score > floor).sort((a, b) => b.score - a.score || a.i - b.i).map((item, i) => [item.i, i + 1]));
  const keywordRanks = ranks(lexical, 0);
  const results: RankedCard[] = index.flatMap((item, i) => {
    const kr = keywordRanks.get(i);
    const semanticMatch = semantic !== undefined && semantic[i]! > minSimilarity;
    if (!kr && !semanticMatch) return [];
    const exact = item.card.method.toLowerCase() === query.toLowerCase();
    // Reserve disjoint score ranges for semantic matches and lexical supplements.
    // A weak shared token must not outrank stronger cross-language similarity.
    const score = semantic ? semanticMatch ? 1 + semantic[i]! : 1 / (60 + kr!) : lexical[i]!;
    return [{ ...item.card, score, ...(semantic ? { semantic_score: semantic[i]! } : {}), exact, semanticMatch, lexicalScore: lexical[i]! }];
  }).sort((a, b) => Number(b.exact) - Number(a.exact) || Number(b.semanticMatch) - Number(a.semanticMatch)
    || b.score - a.score || b.lexicalScore - a.lexicalScore || a.method.localeCompare(b.method));
  const balanced = balanceServices(results, Boolean(args.service_id));
  search.diversity = balanced.metadata;
  return pageResponse(balanced.ranked.map(({ exact: _exact, semanticMatch: _semanticMatch, lexicalScore: _lexicalScore, ...card }) => ({
    ...card, score: Number(card.score.toFixed(6)),
    ...(card.semantic_score !== undefined ? { semantic_score: Number(card.semantic_score.toFixed(6)) } : {}),
  })), args,
    { ...options.responseBase, query, total_candidates: index.length, search }, 'results');
}

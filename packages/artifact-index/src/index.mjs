import { createReadStream } from 'node:fs';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join, resolve, basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { ArtifactStore } from './store.mjs';
import { SCHEMA_VERSION, ARTIFACT_KINDS, SHARING_VALUES, hash, stableJSON, normalizeProfile, profileFingerprint, vectorToBlob, blobToVector, validateLocator } from './schema.mjs';

export { ArtifactStore } from './store.mjs';
export { SCHEMA_VERSION } from './schema.mjs';

const defaultDir = () => join(homedir(), '.1agents', 'artifacts');
const boundedInt = (n, fallback, min, max) => Number.isInteger(n) ? Math.max(min, Math.min(max, n)) : fallback;
const message = error => String(error?.message ?? error).slice(0, 1000);
const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
async function fileHash(path) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return `sha256:${digest.digest('hex')}`;
}
async function potentialRealPath(file) {
  let existing = resolve(file);
  const missing = [];
  while (true) {
    try { return resolve(await realpath(existing), ...missing.reverse()); }
    catch {
      const parent = dirname(existing);
      if (parent === existing) return resolve(file);
      missing.push(basename(existing)); existing = parent;
    }
  }
}
async function timed(operation, milliseconds, signal) {
  const controller = new AbortController();
  const forward = () => controller.abort(signal.reason);
  if (signal?.aborted) forward();
  signal?.addEventListener('abort', forward, { once: true });
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(`Embedding request timed out after ${milliseconds} ms`)); }, milliseconds); }),
      new Promise((_, reject) => { controller.signal.addEventListener('abort', () => reject(new Error('Embedding request aborted')), { once: true }); if (controller.signal.aborted) reject(new Error('Embedding request aborted')); }),
    ]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', forward); }
}

function normalized(text) { return String(text).normalize('NFKC').toLowerCase(); }
function queryTerms(query) {
  const words = normalized(query).match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms = new Set();
  for (const word of words) {
    terms.add(word);
    if (/\p{Script=Han}/u.test(word) && word.length > 2) for (let i = 0; i < word.length - 1; i++) terms.add(word.slice(i, i + 2));
  }
  return [...terms].slice(0, 128);
}
function lexicalScore(text, title, query, terms) {
  const body = normalized(text), heading = normalized(title), phrase = normalized(query).trim();
  let score = body.includes(phrase) ? 5 : 0;
  if (heading.includes(phrase)) score += 2;
  let matched = 0;
  for (const term of terms) {
    if (body.includes(term)) { score += 1; matched++; }
    if (heading.includes(term)) score += 0.5;
  }
  // A title is useful context, but cannot make every empty page in a video or
  // document a separate lexical hit.
  if (!matched && !body.includes(phrase)) return 0;
  return score / (1 + Math.log1p(body.length) / 20);
}
function snippet(text, query, max = 600) {
  if (text.length <= max) return text;
  const index = normalized(text).indexOf(normalized(query));
  const start = index < 0 ? 0 : Math.max(0, index - Math.floor(max / 3));
  return `${start ? '…' : ''}${text.slice(start, start + max)}${start + max < text.length ? '…' : ''}`;
}

function textChunks(text, configuredLimit) {
  // The shared Qwen document profile has a 512-token window. A page remains
  // one addressable unit, but several overlapping representations ensure its
  // final paragraphs are searchable instead of silently being truncated.
  const size = boundedInt(configuredLimit, /\p{Script=Han}/u.test(text) ? 384 : 1400, 64, 4000);
  if (text.length <= size) return [text];
  const result = [], overlap = Math.min(64, Math.floor(size / 8));
  for (let start = 0; start < text.length; start += size - overlap) {
    const value = text.slice(start, start + size);
    if (value.trim()) result.push(value);
    if (start + size >= text.length) break;
  }
  return result;
}

export class ArtifactIndex {
  constructor(options = {}) {
    this.options = options;
    this.dbPath = options.dbPath ?? join(defaultDir(), 'index.sqlite');
    this.cacheDir = resolve(options.cacheDir ?? join(defaultDir(), 'cache'));
    this.sourceNode = options.sourceNode ?? hostname();
    this.sharing = options.sharing ?? 'local';
    if (typeof this.sourceNode !== 'string' || !this.sourceNode.trim()) throw new Error('sourceNode is required');
    if (!SHARING_VALUES.includes(this.sharing)) throw new Error('Invalid sharing value');
    this.extractor = options.extractor ?? (async (file, opts) => (await import('./extract.mjs')).extractArtifact(file, opts));
    this.embeddings = options.embeddings;
    this.store = new ArtifactStore(this.dbPath);
    this.mutationTail = Promise.resolve();
    this.closed = false;
  }

  ensureOpen() { if (this.closed) throw new Error('Artifact index is closed'); }

  async index(paths, options = {}) {
    this.ensureOpen();
    if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string') || !paths.length) throw new Error('index() requires one or more file paths');
    const operation = this.mutationTail.then(() => this.indexBatch(paths, options));
    this.mutationTail = operation.catch(() => {});
    return operation;
  }

  async indexBatch(paths, options) {
    this.ensureOpen();
    await mkdir(this.cacheDir, { recursive: true });
    const semantic = options.semantic !== false, visual = options.visual !== false;
    const sharing = options.sharing ?? this.sharing;
    if (!SHARING_VALUES.includes(sharing)) throw new Error('Invalid sharing value');
    const prepared = [], outcomes = [], seen = new Set();
    for (const suppliedPath of paths) {
      let sourceId = `resource:${hash(`${this.sourceNode}\0${await potentialRealPath(suppliedPath)}`)}`, observedRevision;
      try {
        const canonical = await realpath(resolve(suppliedPath));
        if (seen.has(canonical)) { outcomes.push({ path: suppliedPath, status: 'skipped', reason: 'duplicate_path' }); continue; }
        seen.add(canonical);
        const before = await stat(canonical);
        if (!before.isFile()) throw new Error('Artifact source must be a regular file');
        const revision = await fileHash(canonical);
        const resourceId = `resource:${hash(`${this.sourceNode}\0${canonical}`)}`;
        sourceId = resourceId;
        observedRevision = revision;
        const extracted = await this.extractor(canonical, { ...options, cacheDir: this.cacheDir, resourceId, visual, sourceNode: this.sourceNode });
        const after = await stat(canonical);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino || revision !== await fileHash(canonical)) throw new Error('Source file changed while being indexed; retry');
        if (!ARTIFACT_KINDS.includes(extracted.kind)) throw new Error('Extractor returned an unsupported artifact kind');
        if (!Array.isArray(extracted.units) || extracted.units.length > 100000) throw new Error('Extractor returned an invalid unit list');
        const unitIds = new Set();
        const units = [];
        for (const sourceUnit of extracted.units) {
          const locator = validateLocator(extracted.kind, sourceUnit.locator);
          const id = `unit:${hash(`${resourceId}\0${stableJSON(locator)}`)}`;
          if (unitIds.has(id)) throw new Error('Extractor returned duplicate unit locators');
          unitIds.add(id);
          const text = String(sourceUnit.text ?? '');
          if (text.length > 10_000_000) throw new Error('An extracted unit exceeds the 10 MB text limit');
          const representations = [], repIds = new Set();
          let rawReps = [...(sourceUnit.representations ?? [])];
          if (text.trim() && !rawReps.some(rep => rep.modality === 'text')) rawReps.unshift({ modality: 'text', text });
          rawReps = rawReps.flatMap(rep => rep.modality === 'text' ? textChunks(String(rep.text ?? text), options.textChunkChars).map(chunk => ({ ...rep, text: chunk })) : [rep]);
          for (const raw of rawReps) {
            if (!['text', 'image', 'video', 'audio'].includes(raw.modality)) throw new Error('Unsupported representation modality');
            const repText = raw.modality === 'text' ? String(raw.text ?? text) : undefined;
            if (raw.modality === 'text' && !repText.trim()) continue;
            if (raw.modality !== 'text' && (typeof raw.path !== 'string' || !raw.path)) throw new Error('Visual representation requires a local path');
            const contentHash = raw.modality === 'text' ? `sha256:${hash(repText)}` : (raw.content_hash ?? await fileHash(raw.path));
            if (typeof contentHash !== 'string' || !contentHash.trim()) throw new Error('Invalid content hash');
            const repId = `representation:${hash(`${id}\0${raw.modality}\0${contentHash}`)}`;
            if (repIds.has(repId)) continue;
            repIds.add(repId);
            const rep = { id: repId, modality: raw.modality, content_hash: contentHash, ...(repText !== undefined ? { text: repText } : { path: resolve(raw.path) }) };
            if (!semantic || (raw.modality !== 'text' && !visual)) rep.error = 'embedding_disabled';
            representations.push(rep);
          }
          const { kind: ignoredKind, locator: ignoredLocator, text: ignoredText, representations: ignoredRepresentations, ...metadata } = sourceUnit;
          const metadataJSON = JSON.stringify(metadata);
          if (Buffer.byteLength(metadataJSON) > 8 * 1024 * 1024) throw new Error('An extracted unit exceeds the 8 MB structured metadata limit');
          units.push({ id, kind: sourceUnit.kind ?? extracted.kind, locator, text, representations, metadata: JSON.parse(metadataJSON) });
        }
        const resource = {
          id: resourceId, source_node: this.sourceNode, source_uri: pathToFileURL(canonical).href, canonical_path: canonical,
          kind: extracted.kind, mime: extracted.mime ?? 'application/octet-stream', title: extracted.title ?? basename(canonical),
          revision, size: after.size, mtime_ms: after.mtimeMs, sharing,
          parser_version: String(extracted.parser_version ?? 'unknown'), indexed_at: new Date().toISOString(), warnings: extracted.warnings ?? [],
        };
        const outcome = { path: canonical, resource_id: resourceId, status: 'parsed', units: units.length, warnings: resource.warnings };
        outcomes.push(outcome);
        prepared.push({ resource, units, outcome });
      } catch (error) {
        const previous = this.store.resource(sourceId);
        if (previous) this.store.markFailure(sourceId, message(error), !observedRevision || previous.revision !== observedRevision || /changed while/.test(message(error)));
        outcomes.push({ path: suppliedPath, resource_id: previous?.id, status: 'failed', error: message(error), ...(previous ? { snapshot_status: this.store.resource(sourceId).status } : {}) });
      }
    }

    const allReps = prepared.flatMap(file => file.units.flatMap(unit => unit.representations));
    const groups = new Map();
    for (const rep of allReps) {
      if (rep.error) continue;
      const key = `${rep.modality}\0${rep.content_hash}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(rep);
    }
    const expectedProfiles = new Map();
    if (typeof this.embeddings?.getProfile === 'function' && groups.size) {
      for (const kind of [...new Set([...groups.values()].map(reps => reps[0].modality === 'text' ? 'text' : 'multimodal'))]) {
        try {
          const profile = await timed(signal => this.embeddings.getProfile(kind, { signal }), boundedInt(options.embeddingTimeoutMs, 60000, 1, 600000), options.signal);
          if (profile) expectedProfiles.set(kind, normalizeProfile(profile));
        } catch { /* Existing complete cache entries remain usable offline. */ }
      }
    }
    const pendingText = [], pendingMedia = [];
    let cached = 0;
    for (const reps of groups.values()) {
      const representative = reps[0];
      const candidates = options.reembed ? [] : this.store.cachedVectors(representative.content_hash, representative.modality);
      // Each cached vector retains its complete model profile. Old namespaces
      // can coexist safely; embedQuery must prove an exact profile match.
      const expected = expectedProfiles.get(representative.modality === 'text' ? 'text' : 'multimodal');
      const candidate = (expected ? candidates.filter(item => item.profile.id === expected.id && profileFingerprint(item.profile) === profileFingerprint(expected)) : candidates).at(-1);
      if (candidate) {
        for (const rep of reps) rep.vector_id = candidate.id;
        cached += reps.length;
      } else (representative.modality === 'text' ? pendingText : pendingMedia).push(reps);
    }
    const errors = [];
    const encodeGroups = async (pending, media) => {
      const batches = chunks(pending, boundedInt(media ? options.mediaBatchSize : options.textBatchSize, media ? 8 : 32, 1, 128));
      for (const [batchIndex, batch] of batches.entries()) {
        try {
          const method = media ? this.embeddings?.embedMedia : this.embeddings?.embedText;
          if (typeof method !== 'function') throw new Error('No local embedding provider configured');
          const inputs = batch.map(reps => media ? { modality: reps[0].modality, path: reps[0].path, content_hash: reps[0].content_hash } : reps[0].text);
          const result = await timed(signal => method.call(this.embeddings, inputs, { inputType: 'document', signal }), boundedInt(options.embeddingTimeoutMs, 60000, 1, 600000), options.signal);
          const profile = normalizeProfile(result.profile);
          if (!Array.isArray(result.vectors) || result.vectors.length !== batch.length) throw new Error('Embedding provider returned the wrong vector count');
          // Validate the complete batch before attaching a single vector.
          result.vectors.forEach(vector => vectorToBlob(vector, profile.dimensions));
          result.vectors.forEach((vector, index) => { for (const rep of batch[index]) Object.assign(rep, { vector, profile }); });
        } catch (error) {
          const detail = message(error);
          const remaining = batches.slice(batchIndex).flat();
          errors.push({ modality: media ? 'visual' : 'text', error: detail, representations: remaining.reduce((sum, reps) => sum + reps.length, 0), circuit_open: true });
          for (const reps of remaining) for (const rep of reps) rep.error = detail;
          break;
        }
      }
    };
    // Batch all documents by backend so a PDF with many pages does not switch
    // Qwen ↔ Gemma once per page on a memory-constrained local machine.
    await encodeGroups(pendingText, false);
    await encodeGroups(pendingMedia, true);
    for (const file of prepared) {
      try {
        const current = await stat(file.resource.canonical_path);
        if (current.size !== file.resource.size || current.mtimeMs !== file.resource.mtime_ms || await fileHash(file.resource.canonical_path) !== file.resource.revision) throw new Error('Source file changed while being indexed; retry');
        this.store.replace(file.resource, file.units);
        const reps = file.units.flatMap(unit => unit.representations);
        file.outcome.status = 'indexed';
        file.outcome.representations = {
          text: reps.filter(rep => rep.modality === 'text').length,
          visual: reps.filter(rep => rep.modality !== 'text').length,
          vectorized_text: reps.filter(rep => rep.modality === 'text' && (rep.vector || rep.vector_id)).length,
          vectorized_visual: reps.filter(rep => rep.modality !== 'text' && (rep.vector || rep.vector_id)).length,
          pending: reps.filter(rep => !rep.vector && !rep.vector_id).length,
        };
      } catch (error) {
        file.outcome.status = 'failed'; file.outcome.error = message(error);
        const previous = this.store.resource(file.resource.id);
        if (previous) this.store.markFailure(previous.id, message(error), error.code === 'ENOENT' || /changed while/.test(message(error)) || previous.revision !== file.resource.revision);
      }
    }
    return {
      schema_version: SCHEMA_VERSION, resources: outcomes,
      diagnostics: { parsed: prepared.length, indexed: outcomes.filter(item => item.status === 'indexed').length, failed: outcomes.filter(item => item.status === 'failed').length, skipped: outcomes.filter(item => item.status === 'skipped').length, cached_representations: cached, vectorized_text: outcomes.reduce((n, item) => n + (item.representations?.vectorized_text ?? 0), 0), vectorized_visual: outcomes.reduce((n, item) => n + (item.representations?.vectorized_visual ?? 0), 0), embedding_errors: errors },
    };
  }

  async search(query, options = {}) {
    this.ensureOpen();
    if (typeof query !== 'string' || !query.trim() || query.length > 8192) throw new Error('Query must contain 1 to 8192 characters');
    const started = performance.now();
    const mode = options.mode ?? 'hybrid';
    if (!['hybrid', 'lexical', 'semantic'].includes(mode)) throw new Error('Invalid search mode');
    const limit = boundedInt(options.limit, 15, 1, 200), offset = boundedInt(options.offset, 0, 0, 10000);
    const maxChars = boundedInt(options.maxChars, 12000, 256, 200000);
    const perResourceLimit = boundedInt(options.perResourceLimit, 3, 1, 200);
    const sharing = options.sharing ?? ['local', 'network'];
    const sharingValues = Array.isArray(sharing) ? sharing : [sharing];
    if (!sharingValues.length || sharingValues.some(item => !SHARING_VALUES.includes(item))) throw new Error('Invalid sharing filter');
    const types = options.types ? (Array.isArray(options.types) ? options.types : [options.types]) : ARTIFACT_KINDS;
    if (!types.length || types.some(type => !ARTIFACT_KINDS.includes(type))) throw new Error('Invalid artifact type filter');
    const modalities = options.modalities ?? ['text', 'image', 'video', 'audio'];
    if (!Array.isArray(modalities) || !modalities.length || modalities.some(value => !['text', 'image', 'video', 'audio'].includes(value))) throw new Error('Invalid modality filter');
    const statusFilter = options.includeStale ? '' : " AND r.status = 'ready'";
    const candidateLimit = boundedInt(options.candidateLimit, 20000, 1, 100000);
    const rows = this.store.db.prepare(`SELECT u.*, r.title, r.source_node, r.source_uri, r.kind AS resource_kind, r.sharing, r.status, r.last_error FROM units u JOIN resources r ON r.id = u.resource_id WHERE r.sharing IN (${sharingValues.map(() => '?').join(',')}) AND r.kind IN (${types.map(() => '?').join(',')})${statusFilter} ORDER BY r.indexed_at DESC, u.ordinal LIMIT ?`).all(...sharingValues, ...types, candidateLimit + 1);
    const truncated = rows.length > candidateLimit;
    if (truncated) rows.pop();
    const candidates = new Map(rows.map(row => [row.id, row]));
    const rankedLists = [], semanticErrors = [];
    const terms = queryTerms(query);
    const lexical = modalities.includes('text') ? rows.map(row => ({ id: row.id, score: lexicalScore(row.text, row.title, query, terms), modality: 'text' })).filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)) : [];
    if (mode !== 'semantic') rankedLists.push({ profile: null, rows: lexical });
    let spaces = 0, spacesSucceeded = 0, visualCandidates = 0;
    if (mode !== 'lexical' && candidates.size) {
      const spacesMap = new Map();
      // Apply source/type/sharing filters in SQL before loading any vectors.
      const vectorRows = this.store.db.prepare(`WITH filtered_units AS (SELECT u.id FROM units u JOIN resources r ON r.id = u.resource_id WHERE r.sharing IN (${sharingValues.map(() => '?').join(',')}) AND r.kind IN (${types.map(() => '?').join(',')})${statusFilter} ORDER BY r.indexed_at DESC, u.ordinal LIMIT ?) SELECT rp.unit_id, rp.modality, v.data, v.profile_id, p.metadata_json FROM representations rp JOIN vectors v ON v.id = rp.vector_id JOIN profiles p ON p.id = v.profile_id JOIN filtered_units u ON u.id = rp.unit_id WHERE rp.modality IN (${modalities.map(() => '?').join(',')})`).all(...sharingValues, ...types, candidateLimit, ...modalities);
      for (const row of vectorRows) {
        if (!candidates.has(row.unit_id)) continue;
        if (row.modality !== 'text') visualCandidates++;
        if (!spacesMap.has(row.profile_id)) spacesMap.set(row.profile_id, { profile: JSON.parse(row.metadata_json), vectors: [] });
        spacesMap.get(row.profile_id).vectors.push(row);
      }
      const selectedSpaces = [...spacesMap.values()].sort((a, b) => a.profile.alias.localeCompare(b.profile.alias)).slice(0, boundedInt(options.maxProfiles, 8, 1, 32));
      spaces = spacesMap.size;
      if (spacesMap.size > selectedSpaces.length) semanticErrors.push({ error: 'Embedding profile search budget exceeded' });
      for (const space of selectedSpaces) {
        try {
          if (typeof this.embeddings?.embedQuery !== 'function') throw new Error('No local embedding provider configured');
          const result = await timed(signal => this.embeddings.embedQuery(query, space.profile, { signal }), boundedInt(options.embeddingTimeoutMs, 60000, 1, 600000), options.signal);
          const actual = normalizeProfile(result.profile);
          if (actual.id !== space.profile.id || profileFingerprint(actual) !== profileFingerprint(space.profile)) throw new Error('Query embedding profile does not match the indexed vector space');
          if (!Array.isArray(result.vectors) || result.vectors.length !== 1) throw new Error('Query provider returned an invalid vector count');
          vectorToBlob(result.vectors[0], actual.dimensions);
          const queryVector = result.vectors[0], byUnit = new Map();
          for (const vector of space.vectors) {
            const values = blobToVector(vector.data, actual.dimensions);
            const cosine = values.reduce((sum, value, index) => sum + value * queryVector[index], 0);
            if (!Number.isFinite(cosine) || cosine < (options.minSimilarity ?? 0.15)) continue;
            const prior = byUnit.get(vector.unit_id);
            if (!prior || cosine > prior.score) byUnit.set(vector.unit_id, { id: vector.unit_id, score: cosine, modality: vector.modality });
          }
          rankedLists.push({ profile: actual.id, rows: [...byUnit.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)) });
          spacesSucceeded++;
        } catch (error) { semanticErrors.push({ profile_id: space.profile.id, error: message(error) }); }
      }
    }
    const semanticStatus = mode === 'lexical' ? 'not_requested' : spaces === 0 ? 'unavailable' : spacesSucceeded === spaces ? 'available' : spacesSucceeded ? 'partial' : 'unavailable';
    // A model outage must leave text usable. A purely visual record has no
    // lexical evidence and is never fabricated as a fallback result.
    const fallback = mode === 'semantic' && spacesSucceeded === 0;
    if (fallback) rankedLists.push({ profile: null, rows: lexical });
    const fused = new Map();
    for (const [listOrder, list] of rankedLists.entries()) {
      for (const [index, item] of list.rows.entries()) {
        let value = fused.get(item.id);
        if (!value) { value = { id: item.id, score: 0, best_list_order: Infinity, matches: [] }; fused.set(item.id, value); }
        const rankScore = 1 / (60 + index + 1);
        // A page may have lexical, Qwen and Gemma evidence while a video has
        // only Gemma. Representation/profile count must never become a bonus.
        if (rankScore > value.score || (rankScore === value.score && listOrder < value.best_list_order)) {
          value.score = rankScore;
          value.best_list_order = listOrder;
        }
        value.matches.push({ modality: item.modality, profile_id: list.profile, rank: index + 1, similarity: list.profile ? item.score : undefined });
      }
    }
    // Different channels' rank-one hits stay together, in stable channel/list
    // order, ahead of every rank-two hit. Hash-derived unit IDs do not decide
    // which modality wins an otherwise equal ranking.
    const sorted = [...fused.values()].sort((a, b) => b.score - a.score || a.best_list_order - b.best_list_order || a.id.localeCompare(b.id));
    const counts = new Map(), balanced = [];
    for (const item of sorted) {
      const row = candidates.get(item.id), count = counts.get(row.resource_id) ?? 0;
      if (count >= perResourceLimit) continue;
      counts.set(row.resource_id, count + 1);
      balanced.push(item);
    }
    const results = []; let characters = 0;
    for (const item of balanced.slice(offset, offset + limit)) {
      const row = candidates.get(item.id);
      const excerpt = snippet(row.text, query, Math.min(600, Math.max(0, maxChars - characters)));
      const result = { unit_id: row.id, resource_id: row.resource_id, title: row.title, kind: row.resource_kind, unit_kind: row.kind, locator: JSON.parse(row.locator_json), snippet: excerpt, source_node: row.source_node, source_uri: row.source_uri, sharing: row.sharing, status: row.status, ...(row.last_error ? { last_error: row.last_error } : {}), score: item.score, matched_modality: [...new Set(item.matches.map(match => match.modality))], matches: item.matches };
      const length = JSON.stringify(result).length;
      if (characters + length > maxChars) break;
      results.push(result); characters += length;
    }
    return { schema_version: SCHEMA_VERSION, query, mode, results, total: balanced.length, semantic_status: semanticStatus, fallback: fallback || (mode === 'hybrid' && semanticStatus === 'unavailable'), diagnostics: { elapsed_ms: Math.round((performance.now() - started) * 100) / 100, candidates: rows.length, candidate_limit: candidateLimit, candidates_truncated: truncated, vector_spaces: spaces, successful_vector_spaces: spacesSucceeded, visual_vectors: visualCandidates, errors: semanticErrors, visual_search_unavailable: mode !== 'lexical' && semanticStatus === 'unavailable' && (!modalities.includes('text') || rows.some(row => !row.text.trim())), chars: characters, per_resource_limit: perResourceLimit } };
  }

  read(unitId) {
    this.ensureOpen();
    const row = this.store.db.prepare('SELECT u.*, r.title, r.kind AS resource_kind, r.source_node, r.source_uri, r.sharing, r.revision, r.parser_version, r.status, r.last_error FROM units u JOIN resources r ON r.id = u.resource_id WHERE u.id = ?').get(unitId);
    if (!row) return null;
    const representations = this.store.db.prepare('SELECT rp.*, v.profile_id, p.metadata_json FROM representations rp LEFT JOIN vectors v ON v.id = rp.vector_id LEFT JOIN profiles p ON p.id = v.profile_id WHERE rp.unit_id = ?').all(unitId).map(rep => ({ id: rep.id, modality: rep.modality, content_hash: rep.content_hash, ...(rep.text !== null ? { text: rep.text } : {}), ...(rep.path !== null ? { path: rep.path } : {}), vector_id: rep.vector_id, profile: rep.metadata_json ? JSON.parse(rep.metadata_json) : null, error: rep.error }));
    return { schema_version: SCHEMA_VERSION, unit_id: row.id, resource_id: row.resource_id, title: row.title, kind: row.resource_kind, unit_kind: row.kind, source_node: row.source_node, source_uri: row.source_uri, sharing: row.sharing, revision: row.revision, parser_version: row.parser_version, resource: { resource_id: row.resource_id, title: row.title, kind: row.resource_kind, source_node: row.source_node, source_uri: row.source_uri, sharing: row.sharing, revision: row.revision, parser_version: row.parser_version, status: row.status, last_error: row.last_error }, locator: JSON.parse(row.locator_json), text: row.text, metadata: JSON.parse(row.metadata_json), representations };
  }

  list(options = {}) {
    this.ensureOpen();
    const limit = boundedInt(options.limit, 100, 1, 1000), offset = boundedInt(options.offset, 0, 0, 1000000);
    const sharing = options.sharing ?? ['local', 'network'];
    const values = Array.isArray(sharing) ? sharing : [sharing];
    if (!values.length || values.some(value => !SHARING_VALUES.includes(value))) throw new Error('Invalid sharing filter');
    const filter = `WHERE r.sharing IN (${values.map(() => '?').join(',')})`;
    const resources = this.store.db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM units u WHERE u.resource_id = r.id) AS unit_count FROM resources r ${filter} ORDER BY r.indexed_at DESC, r.id LIMIT ? OFFSET ?`).all(...values, limit, offset).map(row => {
      const { id, canonical_path, warnings_json, ...resource } = row;
      return { ...resource, resource_id: id, warnings: JSON.parse(warnings_json) };
    });
    return { resources, total: this.store.db.prepare(`SELECT COUNT(*) AS n FROM resources r ${filter}`).get(...values).n, limit, offset };
  }

  remove(resourceId) { this.ensureOpen(); return this.store.remove(resourceId); }
  stats() {
    this.ensureOpen();
    const count = table => this.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    return { schema_version: SCHEMA_VERSION, db_path: this.dbPath, resources: count('resources'), stale_resources: this.store.db.prepare("SELECT COUNT(*) AS n FROM resources WHERE status = 'stale'").get().n, units: count('units'), representations: count('representations'), vectors: count('vectors'), profiles: count('profiles'), pending_representations: this.store.db.prepare('SELECT COUNT(*) AS n FROM representations WHERE vector_id IS NULL').get().n };
  }
  close() { if (!this.closed) { this.store.close(); this.closed = true; } }
}

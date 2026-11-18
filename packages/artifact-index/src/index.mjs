import { createReadStream } from 'node:fs';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join, resolve, basename, dirname, extname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { ArtifactStore } from './store.mjs';
import { collectArtifacts } from './scan.mjs';
import { PARSER_VERSION } from './extract.mjs';
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
/** Run workers concurrently while keeping the input order of their results. */
async function mapConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
function queryTerms(query) {
  const words = normalized(query).match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms = new Set();
  for (const word of words) {
    if (word.length > 64) continue;
    terms.add(word);
    // A Han run without spaces is one word; its character bigrams keep a
    // multi-character phrase searchable inside longer body text.
    if (/\p{Script=Han}/u.test(word) && word.length > 2) for (let i = 0; i < word.length - 1; i++) terms.add(word.slice(i, i + 2));
  }
  return [...terms].slice(0, 128);
}
function occurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0, index = haystack.indexOf(needle);
  // Saturation needs a rough count, not an exact one.
  while (index !== -1 && count < 8) { count++; index = haystack.indexOf(needle, index + needle.length); }
  return count;
}
function lexicalScore(text, title, query, terms) {
  const body = normalized(text), heading = normalized(title), phrase = normalized(query).trim();
  let score = body.includes(phrase) ? 5 : 0;
  if (heading.includes(phrase)) score += 2;
  let matched = 0;
  for (const term of terms) {
    const bodyHits = occurrences(body, term);
    if (bodyHits) { score += 1 + Math.log2(bodyHits); matched++; }
    const titleHits = occurrences(heading, term);
    // A file name is a deliberate label, so it counts as much as the body.
    if (titleHits) score += 1 + Math.log2(titleHits);
  }
  // A title is useful context, but cannot make every empty page in a video or
  // document a separate lexical hit.
  if (!matched && !body.includes(phrase)) return 0;
  return score / (1 + Math.log1p(body.length) / 20);
}
/**
 * A path that names the subject of a search outranks a bulk corpus.
 *
 * A library can hold thousands of generated fixtures that happen to contain a
 * common word. The directory holding the person's own material is a stronger
 * signal than any single document title. A report about a search is weaker
 * than the document the search is about.
 *
 * The hint only applies when the QUERY mentions that subject: searching for a
 * project name must not drag in the resume just because its path says "简历".
 */
const PERSONAL_PATH_HINTS = [
  ['简历', 3], ['讲师', 3], ['求职', 3], ['个人简历', 3], ['自我介绍', 3], ['作品集', 3],
  ['培训', 2], ['白皮书', 2], ['报告', 2], ['个人', 2],
];
const WEAK_PATH_HINTS = [['检索', 1], ['findings', 1], ['summary', 1]];
// The multimodal profile holds page renders, slide images and video clips;
// the Qwen document profile holds text only. An image query can only enter
// the former, so a text-only space is skipped instead of failing the search.
// Transient embedding failures are worth another attempt: a supervisor that
// is switching models can return 503 for a batch that would succeed seconds
// later. Rejected payloads are not retried.
// A supervisor that retires a wedged worker needs ~10 s to load a new one, so
// the backoff must outlast a reload instead of retrying into the same window.
const RETRY_DELAYS = [2000, 15000, 30000];
const RETRYABLE_EMBEDDING = /(?:HTTP (?:429|5\d\d)|\b(?:429|503|504)\b|timed out|timeout|ECONN|EPIPE|ECONNRESET|socket|fetch failed|network|queue is full|cancelled)/i;
const PERMANENT_EMBEDDING = /(?:invalid|mismatch|must |unsupported|not support|unknown)/i;

function retryableEmbeddingError(detail) {
  return !PERMANENT_EMBEDDING.test(detail) && RETRYABLE_EMBEDDING.test(detail);
}

/** Sleep that reacts to cancellation instead of holding the run open. */
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('Embedding request cancelled'));
    const onAbort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('Embedding request cancelled')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Formats whose parser renders pages, slides or video frames. A copy may adopt
// a twin's units only when that twin already carries those renders, otherwise
// an earlier `--no-visual` run would silently strip visuals from the copy.
const RENDERED_EXTENSIONS = new Set(['.pdf', '.pptx', '.pptm', '.ppt', '.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.mpeg', '.mpg']);

/** Re-key another resource's parsed units under this copy's resource id. */
function adoptUnits(source, resourceId) {
  return source.units.map(unit => {
    const id = `unit:${hash(`${resourceId}\0${stableJSON(unit.locator)}`)}`;
    return { ...unit, id, representations: unit.representations.map(rep => ({
      ...rep, id: `representation:${hash(`${id}\0${rep.modality}\0${rep.content_hash}`)}`,
    })) };
  });
}

function supportsMediaQuery(profile) {
  if (!profile || typeof profile !== 'object') return false;
  return profile.alias === 'embeddinggemma2' || profile.task === 'multimodal'
    || (typeof profile.encoding === 'string' && profile.encoding.startsWith('dreammate.gemma2.v1'));
}
function pathWeight(canonicalPath, query = '') {
  if (!canonicalPath) return 0;
  // The boost is evidence that the user named the subject; an image query has
  // no words to compare, so it must never invent a personal-material signal.
  if (!String(query).trim()) return 0;
  const path = normalized(canonicalPath), q = normalized(query);
  let weight = 0;
  for (const [hint, value] of PERSONAL_PATH_HINTS) {
    const h = normalized(hint);
    // The subject must actually be what the user searched for.
    if (q && !q.includes(h) && !h.includes(q)) continue;
    if (path.includes(h)) weight = Math.max(weight, value);
  }
  // Reports about a search describe the material rather than being it.
  for (const [hint, value] of WEAK_PATH_HINTS) if (path.includes(normalized(hint))) weight = Math.min(weight, value);
  return weight;
}
function snippet(text, query, max = 600) {
  if (text.length <= max) return text;
  const index = normalized(text).indexOf(normalized(query));
  const start = index < 0 ? 0 : Math.max(0, index - Math.floor(max / 3));
  return `${start ? '…' : ''}${text.slice(start, start + max)}${start + max < text.length ? '…' : ''}`;
}

/** Replace halves of a surrogate pair that lost their partner. */
function withoutLoneSurrogates(value) {
  return value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

const isLowSurrogate = code => code >= 0xDC00 && code <= 0xDFFF;
const isHighSurrogate = code => code >= 0xD800 && code <= 0xDBFF;

/** Split text without ever cutting an emoji or other surrogate pair in half. */
function textChunks(text, configuredLimit) {
  // The shared Qwen document profile has a 512-token window. A page remains
  // one addressable unit, but several overlapping representations ensure its
  // final paragraphs are searchable instead of silently being truncated.
  const size = boundedInt(configuredLimit, /\p{Script=Han}/u.test(text) ? 384 : 1400, 64, 4000);
  if (text.length <= size) return [text];
  const result = [], overlap = Math.min(64, Math.floor(size / 8)), step = size - overlap;
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + size);
    // A slice boundary inside a surrogate pair yields half an emoji, which
    // serialises as a lone surrogate and makes the tokenizer throw.
    if (end < text.length && isLowSurrogate(text.charCodeAt(end))) end -= 1;
    const value = text.slice(start, end);
    if (value.trim()) result.push(value);
    if (end >= text.length) break;
    let next = start + step;
    if (next > start && isLowSurrogate(text.charCodeAt(next))) next -= 1;
    start = Math.max(next, start + 1);
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
    // Tests and hosts can shorten the backoff without touching defaults.
    this.retryDelays = Array.isArray(options.retryDelays) ? options.retryDelays : undefined;
    this.store = new ArtifactStore(this.dbPath);
    this.mutationTail = Promise.resolve();
    this.closed = false;
  }

  ensureOpen() { if (this.closed) throw new Error('Artifact index is closed'); }

  /**
   * Index files and directories.
   *
   * A directory is walked for locally parseable formats; an explicit file is
   * always attempted so an unsupported format reports a parse error instead of
   * disappearing. A file whose size and modification time are unchanged keeps
   * its existing units and vectors unless `reindex` is requested.
   */
  async index(paths, options = {}) {
    this.ensureOpen();
    if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string') || !paths.length) throw new Error('index() requires one or more file paths');
    const discovery = options.scan === false
      ? { files: paths, directories: [], skipped: [], truncated: false }
      : await collectArtifacts(paths, options.scan ?? {});
    if (!discovery.files.length) {
      return {
        schema_version: SCHEMA_VERSION, resources: [],
        diagnostics: { parsed: 0, indexed: 0, reused: 0, failed: 0, skipped: 0, cached_representations: 0, vectorized_text: 0, vectorized_visual: 0, embedding_errors: [],
          scanned_directories: discovery.directories.length, discovered_files: 0, skipped_files: discovery.skipped_total ?? discovery.skipped.length, skipped_reasons: discovery.skipped_counts ?? {}, truncated: discovery.truncated },
      };
    }
    const operation = this.mutationTail.then(() => this.indexBatch(discovery.files, { ...options, discovery }));
    this.mutationTail = operation.catch(() => {});
    return operation;
  }

  /** True when a stored resource still matches the file on disk. */
  unchanged(resourceId, info, options = {}) {
    const previous = this.store.resource(resourceId);
    if (!previous || previous.status !== 'ready') return false;
    // A newer parser must re-read the source even when the bytes are the same.
    if (previous.parser_version !== (options.parserVersion ?? PARSER_VERSION)) return false;
    if (previous.size !== info.size || previous.mtime_ms !== info.mtimeMs) return false;
    // A resource whose vectors never landed must be retried; otherwise a
    // failed embedding batch would leave it permanently unsearchable.
    return !this.store.hasPendingVectors(resourceId);
  }

  async indexBatch(paths, options) {
    this.ensureOpen();
    await mkdir(this.cacheDir, { recursive: true });
    const semantic = options.semantic !== false, visual = options.visual !== false;
    // Semantic indexing needs a provider. Without one the run is lexical
    // only, and the representations are not "pending" — nothing to retry.
    const embeddable = semantic && typeof this.embeddings?.embedText === 'function';
    const sharing = options.sharing ?? this.sharing;
    if (!SHARING_VALUES.includes(sharing)) throw new Error('Invalid sharing value');
    const outcomes = [], seen = new Set();
    let cached = 0;
    const errors = [];
    // Commit in groups so a long library scan keeps its progress and a
    // restart resumes instead of repeating the whole collection.
    const groupSize = boundedInt(options.chunkSize, 64, 1, 2000);
    for (const [groupIndex, group] of chunks(paths, groupSize).entries()) {
      options.onProgress?.({ phase: 'parse', group: groupIndex + 1, groups: Math.ceil(paths.length / groupSize), files: group.length });
      const prepared = await this.parseGroup(group, options, outcomes, seen, semantic, embeddable, visual, sharing);
      options.onProgress?.({ phase: 'embed', group: groupIndex + 1, groups: Math.ceil(paths.length / groupSize), files: prepared.length });
      const encoded = await this.embedGroup(prepared, options);
      cached += encoded.cached;
      errors.push(...encoded.errors);
      options.onProgress?.({ phase: 'commit', group: groupIndex + 1, groups: Math.ceil(paths.length / groupSize), files: prepared.length, cached: encoded.cached });
      await this.commitGroup(prepared, options);
    }
    const discovery = options.discovery ?? { directories: [], skipped: [], truncated: false };
    return {
      schema_version: SCHEMA_VERSION, resources: outcomes,
      diagnostics: { parsed: outcomes.filter(item => item.status !== 'failed' && item.status !== 'skipped').length, indexed: outcomes.filter(item => item.status === 'indexed').length, reused: outcomes.filter(item => item.reused_from).length, failed: outcomes.filter(item => item.status === 'failed').length, skipped: outcomes.filter(item => item.status === 'skipped').length, cached_representations: cached, vectorized_text: outcomes.reduce((n, item) => n + (item.representations?.vectorized_text ?? 0), 0), vectorized_visual: outcomes.reduce((n, item) => n + (item.representations?.vectorized_visual ?? 0), 0), embedding_errors: errors,
        scanned_directories: discovery.directories.length, discovered_files: discovery.files?.length ?? paths.length, skipped_files: discovery.skipped_total ?? discovery.skipped.length, skipped_reasons: discovery.skipped_counts ?? {}, truncated: discovery.truncated === true },
    };
  }

  /**
   * A committed resource holding the same bytes, or null. Copies adopt its
   * units instead of re-rendering pages or re-encoding media; vectors are
   * shared by content hash, so adopting costs one insert.
   */
  storedTwin(revision, extension, canonical, visual, parserVersion) {
    const twin = this.store.twin(revision, parserVersion, canonical);
    // A twin indexed without visuals must not satisfy a run that asks for them.
    const needsVisual = visual && RENDERED_EXTENSIONS.has(extension);
    if (!twin || extname(twin.canonical_path).toLowerCase() !== extension) return null;
    if (needsVisual && !this.store.hasVisualRepresentations(twin.id)) return null;
    return {
      from: twin.canonical_path, kind: twin.kind, mime: twin.mime, title: twin.title,
      parser_version: twin.parser_version, warnings: JSON.parse(twin.warnings_json ?? '[]'),
      units: this.store.unitsWithRepresentations(twin.id).map(row => ({
        kind: row.kind, locator: JSON.parse(row.locator_json), text: row.text, metadata: JSON.parse(row.metadata_json),
        representations: row.representations.map(rep => ({
          modality: rep.modality, content_hash: rep.content_hash,
          ...(rep.text !== null ? { text: rep.text } : { path: rep.path }),
          ...(rep.vector_id ? { vector_id: rep.vector_id } : {}),
        })),
      })),
    };
  }

  /** Builder that materialises a copy from an adopted parse, or null. */
  adoption(source, revision, canonical, resourceId, sharing) {
    if (!source) return null;
    const units = adoptUnits(source, resourceId);
    return after => {
      const resource = {
        id: resourceId, source_node: this.sourceNode, source_uri: pathToFileURL(canonical).href, canonical_path: canonical,
        kind: source.kind, mime: source.mime, title: source.title, revision, size: after.size, mtime_ms: after.mtimeMs, sharing,
        parser_version: source.parser_version, indexed_at: new Date().toISOString(),
        warnings: [...source.warnings, `Identical bytes were already parsed at ${source.from}; parsing was skipped`],
      };
      const outcome = { path: canonical, resource_id: resourceId, status: 'parsed', units: units.length, reused_from: source.from, warnings: resource.warnings };
      return { outcome, prepared: { resource, units, outcome } };
    };
  }

  /** Parse one group of sources into resources, units and representations. */
  async parseGroup(paths, options, outcomes, seen, semantic, embeddable, visual, sharing) {
    const prepared = [];
    // Copies inside one group race each other, so the first parse publishes its
    // units and the rest adopt them. The map only spans this group, so memory
    // stays as small as the group itself.
    const flights = new Map();
    // Each source needs its own parser process, so several sources are read
    // at once; the parser startup dominates a single small file.
    const concurrency = boundedInt(options.concurrency, 6, 1, 32);
    const results = await mapConcurrent(paths, concurrency, async suppliedPath => {
      let sourceId = `resource:${hash(`${this.sourceNode}\0${await potentialRealPath(suppliedPath)}`)}`, observedRevision, publish;
      try {
        const canonical = await realpath(resolve(suppliedPath));
        if (seen.has(canonical)) return { outcome: { path: suppliedPath, status: 'skipped', reason: 'duplicate_path' } };
        seen.add(canonical);
        const before = await stat(canonical);
        if (!before.isFile()) throw new Error('Artifact source must be a regular file');
        const resourceId = `resource:${hash(`${this.sourceNode}\0${canonical}`)}`;
        sourceId = resourceId;
        if (!options.reindex && this.unchanged(resourceId, before, options)) {
          return { outcome: { path: canonical, resource_id: resourceId, status: 'skipped', reason: 'unchanged' } };
        }
        const revision = await fileHash(canonical);
        observedRevision = revision;
        const extension = extname(canonical).toLowerCase();
        const flightKey = `${revision}\u0000${extension}`;
        // Copies of the same bytes share one parse. The first source to hash
        // registers before any other await, so the copy that arrives second
        // always sees the registration and never parses in parallel.
        const flight = flights.get(flightKey);
        let adoption = null;
        if (flight) adoption = this.adoption(await flight, revision, canonical, resourceId, sharing);
        if (!adoption) adoption = this.adoption(this.storedTwin(revision, extension, canonical, visual, options.parserVersion ?? PARSER_VERSION), revision, canonical, resourceId, sharing);
        if (adoption) {
          const settled = await stat(canonical);
          if (settled.size !== before.size || settled.mtimeMs !== before.mtimeMs) throw new Error('Source file changed while being indexed; retry');
          return adoption(settled);
        }
        if (!flights.has(flightKey)) flights.set(flightKey, new Promise(resolve => { publish = resolve; }));
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
          const text = withoutLoneSurrogates(String(sourceUnit.text ?? ''));
          if (text.length > 10_000_000) throw new Error('An extracted unit exceeds the 10 MB text limit');
          const representations = [], repIds = new Set();
          let rawReps = [...(sourceUnit.representations ?? [])];
          // Chunk the complete unit text so the shared document window is used
          // as designed; the parser's own chunk boundaries are redundant here.
          if (text.trim()) rawReps = [{ modality: 'text', text }, ...rawReps.filter(rep => rep.modality !== 'text')];
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
            if (!semantic || !embeddable || (raw.modality !== 'text' && !visual)) rep.error = 'embedding_disabled';
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
        publish?.({ from: canonical, kind: resource.kind, mime: resource.mime, title: resource.title,
          parser_version: resource.parser_version, warnings: resource.warnings, units });
        return { outcome, prepared: { resource, units, outcome } };
      } catch (error) {
        // Copies waiting on this parse must fall back to parsing themselves.
        publish?.(null);
        const previous = this.store.resource(sourceId);
        if (previous) this.store.markFailure(sourceId, message(error), !observedRevision || previous.revision !== observedRevision || /changed while/.test(message(error)));
        return { outcome: { path: suppliedPath, resource_id: previous?.id, status: 'failed', error: message(error), ...(previous ? { snapshot_status: this.store.resource(sourceId).status } : {}) } };
      }
    });
    for (const result of results) {
      if (!result) continue;
      outcomes.push(result.outcome);
      if (result.prepared) prepared.push(result.prepared);
    }
    return prepared;
  }

  /** Encode the pending representations of one group, reusing cached vectors. */
  async embedGroup(prepared, options) {
    const allReps = prepared.flatMap(file => file.units.flatMap(unit => unit.representations));
    const groups = new Map();
    for (const rep of allReps) {
      // A representation that failed a previous attempt is retried now; only
      // a deliberate opt-out stays excluded.
      if (rep.error && rep.error !== 'embedding_disabled') continue;
      if (rep.error === 'embedding_disabled') continue;
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
      const size = boundedInt(media ? options.mediaBatchSize : options.textBatchSize, media ? 8 : 32, 1, 128);
      const retries = boundedInt(media ? options.mediaRetries : options.textRetries, 2, 0, 5);
      const budget = boundedInt(options.maxConsecutiveFailures, 4, 1, 100);
      const delays = Array.isArray(options.retryDelays) ? options.retryDelays : (this.retryDelays ?? RETRY_DELAYS);
      const label = media ? 'visual' : 'text';
      const attempt = async batch => {
        let failure;
        for (let round = 0; round <= retries; round++) {
          if (round) await pause(delays[Math.min(round - 1, delays.length - 1)] ?? 0, options.signal);
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
            return undefined;
          } catch (error) {
            failure = error;
            // A rejected batch payload will fail again; only transport and
            // service-side failures are worth another attempt.
            if (!retryableEmbeddingError(message(error))) break;
          }
        }
        return failure;
      };
      const jobs = chunks(pending, size);
      let consecutive = 0;
      while (jobs.length) {
        const batch = jobs.shift();
        const failure = await attempt(batch);
        if (!failure) { consecutive = 0; continue; }
        // Some batches fail because of their size on a memory-constrained
        // encoder. Halving isolates the real culprit instead of losing every
        // representation in the batch.
        if (batch.length > 1 && consecutive === 0) {
          const middle = Math.ceil(batch.length / 2);
          jobs.unshift(batch.slice(0, middle), batch.slice(middle));
          continue;
        }
        const detail = message(failure);
        for (const reps of batch) for (const rep of reps) rep.error = detail;
        errors.push({ modality: label, error: detail, representations: batch.reduce((sum, reps) => sum + reps.length, 0), circuit_open: false });
        consecutive += 1;
        if (consecutive < budget) continue;
        const remaining = jobs.flat();
        if (!remaining.length) break;
        errors.push({ modality: label, error: detail, representations: remaining.reduce((sum, reps) => sum + reps.length, 0), circuit_open: true });
        for (const reps of remaining) for (const rep of reps) rep.error = detail;
        jobs.length = 0;
      }
    };
    // Batch all documents by backend so a PDF with many pages does not switch
    // Qwen ↔ Gemma once per page on a memory-constrained local machine.
    await encodeGroups(pendingText, false);
    await encodeGroups(pendingMedia, true);
    return { cached, errors };
  }

  /** Commit one group; a changed source keeps its previous snapshot. */
  async commitGroup(prepared, options) {
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
  }

  async search(query, options = {}) {
    this.ensureOpen();
    // An image query enters the same multimodal space as page renders, slide
    // images and video clips, so no transcription step is needed.
    const queryImage = options.queryImage;
    if (queryImage !== undefined) {
      if (typeof queryImage !== 'string' || !isAbsolute(queryImage)) throw new Error('queryImage must be an absolute local path');
      const info = await stat(queryImage).catch(() => null);
      if (!info?.isFile()) throw new Error('queryImage must point to an existing local file');
    }
    if (typeof query !== 'string') query = '';
    if ((!queryImage && !query.trim()) || query.length > 8192) throw new Error('Query must contain 1 to 8192 characters');
    const started = performance.now();
    const mode = options.mode ?? 'hybrid';
    if (!['hybrid', 'lexical', 'semantic'].includes(mode)) throw new Error('Invalid search mode');
    // An image carries no words, so it cannot rank the lexical channel.
    if (queryImage && mode === 'lexical') throw new Error('Image queries require hybrid or semantic mode');
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
    // Path filters keep bulk generated corpora out of a personal search. The
    // pattern matches the canonical source path.
    const pathFilters = (options.excludePaths ?? []).filter(value => typeof value === 'string' && value.trim());
    const pathFilterClause = pathFilters.length ? ` AND ${pathFilters.map(() => "r.canonical_path NOT LIKE ?").join(' AND ')}` : '';
    const pathFilterArgs = pathFilters.map(pattern => `%${pattern}%`);
    const rows = this.store.db.prepare(`SELECT u.*, r.title, r.source_node, r.source_uri, r.canonical_path, r.kind AS resource_kind, r.sharing, r.status, r.last_error, r.revision FROM units u JOIN resources r ON r.id = u.resource_id WHERE r.sharing IN (${sharingValues.map(() => '?').join(',')}) AND r.kind IN (${types.map(() => '?').join(',')})${statusFilter}${pathFilterClause} ORDER BY r.indexed_at DESC, u.ordinal LIMIT ?`).all(...sharingValues, ...types, ...pathFilterArgs, candidateLimit + 1);
    const truncated = rows.length > candidateLimit;
    if (truncated) rows.pop();
    const candidates = new Map(rows.map(row => [row.id, row]));
    // Rank ties fall back to the source path, not a hash-derived unit id, so
    // identical copies always resolve to the same keeper across runs.
    const pathOf = id => candidates.get(id)?.canonical_path ?? '';
    const rankedLists = [], semanticErrors = [];
    const terms = queryTerms(query);
    const lexical = !queryImage && modalities.includes('text') ? rows.map(row => {
      const base = lexicalScore(row.text, row.title, query, terms);
      if (!base) return { id: row.id, score: 0, modality: 'text' };
      // A personal-material path is a deliberate signal and outranks a bulk
      // generated corpus that merely repeats the query word.
      return { id: row.id, score: base * (1 + pathWeight(row.canonical_path, query)), modality: 'text' };
    }).filter(row => row.score > 0).sort((a, b) => b.score - a.score || pathOf(a.id).localeCompare(pathOf(b.id)) || a.id.localeCompare(b.id)) : [];
    if (mode !== 'semantic' && !queryImage) rankedLists.push({ profile: null, rows: lexical });
    let spaces = 0, spacesSucceeded = 0, visualCandidates = 0;
    if (mode !== 'lexical' && candidates.size) {
      const spacesMap = new Map();
      // Apply source/type/sharing filters in SQL before loading any vectors.
      const vectorRows = this.store.db.prepare(`WITH filtered_units AS (SELECT u.id FROM units u JOIN resources r ON r.id = u.resource_id WHERE r.sharing IN (${sharingValues.map(() => '?').join(',')}) AND r.kind IN (${types.map(() => '?').join(',')})${statusFilter}${pathFilterClause} ORDER BY r.indexed_at DESC, u.ordinal LIMIT ?) SELECT rp.unit_id, rp.modality, v.data, v.profile_id, p.metadata_json FROM representations rp JOIN vectors v ON v.id = rp.vector_id JOIN profiles p ON p.id = v.profile_id JOIN filtered_units u ON u.id = rp.unit_id WHERE rp.modality IN (${modalities.map(() => '?').join(',')})`).all(...sharingValues, ...types, ...pathFilterArgs, candidateLimit, ...modalities);
      for (const row of vectorRows) {
        if (!candidates.has(row.unit_id)) continue;
        if (row.modality !== 'text') visualCandidates++;
        if (!spacesMap.has(row.profile_id)) spacesMap.set(row.profile_id, { profile: JSON.parse(row.metadata_json), vectors: [] });
        spacesMap.get(row.profile_id).vectors.push(row);
      }
      // A text index lives in the Qwen space and cannot hold an image query;
      // only the multimodal (Gemma) space accepts page renders and clips.
      const queryableSpaces = [...spacesMap.values()].filter(space => !queryImage || supportsMediaQuery(space.profile));
      const selectedSpaces = queryableSpaces.sort((a, b) => a.profile.alias.localeCompare(b.profile.alias)).slice(0, boundedInt(options.maxProfiles, 8, 1, 32));
      spaces = queryableSpaces.length;
      if (queryableSpaces.length > selectedSpaces.length) semanticErrors.push({ error: 'Embedding profile search budget exceeded' });
      for (const space of selectedSpaces) {
        try {
          if (queryImage ? typeof this.embeddings?.embedMedia !== 'function' : typeof this.embeddings?.embedQuery !== 'function') throw new Error('No local embedding provider configured');
          const result = await timed(signal => queryImage
            ? this.embeddings.embedMedia([{ modality: 'image', path: queryImage }], { signal })
            : this.embeddings.embedQuery(query, space.profile, { signal }), boundedInt(options.embeddingTimeoutMs, 60000, 1, 600000), options.signal);
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
          // A personal-material path breaks ties inside the vector space, so a
          // generated fixture corpus cannot outrank the actual documents.
          const semanticRows = [...byUnit.values()].map(row => {
            const resource = candidates.get(row.id);
            const weight = resource ? 1 + pathWeight(resource.canonical_path, query) : 1;
            // Keep the raw cosine for reporting; only ordering uses the weight.
            return { ...row, similarity: row.score, score: row.score * weight };
          }).sort((a, b) => b.score - a.score || pathOf(a.id).localeCompare(pathOf(b.id)) || a.id.localeCompare(b.id));
          rankedLists.push({ profile: actual.id, rows: semanticRows });
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
        value.matches.push({ modality: item.modality, profile_id: list.profile, rank: index + 1, similarity: list.profile ? (item.similarity ?? item.score) : undefined });
      }
    }
    // Rank fusion compares positions inside a channel, so a raw score cannot
    // separate channels. A file that the searcher deliberately named — a
    // resume, a registration form — is a stronger answer than a bulk corpus
    // that merely occupies a better rank in one channel.
    for (const value of fused.values()) {
      const row = candidates.get(value.id);
      if (!row) continue;
      const weight = pathWeight(row.canonical_path, query);
      if (weight) { value.score *= 1 + weight; value.personal = true; }
    }
    // Different channels' rank-one hits stay together, in stable channel/list
    // order, ahead of every rank-two hit. Hash-derived unit IDs do not decide
    // which modality wins an otherwise equal ranking.
    const sorted = [...fused.values()].sort((a, b) => b.score - a.score || a.best_list_order - b.best_list_order
      || pathOf(a.id).localeCompare(pathOf(b.id)) || a.id.localeCompare(b.id));
    // The same bytes copied to another path are one answer, not two. Units are
    // keyed by file revision plus locator, so page 65 of a copied PDF merges
    // while page 66 stays its own hit. The winning rank keeps its locator and
    // carries the other copies as `duplicates` instead of repeating itself.
    const collapse = options.collapseDuplicates !== false;
    const seenUnits = new Map(), collapsed = [];
    let duplicatesCollapsed = 0;
    for (const item of sorted) {
      const row = candidates.get(item.id);
      if (!row) continue;
      const key = `${row.revision}\u0000${row.locator_json}`;
      const keeper = collapse ? seenUnits.get(key) : undefined;
      if (keeper) {
        keeper.duplicates.push({ resource_id: row.resource_id, title: row.title, source_uri: row.source_uri, source_node: row.source_node, sharing: row.sharing });
        duplicatesCollapsed++;
        continue;
      }
      const entry = { ...item, duplicates: [] };
      if (collapse) seenUnits.set(key, entry);
      collapsed.push(entry);
    }
    const counts = new Map(), balanced = [];
    for (const item of collapsed) {
      const row = candidates.get(item.id), count = counts.get(row.resource_id) ?? 0;
      if (count >= perResourceLimit) continue;
      counts.set(row.resource_id, count + 1);
      balanced.push(item);
    }
    const results = []; let characters = 0;
    for (const item of balanced.slice(offset, offset + limit)) {
      const row = candidates.get(item.id);
      const excerpt = snippet(row.text, query, Math.min(600, Math.max(0, maxChars - characters)));
      // `score` is the fused rank score; `similarity` is the raw cosine of the
      // best vector hit so callers can see how close the match really was.
      const similarities = item.matches.map(match => match.similarity).filter(value => typeof value === 'number');
      const result = { unit_id: row.id, resource_id: row.resource_id, title: row.title, kind: row.resource_kind, unit_kind: row.kind, locator: JSON.parse(row.locator_json), snippet: excerpt, source_node: row.source_node, source_uri: row.source_uri, sharing: row.sharing, status: row.status, ...(row.last_error ? { last_error: row.last_error } : {}), score: item.score, ...(similarities.length ? { similarity: Math.max(...similarities) } : {}), ...(item.duplicates?.length ? { duplicates: item.duplicates } : {}), matched_modality: [...new Set(item.matches.map(match => match.modality))], matches: item.matches };
      const length = JSON.stringify(result).length;
      if (characters + length > maxChars) break;
      results.push(result); characters += length;
    }
    return { schema_version: SCHEMA_VERSION, query, ...(queryImage ? { query_image: queryImage } : {}), mode, results, total: balanced.length, semantic_status: semanticStatus, fallback: fallback || (mode === 'hybrid' && semanticStatus === 'unavailable'), diagnostics: { elapsed_ms: Math.round((performance.now() - started) * 100) / 100, candidates: rows.length, candidate_limit: candidateLimit, candidates_truncated: truncated, vector_spaces: spaces, successful_vector_spaces: spacesSucceeded, visual_vectors: visualCandidates, errors: semanticErrors, visual_search_unavailable: mode !== 'lexical' && semanticStatus === 'unavailable' && (!modalities.includes('text') || rows.some(row => !row.text.trim())), chars: characters, per_resource_limit: perResourceLimit, duplicates_collapsed: duplicatesCollapsed } };
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

/** Reuse DreamMate's registered local providers. No model installation or worker spawning. */
import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { link, mkdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import path from 'node:path';

const PROTOCOL = 'dreammate.embedding.v1';
const MAX_BODY = 262144, MAX_RESPONSE = 16 * 1024 * 1024;
const fail = message => Object.assign(new Error(message), { code: 'EMBEDDING_UNAVAILABLE' });
const canonical = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 200;

export function isPrivateAddress(value) {
  const address = value.replace(/^\[|\]$/g, '').toLowerCase();
  if (address === '::1') return true;
  if (address.startsWith('::ffff:')) return isPrivateAddress(address.slice(7));
  if (isIP(address) === 6) return /^f[cd][0-9a-f]{2}:/.test(address) || /^fe[89ab][0-9a-f]:/.test(address);
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
}

function agentUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('Invalid local embedding gateway URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || (url.pathname !== '/' && url.pathname !== '') || (isIP(url.hostname.replace(/^\[|\]$/g, '')) && !isPrivateAddress(url.hostname))) {
    throw fail('Embedding gateway must be a loopback or private-network HTTP origin');
  }
  return url;
}

function isLoopback(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
}

async function requestJson(url, { body, timeoutMs, signal }) {
  signal?.throwIfAborted();
  const started = Date.now();
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(fail('Local embedding gateway DNS timed out')), timeoutMs);
    const abort = () => reject(signal.reason ?? fail('Embedding operation cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    lookup(host, { all: true }).then(resolve, reject).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', abort); });
  });
  timeoutMs -= Date.now() - started;
  if (timeoutMs < 1) throw fail('Local embedding operation timed out');
  signal?.throwIfAborted();
  if (!addresses.length || addresses.some(item => !isPrivateAddress(item.address))) throw fail('Public embedding gateways are not allowed');
  const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  if (data && data.length > MAX_BODY) throw fail('Embedding request exceeds the local provider body limit');
  return new Promise((resolve, reject) => {
    const pinned = addresses[0];
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: data ? 'POST' : 'GET', agent: false, signal,
      lookup: (_hostname, options, callback) => options?.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family),
      headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
    }, response => {
      let size = 0; const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_RESPONSE) response.destroy(fail('Embedding response exceeds limit'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) throw fail(`Local embedding request failed (HTTP ${response.statusCode})`);
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!result || typeof result !== 'object' || Array.isArray(result)) throw fail('Invalid local embedding response');
          resolve(result);
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => request.destroy(fail('Local embedding request timed out')), timeoutMs);
    request.once('close', () => clearTimeout(timer));
    request.on('error', reject);
    request.end(data);
  });
}

export function embeddingProfile(value) {
  const alias = value.alias ?? value.model;
  if (!['qwen3', 'embeddinggemma2'].includes(alias) || !canonical(value.revision) || !canonical(value.encoding)
    || !Number.isSafeInteger(value.dimensions) || value.dimensions < 1 || value.dimensions > 4096
    || (value.task !== undefined && value.task !== 'document_search')) throw fail('Invalid embedding profile');
  if (alias === 'qwen3' ? value.task !== 'document_search' || !/^dreammate\.artifact-search\.v1:fp32:max\d+:dim\d+$/.test(value.encoding)
    : value.task !== undefined || !/^dreammate\.gemma2\.v1:fp32:max\d+:dim\d+$/.test(value.encoding)) throw fail('Unsupported artifact embedding profile');
  if (!value.encoding.endsWith(`:dim${value.dimensions}`)) throw fail('Embedding dimension/profile mismatch');
  const id = createHash('sha256').update(JSON.stringify([alias, value.revision, value.dimensions, value.encoding, value.task ?? null])).digest('hex');
  const profile = { id, model: `${alias}@${value.revision}`, alias, revision: value.revision, dimensions: value.dimensions, encoding: value.encoding,
    ...(value.task === undefined ? {} : { task: value.task }) };
  if ((value.id !== undefined && value.id !== id) || (value.alias !== undefined && value.model !== undefined && value.model !== profile.model)) throw fail('Embedding profile fingerprint mismatch');
  return profile;
}

function vectorsFrom(result, profile, count) {
  if (result.model !== profile.model || result.alias !== profile.alias || result.revision !== profile.revision
    || result.dimensions !== profile.dimensions || result.encoding !== profile.encoding || result.task !== profile.task
    || !Array.isArray(result.embeddings) || result.embeddings.length !== count) throw fail('Provider returned an incompatible embedding profile or count');
  for (const vector of result.embeddings) {
    if (!Array.isArray(vector) || vector.length !== profile.dimensions || vector.some(n => typeof n !== 'number' || !Number.isFinite(n))
      || Math.abs(vector.reduce((sum, n) => sum + n * n, 0) - 1) > 0.01) throw fail('Provider returned an invalid embedding vector');
  }
  return result.embeddings;
}

function textsChecked(texts) {
  if (!Array.isArray(texts) || !texts.length || texts.some(text => typeof text !== 'string' || !text.trim() || [...text].length > 8192)) throw fail('Expected nonempty texts of at most 8192 characters');
}

/** All requests stay on this gateway; advertisements cannot redirect the client. */
export function createEmbeddingClient({ agent = 'http://127.0.0.1:36908', mediaRoot, timeoutMs = 60000, maxMediaBytes = 512 * 1024 * 1024 } = {}) {
  const origin = agentUrl(agent);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw fail('Invalid embedding timeout');
  if (mediaRoot !== undefined && (typeof mediaRoot !== 'string' || !path.isAbsolute(mediaRoot))) throw fail('mediaRoot must be an absolute local directory');
  if (!Number.isSafeInteger(maxMediaBytes) || maxMediaBytes < 1) throw fail('Invalid media size limit');
  const budget = signal => ({ expires: Date.now() + timeoutMs, signal });
  const request = async (route, body, deadline) => {
    deadline.signal?.throwIfAborted();
    const remaining = deadline.expires - Date.now();
    if (remaining < 1) throw fail('Local embedding operation timed out');
    return requestJson(new URL(route, origin), { body, timeoutMs: remaining, signal: deadline.signal });
  };
  const invoke = (provider, method, params, deadline) => request(`/services/${encodeURIComponent(provider.id)}/invoke`, { method, params }, deadline);
  async function discover(deadline) {
    const response = await request('/services', undefined, deadline);
    if (!Array.isArray(response.services)) throw fail('Invalid local service catalog');
    return response.services.flatMap(service => {
      const ad = service?.metadata?.embedding_provider;
      if (!service || !canonical(service.id) || service.metadata?.enabled === false || service.liveness === 'down'
        || !Number.isSafeInteger(service.port) || service.port < 1 || service.port > 65535 || service.command !== undefined
        || !ad || ad.protocol !== PROTOCOL || ad.ready !== true || !['qwen3', 'embeddinggemma2'].includes(ad.model)
        || !canonical(ad.revision) || !canonical(ad.encoding) || !Number.isSafeInteger(ad.dimensions) || ad.dimensions < 1 || ad.dimensions > 4096
        || !Number.isFinite(ad.priority ?? 0) || Math.abs(ad.priority ?? 0) > 1000
        || (service.execution !== undefined && service.execution !== 'http') || !service.methods?.['embedding.encode_text']) return [];
      return [{ id: service.id, alias: ad.model, revision: ad.revision, dimensions: ad.dimensions, encoding: ad.encoding,
        priority: ad.priority ?? 0, healthy: service.liveness === 'up', methods: service.methods }];
    }).sort((a, b) => b.priority - a.priority || Number(b.healthy) - Number(a.healthy) || a.id.localeCompare(b.id));
  }
  async function inspect(provider, deadline) {
    if (provider.alias === 'embeddinggemma2') return { provider, profile: embeddingProfile({ model: provider.alias, revision: provider.revision, dimensions: provider.dimensions, encoding: provider.encoding }) };
    const status = await invoke(provider, 'embedding.status', {}, deadline);
    const doc = status.embedding_profiles?.find(value => value?.task === 'document_search' && value.model === provider.alias
      && value.revision === provider.revision && value.dimensions === provider.dimensions
      && value.encoding === provider.encoding.replace('dreammate.tool-search.v1:', 'dreammate.artifact-search.v1:'));
    if (!doc) throw fail('Local provider does not support the document_search profile; upgrade the shared supervisor');
    return { provider, profile: embeddingProfile(doc), status };
  }
  async function select(alias, deadline, expected) {
    const providers = (await discover(deadline)).filter(item => item.alias === alias);
    let last;
    for (const provider of providers) {
      try {
        const selected = await inspect(provider, deadline);
        if (expected && selected.profile.id !== expected.id) continue;
        return selected;
      } catch (error) { last = error; }
    }
    throw last ?? fail(expected ? 'The indexed embedding profile is not available on the local network' : `No ready shared ${alias} embedding provider`);
  }
  async function encodeTexts(texts, selected, inputType, deadline) {
    const vectors = [];
    for (let i = 0; i < texts.length;) {
      const batch = texts.slice(i, i + 16);
      const params = { texts: batch, input_type: inputType, ...(selected.profile.task ? { task: selected.profile.task } : {}) };
      while (batch.length > 1 && Buffer.byteLength(JSON.stringify({ method: 'embedding.encode_text', params })) > MAX_BODY) batch.pop();
      const result = await invoke(selected.provider, 'embedding.encode_text', params, deadline);
      vectors.push(...vectorsFrom(result, selected.profile, batch.length));
      i += batch.length;
    }
    return { profile: selected.profile, vectors };
  }
  async function mediaDirectory(selected, deadline) {
    // A remote worker's filesystem path is never interpreted as a local path.
    if (!isLoopback(origin)) throw fail('Local media paths require a loopback gateway; transfer through a dedicated media service for remote providers');
    const status = await invoke(selected.provider, 'embedding.status', {}, deadline);
    const directory = mediaRoot ?? status.media_input?.root;
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw fail('Shared Gemma media inbox is not configured; upgrade the supervisor or provide mediaRoot');
    return realpath(directory);
  }
  return {
    async discover({ signal } = {}) { return discover(budget(signal)); },
    /** Explicit text provider; selection never loads weights. */
    async getTextProfile(alias, { signal } = {}) {
      if (!['qwen3', 'embeddinggemma2'].includes(alias)) throw fail('Unknown text embedding model');
      return (await select(alias, budget(signal))).profile;
    },
    /** Encode documents in an already selected, exact vector space. */
    async embedDocuments(texts, profile, { signal } = {}) {
      textsChecked(texts);
      const expected = embeddingProfile(profile), deadline = budget(signal);
      const selected = await select(expected.alias, deadline, expected);
      return encodeTexts(texts, selected, 'document', deadline);
    },
    async getProfile(kind, { signal } = {}) {
      if (!['text', 'multimodal'].includes(kind)) throw fail('Unknown embedding content type');
      return (await select(kind === 'text' ? 'qwen3' : 'embeddinggemma2', budget(signal))).profile;
    },
    async status({ signal } = {}) {
      const deadline = budget(signal), providers = await discover(deadline), profiles = { text: null, multimodal: null };
      const errors = [];
      for (const provider of providers) {
        const kind = provider.alias === 'qwen3' ? 'text' : 'multimodal';
        if (profiles[kind]) continue;
        try { profiles[kind] = (await inspect(provider, deadline)).profile; } catch (error) { errors.push(error.message); }
      }
      return { providers: providers.map(({ methods, ...provider }) => provider), profiles, ...(errors.length ? { errors } : {}) };
    },
    async embedText(texts, { inputType = 'document', signal } = {}) {
      textsChecked(texts);
      if (!['query', 'document'].includes(inputType)) throw fail('Invalid embedding input type');
      const deadline = budget(signal), selected = await select('qwen3', deadline);
      return encodeTexts(texts, selected, inputType, deadline);
    },
    async embedQuery(query, profile, { signal } = {}) {
      textsChecked([query]);
      const expected = embeddingProfile(profile), deadline = budget(signal);
      const selected = await select(expected.alias, deadline, expected);
      return encodeTexts([query], selected, 'query', deadline);
    },
    async embedMedia(items, { signal } = {}) {
      if (!Array.isArray(items) || !items.length || items.some(item => !item || !['image', 'video'].includes(item.modality)
        || typeof item.path !== 'string' || !path.isAbsolute(item.path))) throw fail('Expected local image/video paths');
      const deadline = budget(signal), selected = await select('embeddinggemma2', deadline);
      if (!selected.provider.methods['embedding.encode_media']) throw fail('Shared provider does not support media encoding');
      const root = await mediaDirectory(selected, deadline);
      const directory = path.join(root, 'artifact-index');
      await mkdir(directory, { recursive: true });
      const targetRoot = await realpath(directory);
      if (targetRoot !== directory) throw fail('Media inbox artifact directory must not be a symlink');
      const prepared = [];
      for (const item of items) {
        signal?.throwIfAborted();
        const source = await realpath(item.path), sourceStat = await stat(source);
        if (!sourceStat.isFile() || sourceStat.size > maxMediaBytes) throw fail('Media source exceeds configured file size limit');
        const bytes = await readFile(source, { signal });
        if (bytes.length > maxMediaBytes) throw fail('Media source exceeds configured file size limit');
        const digest = createHash('sha256').update(bytes).digest('hex');
        const ext = path.extname(source).toLowerCase();
        if (!(item.modality === 'image' ? ['.png', '.jpg', '.jpeg', '.webp', '.gif'] : ['.mp4', '.mov', '.mkv', '.webm']).includes(ext)) throw fail('Unsupported media input extension');
        const target = path.join(directory, `${digest}${ext}`);
        const temporary = path.join(directory, `.${digest}.${randomUUID()}.tmp`);
        try {
          // Publish only complete content. Hard-link creation also refuses to
          // overwrite an existing cache entry or follow an existing symlink.
          await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600, signal });
          try { await link(temporary, target); }
          catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const targetStat = await stat(target);
            if (!targetStat.isFile() || await realpath(target) !== target
              || createHash('sha256').update(await readFile(target, { signal })).digest('hex') !== digest) throw fail('Content-addressed media inbox entry is invalid');
          }
        } finally { await unlink(temporary).catch(() => {}); }
        prepared.push({ [item.modality]: path.relative(root, target) });
      }
      const vectors = [];
      for (let i = 0; i < prepared.length; i += 4) {
        const batch = prepared.slice(i, i + 4);
        const result = await invoke(selected.provider, 'embedding.encode_media', { items: batch }, deadline);
        vectors.push(...vectorsFrom(result, selected.profile, batch.length));
      }
      return { profile: selected.profile, vectors };
    },
  };
}

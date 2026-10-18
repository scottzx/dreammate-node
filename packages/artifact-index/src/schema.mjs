import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 1;
export const ARTIFACT_KINDS = ['pdf', 'presentation', 'spreadsheet', 'video'];
export const SHARING_VALUES = ['local', 'network'];

export function stableJSON(value) {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${stableJSON(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function hash(value) { return createHash('sha256').update(value).digest('hex'); }

export function normalizeProfile(profile) {
  if (!profile || typeof profile !== 'object') throw new Error('Embedding result has no profile');
  for (const key of ['id', 'model', 'alias', 'revision', 'encoding']) {
    if (typeof profile[key] !== 'string' || !profile[key].trim()) throw new Error(`Invalid embedding profile ${key}`);
  }
  if (!Number.isInteger(profile.dimensions) || profile.dimensions < 1 || profile.dimensions > 65536) throw new Error('Invalid embedding dimensions');
  if (profile.model !== `${profile.alias}@${profile.revision}`) throw new Error('Embedding model must include its exact revision');
  if (profile.task !== undefined && (typeof profile.task !== 'string' || !profile.task)) throw new Error('Invalid embedding task');
  return {
    id: profile.id, model: profile.model, alias: profile.alias,
    revision: profile.revision, dimensions: profile.dimensions,
    encoding: profile.encoding, ...(profile.task ? { task: profile.task } : {}),
  };
}

export function profileFingerprint(profile) {
  const { id, ...metadata } = normalizeProfile(profile);
  return hash(stableJSON(metadata));
}

// Persist normalized float32 values; reject invalid/unnormalized responses rather
// than silently hiding a broken provider or mixing incompatible vector spaces.
export function vectorToBlob(vector, dimensions) {
  if ((!Array.isArray(vector) && !ArrayBuffer.isView(vector)) || vector.length !== dimensions) throw new Error('Embedding vector dimension mismatch');
  let sum = 0;
  const blob = Buffer.alloc(dimensions * 4);
  for (let i = 0; i < dimensions; i++) {
    const value = vector[i];
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Embedding vector contains a non-finite or non-numeric value');
    sum += value * value;
    blob.writeFloatLE(value, i * 4);
    if (!Number.isFinite(blob.readFloatLE(i * 4))) throw new Error('Embedding vector overflows float32');
  }
  if (Math.abs(Math.sqrt(sum) - 1) > 0.005) throw new Error('Embedding vector must have unit norm');
  return blob;
}

export function blobToVector(blob, dimensions) {
  const bytes = Buffer.from(blob);
  if (bytes.length !== dimensions * 4) throw new Error('Stored embedding dimension mismatch');
  return Array.from({ length: dimensions }, (_, i) => bytes.readFloatLE(i * 4));
}

export function validateLocator(kind, locator) {
  if (!locator || typeof locator !== 'object' || Array.isArray(locator)) throw new Error('Unit is missing a locator');
  const positive = n => Number.isInteger(n) && n >= 1;
  if (kind === 'pdf' && !positive(locator.page)) throw new Error('PDF unit requires a 1-based page');
  if (kind === 'presentation' && !positive(locator.slide)) throw new Error('Presentation unit requires a 1-based slide');
  if (kind === 'spreadsheet' && (typeof locator.sheet !== 'string' || !locator.sheet || typeof locator.range !== 'string' || !/^[A-Z]+[1-9]\d*(?::[A-Z]+[1-9]\d*)?$/.test(locator.range))) throw new Error('Spreadsheet unit requires sheet and A1 cell range');
  if (kind === 'video' && (!Number.isInteger(locator.start_ms) || !Number.isInteger(locator.end_ms) || locator.start_ms < 0 || locator.end_ms <= locator.start_ms)) throw new Error('Video unit requires a positive time interval');
  return JSON.parse(stableJSON(locator));
}

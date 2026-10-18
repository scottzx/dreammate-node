import type { SharedEmbeddingClient } from './embeddings.js';

export type ArtifactKind = 'pdf' | 'presentation' | 'spreadsheet' | 'video';
export type Modality = 'text' | 'image' | 'video' | 'audio';
export type Sharing = 'local' | 'network';
export type Locator = { page: number; [key: string]: unknown } | { slide: number; [key: string]: unknown } | { sheet: string; range: string; [key: string]: unknown } | { start_ms: number; end_ms: number; [key: string]: unknown };
export interface EmbeddingProfile { id: string; model: string; alias: string; revision: string; dimensions: number; encoding: string; task?: string }
export interface EmbeddingResult { profile: EmbeddingProfile; vectors: number[][] }
export interface Representation { modality: Modality; text?: string; path?: string; content_hash?: string }
export interface ExtractedArtifact { kind: ArtifactKind; mime?: string; title?: string; parser_version: string; units: Array<{kind: string; locator: Locator; text?: string; representations?: Representation[]; [key: string]: unknown}>; warnings?: unknown[] }
export interface EmbeddingClient {
  getProfile?(kind: 'text' | 'multimodal', options?: { signal?: AbortSignal }): Promise<EmbeddingProfile | null>;
  embedText(texts: string[], options?: { inputType?: 'document' | 'query'; signal?: AbortSignal }): Promise<EmbeddingResult>;
  embedMedia(items: Representation[], options?: { inputType?: 'document'; signal?: AbortSignal }): Promise<EmbeddingResult>;
  embedQuery(query: string, profile: EmbeddingProfile, options?: { signal?: AbortSignal }): Promise<EmbeddingResult>;
}
export interface IndexOptions {
  semantic?: boolean; visual?: boolean; sharing?: Sharing; reembed?: boolean; signal?: AbortSignal;
  embeddingTimeoutMs?: number; textBatchSize?: number; mediaBatchSize?: number; textChunkChars?: number;
  python?: string; maxFileBytes?: number; renderDpi?: number; segmentMs?: number; overlapMs?: number;
  videoFps?: number; videoMaxDimension?: number; timeoutMs?: number; maxOutputBytes?: number;
  [key: string]: unknown;
}
export interface ArtifactIndexOptions {
  dbPath?: string; cacheDir?: string; sourceNode?: string; sharing?: Sharing; embeddings?: EmbeddingClient | SharedEmbeddingClient;
  extractor?: (file: string, options: IndexOptions & {cacheDir: string; resourceId: string; sourceNode: string}) => Promise<ExtractedArtifact>;
}
export interface Resource {
  resource_id: string; schema_version?: number; source_node: string; source_uri: string;
  kind: ArtifactKind; mime?: string; title: string; revision: string; sharing: Sharing;
  parser_version: string; size?: number; mtime_ms?: number; indexed_at?: string; warnings?: unknown[]; unit_count?: number; status?: 'ready' | 'stale'; last_error?: string | null;
}
export interface ReadUnit {
  schema_version: number; unit_id: string; resource_id: string; title: string; kind: ArtifactKind; unit_kind: string;
  source_node: string; source_uri: string; sharing: Sharing; revision: string; parser_version: string;
  resource: Resource; locator: Locator; text: string; metadata: Record<string, unknown>;
  representations: Array<Representation & {id: string; content_hash: string; vector_id: string | null; profile: EmbeddingProfile | null; error: string | null}>;
}
export interface SearchOptions {
  mode?: 'hybrid' | 'lexical' | 'semantic'; limit?: number; offset?: number; maxChars?: number;
  types?: ArtifactKind[] | ArtifactKind; sharing?: Sharing | Sharing[]; perResourceLimit?: number;
  candidateLimit?: number; maxProfiles?: number; minSimilarity?: number; embeddingTimeoutMs?: number; signal?: AbortSignal; modalities?: Modality[]; includeStale?: boolean;
}
export interface SearchResult {
  unit_id: string; resource_id: string; title: string; kind: ArtifactKind; unit_kind: string; locator: Locator;
  snippet: string; source_node: string; source_uri: string; sharing: Sharing; score: number; matched_modality: Modality[]; status: 'ready' | 'stale'; last_error?: string;
  matches: Array<{modality: Modality; profile_id: string | null; rank: number; similarity?: number}>;
}
export interface SearchResponse {
  schema_version: number; query: string; mode: 'hybrid' | 'lexical' | 'semantic'; results: SearchResult[]; total: number;
  semantic_status: 'not_requested' | 'unavailable' | 'partial' | 'available'; fallback: boolean;
  diagnostics: {elapsed_ms: number; candidates: number; candidate_limit: number; candidates_truncated: boolean; vector_spaces: number; successful_vector_spaces: number; visual_vectors: number; errors: Array<{profile_id?: string; error: string}>; visual_search_unavailable: boolean; chars: number; per_resource_limit: number};
}
export interface IndexResponse {
  schema_version: number;
  resources: Array<{path: string; resource_id?: string; status: 'indexed' | 'parsed' | 'failed' | 'skipped'; units?: number; warnings?: unknown[]; reason?: string; error?: string; snapshot_status?: 'ready' | 'stale'; representations?: {text: number; visual: number; vectorized_text: number; vectorized_visual: number; pending: number}}>;
  diagnostics: {parsed: number; indexed: number; failed: number; skipped: number; cached_representations: number; vectorized_text: number; vectorized_visual: number; embedding_errors: Array<{modality: string; error: string; representations: number; circuit_open: boolean}>};
}
export interface IndexStats {schema_version: number; db_path: string; resources: number; stale_resources: number; units: number; representations: number; vectors: number; profiles: number; pending_representations: number}
export const SCHEMA_VERSION: number;
export class ArtifactIndex {
  constructor(options?: ArtifactIndexOptions);
  readonly dbPath: string; readonly cacheDir: string; readonly sourceNode: string; readonly sharing: Sharing;
  index(paths: string[], options?: IndexOptions): Promise<IndexResponse>;
  search(query: string, options?: SearchOptions): Promise<SearchResponse>;
  read(unitId: string): ReadUnit | null;
  list(options?: {limit?: number; offset?: number; sharing?: Sharing | Sharing[]}): {resources: Resource[]; total: number; limit: number; offset: number};
  remove(resourceId: string): {resource_id: string; removed: boolean};
  stats(): IndexStats;
  close(): void;
}
/** Low-level SQLite access. Most callers should use ArtifactIndex. */
export class ArtifactStore {
  constructor(dbPath: string);
  readonly db: import('node:sqlite').DatabaseSync;
  resource(id: string): Record<string, unknown> | undefined;
  markFailure(id: string, error: string, stale?: boolean): void;
  cachedVectors(contentHash: string, modality: Modality): Array<Record<string, unknown> & {profile: EmbeddingProfile}>;
  transaction<T>(operation: () => T): T;
  putVector(profile: EmbeddingProfile, contentHash: string, modality: Modality, vector: number[]): string;
  replace(resource: Record<string, unknown>, units: Array<Record<string, unknown>>): void;
  collectUnused(): void;
  remove(id: string): {resource_id: string; removed: boolean};
  close(): void;
}

/** Shared local model services; this client never installs or starts models. */
export type EmbeddingAlias = 'qwen3' | 'embeddinggemma2';
export type EmbeddingTask = 'document_search';
export type EmbeddingKind = 'text' | 'multimodal';

export interface EmbeddingProfile {
  /** Stable SHA-256 fingerprint of alias, revision, dimensions, encoding and task. */
  id: string;
  /** Exact model identity in alias@revision form. */
  model: string;
  alias: EmbeddingAlias;
  revision: string;
  dimensions: number;
  encoding: string;
  task?: EmbeddingTask;
}

export interface EmbeddingProfileInput {
  id?: string;
  /** A provider alias, or alias@revision when alias is supplied. */
  model?: string;
  alias?: EmbeddingAlias;
  revision: string;
  dimensions: number;
  encoding: string;
  task?: EmbeddingTask;
}

export interface EmbeddingResult {
  profile: EmbeddingProfile;
  /** Finite, unit-normalized vectors in exactly this profile's vector space. */
  vectors: number[][];
}

export interface EmbeddingOperationOptions {
  signal?: AbortSignal;
}

export interface EmbedTextOptions extends EmbeddingOperationOptions {
  inputType?: 'document' | 'query';
}

export interface EmbedMediaOptions extends EmbeddingOperationOptions {
  inputType?: 'document';
}

export interface LocalMediaInput {
  modality: 'image' | 'video';
  /** Absolute local source path, copied into the existing shared Gemma inbox. */
  path: string;
  /** Optional caller metadata. The client computes its own hash of source bytes. */
  content_hash?: string;
}

export interface DiscoveredEmbeddingProvider {
  id: string;
  alias: EmbeddingAlias;
  revision: string;
  dimensions: number;
  encoding: string;
  priority: number;
  healthy: boolean;
  methods: Record<string, unknown>;
}

export interface EmbeddingStatus {
  providers: Array<Omit<DiscoveredEmbeddingProvider, 'methods'>>;
  profiles: {
    text: EmbeddingProfile | null;
    multimodal: EmbeddingProfile | null;
  };
  errors?: string[];
}

export interface EmbeddingClientOptions {
  /** Existing loopback/private-network gateway. Default: http://127.0.0.1:36908. */
  agent?: string;
  /** Existing Gemma media inbox; otherwise read from embedding.status. */
  mediaRoot?: string;
  /** Whole-operation budget, including discovery and every batch. Default: 60000. */
  timeoutMs?: number;
  /** Maximum input media file size in bytes. Default: 512 MiB. */
  maxMediaBytes?: number;
}

export interface SharedEmbeddingClient {
  /** Explicit text model; does not load model weights. */
  getTextProfile(alias: EmbeddingAlias, options?: EmbeddingOperationOptions): Promise<EmbeddingProfile>;
  /** Documents must use precisely the selected profile, never a fallback model. */
  embedDocuments(texts: string[], profile: EmbeddingProfileInput, options?: EmbeddingOperationOptions): Promise<EmbeddingResult>;
  /** Read advertisements without loading weights or extending model idle time. */
  discover(options?: EmbeddingOperationOptions): Promise<DiscoveredEmbeddingProvider[]>;
  /** Inspect current supported profiles without loading model weights. */
  getProfile(kind: EmbeddingKind, options?: EmbeddingOperationOptions): Promise<EmbeddingProfile>;
  status(options?: EmbeddingOperationOptions): Promise<EmbeddingStatus>;
  /** Always use the separate Qwen document_search profile. */
  embedText(texts: string[], options?: EmbedTextOptions): Promise<EmbeddingResult>;
  /** Loopback gateway required; never interprets a remote filesystem path locally. */
  embedMedia(items: LocalMediaInput[], options?: EmbedMediaOptions): Promise<EmbeddingResult>;
  /** Require an exact profile match; a media-index text query stays in Gemma space. */
  embedQuery(query: string, profile: EmbeddingProfileInput, options?: EmbeddingOperationOptions): Promise<EmbeddingResult>;
}

export function createEmbeddingClient(options?: EmbeddingClientOptions): SharedEmbeddingClient;
export function embeddingProfile(value: EmbeddingProfileInput): EmbeddingProfile;
export function isPrivateAddress(address: string): boolean;

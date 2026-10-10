import type { RegisteredService } from './registry.js';
import { localEmbeddingEndpoint } from './tool-search.js';

export const EMBEDDING_PROTOCOL = 'dreammate.embedding.v1' as const;

export interface EmbeddingAdvertisement {
  protocol: typeof EMBEDDING_PROTOCOL;
  model: string;
  revision: string;
  dimensions: number;
  encoding: string;
  ready: true;
  priority: number;
}

export interface EmbeddingProvider {
  endpoint: string;
  model: string;
  expectedModel: string;
  dimensions: number;
  encoding: string;
  node: string;
  service_id: string;
  priority: number;
}

export type EmbeddingService = RegisteredService & { node: string; gateway_url?: string };

function canonicalString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

/** Advertisements are a typed opt-in; never infer providers from a method name. */
export function parseEmbeddingAdvertisement(service: RegisteredService): EmbeddingAdvertisement | undefined {
  const value = service.metadata?.embedding_provider;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const advertisement = value as Record<string, unknown>;
  const { protocol, model, revision, dimensions, encoding, ready } = advertisement;
  const priority = advertisement.priority === undefined ? 0 : advertisement.priority;
  if (protocol !== EMBEDDING_PROTOCOL || ready !== true || model !== 'qwen3' || !canonicalString(revision)
    || !canonicalString(encoding) || encoding.length > 200
    || typeof dimensions !== 'number' || !Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 4096
    || typeof priority !== 'number' || !Number.isFinite(priority) || priority < -1000 || priority > 1000) return undefined;
  return { protocol, model, revision, dimensions, encoding, ready, priority };
}

/** Only the gateway actually scanned by discovery determines the remote route. */
export function discoverEmbeddingProviders(services: readonly EmbeddingService[], preferredModel?: string): EmbeddingProvider[] {
  const candidates: (EmbeddingProvider & { healthy: boolean })[] = [];
  for (const service of services) {
    if (service.metadata?.enabled === false || service.liveness === 'down'
      || !Number.isSafeInteger(service.port) || service.port! < 1 || service.port! > 65535
      || (service.execution !== undefined && service.execution !== 'http') || service.command !== undefined) continue;
    const advertisement = parseEmbeddingAdvertisement(service);
    if (!advertisement || (preferredModel !== undefined && advertisement.model !== preferredModel)
      || !canonicalString(service.id) || !canonicalString(service.node) || !service.gateway_url) continue;
    let endpoint: string;
    try {
      const gateway = new URL(service.gateway_url);
      if (gateway.username || gateway.password || gateway.search || gateway.hash) continue;
      // Validate origin separately: provider metadata cannot nominate another host.
      localEmbeddingEndpoint(gateway.origin);
      endpoint = `${gateway.toString().replace(/\/+$/, '')}/services/${encodeURIComponent(service.id)}/embed`;
    } catch { continue; }
    candidates.push({ endpoint, model: advertisement.model, expectedModel: `${advertisement.model}@${advertisement.revision}`,
      dimensions: advertisement.dimensions, encoding: advertisement.encoding, node: service.node, service_id: service.id,
      priority: advertisement.priority, healthy: service.liveness === 'up' });
  }
  candidates.sort((a, b) => b.priority - a.priority
    || Number(b.healthy) - Number(a.healthy) || a.endpoint.localeCompare(b.endpoint)
    || a.model.localeCompare(b.model) || a.expectedModel.localeCompare(b.expectedModel) || a.encoding.localeCompare(b.encoding));
  const seen = new Set<string>();
  return candidates.flatMap(({ healthy: _healthy, ...provider }) => {
    const key = JSON.stringify([provider.endpoint, provider.model, provider.expectedModel, provider.encoding]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [provider];
  });
}

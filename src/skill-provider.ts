import type { RegisteredService, ServiceRegistry } from './registry.js';

export const SKILL_PROVIDER_PROTOCOL = 'dreammate.skills.v1';

export class SkillProviderError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** Resolve on every request so registrations and restarts take effect without a cached client. */
export function registeredSkillProvider(
  registry: ServiceRegistry,
  visible: (service: RegisteredService) => boolean = () => true,
): RegisteredService {
  const services = registry.list().filter(service => {
    if (!visible(service)) return false;
    const advertisement = service.metadata?.skill_provider;
    return advertisement !== null && typeof advertisement === 'object'
      && (advertisement as { protocol?: unknown }).protocol === SKILL_PROVIDER_PROTOCOL
      && service.metadata?.enabled !== false && service.liveness !== 'down';
  });
  if (services.length > 1) throw new SkillProviderError(409, 'SKILL_PROVIDER_AMBIGUOUS', 'Multiple skill providers are registered; keep one active provider per node');
  const service = services[0];
  if (!service || !Number.isInteger(service.port) || service.port! < 1 || service.port! > 65535
    || (service.execution !== undefined && service.execution !== 'http') || service.command !== undefined) {
    throw new SkillProviderError(503, 'SKILL_PROVIDER_UNAVAILABLE', 'No active HTTP skill provider is registered');
  }
  return service;
}

/** A service may mark selected methods as local regardless of which gateway route invokes them. */
export function requiresLocalMethod(service: RegisteredService, payload: unknown, routedMethod?: string): boolean {
  const local = service.metadata?.local_only_methods;
  if (local === undefined) return false;
  // Fail closed if a persisted or externally supplied descriptor is malformed.
  if (!Array.isArray(local) || local.some(method => typeof method !== 'string')) return true;
  const entry = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  return [routedMethod, entry.method, entry.capability].some(method => typeof method === 'string' && local.includes(method));
}

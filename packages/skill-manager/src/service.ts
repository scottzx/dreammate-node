import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { SkillSourceError, SkillSourceManager, type SkillSourceManagerOptions } from './manager.js';

export const SKILL_PROVIDER_PROTOCOL = 'dreammate.skills.v1';
export const SKILL_SERVICE_ID = 'dreammate-skill-manager';
export const SKILL_SERVICE_PORT = 36909;

type Schema = Record<string, unknown>;
export interface SkillServiceMethod {
  description: string;
  parameters: Schema;
  returns?: Schema;
}

const schema = (properties: Record<string, Schema> = {}, required: string[] = []): Schema =>
  ({ type: 'object', properties, required, additionalProperties: false });
const sourceIdSchema = { type: 'string', pattern: '^skills-[A-Za-z0-9_-]{1,64}$' };
export const SKILL_SERVICE_METHODS: Record<string, SkillServiceMethod> = {
  catalog: { description: 'List published skill summaries and content revisions, without loading full guides.',
    parameters: schema({ limit: { type: 'integer', minimum: 1, maximum: 200, default: 200 }, offset: { type: 'integer', minimum: 0, default: 0 } }),
    returns: schema({ skills: { type: 'array' }, diagnostics: { type: 'array' }, total: { type: 'integer' }, has_more: { type: 'boolean' }, next_offset: { type: ['integer', 'null'] } }) },
  read: { description: 'Read the complete guide or a package resource at an exact content revision.',
    parameters: schema({ skill_id: { type: 'string', minLength: 1, maxLength: 256 }, revision: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
      resource: { type: 'string', minLength: 1, maxLength: 1024 } }, ['skill_id', 'revision']) },
  sources: { description: 'List local skill source directories and their scan status.', parameters: schema() },
  add_source: { description: 'Publish one local skill directory or the skill directories within a project.',
    parameters: { ...schema({ name: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' }, dir: { type: 'string', minLength: 1, maxLength: 4096 },
      project: { type: 'string', minLength: 1, maxLength: 4096 } }, ['name']), oneOf: [{ required: ['dir'], not: { required: ['project'] } }, { required: ['project'], not: { required: ['dir'] } }] } },
  remove_source: { description: 'Unpublish a source without editing or deleting its skill files.', parameters: schema({ id: sourceIdSchema }, ['id']) },
  refresh_sources: { description: 'Rescan a source, or all published sources.', parameters: schema({ id: sourceIdSchema }) },
  discover_sources: { description: 'Discover existing shared skill roots and optionally project directories from 1session.',
    parameters: schema({ projects: { type: 'boolean', default: true } }) },
};

export interface SkillServiceRegistration {
  id: string;
  name: string;
  kind: 'resource_provider';
  port: number;
  reachability: 'localhost';
  health: '/health';
  execution: 'http';
  methods: Record<string, SkillServiceMethod>;
  metadata: { skill_provider: { protocol: string; instance_id: string }; local_only_methods: string[]; invoke_timeout_ms: number };
}

export interface SkillServiceOptions {
  port?: number;
  /** Only loopback listeners are accepted; remote reads go through the Node gateway. */
  host?: string;
  agentUrl?: string;
  register?: boolean;
  registrationIntervalMs?: number;
  registrationTimeoutMs?: number;
  serviceId?: string;
  manager?: SkillSourceManager;
  managerOptions?: SkillSourceManagerOptions;
}

export interface SkillService {
  server: Server;
  manager: SkillSourceManager;
  readonly descriptor: SkillServiceRegistration;
  readonly registration: { registered: boolean; lastError?: string; lastAttemptAt?: string };
  /** Retry registration immediately; normal registration also runs every 15 seconds. */
  report(): Promise<void>;
  close(): Promise<void>;
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parameters(value: unknown, fields: string[]): Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(key => !fields.includes(key))) throw new SkillSourceError(400, 'Invalid method parameters');
  return value;
}

function sourceId(value: unknown): string {
  if (typeof value !== 'string' || !/^skills-[A-Za-z0-9_-]{1,64}$/.test(value)) throw new SkillSourceError(400, 'Invalid skill source ID');
  return value;
}

async function invoke(manager: SkillSourceManager, method: string, value: unknown): Promise<unknown> {
  if (method === 'catalog') {
    const input = parameters(value, ['limit', 'offset']);
    const limit = input.limit ?? 200;
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 200
      || !Number.isSafeInteger(offset) || (offset as number) < 0) throw new SkillSourceError(400, 'Invalid catalog pagination');
    const catalog = await manager.catalog();
    const skills = catalog.skills.slice(offset as number, (offset as number) + (limit as number));
    const next = (offset as number) + skills.length;
    return { skills, diagnostics: catalog.diagnostics, total: catalog.skills.length,
      has_more: next < catalog.skills.length, next_offset: next < catalog.skills.length ? next : null };
  }
  if (method === 'read') {
    const input = parameters(value, ['skill_id', 'revision', 'resource']);
    if (typeof input.skill_id !== 'string' || !input.skill_id.trim() || input.skill_id.length > 256 || input.skill_id.includes('\0')
      || typeof input.revision !== 'string' || !/^[a-fA-F0-9]{64}$/.test(input.revision)) throw new SkillSourceError(400, 'Skill ID and SHA256 revision are required');
    if (input.resource !== undefined && (typeof input.resource !== 'string' || !input.resource || input.resource.length > 1024
      || input.resource.includes('\0') || input.resource.includes('\\') || path.posix.isAbsolute(input.resource)
      || /^[A-Za-z]:/.test(input.resource) || input.resource.split('/').some(part => !part || part === '.' || part === '..'))) {
      throw new SkillSourceError(400, 'Resource must be a package-relative path');
    }
    return manager.read(input.skill_id, input.revision.toLowerCase(), input.resource as string | undefined);
  }
  if (method === 'sources') { parameters(value, []); return { sources: await manager.list() }; }
  if (method === 'add_source') {
    const input = parameters(value, ['name', 'dir', 'project']);
    return manager.add(input);
  }
  if (method === 'remove_source') { const input = parameters(value, ['id']); return manager.remove(sourceId(input.id)); }
  if (method === 'refresh_sources') {
    const input = parameters(value, ['id']);
    return manager.refresh(input.id === undefined ? undefined : sourceId(input.id));
  }
  if (method === 'discover_sources') {
    const input = parameters(value, ['projects']);
    if (input.projects !== undefined && typeof input.projects !== 'boolean') throw new SkillSourceError(400, 'projects must be a boolean');
    return manager.discover({ projects: input.projects !== false });
  }
  throw new SkillSourceError(404, 'Unknown skill method');
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let oversized = false;
  for await (const chunk of req) {
    bytes += (chunk as Buffer).length;
    if (bytes > 64 * 1024) oversized = true;
    else chunks.push(chunk as Buffer);
  }
  if (oversized) throw new SkillSourceError(413, 'Request body exceeds 64 KiB');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new SkillSourceError(400, 'Request body must be JSON'); }
}

function agentBase(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new SkillSourceError(400, 'Agent URL must identify a local HTTP Node'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new SkillSourceError(400, 'Skill service registration requires a loopback Node URL');
  }
  return url.origin;
}

/** Construct an independent HTTP provider; this function neither listens nor starts discovery. */
export function createSkillService(options: SkillServiceOptions = {}): SkillService {
  const port = options.port ?? SKILL_SERVICE_PORT;
  const host = options.host ?? '127.0.0.1';
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new SkillSourceError(400, 'Invalid skill service port');
  if (host !== '127.0.0.1') throw new SkillSourceError(400, 'Skill service must listen on 127.0.0.1');
  const base = agentBase(options.agentUrl ?? process.env.DREAMMATE_AGENT_URL ?? 'http://127.0.0.1:36908');
  const registrationIntervalMs = options.registrationIntervalMs ?? 15_000;
  const timeoutMs = options.registrationTimeoutMs ?? 3_000;
  if (!Number.isSafeInteger(registrationIntervalMs) || registrationIntervalMs < 10 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new SkillSourceError(400, 'Invalid registration timing');
  }
  const id = options.serviceId ?? SKILL_SERVICE_ID;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new SkillSourceError(400, 'Invalid skill service ID');
  const manager = options.manager ?? new SkillSourceManager({ ...options.managerOptions, autoDiscover: options.managerOptions?.autoDiscover ?? true });
  const instance = randomUUID();
  const registration: SkillService['registration'] = { registered: false };
  const controllers = new Set<AbortController>();
  let closing = false;
  let reportJob: Promise<void> | undefined;
  let closeJob: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let attempted = false;

  const server = createServer((req, res) => {
    void (async () => {
      if (closing) return json(res, 503, { error: 'Skill service is stopping' });
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (req.method === 'GET' && pathname === '/health') return json(res, 200, { ok: true, service: SKILL_SERVICE_ID, id, protocol: SKILL_PROVIDER_PROTOCOL });
      if (req.method !== 'POST' || pathname !== '/invoke') return json(res, 404, { error: 'No such skill service route' });
      const payload = await body(req);
      if (!object(payload) || Object.keys(payload).some(key => !['method', 'params', 'capability'].includes(key)) || typeof payload.method !== 'string'
        || (payload.capability !== undefined && typeof payload.capability !== 'string')) {
        throw new SkillSourceError(400, 'Invocation requires method and params');
      }
      return json(res, 200, await invoke(manager, payload.method, payload.params === undefined ? {} : payload.params));
    })().catch(error => {
      if (res.destroyed || res.writableEnded) return;
      json(res, error instanceof SkillSourceError ? error.status : 500,
        { error: error instanceof Error ? error.message : String(error), code: error instanceof SkillSourceError ? 'SKILL_SOURCE_ERROR' : 'SKILL_SERVICE_ERROR' });
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;

  const descriptor = (): SkillServiceRegistration => ({
    id, name: 'Skill Manager', kind: 'resource_provider',
    port: (server.address() as AddressInfo | null)?.port ?? port,
    reachability: 'localhost', health: '/health', execution: 'http', methods: SKILL_SERVICE_METHODS,
    metadata: { skill_provider: { protocol: SKILL_PROVIDER_PROTOCOL, instance_id: instance }, invoke_timeout_ms: 65_000,
      local_only_methods: ['sources', 'add_source', 'remove_source', 'refresh_sources', 'discover_sources'] },
  });

  async function request(method: string, route: string, input?: unknown, headers: Record<string, string> = {}): Promise<{ ok: boolean; status: number; data?: unknown; etag?: string }> {
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${base}${route}`, { method, signal: controller.signal, redirect: 'error',
        headers: { ...headers, ...(input === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      if (method === 'GET' && response.ok) return { ok: true, status: response.status, data: await response.json(), etag: response.headers.get('etag') ?? undefined };
      await response.body?.cancel();
      return { ok: response.ok, status: response.status };
    } finally { clearTimeout(timeout); controllers.delete(controller); }
  }

  const service: SkillService = {
    server, manager,
    get descriptor() { return descriptor(); },
    get registration() { return { ...registration }; },
    async report() {
      if (closing || options.register === false || !server.listening) return;
      if (reportJob) return reportJob;
      reportJob = (async () => {
        attempted = true;
        registration.lastAttemptAt = new Date().toISOString();
        try {
          const response = await request('POST', '/services', descriptor());
          if (!response.ok) throw new Error(`Node registration returned HTTP ${response.status}`);
          if (!closing) { registration.registered = true; delete registration.lastError; }
        } catch (error) {
          registration.registered = false;
          registration.lastError = error instanceof Error ? error.message : String(error);
        }
      })();
      try { await reportJob; } finally { reportJob = undefined; }
    },
    async close() {
      if (closeJob) return closeJob;
      closing = true;
      const closingDescriptor = descriptor();
      if (timer) clearInterval(timer);
      for (const controller of controllers) controller.abort();
      closeJob = (async () => {
        await reportJob;
        const withdrawal = (async () => {
          if (!attempted || options.register === false) return;
          try {
            const response = await request('GET', `/services/${encodeURIComponent(id)}`);
            if (!response.ok || !response.etag) return;
            const current = response.data;
            if (!object(current) || current.port !== closingDescriptor.port || !object(current.metadata)
              || !object(current.metadata.skill_provider) || current.metadata.skill_provider.instance_id !== instance) return;
            await request('DELETE', `/services/${encodeURIComponent(id)}`, undefined, { 'if-match': response.etag });
          } catch { /* Node absence and a replaced registration do not prevent local shutdown. */ }
        })();
        await Promise.allSettled([manager.stop(), withdrawal, new Promise<void>((resolve, reject) => {
          if (!server.listening) return resolve();
          server.close(error => error ? reject(error) : resolve());
          server.closeAllConnections();
        })]);
        registration.registered = false;
      })();
      return closeJob;
    },
  };
  server.once('listening', () => {
    if (closing) { void service.close(); return; }
    void manager.start().catch(() => undefined);
    if (options.register !== false) {
      void service.report();
      timer = setInterval(() => { void service.report(); }, registrationIntervalMs);
      timer.unref();
    }
  });
  return service;
}

/** Listen immediately; discovery and optional Node registration run in the background. */
export async function serveSkillService(options: SkillServiceOptions = {}): Promise<SkillService> {
  const service = createSkillService(options);
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => { service.server.off('listening', ready); reject(error); };
      const ready = () => { service.server.off('error', fail); resolve(); };
      service.server.once('error', fail);
      service.server.once('listening', ready);
      service.server.listen(options.port ?? SKILL_SERVICE_PORT, options.host ?? '127.0.0.1');
    });
    return service;
  } catch (error) { await service.close(); throw error; }
}

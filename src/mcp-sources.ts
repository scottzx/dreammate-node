import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolResultSchema, ErrorCode, McpError, ToolListChangedNotificationSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { MAX_MCP_CONFIG_BYTES, parseMcpSourceConfig, type McpSourceConfig } from './mcp-source-config.js';
import { ServiceRegistry, type MethodDescriptor } from './registry.js';
import { withRequestTimeout } from './request-timeout.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType, JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation';
import { CatalogError, detectCatalogAdapters, type CatalogAdapter, type CatalogCall, type CatalogTool } from './mcp-catalogs.js';
import { ToolNameError, ToolNameIndex, type NamedTool } from './mcp-tool-names.js';

export interface McpSourceManagerOptions {
  /** Credentials live only in this owner-readable file, never in the service registry. */
  storagePath?: string | false;
  timeoutMs?: number;
  reconnectIntervalMs?: number;
  catalogRefreshIntervalMs?: number;
  catalogTimeoutMs?: number;
}

export interface McpSourceStatus {
  id: string;
  name: string;
  type: McpSourceConfig['type'];
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  transport?: McpSourceConfig['type'];
  tool_count: number;
  last_connected_at?: string;
  last_checked_at?: string;
  error?: string;
  native_tool_count?: number;
  action_count?: number;
  catalog?: { status: string; checked_at?: string; error?: string };
}

export interface McpSourceImportResult {
  sources: McpSourceStatus[];
}

export class McpSourceError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'McpSourceError';
  }
}

type SourceRoute = { kind: 'native'; name: string } | { kind: 'action'; adapter: CatalogAdapter; child: CatalogTool; fingerprint: string };
interface CachedSchema { fingerprint: string; descriptor: MethodDescriptor; validate: JsonSchemaValidator<unknown> }

interface SourceState {
  config: McpSourceConfig;
  status: McpSourceStatus['status'];
  tools: Map<string, Tool>;
  client?: Client;
  transport?: Transport;
  actualTransport?: McpSourceConfig['type'];
  connectedAt?: string;
  checkedAt?: string;
  error?: string;
  generation: number;
  connecting?: Promise<void>;
  discovering?: Promise<void>;
  checking?: Promise<void>;
  closing?: Promise<void>;
  refreshingOAuth?: Promise<string>;
  oauthNeedsPersist?: boolean;
  oauthLeewayMs?: number;
  names: ToolNameIndex<SourceRoute>;
  children: Map<string, Extract<SourceRoute, { kind: 'action' }>>;
  schemas: Map<string, CachedSchema>;
  schemaJobs: Map<string, Promise<MethodDescriptor>>;
  catalogRefreshing?: Promise<void>;
  catalogStatus: 'unsupported' | 'pending' | 'ready' | 'error';
  catalogCheckedAt?: string;
  catalogError?: string;
}

const MAX_TOOLS = 10_000;
const MAX_TOOL_PAGES = 100;
const MAX_SOURCES = 64;

function timedOut(error: unknown): boolean {
  return error instanceof McpError && error.code === ErrorCode.RequestTimeout
    || error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolveEnvironment(value: string): string {
  return value.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
    if (match === '$$') return '$';
    const resolved = process.env[name];
    if (resolved === undefined) throw new Error('MCP environment variable is missing');
    return resolved;
  });
}

function resolvedMap(values?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values ?? {}).map(([key, value]) => [key, resolveEnvironment(value)]));
}

function statusOf(state: SourceState): McpSourceStatus {
  return {
    id: state.config.id,
    name: state.config.name,
    type: state.config.type,
    status: state.status,
    ...(state.actualTransport ? { transport: state.actualTransport } : {}),
    tool_count: state.tools.size + (state.catalogStatus === 'ready' ? state.children.size : 0),
    native_tool_count: state.tools.size,
    action_count: state.catalogStatus === 'ready' ? state.children.size : 0,
    catalog: { status: state.catalogStatus, ...(state.catalogCheckedAt ? { checked_at: state.catalogCheckedAt } : {}),
      ...(state.catalogError ? { error: state.catalogError } : {}) },
    ...(state.connectedAt ? { last_connected_at: state.connectedAt } : {}),
    ...(state.checkedAt ? { last_checked_at: state.checkedAt } : {}),
    ...(state.error ? { error: state.error } : {}),
  };
}

/** Owns MCP connections and projects their tool contracts into ordinary node services. */
export class McpSourceManager {
  readonly #registry: ServiceRegistry;
  readonly #sources = new Map<string, SourceState>();
  readonly #storagePath: string | false;
  readonly #timeoutMs: number;
  readonly #invokeTimeoutMs: number;
  readonly #reconnectIntervalMs: number;
  readonly #catalogRefreshIntervalMs: number;
  readonly #catalogTimeoutMs: number;
  #timer?: NodeJS.Timeout;
  #started = false;
  #stopping = false;
  #loadFailed = false;

  constructor(registry: ServiceRegistry, options: McpSourceManagerOptions = {}) {
    this.#registry = registry;
    const isTest = process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT)
      || process.execArgv.includes('--test');
    this.#storagePath = options.storagePath ?? (isTest ? false : path.join(os.homedir(), '.1agents', 'mcp-sources.json'));
    this.#timeoutMs = Math.max(1, options.timeoutMs ?? 12_000);
    this.#invokeTimeoutMs = Math.max(1, options.timeoutMs ?? 120_000);
    this.#reconnectIntervalMs = Math.max(10, options.reconnectIntervalMs ?? 15_000);
    this.#catalogRefreshIntervalMs = Math.max(10, options.catalogRefreshIntervalMs ?? 300_000);
    this.#catalogTimeoutMs = Math.max(1, options.catalogTimeoutMs ?? options.timeoutMs ?? 30_000);
    // A registry snapshot is not proof that a previous MCP session is still alive.
    for (const service of registry.list()) {
      if (service.metadata?.mcp_source === service.id) registry.deregister(service.id);
    }
    this.#load();
  }

  #load(): void {
    if (!this.#storagePath) return;
    try {
      const raw = fs.readFileSync(this.#storagePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      // The last source can be removed, leaving a valid empty persisted collection.
      if (object(parsed) && Object.keys(parsed).length === 1 && object(parsed.mcpServers)
        && Object.keys(parsed.mcpServers).length === 0) return;
      const configs = parseMcpSourceConfig(raw);
      for (const config of configs) this.#sources.set(config.id, this.#newState(config));
    } catch (error) {
      // A missing or damaged local configuration cannot prevent the node from starting.
      if (!object(error) || error.code !== 'ENOENT') this.#loadFailed = true;
    }
  }

  #newState(config: McpSourceConfig): SourceState {
    return { config, status: 'disconnected', tools: new Map(), generation: 0, names: new ToolNameIndex(config.id, []),
      children: new Map(), schemas: new Map(), schemaJobs: new Map(), catalogStatus: 'unsupported' };
  }

  #persist(): void {
    if (!this.#storagePath) return;
    if (this.#loadFailed) throw new McpSourceError(500, 'Stored MCP configuration could not be read; repair or remove it before changing sources');
    let temporary: string | undefined;
    try {
      fs.mkdirSync(path.dirname(this.#storagePath), { recursive: true, mode: 0o700 });
      const mcpServers = Object.fromEntries([...this.#sources.values()].map(({ config }) => {
        const { id: _id, name, ...connection } = config;
        return [name, connection];
      }));
      const serialized = JSON.stringify({ mcpServers }, null, 2);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_MCP_CONFIG_BYTES) {
        throw new McpSourceError(400, 'Stored MCP configuration exceeds the total size limit');
      }
      temporary = `${this.#storagePath}.${randomUUID()}.tmp`;
      fs.writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.#storagePath);
    } catch (error) {
      if (temporary) {
        try { fs.unlinkSync(temporary); } catch { /* No partial credential files. */ }
      }
      if (error instanceof McpSourceError) throw error;
      throw new McpSourceError(500, 'MCP configuration could not be saved');
    }
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#stopping = false;
    this.#timer = setInterval(() => {
      for (const state of this.#sources.values()) {
        if (state.status === 'connected') void this.#check(state);
        else void this.#connect(state);
      }
    }, this.#reconnectIntervalMs);
    this.#timer.unref();
    await Promise.all([...this.#sources.values()].map(state => state.status === 'connected' ? Promise.resolve() : this.#connect(state)));
  }

  async import(input: unknown, name?: string): Promise<McpSourceImportResult> {
    const configs = parseMcpSourceConfig(input, name);
    if (this.#stopping) throw new Error('MCP source manager is stopped');
    if (this.#sources.size + configs.length > MAX_SOURCES) throw new Error('MCP source limit reached');
    for (const config of configs) {
      if (this.#sources.has(config.id)) throw new McpSourceError(409, 'MCP source already exists; remove it before importing a replacement');
      if (this.#registry.get(config.id)) throw new McpSourceError(409, 'MCP source ID conflicts with a registered service');
    }
    const states = configs.map(config => this.#newState(config));
    for (const state of states) this.#sources.set(state.config.id, state);
    try { this.#persist(); }
    catch (error) {
      for (const state of states) this.#sources.delete(state.config.id);
      throw error;
    }
    await Promise.all(states.map(state => this.#connect(state)));
    return { sources: states.map(statusOf) };
  }

  list(): McpSourceStatus[] {
    return [...this.#sources.values()].map(statusOf);
  }

  owns(id: string): boolean {
    return this.#sources.has(id);
  }

  async remove(id: string): Promise<boolean> {
    const state = this.#sources.get(id);
    if (!state) return false;
    this.#sources.delete(id);
    try { this.#persist(); }
    catch (error) { this.#sources.set(id, state); throw error; }
    state.generation++;
    if (this.#registry.get(id)?.metadata?.mcp_source === id) this.#registry.deregister(id);
    await this.#close(state);
    return true;
  }

  async refresh(id: string): Promise<McpSourceStatus> {
    const state = this.#sources.get(id);
    if (!state) throw new McpSourceError(404, 'MCP source not found');
    if (this.#stopping) throw new Error('MCP source manager is stopped');
    if (state.status === 'connected') await this.#discover(state);
    else await this.#connect(state);
    return statusOf(state);
  }

  #current(state: SourceState, generation: number): boolean {
    return !this.#stopping && this.#sources.get(state.config.id) === state && state.generation === generation;
  }

  #syncRegistry(state: SourceState): void {
    if (this.#sources.get(state.config.id) !== state) return;
    const id = state.config.id;
    const existing = this.#registry.get(id);
    if (existing && existing.metadata?.mcp_source !== id) return;
    state.names = new ToolNameIndex<SourceRoute>(id, [
      ...[...state.tools.keys()].map(name => ({ kind: 'native' as const, name, value: { kind: 'native' as const, name } })),
      ...(state.catalogStatus === 'ready' ? [...state.children.values()].map(route => ({ kind: 'action' as const, name: route.child.name,
        group: route.child.group, adapter: route.adapter.id, value: route })) : []),
    ]);
    const methods: Record<string, MethodDescriptor> = Object.fromEntries(state.names.records.map(record => {
      const common = { original_name: record.name, aliases: record.aliases, ...(record.group ? { toolset: record.group } : {}) };
      if (record.value.kind === 'action') {
        const cached = state.schemas.get(record.method);
        return [record.method, { description: record.value.child.description, ...common,
          schema_loaded: false, schema_cached: Boolean(cached), catalog_adapter: record.value.adapter.id }];
      }
      const tool = state.tools.get(record.value.name)!;
      return [record.method, {
        description: tool.description ?? tool.title ?? tool.name,
        parameters: tool.inputSchema,
        ...(tool.outputSchema ? { returns: tool.outputSchema, outputSchema: tool.outputSchema } : {}),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        ...(tool.title ? { title: tool.title } : {}),
        ...(tool._meta ? { _meta: tool._meta } : {}),
        ...common,
      }];
    }));
    const registered = this.#registry.register({
      id, name: state.config.name, kind: 'mcp', execution: 'http', reachability: 'localhost', methods,
      metadata: {
        mcp_source: id,
        mcp_transport: state.actualTransport ?? state.config.type,
        description: `MCP tools from ${state.config.name}`,
        enabled: state.status === 'connected',
        mcp_status: state.status,
        tool_count: state.names.records.length,
        native_tool_count: state.tools.size,
        action_count: state.catalogStatus === 'ready' ? state.children.size : 0,
        child_catalog: { status: state.catalogStatus, checked_at: state.catalogCheckedAt ?? null,
          ...(state.catalogError ? { error: state.catalogError } : {}) },
      },
    });
    registered.liveness = state.status === 'connected' ? 'up' : 'down';
    registered.lastProbedAt = state.checkedAt ?? new Date().toISOString();
  }

  #close(state: SourceState): Promise<void> {
    if (state.closing) return state.closing;
    const client = state.client;
    const transport = state.transport;
    const childPid = transport instanceof StdioClientTransport ? transport.pid : null;
    state.client = undefined;
    state.transport = undefined;
    state.catalogRefreshing = undefined;
    state.schemaJobs.clear();
    if (client) {
      client.onclose = undefined;
      client.onerror = undefined;
    }
    const job = (async () => {
      try {
        await withRequestTimeout(async () => {
          if (transport instanceof StreamableHTTPClientTransport && transport.sessionId) {
            try { await withRequestTimeout(() => transport.terminateSession(), 500); }
            catch { /* Expired/offline sessions cannot block local cleanup. */ }
          }
          if (client) await client.close();
          else await transport?.close();
          // The SDK sends SIGKILL after its grace period and resolves before the OS exit event.
          if (childPid !== null) {
            const deadline = Date.now() + 500;
            while (Date.now() < deadline) {
              try { process.kill(childPid, 0); } catch { break; }
              await new Promise(resolve => setTimeout(resolve, 10));
            }
          }
        }, 5_000);
      } catch { /* Shutdown errors never expose transport messages or credentials. */ }
    })().finally(() => { if (state.closing === job) state.closing = undefined; });
    state.closing = job;
    return job;
  }

  #connect(state: SourceState): Promise<void> {
    if (this.#stopping || this.#sources.get(state.config.id) !== state) return Promise.resolve();
    if (state.connecting) return state.connecting;
    const generation = ++state.generation;
    const job = this.#connectOnce(state, generation).finally(() => {
      if (state.connecting === job) state.connecting = undefined;
    });
    state.connecting = job;
    return job;
  }

  async #accessToken(state: SourceState, configuredHeaders: Record<string, string>, signal: AbortSignal | null | undefined,
    generation: number, cleanup: boolean): Promise<string | undefined> {
    const oauth = state.config.oauth;
    if (!oauth) return undefined;
    const tokenText = (value: string): string => {
      const resolved = resolveEnvironment(value);
      if (!resolved || /[\r\n\0]/.test(resolved)) throw new Error('Invalid MCP OAuth credential');
      return resolved;
    };
    // Session cleanup must not initiate a new authorization grant after removal/shutdown.
    if (cleanup || this.#stopping || this.#sources.get(state.config.id) !== state) {
      return oauth.accessToken ? tokenText(oauth.accessToken) : undefined;
    }
    if (oauth.accessToken && oauth.expiresAt && oauth.expiresAt > Date.now() + (state.oauthLeewayMs ?? 60_000)) {
      if (state.oauthNeedsPersist) { this.#persist(); state.oauthNeedsPersist = false; }
      return tokenText(oauth.accessToken);
    }
    if (state.refreshingOAuth) return state.refreshingOAuth;
    const refresh = (async () => {
      const tokenUrl = new URL(resolveEnvironment(oauth.tokenUrl));
      if (!['http:', 'https:'].includes(tokenUrl.protocol) || tokenUrl.username || tokenUrl.password || tokenUrl.hash) {
        throw new Error('Invalid MCP OAuth endpoint');
      }
      const form = new URLSearchParams({
        grant_type: 'refresh_token', client_id: tokenText(oauth.clientId), refresh_token: tokenText(oauth.refreshToken),
        ...(oauth.clientSecret ? { client_secret: tokenText(oauth.clientSecret) } : {}),
        ...(oauth.scope ? { scope: tokenText(oauth.scope) } : {}),
      });
      const headers = new Headers(configuredHeaders);
      headers.delete('authorization');
      headers.set('content-type', 'application/x-www-form-urlencoded');
      headers.set('accept', 'application/json');
      const response: unknown = await withRequestTimeout(async timeoutSignal => {
        const result = await fetch(tokenUrl, { method: 'POST', headers, body: form.toString(), redirect: 'error',
          signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal });
        if (!result.ok) { await result.body?.cancel(); throw new Error('MCP OAuth refresh failed'); }
        return result.json();
      }, this.#timeoutMs);
      if (!object(response) || typeof response.access_token !== 'string'
        || !response.access_token.trim() || response.access_token.length > 65_536 || /[\r\n\0]/.test(response.access_token)
        || response.refresh_token !== undefined && (typeof response.refresh_token !== 'string'
          || !response.refresh_token.trim() || response.refresh_token.length > 65_536 || /[\r\n\0]/.test(response.refresh_token))) {
        throw new Error('Invalid MCP OAuth refresh response');
      }
      if (response.token_type !== undefined && (typeof response.token_type !== 'string' || response.token_type.toLowerCase() !== 'bearer')) {
        throw new Error('Unsupported MCP OAuth token type');
      }
      const expiresIn = response.expires_in === undefined ? 300 : Number(response.expires_in);
      if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 31_536_000) throw new Error('Invalid MCP OAuth token expiry');
      if (!this.#current(state, generation)) throw new Error('MCP source is unavailable');
      // Server-issued tokens are opaque data, never new templates that may read local environment secrets.
      const opaqueToken = (value: string) => value.replace(/\$/g, () => '$$');
      state.config.oauth = { ...oauth, accessToken: opaqueToken(response.access_token),
        expiresAt: Date.now() + Math.max(1, Math.floor(expiresIn * 1000)),
        ...(typeof response.refresh_token === 'string' ? { refreshToken: opaqueToken(response.refresh_token) } : {}) };
      state.oauthLeewayMs = Math.min(60_000, expiresIn * 100);
      state.oauthNeedsPersist = true;
      this.#persist();
      state.oauthNeedsPersist = false;
      return response.access_token;
    })().finally(() => { if (state.refreshingOAuth === refresh) state.refreshingOAuth = undefined; });
    state.refreshingOAuth = refresh;
    return refresh;
  }

  async #connectOnce(state: SourceState, generation: number): Promise<void> {
    state.status = 'connecting';
    state.error = undefined;
    this.#syncRegistry(state);
    await this.#close(state);
    if (!this.#current(state, generation)) return;
    try {
      const existing = this.#registry.get(state.config.id);
      if (existing && existing.metadata?.mcp_source !== state.config.id) throw new Error('MCP source ID conflict');
      const config = state.config;
      const expiresAt = Date.now() + this.#timeoutMs;
      const remaining = () => {
        const ms = expiresAt - Date.now();
        if (ms <= 0) throw new DOMException('MCP connection timed out', 'TimeoutError');
        return ms;
      };
      const headers = resolvedMap(config.headers);
      if (Object.values(headers).some(value => /[\r\n\0]/.test(value))) throw new Error('Invalid MCP header');
      const remoteUrl = config.url ? new URL(resolveEnvironment(config.url)) : undefined;
      if (remoteUrl && (!['http:', 'https:'].includes(remoteUrl.protocol)
        || remoteUrl.username || remoteUrl.password || remoteUrl.hash)) throw new Error('Invalid MCP URL');
      let unsupportedInitialization = false;
      // Record only the initialize response: a tools/call 404 must never trigger a replay via SSE.
      const initializeFetch: typeof fetch = async (input, init) => {
        const cleanup = init?.method === 'DELETE';
        if (!cleanup && !this.#current(state, generation)) throw new Error('MCP source is unavailable');
        const accessToken = await this.#accessToken(state, headers, init?.signal, generation, cleanup);
        if (!cleanup && !this.#current(state, generation)) throw new Error('MCP source is unavailable');
        const requestHeaders = new Headers(init?.headers ?? headers);
        if (accessToken) requestHeaders.set('authorization', `Bearer ${accessToken}`);
        const response = await fetch(input, { ...init, headers: requestHeaders, redirect: 'error' });
        // A rejected request is returned once. Only a future connection/request may refresh its grant.
        if (response.status === 401 && state.config.oauth) delete state.config.oauth.expiresAt;
        if (typeof init?.body === 'string') {
          try {
            const request = JSON.parse(init.body) as { method?: string };
            if (request.method === 'initialize' && [404, 405].includes(response.status)) unsupportedInitialization = true;
          } catch { /* SDK-generated bodies are JSON; ignore unrelated requests. */ }
        }
        return response;
      };
      const makeTransport = (type: McpSourceConfig['type']): Transport => {
        if (type === 'stdio') return new StdioClientTransport({
          command: config.command!, args: config.args, cwd: config.cwd,
          env: { ...getDefaultEnvironment(), ...resolvedMap(config.env) },
          // Untrusted subprocess stderr can contain credentials; drain it without forwarding.
          stderr: 'pipe',
        });
        if (type === 'sse') return new SSEClientTransport(remoteUrl!, { requestInit: { headers }, fetch: initializeFetch });
        return new StreamableHTTPClientTransport(remoteUrl!, {
          requestInit: { headers }, fetch: initializeFetch,
          // The manager reconnects sessions; it never resumes or replays a tool invocation.
          reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1_000, maxReconnectionDelay: 30_000, reconnectionDelayGrowFactor: 1.5 },
        });
      };
      const connect = async (type: McpSourceConfig['type']): Promise<void> => {
        const transport = makeTransport(type);
        const client = new Client({ name: 'dreammate-node', version: '0.10.0' });
        state.client = client;
        state.transport = transport;
        state.actualTransport = type;
        if (transport instanceof StdioClientTransport) transport.stderr?.on('data', () => {});
        // SDK errors may include complete response bodies or token-bearing URLs.
        client.onerror = () => {};
        client.onclose = () => {
          if (!this.#current(state, generation) || state.client !== client) return;
          state.client = undefined;
          state.transport = undefined;
          state.status = 'disconnected';
          state.error = 'MCP connection closed';
          state.checkedAt = new Date().toISOString();
          this.#syncRegistry(state);
        };
        client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
          if (this.#current(state, generation) && state.client === client && state.status === 'connected') await this.#discover(state);
        });
        const timeout = remaining();
        await withRequestTimeout(signal => client.connect(transport, {
          signal, timeout, maxTotalTimeout: timeout,
        }), timeout);
      };
      try { await connect(config.type); }
      catch (error) {
        if (config.type !== 'http' || !unsupportedInitialization || !this.#current(state, generation)) throw error;
        await this.#close(state);
        if (!this.#current(state, generation)) return;
        await connect('sse');
      }
      if (!this.#current(state, generation)) return;
      const client = state.client;
      if (!client) throw new Error('MCP connection closed');
      const tools = await this.#listTools(client, remaining());
      if (!this.#current(state, generation) || state.client !== client) return;
      state.tools = tools;
      state.schemas.clear();
      state.status = 'connected';
      state.error = undefined;
      state.connectedAt = state.checkedAt = new Date().toISOString();
      this.#syncRegistry(state);
      await this.#refreshCatalogs(state, true);
    } catch (error) {
      if (!this.#current(state, generation)) return;
      state.status = 'error';
      state.error = timedOut(error) ? 'MCP connection timed out' : 'MCP connection failed';
      state.checkedAt = new Date().toISOString();
      await this.#close(state);
      if (this.#current(state, generation)) this.#syncRegistry(state);
    }
  }

  async #listTools(client: Client, timeoutMs = this.#timeoutMs): Promise<Map<string, Tool>> {
    return withRequestTimeout(async signal => {
      const tools = new Map<string, Tool>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < MAX_TOOL_PAGES; page++) {
        const result = await client.listTools(cursor ? { cursor } : undefined, {
          signal, timeout: timeoutMs, maxTotalTimeout: timeoutMs,
        });
        for (const tool of result.tools) {
          if (!tool.name || tools.has(tool.name) || tools.size >= MAX_TOOLS) throw new Error('Invalid MCP tool catalog');
          tools.set(tool.name, tool);
        }
        if (result.nextCursor === undefined) return tools;
        cursor = result.nextCursor;
        if (!cursor || cursor.length > 4096 || cursors.has(cursor)) throw new Error('Invalid MCP tool cursor');
        cursors.add(cursor);
      }
      throw new Error('MCP tool page limit reached');
    }, timeoutMs);
  }

  #catalogCall(state: SourceState, client: Client, generation: number, signal: AbortSignal, timeout: number): CatalogCall {
    return async (name, args) => {
      signal.throwIfAborted();
      if (!this.#current(state, generation) || state.client !== client || !state.tools.has(name)) throw new CatalogError(502, 'MCP catalog connection is unavailable');
      return CallToolResultSchema.parse(await client.callTool({ name, arguments: args }, CallToolResultSchema, { signal, timeout, maxTotalTimeout: timeout }));
    };
  }

  #refreshCatalogs(state: SourceState, force = false): Promise<void> {
    if (state.catalogRefreshing) return force
      ? state.catalogRefreshing.then(() => this.#refreshCatalogs(state, true)) : state.catalogRefreshing;
    const client = state.client;
    if (this.#stopping || !client || state.status !== 'connected') return Promise.resolve();
    const interval = state.catalogStatus === 'error' ? Math.min(this.#catalogRefreshIntervalMs, 15_000) : this.#catalogRefreshIntervalMs;
    if (!force && state.catalogCheckedAt && Date.now() - Date.parse(state.catalogCheckedAt) < interval) return Promise.resolve();
    const generation = state.generation, upstreamTools = state.tools;
    const adapters = detectCatalogAdapters(upstreamTools);
    state.catalogStatus = adapters.length ? 'pending' : 'unsupported';
    state.catalogError = undefined;
    this.#syncRegistry(state);
    const job = (async () => {
      try {
        const children = await withRequestTimeout(async signal => {
          const result = new Map<string, Extract<SourceRoute, { kind: 'action' }>>();
          const call = this.#catalogCall(state, client, generation, signal, this.#catalogTimeoutMs);
          for (const adapter of adapters) {
            for (const child of await adapter.discover(call)) {
              const key = JSON.stringify([adapter.id, child.group, child.name]);
              if (result.has(key) || result.size >= 5000) throw new CatalogError(502, 'Duplicate catalog identity or catalog limit exceeded');
              result.set(key, { kind: 'action', adapter, child, fingerprint: JSON.stringify(child) });
            }
          }
          return result;
        }, this.#catalogTimeoutMs);
        if (!this.#current(state, generation) || state.client !== client || state.tools !== upstreamTools) return;
        state.children = children;
        state.schemas.clear();
        state.schemaJobs.clear();
        state.catalogStatus = adapters.length ? 'ready' : 'unsupported';
      } catch {
        if (!this.#current(state, generation) || state.client !== client || state.tools !== upstreamTools) return;
        state.catalogStatus = 'error';
        state.catalogError = 'Child catalog refresh failed; native MCP tools remain available';
      } finally {
        if (this.#current(state, generation) && state.client === client && state.tools === upstreamTools) {
          state.catalogCheckedAt = new Date().toISOString();
          this.#syncRegistry(state);
        }
      }
    })().finally(() => { if (state.catalogRefreshing === job) state.catalogRefreshing = undefined; });
    state.catalogRefreshing = job;
    return job;
  }

  #assertActionCurrent(state: SourceState, record: NamedTool<SourceRoute>, client: Client, generation: number): void {
    if (!this.#current(state, generation) || state.client !== client) throw new CatalogError(502, 'MCP source is unavailable');
    try { if (state.names.resolve(record.method).value === record.value) return; } catch { /* The action was removed. */ }
    throw new CatalogError(409, 'Catalog changed; inspect this action again');
  }

  #describeAction(state: SourceState, record: NamedTool<SourceRoute>, client: Client, generation: number): Promise<MethodDescriptor> {
    if (record.value.kind !== 'action') throw new CatalogError(400, 'Not a catalog action');
    this.#assertActionCurrent(state, record, client, generation);
    const route = record.value;
    const cached = state.schemas.get(record.method);
    if (cached?.fingerprint === route.fingerprint) return Promise.resolve(cached.descriptor);
    const pending = state.schemaJobs.get(record.method);
    if (pending) return pending;
    const job = (async () => {
      try {
        const descriptor = await withRequestTimeout(signal => route.adapter.describe(
          this.#catalogCall(state, client, generation, signal, this.#catalogTimeoutMs), route.child), this.#catalogTimeoutMs);
        this.#assertActionCurrent(state, record, client, generation);
        if (JSON.stringify(descriptor).length > 512_000) throw new CatalogError(502, 'Action schema exceeds the size limit');
        const validate = new AjvJsonSchemaValidator().getValidator(descriptor.parameters as JsonSchemaType);
        state.schemas.set(record.method, { fingerprint: route.fingerprint, descriptor, validate });
        this.#syncRegistry(state);
        return descriptor;
      } catch (error) {
        if (error instanceof CatalogError) throw error;
        throw new CatalogError(502, 'Action schema could not be loaded');
      }
    })().finally(() => { if (state.schemaJobs.get(record.method) === job) state.schemaJobs.delete(record.method); });
    state.schemaJobs.set(record.method, job);
    return job;
  }

  async describe(id: string, method: string): Promise<{ method: string; details: MethodDescriptor }> {
    const state = this.#sources.get(id);
    if (!state) throw new McpSourceError(404, 'MCP source not found');
    const record = state.names.resolve(method);
    if (!state.client || state.status !== 'connected') throw new McpSourceError(502, 'MCP source is unavailable');
    const descriptor = record.value.kind === 'native' ? this.#registry.get(id)!.methods![record.method]!
      : await this.#describeAction(state, record, state.client, state.generation);
    return { method: record.method, details: { ...descriptor, original_name: record.name, aliases: record.aliases,
      ...(record.group ? { toolset: record.group } : {}), schema_loaded: true } as MethodDescriptor };
  }

  #check(state: SourceState): Promise<void> {
    if (state.checking || state.discovering || state.connecting || this.#stopping) {
      return state.checking ?? state.discovering ?? state.connecting ?? Promise.resolve();
    }
    const client = state.client;
    const generation = state.generation;
    if (!client) return this.#connect(state);
    const job = (async () => {
      try {
        await withRequestTimeout(signal => client.ping({ signal, timeout: this.#timeoutMs, maxTotalTimeout: this.#timeoutMs }), this.#timeoutMs);
        if (!this.#current(state, generation) || state.client !== client) return;
        state.checkedAt = new Date().toISOString();
        const registered = this.#registry.get(state.config.id);
        if (registered?.metadata?.mcp_source === state.config.id) registered.lastProbedAt = state.checkedAt;
        await this.#refreshCatalogs(state);
      } catch (error) {
        if (!this.#current(state, generation) || state.client !== client) return;
        state.status = 'error';
        state.error = timedOut(error) ? 'MCP connection timed out' : 'MCP connection failed';
        state.checkedAt = new Date().toISOString();
        void this.#close(state);
        this.#syncRegistry(state);
      }
    })().finally(() => { if (state.checking === job) state.checking = undefined; });
    state.checking = job;
    return job;
  }

  #discover(state: SourceState): Promise<void> {
    if (state.discovering) return state.discovering;
    if (state.connecting || this.#stopping) return state.connecting ?? Promise.resolve();
    const client = state.client;
    const generation = state.generation;
    if (!client) return this.#connect(state);
    const job = (async () => {
      try {
        const tools = await this.#listTools(client);
        if (!this.#current(state, generation) || state.client !== client) return;
        state.tools = tools;
        state.status = 'connected';
        state.error = undefined;
        state.checkedAt = new Date().toISOString();
        this.#syncRegistry(state);
        await this.#refreshCatalogs(state, true);
      } catch (error) {
        if (!this.#current(state, generation) || state.client !== client) return;
        state.status = 'error';
        state.error = timedOut(error) ? 'MCP discovery timed out' : 'MCP discovery failed';
        state.checkedAt = new Date().toISOString();
        await this.#close(state);
        if (this.#current(state, generation)) this.#syncRegistry(state);
      }
    })().finally(() => { if (state.discovering === job) state.discovering = undefined; });
    state.discovering = job;
    return job;
  }

  async invoke(id: string, payload: { method?: string; capability?: string; params?: unknown }): Promise<{ status: number; data: unknown }> {
    const failure = (status: number, error: string) => ({ status, data: {
      error, retryable: false,
      ...(status >= 500 ? { kind: status === 504 ? 'timeout' : 'transport', upstream_status: null } : {}),
    } });
    const state = this.#sources.get(id);
    if (!state) return failure(404, 'MCP source not found');
    if (!object(payload)) return failure(400, 'MCP invocation must be an object');
    const method = payload.method ?? payload.capability;
    if (typeof method !== 'string' || !method) return failure(400, 'MCP method is required');
    const params = payload.params === undefined ? {} : payload.params;
    if (!object(params)) return failure(400, 'MCP tool arguments must be an object');
    let selected: NamedTool<SourceRoute>;
    try { selected = state.names.resolve(method); }
    catch (error) {
      if (error instanceof ToolNameError) return { status: error.status, data: { error: error.message, candidates: error.candidates, retryable: false } };
      throw error;
    }
    const client = state.client;
    const generation = state.generation;
    if (this.#stopping || state.status !== 'connected' || !client) return failure(502, 'MCP source is unavailable');
    try {
      const result = await withRequestTimeout(async signal => {
        const call = this.#catalogCall(state, client, generation, signal, this.#invokeTimeoutMs);
        if (selected.value.kind === 'native') return call(selected.value.name, params);
        await this.#describeAction(state, selected, client, generation);
        this.#assertActionCurrent(state, selected, client, generation);
        signal.throwIfAborted();
        if (!state.schemas.get(selected.method)!.validate(params).valid) throw new CatalogError(400, 'Action arguments do not match the inspected schema');
        return selected.value.adapter.invoke(call, selected.value.child, params);
      }, this.#invokeTimeoutMs);
      // MCP business failures stay valid MCP results (including isError, media, structuredContent and _meta).
      return { status: 200, data: result };
    } catch (error) {
      if (error instanceof CatalogError) return failure(error.status, error.message);
      const timeout = timedOut(error);
      // A server-side JSON-RPC business error is not evidence of a broken connection.
      if (!(error instanceof McpError) || [ErrorCode.RequestTimeout, ErrorCode.ConnectionClosed].includes(error.code)) {
        if (this.#current(state, generation) && state.client === client) {
          state.status = 'error';
          state.error = timeout ? 'MCP invocation timed out' : 'MCP connection failed';
          state.checkedAt = new Date().toISOString();
          void this.#close(state);
          this.#syncRegistry(state);
        }
      }
      return failure(timeout ? 504 : 502, timeout ? 'MCP invocation timed out' : 'MCP invocation failed');
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#started = false;
    clearInterval(this.#timer);
    this.#timer = undefined;
    await Promise.all([...this.#sources.values()].map(async state => {
      state.generation++;
      state.status = 'disconnected';
      state.error = undefined;
      this.#syncRegistry(state);
      await this.#close(state);
    }));
  }
}

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { ServiceRegistry } from '../src/registry.js';
import { McpSourceError, McpSourceManager } from '../src/mcp-sources.js';

const stdioFixture = fileURLToPath(new URL('./fixtures/mcp-source-stdio.mjs', import.meta.url));

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Expected MCP state was not reached');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function withFixture(body: (fixture: {
  url: string;
  setAvailable: (value: boolean) => void;
  setMode: (value: 'normal' | 'duplicate_cursor' | 'hang' | 'tool_404') => void;
  requests: string[];
}) => Promise<void>): Promise<void> {
  let available = true;
  let mode = 'normal';
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw) as { id?: number; method: string; params?: Record<string, any> };
    requests.push(request.method);
    if (!available) { res.writeHead(503).end('private upstream diagnostics secret=hidden-token'); return; }
    if (request.method === 'notifications/initialized' || request.id === undefined) { res.writeHead(202).end(); return; }
    if (request.method === 'tools/call' && mode === 'hang') return;
    if (request.method === 'tools/call' && mode === 'tool_404') { res.writeHead(404).end('hidden-token'); return; }
    const result = request.method === 'initialize'
      ? { protocolVersion: request.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'runtime-fixture', version: '1' } }
      : request.method === 'tools/list'
        ? { tools: mode === 'duplicate_cursor' && request.params?.cursor ? [] : [{ name: 'echo', inputSchema: { type: 'object' }, description: 'Runtime echo' }],
          ...(mode === 'duplicate_cursor' ? { nextCursor: 'repeated' } : {}) }
        : request.method === 'tools/call'
          ? { content: [{ type: 'text', text: 'done' }], _meta: { verified: true } }
          : {};
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await body({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, requests,
      setAvailable: value => { available = value; }, setMode: value => { mode = value; } });
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

test('MCP source persistence restores literal config, owner-only permissions and fresh local sessions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-runtime-'));
  const storagePath = path.join(dir, 'mcp-sources.json');
  process.env.RUNTIME_MCP_SECRET = 'stdio-fixture-secret';
  const first = new McpSourceManager(new ServiceRegistry({ storagePath: false }), { storagePath });
  let restored: McpSourceManager | undefined;
  try {
    const imported = await first.import({ mcpServers: { local: {
      command: process.execPath, args: [stdioFixture], env: { MCP_FIXTURE_SECRET: '${RUNTIME_MCP_SECRET}' },
    } } });
    assert.equal(imported.sources[0]?.status, 'connected');
    const file = fs.readFileSync(storagePath, 'utf8');
    assert.match(file, /\$\{RUNTIME_MCP_SECRET\}/);
    assert.doesNotMatch(file, /stdio-fixture-secret/);
    assert.equal(fs.statSync(storagePath).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ['mcp-sources.json']);
    await first.stop();
    const registry = new ServiceRegistry({ storagePath: false });
    registry.register({ id: 'mcp-local', metadata: { mcp_source: 'mcp-local', enabled: true } });
    registry.register({ id: 'independent', command: 'echo' });
    restored = new McpSourceManager(registry, { storagePath });
    assert.equal(registry.get('mcp-local'), undefined);
    assert.ok(registry.get('independent'));
    assert.equal(restored.list()[0]?.status, 'disconnected');
    await restored.start();
    assert.equal(restored.list()[0]?.status, 'connected');
    assert.equal(registry.get('mcp-local')?.liveness, 'up');
    assert.equal(registry.get('mcp-local')?.port, undefined);
    assert.equal(registry.get('mcp-local')?.command, undefined);
    const result = await restored.invoke('mcp-local', { method: 'mcp-local.local_echo', params: { message: 'restored' } });
    assert.equal(result.status, 200);
    assert.deepEqual((result.data as { structuredContent: unknown }).structuredContent, { message: 'restored', configured_env: true });
    assert.doesNotMatch(JSON.stringify({ sources: restored.list(), registry: registry.list() }), /RUNTIME_MCP_SECRET|stdio-fixture-secret|MCP_FIXTURE_SECRET/);
  } finally {
    await first.stop(); await restored?.stop();
    delete process.env.RUNTIME_MCP_SECRET;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP persistence rejects total configuration overflow and protects damaged files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-runtime-'));
  const storagePath = path.join(dir, 'mcp-sources.json');
  const manager = new McpSourceManager(new ServiceRegistry({ storagePath: false }), { storagePath, timeoutMs: 200 });
  let damaged: McpSourceManager | undefined;
  try {
    const source = { command: 'nonexistent-mcp-runtime-fixture', env: { LARGE_A: 'a'.repeat(60_000), LARGE_B: 'b'.repeat(60_000) } };
    await manager.import(source, 'first');
    await manager.import(source, 'second');
    const before = fs.readFileSync(storagePath, 'utf8');
    await assert.rejects(manager.import(source, 'third'), (error: unknown) => error instanceof McpSourceError && error.status === 400);
    assert.equal(fs.readFileSync(storagePath, 'utf8'), before);
    assert.deepEqual(manager.list().map(item => item.id), ['mcp-first', 'mcp-second']);
    await manager.remove('mcp-first'); await manager.remove('mcp-second');
    const empty = new McpSourceManager(new ServiceRegistry({ storagePath: false }), { storagePath, timeoutMs: 200 });
    assert.deepEqual(empty.list(), []);
    await empty.import({ command: 'nonexistent-mcp-runtime-fixture' }, 'fresh');
    await empty.stop();
    fs.writeFileSync(storagePath, '{broken config', 'utf8');
    damaged = new McpSourceManager(new ServiceRegistry({ storagePath: false }), { storagePath });
    await damaged.start();
    await assert.rejects(damaged.import({ command: 'nonexistent-mcp-runtime-fixture' }, 'replacement'),
      (error: unknown) => error instanceof McpSourceError && error.status === 500);
    assert.equal(fs.readFileSync(storagePath, 'utf8'), '{broken config');
    assert.deepEqual(damaged.list(), []);
  } finally {
    await manager.stop(); await damaged?.stop(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP heartbeat marks failures down and reconnects without periodically rediscovering tools', async () => {
  await withFixture(async fixture => {
    const registry = new ServiceRegistry({ storagePath: false });
    const manager = new McpSourceManager(registry, { storagePath: false, timeoutMs: 300, reconnectIntervalMs: 20 });
    try {
      await manager.import({ url: fixture.url }, 'heartbeat');
      await manager.start();
      await eventually(() => fixture.requests.includes('ping'));
      assert.equal(fixture.requests.filter(method => method === 'tools/list').length, 1);
      fixture.setAvailable(false);
      await eventually(() => manager.list()[0]?.status === 'error');
      assert.equal(registry.get('mcp-heartbeat')?.metadata?.enabled, false);
      await registry.probeAll();
      assert.equal(registry.get('mcp-heartbeat')?.liveness, 'down');
      fixture.setAvailable(true);
      await eventually(() => manager.list()[0]?.status === 'connected');
      assert.equal(registry.get('mcp-heartbeat')?.metadata?.enabled, true);
      const result = await manager.invoke('mcp-heartbeat', { method: 'mcp-heartbeat.echo' });
      assert.equal(result.status, 200);
    } finally { await manager.stop(); }
  });
});

test('MCP bounds repeated pagination, reports timeout, and never falls back after a tool call', async () => {
  await withFixture(async fixture => {
    const manager = new McpSourceManager(new ServiceRegistry({ storagePath: false }), { storagePath: false, timeoutMs: 60 });
    try {
      fixture.setMode('duplicate_cursor');
      const invalid = await manager.import({ url: fixture.url }, 'invalid');
      assert.equal(invalid.sources[0]?.status, 'error');
      assert.equal(fixture.requests.filter(method => method === 'tools/list').length, 2);
      fixture.setMode('normal');
      await manager.import({ url: fixture.url }, 'call');
      const badParams = await manager.invoke('mcp-call', { method: 'mcp-call.echo', params: null });
      assert.equal(badParams.status, 400);
      fixture.setMode('tool_404');
      const failed = await manager.invoke('mcp-call', { method: 'mcp-call.echo' });
      assert.equal(failed.status, 502);
      assert.equal(fixture.requests.filter(method => method === 'tools/call').length, 1);
      assert.equal(manager.list().find(source => source.id === 'mcp-call')?.transport, 'http');
      assert.doesNotMatch(JSON.stringify(failed), /hidden-token/);
      fixture.setMode('normal'); await manager.refresh('mcp-call');
      fixture.setMode('hang');
      const timeout = await manager.invoke('mcp-call', { method: 'mcp-call.echo' });
      assert.equal(timeout.status, 504);
      assert.deepEqual(timeout.data, { error: 'MCP invocation timed out', retryable: false, kind: 'timeout', upstream_status: null });
      assert.equal(fixture.requests.filter(method => method === 'tools/call').length, 2);
    } finally { await manager.stop(); }
  });
});

test('MCP stop awaits subprocess cleanup already begun by an invocation timeout', { timeout: 10_000 }, async () => {
  const code = `
    import { Server } from '@modelcontextprotocol/sdk/server/index.js';
    import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
    import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
    const server = new Server({name:'stubborn-fixture',version:'1'}, {capabilities:{tools:{}}});
    server.setRequestHandler(ListToolsRequestSchema, () => ({tools:[
      {name:'pid',inputSchema:{type:'object'}}, {name:'hang',inputSchema:{type:'object'}}
    ]}));
    server.setRequestHandler(CallToolRequestSchema, request => request.params.name === 'pid'
      ? {content:[],structuredContent:{pid:process.pid}} : new Promise(() => {}));
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    await server.connect(new StdioServerTransport());
  `;
  const manager = new McpSourceManager(new ServiceRegistry({ storagePath: false }), { storagePath: false, timeoutMs: 1500 });
  let pid: number | undefined;
  try {
    const imported = await manager.import({ command: process.execPath, args: ['--input-type=module', '-e', code], cwd: process.cwd() }, 'stubborn');
    assert.equal(imported.sources[0]?.status, 'connected');
    const result = await manager.invoke('mcp-stubborn', { method: 'mcp-stubborn.pid' });
    pid = (result.data as { structuredContent: { pid: number } }).structuredContent.pid;
    const timeout = await manager.invoke('mcp-stubborn', { method: 'mcp-stubborn.hang' });
    assert.equal(timeout.status, 504);
    await manager.stop();
    assert.throws(() => process.kill(pid!, 0), { code: 'ESRCH' });
  } finally {
    await manager.stop();
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ } }
  }
});

test('MCP remote transports reject redirects without forwarding custom credentials', async () => {
  let redirectedRequests = 0;
  const target = createServer((_req, res) => { redirectedRequests++; res.writeHead(401).end(); });
  const redirect = createServer((_req, res) => {
    res.writeHead(307, { location: `http://127.0.0.1:${(target.address() as AddressInfo).port}/credentials-target` }).end();
  });
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => redirect.listen(0, '127.0.0.1', resolve));
  const manager = new McpSourceManager(new ServiceRegistry({ storagePath: false }), { storagePath: false, timeoutMs: 200 });
  try {
    const url = `http://127.0.0.1:${(redirect.address() as AddressInfo).port}/mcp`;
    for (const type of ['http', 'sse']) {
      const result = await manager.import({ type, url, headers: { 'X-Api-Key': 'protected-secret' } }, `redirect-${type}`);
      assert.equal(result.sources[0]?.status, 'error');
      assert.doesNotMatch(JSON.stringify(result), /protected-secret|credentials-target/);
    }
    assert.equal(redirectedRequests, 0);
  } finally {
    await manager.stop();
    await Promise.all([redirect, target].map(server => new Promise<void>(resolve => {
      server.close(() => resolve()); server.closeAllConnections();
    })));
  }
});

test('MCP OAuth rotates and persists opaque tokens, restores sessions, and refreshes parallel requests once', async context => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-oauth-runtime-'));
  const storagePath = path.join(dir, 'mcp-sources.json');
  const issuedAccessToken = '${MCP_OPAQUE_ACCESS_SECRET}-$${MCP_OPAQUE_ACCESS_SECRET}';
  const issuedRefreshToken = '${MCP_OPAQUE_REFRESH_SECRET}-$${MCP_OPAQUE_REFRESH_SECRET}';
  let expiresIn = 3600.0001;
  process.env.MCP_INITIAL_REFRESH = 'authorized-initial-refresh';
  process.env.MCP_OAUTH_CLIENT = 'authorized-client';
  process.env.MCP_OPAQUE_ACCESS_SECRET = 'must-never-send-access-secret';
  process.env.MCP_OPAQUE_REFRESH_SECRET = 'must-never-send-refresh-secret';
  const grants: Record<string, string>[] = [];
  const bearerHeaders: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.url === '/token') {
      assert.equal(req.headers.authorization, undefined);
      assert.equal(req.headers['x-route'], 'required-route');
      grants.push(Object.fromEntries(new URLSearchParams(raw)));
      await new Promise(resolve => setTimeout(resolve, 30));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        access_token: issuedAccessToken, refresh_token: issuedRefreshToken, expires_in: expiresIn, token_type: 'Bearer',
      }));
      return;
    }
    bearerHeaders.push(req.headers.authorization ?? '');
    if (req.headers.authorization !== `Bearer ${issuedAccessToken}`) { res.writeHead(401).end(); return; }
    const request = JSON.parse(raw) as { id?: number; method: string; params?: Record<string, any> };
    if (request.id === undefined) { res.writeHead(202).end(); return; }
    const result = request.method === 'initialize'
      ? { protocolVersion: request.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'oauth-runtime', version: '1' } }
      : request.method === 'tools/list' ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
        : request.method === 'tools/call' ? { content: [{ type: 'text', text: 'authorized' }] } : {};
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const registry = new ServiceRegistry({ storagePath: false });
  const manager = new McpSourceManager(registry, { storagePath, timeoutMs: 2000 });
  let restored: McpSourceManager | undefined;
  try {
    const imported = await manager.import({ url: `${base}/mcp`, headers: { 'X-Route': 'required-route', Authorization: 'Bearer stale-config-token' }, oauth: {
      tokenUrl: `${base}/token`, clientId: '${MCP_OAUTH_CLIENT}', refreshToken: '${MCP_INITIAL_REFRESH}',
      accessToken: 'expired-token', expiresAt: Date.now() - 1000,
    } }, 'oauth');
    assert.equal(imported.sources[0]?.status, 'connected');
    assert.equal(grants.length, 1);
    assert.deepEqual(grants[0], { grant_type: 'refresh_token', client_id: 'authorized-client', refresh_token: 'authorized-initial-refresh' });
    const persisted = JSON.parse(fs.readFileSync(storagePath, 'utf8')).mcpServers.oauth.oauth;
    assert.equal(persisted.clientId, '${MCP_OAUTH_CLIENT}');
    assert.equal(persisted.accessToken, issuedAccessToken.replace(/\$/g, () => '$$'));
    assert.equal(persisted.refreshToken, issuedRefreshToken.replace(/\$/g, () => '$$'));
    assert.equal(Number.isSafeInteger(persisted.expiresAt), true);
    assert.equal(fs.statSync(storagePath).mode & 0o777, 0o600);
    assert.doesNotMatch(JSON.stringify({ status: manager.list(), registry: registry.list() }), /authorized-initial-refresh|must-never-send|stale-config-token|MCP_OPAQUE/);
    await manager.stop();
    restored = new McpSourceManager(new ServiceRegistry({ storagePath: false }), { storagePath, timeoutMs: 2000 });
    await restored.start();
    assert.equal(restored.list()[0]?.status, 'connected');
    assert.equal(grants.length, 1);
    let future = Date.now() + 7_200_000;
    context.mock.method(Date, 'now', () => future);
    const results = await Promise.all(Array.from({ length: 4 }, () => restored!.invoke('mcp-oauth', { method: 'mcp-oauth.echo' })));
    assert.ok(results.every(result => result.status === 200));
    assert.equal(grants.length, 2);
    assert.equal(grants[1]?.refresh_token, issuedRefreshToken);
    assert.ok(bearerHeaders.every(header => header === `Bearer ${issuedAccessToken}`));
    expiresIn = 30.0001;
    future += 7_200_000;
    assert.equal((await restored.invoke('mcp-oauth', { method: 'mcp-oauth.echo' })).status, 200);
    assert.equal((await restored.invoke('mcp-oauth', { method: 'mcp-oauth.echo' })).status, 200);
    assert.equal(grants.length, 3); // Short-lived valid tokens do not refresh on every request.
  } finally {
    context.mock.restoreAll();
    await manager.stop(); await restored?.stop();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    for (const key of ['MCP_INITIAL_REFRESH', 'MCP_OAUTH_CLIENT', 'MCP_OPAQUE_ACCESS_SECRET', 'MCP_OPAQUE_REFRESH_SECRET']) delete process.env[key];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP OAuth refresh is aborted when initialization times out', async () => {
  let grants = 0;
  let closed = 0;
  let mcpRequests = 0;
  const server = createServer((req, res) => {
    if (req.url === '/token') { grants++; res.once('close', () => { closed++; }); }
    else { mcpRequests++; res.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const manager = new McpSourceManager(new ServiceRegistry({ storagePath: false }), { storagePath: false, timeoutMs: 60 });
  try {
    const imported = await manager.import({ url: `${base}/mcp`, oauth: {
      tokenUrl: `${base}/token`, clientId: 'client', refreshToken: 'refresh-secret',
    } }, 'slow-oauth');
    assert.equal(imported.sources[0]?.status, 'error');
    await eventually(() => closed === 1);
    assert.equal(grants, 1);
    assert.equal(mcpRequests, 0);
    assert.doesNotMatch(JSON.stringify(imported), /refresh-secret|\/token/);
  } finally {
    await manager.stop();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
});

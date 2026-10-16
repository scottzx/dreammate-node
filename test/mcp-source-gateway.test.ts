import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { createAgent } from '../src/server.js';
import { ServiceRegistry } from '../src/registry.js';
import { callDreammateTool } from '../src/mcp.js';

const secretHeader = 'remote-fixture-secret';
const secretUrl = 'url-fixture-secret';
const stdioFixture = fileURLToPath(new URL('./fixtures/mcp-source-stdio.mjs', import.meta.url));
const echoSchema = {
  type: 'object' as const,
  properties: { message: { type: 'string' }, nested: { type: 'object', properties: { count: { type: 'integer' } } } },
  required: ['message'],
};
const echoOutputSchema = { type: 'object' as const, properties: { received: { type: 'object' } }, required: ['received'] };
const remoteTools: Tool[] = [
  { name: 'echo', description: 'Echo a message with structured output and media', inputSchema: echoSchema, outputSchema: echoOutputSchema, annotations: { readOnlyHint: true } },
  { name: 'fail', description: 'Return an MCP tool error', inputSchema: { type: 'object' } },
];

function resultFor(name: string, args: Record<string, unknown> = {}): CallToolResult {
  if (name === 'fail') return {
    isError: true, content: [{ type: 'text', text: 'Fixture business error' }],
    structuredContent: { failed: true }, _meta: { fixture_transport: 'http', reason: 'business' },
  };
  return {
    content: [
      { type: 'text', text: String(args.message ?? name), _meta: { block: 'text' } },
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
      { type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/wav' },
      { type: 'resource_link', name: 'fixture-file', uri: 'https://example.test/fixture.txt', mimeType: 'text/plain' },
      { type: 'resource', resource: { uri: 'fixture://message', mimeType: 'text/plain', text: 'Embedded fixture' } },
    ],
    structuredContent: { received: args }, _meta: { fixture_transport: 'http', request_tag: 'preserved' },
  };
}

async function listen(server: HttpServer, host = '127.0.0.1'): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => { server.off('error', reject); resolve(); });
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: HttpServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

async function withAgent<T>(body: (base: string, registry: ServiceRegistry) => Promise<T>, host = '127.0.0.1'): Promise<T> {
  const registry = new ServiceRegistry({ storagePath: false });
  const { server, mcpSources } = createAgent({ registry, mcpSources: { storagePath: false, timeoutMs: 5000 } });
  const base = await listen(server, host);
  try { return await body(base, registry); }
  finally { await mcpSources.stop(); await close(server); }
}

async function withRemote<T>(body: (fixture: {
  url: string;
  cursors: (string | undefined)[];
  calls: { name: string; arguments: Record<string, unknown> }[];
  setTools: (tools: Tool[]) => void;
  setAvailable: (value: boolean) => void;
  notifyToolListChanged: () => Promise<void>;
  tokenUrl: string;
  tokenRequests: { contentType: string; form: Record<string, string> }[];
  authorizationHeaders: (string | undefined)[];
  setDenyAuthorization: (value: boolean) => void;
  setOAuthResponseTokens: (value: { accessToken: string; refreshToken: string }) => void;
}) => Promise<T>, legacySse = false, oauthFixture = false): Promise<T> {
  let tools = [...remoteTools];
  let available = true;
  let denyAuthorization = false;
  let refreshToken = 'oauth-fixture-refresh-initial';
  let accessToken: string | undefined;
  let oauthResponseTokens: { accessToken: string; refreshToken: string } | undefined;
  const cursors: (string | undefined)[] = [];
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const tokenRequests: { contentType: string; form: Record<string, string> }[] = [];
  const authorizationHeaders: (string | undefined)[] = [];
  const servers = new Set<Server>();
  const sse = new Map<string, SSEServerTransport>();
  const makeServer = () => {
    const server = new Server({ name: 'remote-source-fixture', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
    servers.add(server);
    server.setRequestHandler(ListToolsRequestSchema, request => {
      cursors.push(request.params?.cursor);
      return request.params?.cursor === 'second' ? { tools: tools.slice(1) } : { tools: tools.slice(0, 1), ...(tools.length > 1 ? { nextCursor: 'second' } : {}) };
    });
    server.setRequestHandler(CallToolRequestSchema, request => {
      const args = request.params.arguments ?? {};
      calls.push({ name: request.params.name, arguments: args });
      return resultFor(request.params.name, args);
    });
    return server;
  };
  const http = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, 'http://fixture.test');
      if (oauthFixture && url.pathname === '/oauth/token' && req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) raw += String(chunk);
        const form = Object.fromEntries(new URLSearchParams(raw));
        tokenRequests.push({ contentType: String(req.headers['content-type']), form });
        res.setHeader('content-type', 'application/json');
        if (form.grant_type !== 'refresh_token' || form.client_id !== 'oauth-fixture-client' || form.refresh_token !== refreshToken) {
          res.writeHead(401).end(JSON.stringify({ error: 'Invalid fixture refresh grant' }));
          return;
        }
        accessToken = oauthResponseTokens?.accessToken ?? `oauth-fixture-access-${tokenRequests.length}`;
        refreshToken = oauthResponseTokens?.refreshToken ?? `oauth-fixture-refresh-${tokenRequests.length}`;
        res.end(JSON.stringify({ access_token: accessToken, refresh_token: refreshToken, expires_in: 3600, token_type: 'Bearer' }));
        return;
      }
      if (req.headers['x-fixture-secret'] !== secretHeader) { res.writeHead(401).end(); return; }
      if (oauthFixture) {
        authorizationHeaders.push(req.headers.authorization);
        if (denyAuthorization || !accessToken || req.headers.authorization !== `Bearer ${accessToken}`) {
          res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Rejected fixture bearer' }));
          return;
        }
      }
      if (!available) { res.writeHead(503).end(JSON.stringify({ error: `Private upstream diagnostic: ${secretHeader}` })); return; }
      if (legacySse && url.pathname === '/messages' && req.method === 'POST') {
        const transport = sse.get(url.searchParams.get('sessionId') ?? '');
        if (!transport) { res.writeHead(404).end(); return; }
        await transport.handlePostMessage(req, res);
        return;
      }
      if (url.pathname !== '/mcp' || url.searchParams.get('token') !== secretUrl) { res.writeHead(404).end(); return; }
      if (legacySse) {
        if (req.method !== 'GET') { res.writeHead(405).end(); return; }
        const server = makeServer();
        const transport = new SSEServerTransport('/messages', res);
        sse.set(transport.sessionId, transport);
        res.once('close', () => { sse.delete(transport.sessionId); servers.delete(server); void server.close(); });
        await server.connect(transport);
        return;
      }
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      const server = makeServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.once('close', () => { servers.delete(server); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500).end(JSON.stringify({ error: String(error) }));
      else res.end();
    }
  });
  const base = await listen(http);
  try { return await body({
    url: `${base}/mcp?token=${secretUrl}`, cursors, calls,
    setTools: value => { tools = value; }, setAvailable: value => { available = value; },
    notifyToolListChanged: async () => { await Promise.all([...servers].map(server => server.sendToolListChanged())); },
    tokenUrl: `${base}/oauth/token`, tokenRequests, authorizationHeaders,
    setDenyAuthorization: value => { denyAuthorization = value; },
    setOAuthResponseTokens: value => { oauthResponseTokens = value; },
  }); }
  finally { await Promise.allSettled([...servers].map(server => server.close())); await close(http); }
}

function post(base: string, pathname: string, body: unknown): Promise<Response> {
  return fetch(`${base}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
function toolData(result: Awaited<ReturnType<typeof callDreammateTool>>): Record<string, any> {
  return (result.structuredContent ?? JSON.parse((result.content[0] as { text: string }).text)) as Record<string, any>;
}
function remoteConfig(url: string, type = 'http') {
  return { url, type, headers: { 'X-Fixture-Secret': secretHeader } };
}
function assertNoSecrets(value: unknown): void {
  assert.doesNotMatch(JSON.stringify(value), /remote-fixture-secret|url-fixture-secret|stdio-fixture-secret|X-Fixture-Secret|MCP_FIXTURE_SECRET|oauth-fixture-(?:refresh|access|expired|client|local)/);
}

test('MCP sources: pasted HTTP and stdio configs discover every page and work through search → inspect → invoke', { timeout: 20000 }, async () => {
  await withRemote(async fixture => withAgent(async (base, registry) => {
    const response = await post(base, '/mcp/sources', { config: JSON.stringify({ mcpServers: {
      demo: remoteConfig(fixture.url),
      local: { command: process.execPath, args: [stdioFixture], env: { MCP_FIXTURE_SECRET: 'stdio-fixture-secret' } },
    } }) });
    assert.equal(response.status, 201);
    const imported = await response.json() as { sources: { id: string; tool_count: number; status: string }[] };
    assert.deepEqual(imported.sources.map(source => source.id).sort(), ['mcp-demo', 'mcp-local']);
    assert.ok(imported.sources.every(source => source.tool_count === 2 && source.status === 'connected'));
    assert.deepEqual(fixture.cursors, [undefined, 'second']);
    assert.deepEqual(Object.keys(registry.get('mcp-demo')!.methods!).sort(), ['mcp-demo.echo', 'mcp-demo.fail']);
    assert.deepEqual(Object.keys(registry.get('mcp-local')!.methods!).sort(), ['mcp-local.local_echo', 'mcp-local.process_id']);
    assert.equal(registry.get('mcp-demo')!.metadata?.mcp_source, 'mcp-demo');

    const options = { agentUrl: base, embeddingUrl: '' };
    const search = await callDreammateTool('dreammate_search_tools', { query: 'Echo a message', node: 'localhost' }, options);
    assert.equal(search.isError, undefined);
    const results = toolData(search).results as { service_id: string; method: string }[];
    assert.ok(results.some(result => result.service_id === 'mcp-demo' && result.method === 'mcp-demo.echo'));
    assert.ok(results.some(result => result.service_id === 'mcp-local' && result.method === 'mcp-local.local_echo'));
    const inspect = toolData(await callDreammateTool('dreammate_inspect', { service_id: 'mcp-demo', method: 'mcp-demo.echo' }, options));
    assert.deepEqual(inspect.details.parameters, echoSchema);
    assert.deepEqual(inspect.details.returns, echoOutputSchema);
    assert.deepEqual(inspect.details.annotations, { readOnlyHint: true });
    const params = { message: 'Gateway integration', nested: { count: 3 } };
    const invoke = await callDreammateTool('dreammate_invoke', { service_id: 'mcp-demo', method: 'mcp-demo.echo', params }, options);
    const expected = resultFor('echo', params);
    assert.deepEqual(invoke.content, expected.content);
    assert.deepEqual(invoke.structuredContent, expected.structuredContent);
    assert.equal(invoke._meta?.request_tag, 'preserved');
    assert.deepEqual(fixture.calls, [{ name: 'echo', arguments: params }]);
    for (const [payload, status] of [
      [{ method: 'unknown' }, 404],
      [{ method: 'mcp-local.local_echo' }, 404],
      [{ method: 'mcp-demo.unknown' }, 404],
      [{ method: 'mcp-demo.echo', params: [] }, 400],
    ] as const) {
      const invalid = await post(base, '/services/mcp-demo/invoke', payload);
      assert.equal(invalid.status, status);
      await invalid.json();
    }
    assert.equal(fixture.calls.length, 1, 'invalid or cross-source methods must never call the MCP');

    const alias = await post(base, '/services/mcp-demo/invoke', { method: 'echo', params });
    assert.equal(alias.status, 200, 'unique upstream names resolve within the selected source');
    assert.deepEqual(await alias.json(), expected);

    const direct = await post(base, '/services/mcp-demo/invoke', { method: 'mcp-demo.echo', params });
    assert.equal(direct.status, 200);
    assert.deepEqual(await direct.json(), expected);
    const byCapability = await post(base, '/capabilities/mcp-demo.echo/invoke', { params });
    assert.equal(byCapability.status, 200);
    assert.deepEqual(await byCapability.json(), expected);
    const failure = await callDreammateTool('dreammate_invoke', { service_id: 'mcp-demo', method: 'mcp-demo.fail' }, options);
    assert.equal(failure.isError, true);
    assert.deepEqual(failure.content, resultFor('fail').content);
    assert.deepEqual(failure.structuredContent, { failed: true });
    assert.equal(failure._meta?.reason, 'business');

    const local = await callDreammateTool('dreammate_invoke', { service_id: 'mcp-local', method: 'mcp-local.local_echo', params: { message: 'Local process' } }, options);
    assert.equal(local.isError, undefined);
    assert.deepEqual(local.structuredContent, { message: 'Local process', configured_env: true });
    assert.equal(local._meta?.fixture_transport, 'stdio');
    const localByCapability = await post(base, '/capabilities/mcp-local.local_echo/invoke', { params: { message: 'Local capability' } });
    assert.equal(localByCapability.status, 200);
    assert.deepEqual((await localByCapability.json() as CallToolResult).structuredContent, { message: 'Local capability', configured_env: true });

    assertNoSecrets(imported);
    for (const route of ['/mcp/sources', '/services', '/services/mcp-demo', '/manifest']) {
      const response = await fetch(`${base}${route}`);
      assert.equal(response.status, 200);
      assertNoSecrets(await response.json());
    }
  }));
});

test('MCP sources: refresh replaces discovered methods and removal closes the local process and unregisters tools', { timeout: 20000 }, async () => {
  await withRemote(async fixture => withAgent(async (base, registry) => {
    const add = await post(base, '/mcp/sources', { config: { mcpServers: {
      demo: remoteConfig(fixture.url), local: { command: process.execPath, args: [stdioFixture] },
    } } });
    assert.equal(add.status, 201);
    await add.json();
    fixture.setTools([{ name: 'lookup', description: 'Lookup a refreshed item', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } }]);
    const refresh = await post(base, '/mcp/sources/mcp-demo/refresh', {});
    assert.equal(refresh.status, 200);
    await refresh.json();
    assert.deepEqual(Object.keys(registry.get('mcp-demo')!.methods!), ['mcp-demo.lookup']);
    const search = toolData(await callDreammateTool('dreammate_search_tools', { query: 'Lookup a refreshed item', node: 'localhost' }, { agentUrl: base, embeddingUrl: '' }));
    assert.equal(search.results[0].method, 'mcp-demo.lookup');
    const stale = await post(base, '/services/mcp-demo/invoke', { method: 'mcp-demo.echo' });
    assert.equal(stale.status, 404);
    await stale.json();

    const pidResponse = await post(base, '/services/mcp-local/invoke', { method: 'mcp-local.process_id' });
    assert.equal(pidResponse.status, 200);
    const pid = ((await pidResponse.json()) as CallToolResult).structuredContent!.pid as number;
    assert.doesNotThrow(() => process.kill(pid, 0));
    for (const id of ['mcp-demo', 'mcp-local']) {
      const removal = await fetch(`${base}/mcp/sources/${id}`, { method: 'DELETE' });
      assert.equal(removal.status, 200);
      await removal.json();
      assert.equal(registry.get(id), undefined);
    }
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    const missing = await post(base, '/services/mcp-local/invoke', { method: 'mcp-local.process_id' });
    assert.equal(missing.status, 404);
    await missing.json();
    const list = await (await fetch(`${base}/mcp/sources`)).json() as { sources: unknown[] };
    assert.deepEqual(list.sources, []);
  }));
});

test('MCP sources: malformed configs and name collisions fail without overwriting services or exposing credentials', { timeout: 20000 }, async () => {
  await withRemote(async fixture => withAgent(async (base, registry) => {
    const invalid = [
      '{', {}, { mcpServers: {} },
      { mcpServers: { bad: { command: process.execPath, url: fixture.url } } },
      { mcpServers: { bad: { url: 'file:///tmp/not-an-mcp' } } },
      { mcpServers: { bad: { command: process.execPath, env: { TOKEN: 42 } } } },
    ];
    for (const config of invalid) {
      const response = await post(base, '/mcp/sources', { config });
      assert.equal(response.status, 400);
      assertNoSecrets(await response.json());
      assert.deepEqual(registry.list(), []);
    }
    const add = await post(base, '/mcp/sources', { config: { mcpServers: { demo: remoteConfig(fixture.url) } } });
    assert.equal(add.status, 201);
    await add.json();
    const original = registry.get('mcp-demo');
    const overwrite = await post(base, '/services', { id: 'mcp-demo', name: 'Replacement', port: 8080 });
    assert.equal(overwrite.status, 409);
    await overwrite.json();
    const deleteOrdinaryRoute = await fetch(`${base}/services/mcp-demo`, { method: 'DELETE' });
    assert.equal(deleteOrdinaryRoute.status, 409);
    await deleteOrdinaryRoute.json();
    const spoof = await post(base, '/services', { id: 'spoofed', port: 8080, metadata: { mcp_source: 'mcp-demo' } });
    assert.equal(spoof.status, 409);
    await spoof.json();
    assert.equal(registry.get('mcp-demo'), original);
    assert.equal(registry.get('spoofed'), undefined);
    const duplicate = await post(base, '/mcp/sources', { config: { mcpServers: { demo: remoteConfig(fixture.url) } } });
    assert.equal(duplicate.status, 409);
    assertNoSecrets(await duplicate.json());
    assert.equal(registry.get('mcp-demo'), original);
    registry.register({ id: 'mcp-reserved', name: 'Existing independent service', port: 8080 });
    const reserved = registry.get('mcp-reserved');
    const collision = await post(base, '/mcp/sources', { config: { mcpServers: { reserved: remoteConfig(fixture.url) } } });
    assert.equal(collision.status, 409);
    assertNoSecrets(await collision.json());
    assert.equal(registry.get('mcp-reserved'), reserved);
    for (const [path, method] of [['/mcp/sources/missing', 'DELETE'], ['/mcp/sources/missing/refresh', 'POST']]) {
      const response = await fetch(`${base}${path}`, { method });
      assert.equal(response.status, 404);
      await response.json();
    }
  }));
});

test('MCP sources: legacy SSE works explicitly and via HTTP transport fallback', { timeout: 20000 }, async () => {
  await withRemote(async fixture => withAgent(async (base, registry) => {
    for (const type of ['sse', 'http']) {
      const add = await post(base, '/mcp/sources', { config: { mcpServers: { [type]: remoteConfig(fixture.url, type) } } });
      assert.equal(add.status, 201);
      const imported = await add.json() as { sources: { status: string; tool_count: number }[] };
      assert.equal(imported.sources[0]!.status, 'connected');
      assert.equal(imported.sources[0]!.tool_count, 2);
      assert.ok(registry.get(`mcp-${type}`)!.methods![`mcp-${type}.echo`]);
      const invoke = await post(base, `/services/mcp-${type}/invoke`, { method: `mcp-${type}.echo`, params: { message: type } });
      assert.equal(invoke.status, 200);
      assert.deepEqual(await invoke.json(), resultFor('echo', { message: type }));
    }
    fixture.setTools([{ name: 'notified', description: 'Tool discovered from list changed notification', inputSchema: { type: 'object' } }]);
    await fixture.notifyToolListChanged();
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && ['sse', 'http'].some(type => !registry.get(`mcp-${type}`)!.methods![`mcp-${type}.notified`])) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    for (const type of ['sse', 'http']) assert.deepEqual(Object.keys(registry.get(`mcp-${type}`)!.methods!), [`mcp-${type}.notified`]);
  }), true);
});

test('MCP sources: discovery failures disable tools, survive registry probing, redact upstream errors and recover on refresh', { timeout: 20000 }, async () => {
  await withRemote(async fixture => withAgent(async (base, registry) => {
    const add = await post(base, '/mcp/sources', { config: { mcpServers: { demo: remoteConfig(fixture.url) } } });
    assert.equal(add.status, 201);
    await add.json();
    fixture.setAvailable(false);
    const refresh = await post(base, '/mcp/sources/mcp-demo/refresh', {});
    assert.equal(refresh.status, 200);
    const failure = await refresh.json() as { status: string; error: string };
    assert.equal(failure.status, 'error');
    assertNoSecrets(failure);
    assert.equal(registry.get('mcp-demo')!.liveness, 'down');
    assert.equal(registry.get('mcp-demo')!.metadata?.enabled, false);
    await registry.probeAll();
    assert.equal(registry.get('mcp-demo')!.liveness, 'down');
    assert.equal(registry.get('mcp-demo')!.metadata?.enabled, false);
    const unavailable = await post(base, '/services/mcp-demo/invoke', { method: 'mcp-demo.echo', params: { message: 'Unavailable' } });
    assert.ok(unavailable.status >= 400);
    assertNoSecrets(await unavailable.json());
    const search = toolData(await callDreammateTool('dreammate_search_tools', { query: 'Echo a message', node: 'localhost' }, { agentUrl: base, embeddingUrl: '' }));
    assert.equal(search.total_matched, 0);
    fixture.setAvailable(true);
    const recovery = await post(base, '/mcp/sources/mcp-demo/refresh', {});
    assert.equal(recovery.status, 200);
    assert.equal((await recovery.json() as { status: string }).status, 'connected');
    assert.equal(registry.get('mcp-demo')!.liveness, 'up');
    assert.equal(registry.get('mcp-demo')!.metadata?.enabled, true);
  }));
});

test('MCP sources: an older ordinary service probe cannot mark its replacement MCP connection down', { timeout: 20000 }, async () => {
  await withRemote(async fixture => {
    let releaseProbe: ((alive: boolean) => void) | undefined;
    const registry = new ServiceRegistry({ storagePath: false, probe: () => new Promise(resolve => { releaseProbe = resolve; }) });
    registry.register({ id: 'mcp-demo', port: 8080 });
    const { server, mcpSources } = createAgent({ registry, mcpSources: { storagePath: false, timeoutMs: 5000 } });
    const base = await listen(server);
    const oldProbe = registry.probeAll();
    try {
      assert.ok(releaseProbe);
      registry.deregister('mcp-demo');
      const add = await post(base, '/mcp/sources', { config: { mcpServers: { demo: remoteConfig(fixture.url) } } });
      assert.equal(add.status, 201);
      await add.json();
      const replacement = registry.get('mcp-demo');
      assert.equal(replacement!.liveness, 'up');
      releaseProbe(false);
      await oldProbe;
      assert.equal(registry.get('mcp-demo'), replacement);
      assert.equal(replacement!.liveness, 'up');
      assert.equal(replacement!.metadata?.enabled, true);
      assert.equal(replacement!.failures, 0);
      assert.equal(mcpSources.list()[0]!.status, 'connected');
    } finally {
      releaseProbe?.(false);
      await oldProbe;
      await mcpSources.stop();
      await close(server);
    }
  });
});

test('MCP sources: expired OAuth grants refresh before discovery and invocation, rotate credentials and never replay a rejected call', { timeout: 20000 }, async () => {
  await withRemote(async fixture => withAgent(async (base, registry) => {
    const add = await post(base, '/mcp/sources', { config: { mcpServers: { authorized: {
      ...remoteConfig(fixture.url),
      headers: { 'X-Fixture-Secret': secretHeader, Authorization: 'Bearer oauth-fixture-expired-header' },
      oauth: {
        tokenUrl: fixture.tokenUrl, clientId: 'oauth-fixture-client',
        refreshToken: 'oauth-fixture-refresh-initial', accessToken: 'oauth-fixture-expired-access', expiresAt: Date.now() - 120000,
      },
    } } } });
    assert.equal(add.status, 201);
    const imported = await add.json() as { sources: { status: string; tool_count: number }[] };
    assert.equal(imported.sources[0]!.status, 'connected');
    assert.equal(imported.sources[0]!.tool_count, 2);
    assert.equal(fixture.tokenRequests.length, 1);
    assert.match(fixture.tokenRequests[0]!.contentType, /^application\/x-www-form-urlencoded\b/);
    assert.deepEqual(fixture.tokenRequests[0]!.form, { grant_type: 'refresh_token', client_id: 'oauth-fixture-client', refresh_token: 'oauth-fixture-refresh-initial' });
    assert.ok(fixture.authorizationHeaders.length >= 3);
    assert.ok(fixture.authorizationHeaders.every(header => header === 'Bearer oauth-fixture-access-1'));
    assertNoSecrets(imported);
    assertNoSecrets(registry.list());

    const options = { agentUrl: base, embeddingUrl: '' };
    const search = toolData(await callDreammateTool('dreammate_search_tools', { query: 'Echo a message', node: 'localhost' }, options));
    assert.equal(search.results[0].service_id, 'mcp-authorized');
    const inspect = toolData(await callDreammateTool('dreammate_inspect', { service_id: 'mcp-authorized', method: 'mcp-authorized.echo' }, options));
    assert.deepEqual(inspect.details.parameters, echoSchema);
    const params = { message: 'OAuth authorized invocation' };
    const invoke = await callDreammateTool('dreammate_invoke', { service_id: 'mcp-authorized', method: 'mcp-authorized.echo', params }, options);
    assert.equal(invoke.isError, undefined);
    assert.deepEqual(invoke.content, resultFor('echo', params).content);
    assert.equal(fixture.tokenRequests.length, 1, 'a valid refreshed token must be reused');
    assert.deepEqual(fixture.calls, [{ name: 'echo', arguments: params }]);
    for (const route of ['/mcp/sources', '/services', '/services/mcp-authorized', '/manifest']) {
      const response = await fetch(`${base}${route}`);
      assert.equal(response.status, 200);
      const result = await response.json();
      assertNoSecrets(result);
      assert.doesNotMatch(JSON.stringify(result), /refreshToken|accessToken|tokenUrl|"oauth":/);
    }

    fixture.setDenyAuthorization(true);
    const requestsBefore = fixture.authorizationHeaders.length;
    const denied = await post(base, '/services/mcp-authorized/invoke', { method: 'mcp-authorized.echo', params: { message: 'Rejected invocation' } });
    assert.equal(denied.status, 502);
    assertNoSecrets(await denied.json());
    assert.equal(fixture.authorizationHeaders.length, requestsBefore + 1, 'a rejected invocation must never be sent twice');
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.tokenRequests.length, 1, 'a 401 must not trigger a refresh and resend in the same invocation');
    fixture.setDenyAuthorization(false);
    const recovered = await post(base, '/mcp/sources/mcp-authorized/refresh', {});
    assert.equal(recovered.status, 200);
    const recovery = await recovered.json() as { status: string };
    assert.equal(recovery.status, 'connected');
    assertNoSecrets(recovery);
    assert.equal(fixture.tokenRequests.length, 2);
    assert.equal(fixture.tokenRequests[1]!.form.refresh_token, 'oauth-fixture-refresh-1');
    assert.equal(fixture.authorizationHeaders.at(-1), 'Bearer oauth-fixture-access-2');
  }), false, true);
});

test('MCP sources: opaque tokens returned by OAuth never interpolate local environment variables', { timeout: 20000 }, async () => {
  const previous = process.env.MCP_OAUTH_GATEWAY_SECRET;
  const localSecret = 'oauth-fixture-local-environment-secret';
  const opaqueToken = '${MCP_OAUTH_GATEWAY_SECRET}';
  process.env.MCP_OAUTH_GATEWAY_SECRET = localSecret;
  try {
    await withRemote(async fixture => {
      fixture.setOAuthResponseTokens({ accessToken: opaqueToken, refreshToken: opaqueToken });
      await withAgent(async (base, registry) => {
        const add = await post(base, '/mcp/sources', { config: { mcpServers: { opaque: {
          ...remoteConfig(fixture.url), oauth: { tokenUrl: fixture.tokenUrl, clientId: 'oauth-fixture-client', refreshToken: 'oauth-fixture-refresh-initial' },
        } } } });
        assert.equal(add.status, 201);
        const imported = await add.json() as { sources: { status: string }[] };
        assert.equal(imported.sources[0]!.status, 'connected');
        assert.ok(fixture.authorizationHeaders.length >= 3);
        assert.ok(fixture.authorizationHeaders.every(header => header === `Bearer ${opaqueToken}`));
        assertNoSecrets(imported);
        assertNoSecrets(registry.list());
        fixture.setDenyAuthorization(true);
        const denied = await post(base, '/services/mcp-opaque/invoke', { method: 'mcp-opaque.echo' });
        assert.equal(denied.status, 502);
        await denied.json();
        fixture.setDenyAuthorization(false);
        const recovery = await post(base, '/mcp/sources/mcp-opaque/refresh', {});
        assert.equal(recovery.status, 200);
        assert.equal((await recovery.json() as { status: string }).status, 'connected');
        assert.equal(fixture.tokenRequests[1]!.form.refresh_token, opaqueToken);
        assert.ok(!JSON.stringify(fixture.authorizationHeaders).includes(localSecret));
        assert.ok(!JSON.stringify(fixture.tokenRequests).includes(localSecret));
      });
    }, false, true);
  } finally {
    if (previous === undefined) delete process.env.MCP_OAUTH_GATEWAY_SECRET;
    else process.env.MCP_OAUTH_GATEWAY_SECRET = previous;
  }
});

test('MCP source management is loopback-only while imported tools remain available to other nodes', { timeout: 20000 }, async t => {
  const address = Object.values(networkInterfaces()).flat().find(entry => entry && !entry.internal && entry.family === 'IPv4')?.address;
  if (!address) { t.skip('No non-loopback IPv4 interface is available'); return; }
  await withRemote(async fixture => withAgent(async (base, registry) => {
    const add = await post(base, '/mcp/sources', { config: { mcpServers: { demo: remoteConfig(fixture.url) } } });
    assert.equal(add.status, 201);
    await add.json();
    const remoteBase = base.replace('127.0.0.1', address);
    for (const [path, method] of [
      ['/mcp/sources', 'GET'], ['/mcp/sources', 'POST'],
      ['/mcp/sources/mcp-demo', 'DELETE'], ['/mcp/sources/mcp-demo/refresh', 'POST'],
    ]) {
      const response = await fetch(`${remoteBase}${path}`, { method, ...(method === 'POST' ? { body: '{}' } : {}) });
      assert.equal(response.status, 403);
      assertNoSecrets(await response.json());
    }
    assert.ok(registry.get('mcp-demo'));
    const invoke = await post(remoteBase, '/services/mcp-demo/invoke', { method: 'mcp-demo.echo', params: { message: 'Other node' } });
    assert.equal(invoke.status, 200);
    assert.deepEqual(await invoke.json(), resultFor('echo', { message: 'Other node' }));
  }, '0.0.0.0'));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request as httpRequest, type ClientRequest, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createAgent } from '../src/server.js';
import { ServiceRegistry } from '../src/registry.js';
import { callDreammateTool } from '../src/mcp.js';

const tool = {
  name: 'echo',
  description: 'Echo a sharing boundary message',
  inputSchema: { type: 'object' as const, properties: { message: { type: 'string' } } },
};

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

async function withFixture<T>(body: (fixture: {
  url: string;
  port: number;
  methods: string[];
  calls: Record<string, unknown>[];
  ordinaryCalls: Record<string, unknown>[];
}) => Promise<T>): Promise<T> {
  const methods: string[] = [];
  const calls: Record<string, unknown>[] = [];
  const ordinaryCalls: Record<string, unknown>[] = [];
  const servers = new Set<Server>();
  const http = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      let raw = '';
      for await (const chunk of req) raw += String(chunk);
      const payload = JSON.parse(raw) as Record<string, unknown>;
      if (req.url === '/invoke') {
        ordinaryCalls.push(payload);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ordinary: true }));
        return;
      }
      if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
      methods.push(String(payload.method));
      const server = new Server({ name: 'sharing-boundary-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
      servers.add(server);
      server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [tool] }));
      server.setRequestHandler(CallToolRequestSchema, request => {
        const args = request.params.arguments ?? {};
        calls.push(args);
        return { content: [{ type: 'text', text: String(args.message ?? 'echo') }], structuredContent: { received: args } };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.once('close', () => { servers.delete(server); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, payload);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500).end(JSON.stringify({ error: String(error) }));
      else res.end();
    }
  });
  const base = await listen(http);
  try {
    return await body({ url: `${base}/mcp`, port: (http.address() as AddressInfo).port, methods, calls, ordinaryCalls });
  } finally {
    await Promise.allSettled([...servers].map(server => server.close()));
    await close(http);
  }
}

async function withAgent<T>(body: (agent: ReturnType<typeof createAgent> & { base: string }) => Promise<T>, host = '127.0.0.1'): Promise<T> {
  const registry = new ServiceRegistry({ storagePath: false });
  const agent = createAgent({ registry, mcpSources: { storagePath: false, timeoutMs: 5000 } });
  const base = await listen(agent.server, host);
  try { return await body({ ...agent, base }); }
  finally { await agent.mcpSources.stop(); await close(agent.server); }
}

function request(base: string, pathname: string, method: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function json(base: string, pathname: string): Promise<Record<string, any>> {
  const response = await fetch(`${base}${pathname}`);
  assert.equal(response.status, 200, pathname);
  return await response.json() as Record<string, any>;
}

function toolData(result: Awaited<ReturnType<typeof callDreammateTool>>): Record<string, any> {
  return (result.structuredContent ?? JSON.parse((result.content[0] as { text: string }).text)) as Record<string, any>;
}

async function importSources(base: string, url: string): Promise<void> {
  const response = await request(base, '/mcp/sources', 'POST', { config: { mcpServers: {
    shared: { url, type: 'http' },
    private: { url, type: 'http', sharing: 'local' },
  } } });
  assert.equal(response.status, 201);
  const imported = await response.json() as { sources: { id: string; status: string; sharing: string }[] };
  assert.deepEqual(imported.sources.map(source => [source.id, source.status, source.sharing]), [
    ['mcp-shared', 'connected', 'network'], ['mcp-private', 'connected', 'local'],
  ]);
}

test('MCP sharing updates validate input and preserve the active connection', { timeout: 20000 }, async () => {
  await withFixture(async fixture => withAgent(async ({ base, registry, mcpSources }) => {
    await importSources(base, fixture.url);
    assert.equal(registry.get('mcp-shared')!.metadata?.mcp_sharing, 'network');
    assert.equal(registry.get('mcp-private')!.metadata?.mcp_sharing, 'local');
    assert.equal((await json(base, '/mcp/sources')).sources.find((source: { id: string }) => source.id === 'mcp-private').sharing, 'local');
    const connectionRequests = [...fixture.methods];

    for (const invalid of [{ sharing: 'private' }, { sharing: null }, {}, [], 'local']) {
      const response = await request(base, '/mcp/sources/mcp-private/sharing', 'PATCH', invalid);
      assert.equal(response.status, 400, JSON.stringify(invalid));
      await response.json();
      assert.equal(mcpSources.list().find(source => source.id === 'mcp-private')!.sharing, 'local');
      assert.equal(registry.get('mcp-private')!.metadata?.mcp_sharing, 'local');
    }
    const malformed = await fetch(`${base}/mcp/sources/mcp-private/sharing`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{',
    });
    assert.equal(malformed.status, 400);
    await malformed.json();
    assert.equal(mcpSources.list().find(source => source.id === 'mcp-private')!.sharing, 'local');
    const missing = await request(base, '/mcp/sources/missing/sharing', 'PATCH', { sharing: 'network' });
    assert.equal(missing.status, 404);
    await missing.json();

    const changed = await request(base, '/mcp/sources/mcp-private/sharing', 'PATCH', { sharing: 'network' }, { 'X-Forwarded-For': '198.51.100.7' });
    assert.equal(changed.status, 200, 'a loopback socket remains trusted regardless of forwarded headers');
    assert.equal((await changed.json() as { sharing: string }).sharing, 'network');
    assert.equal(registry.get('mcp-private')!.metadata?.mcp_sharing, 'network');
    await mcpSources.setSharing('mcp-private', 'local');
    assert.equal(registry.get('mcp-private')!.metadata?.mcp_sharing, 'local');
    assert.deepEqual(fixture.methods, connectionRequests, 'sharing changes must not reconnect or rediscover upstream tools');

    const invoke = await request(base, '/services/mcp-private/invoke', 'POST', { method: 'mcp-private.echo', params: { message: 'still connected' } }, { 'X-Forwarded-For': '198.51.100.7' });
    assert.equal(invoke.status, 200);
    assert.deepEqual((await invoke.json() as { structuredContent: unknown }).structuredContent, { received: { message: 'still connected' } });
    assert.deepEqual(fixture.calls, [{ message: 'still connected' }]);
  }));
});

test('MCP local sharing hides discovery and every service route from non-loopback callers', { timeout: 20000 }, async t => {
  const address = Object.values(networkInterfaces()).flat().find(entry => entry && !entry.internal && entry.family === 'IPv4')?.address;
  if (!address) { t.skip('No non-loopback IPv4 interface is available'); return; }
  await withFixture(async fixture => withAgent(async ({ base, registry }) => {
    await importSources(base, fixture.url);
    registry.register({
      id: 'ordinary', port: fixture.port, reachability: 'localhost',
      methods: { 'ordinary.echo': { description: 'Echo through the ordinary HTTP gateway', parameters: { type: 'object' } } },
    });
    registry.get('mcp-private')!.skills = { privateGuide: { name: 'privateGuide', description: 'Private skill', sop: 'Private source instructions' } };
    const remote = base.replace('127.0.0.1', address);
    const connectionRequests = [...fixture.methods];

    for (const [target, ids] of [[base, ['mcp-shared', 'mcp-private', 'ordinary']], [remote, ['mcp-shared', 'ordinary']]] as const) {
      assert.equal((await json(target, '/health')).services, ids.length);
      for (const route of ['/manifest', '/services']) {
        assert.deepEqual((await json(target, route)).services.map((service: { id: string }) => service.id).sort(), [...ids].sort(), `${target}${route}`);
      }
    }

    const spoofedManagement = await request(remote, '/mcp/sources/mcp-private/sharing', 'PATCH', { sharing: 'network' }, { 'X-Forwarded-For': '127.0.0.1' });
    assert.equal(spoofedManagement.status, 403);
    await spoofedManagement.json();
    assert.equal(registry.get('mcp-private')!.metadata?.mcp_sharing, 'local');

    const hiddenRoutes: [string, string, unknown?][] = [
      ['/services/mcp-private', 'GET'],
      ['/services/mcp-private/methods/mcp-private.echo', 'GET'],
      ['/services/mcp-private/invoke', 'POST', { method: 'mcp-private.echo' }],
      ['/services/mcp-private/invoke', 'POST', { method: 'echo' }],
      ['/capabilities/mcp-private.echo/invoke', 'POST', {}],
      ['/services/mcp-private/embed', 'POST', {}],
      ['/services/mcp-private/start', 'POST', {}],
      ['/services/mcp-private/stop', 'POST', {}],
      ['/services/mcp-private/skills/privateGuide/archive', 'GET'],
    ];
    for (const [route, method, body] of hiddenRoutes) {
      const response = await request(remote, route, method, body, { 'X-Forwarded-For': '127.0.0.1' });
      assert.equal(response.status, 404, route);
      assert.equal(response.headers.get('etag'), null, 'a hidden source must not expose its service revision');
      const payload = await response.json();
      assert.doesNotMatch(JSON.stringify(payload), /sharing boundary message|Private source instructions|inputSchema/);
    }
    assert.deepEqual(fixture.methods, connectionRequests, 'hidden source requests must not reach the MCP upstream');

    const options = { agentUrl: remote, embeddingUrl: '' };
    const search = toolData(await callDreammateTool('dreammate_search_tools', { query: 'Echo a sharing boundary message', node: 'localhost' }, options));
    assert.ok(search.results.some((entry: { service_id: string }) => entry.service_id === 'mcp-shared'));
    assert.ok(search.results.every((entry: { service_id: string }) => entry.service_id !== 'mcp-private'));
    const hiddenInspect = await callDreammateTool('dreammate_inspect', { service_id: 'mcp-private', method: 'mcp-private.echo' }, options);
    assert.equal(hiddenInspect.isError, true);
    const hiddenInvoke = await callDreammateTool('dreammate_invoke', { service_id: 'mcp-private', method: 'mcp-private.echo' }, options);
    assert.equal(hiddenInvoke.isError, true);
    assert.equal(toolData(hiddenInvoke).http_status, 404);
    assert.deepEqual(fixture.methods, connectionRequests);

    const sharedInspect = await callDreammateTool('dreammate_inspect', { service_id: 'mcp-shared', method: 'mcp-shared.echo' }, options);
    assert.equal(sharedInspect.isError, undefined);
    assert.deepEqual(toolData(sharedInspect).details.parameters, tool.inputSchema);
    const sharedInvoke = await callDreammateTool('dreammate_invoke', { service_id: 'mcp-shared', method: 'mcp-shared.echo', params: { message: 'network is the default' } }, options);
    assert.equal(sharedInvoke.isError, undefined);
    assert.deepEqual(sharedInvoke.structuredContent, { received: { message: 'network is the default' } });
    const ordinary = await request(remote, '/services/ordinary/invoke', 'POST', { method: 'ordinary.echo' });
    assert.equal(ordinary.status, 200);
    assert.deepEqual(await ordinary.json(), { ordinary: true });
    assert.equal(fixture.ordinaryCalls.length, 1, 'ordinary localhost services retain their existing gateway behavior');

    for (const route of ['/services/mcp-private', '/services/mcp-private/methods/mcp-private.echo']) {
      const response = await request(base, route, 'GET', undefined, { 'X-Forwarded-For': address });
      assert.equal(response.status, 200, 'loopback visibility depends on the socket rather than forwarded headers');
      await response.json();
    }
  }, '0.0.0.0'));
});

test('MCP sharing switches local → network → local immediately and rejects previously discovered remote calls', { timeout: 20000 }, async t => {
  const address = Object.values(networkInterfaces()).flat().find(entry => entry && !entry.internal && entry.family === 'IPv4')?.address;
  if (!address) { t.skip('No non-loopback IPv4 interface is available'); return; }
  await withFixture(async fixture => withAgent(async ({ base, mcpSources }) => {
    await importSources(base, fixture.url);
    const remote = base.replace('127.0.0.1', address);
    const discoveryRequests = fixture.methods.filter(method => method === 'initialize' || method === 'tools/list');

    const publish = await request(base, '/mcp/sources/mcp-private/sharing', 'PATCH', { sharing: 'network' });
    assert.equal(publish.status, 200);
    assert.equal((await publish.json() as { sharing: string }).sharing, 'network');
    assert.ok((await json(remote, '/services')).services.some((service: { id: string }) => service.id === 'mcp-private'));
    assert.equal((await json(remote, '/health')).services, 2);
    const discovered = await json(remote, '/services/mcp-private/methods/mcp-private.echo');
    assert.deepEqual(discovered.details.parameters, tool.inputSchema);
    const byCapability = await request(remote, '/capabilities/mcp-private.echo/invoke', 'POST', { params: { message: 'temporarily shared' } });
    assert.equal(byCapability.status, 200);
    await byCapability.json();
    assert.equal(fixture.calls.length, 1);

    await mcpSources.setSharing('mcp-private', 'local');
    assert.equal((await json(remote, '/health')).services, 1);
    assert.ok((await json(remote, '/manifest')).services.every((service: { id: string }) => service.id !== 'mcp-private'));
    for (const route of ['/services/mcp-private/invoke', '/capabilities/mcp-private.echo/invoke']) {
      const stale = await request(remote, route, 'POST', { method: 'mcp-private.echo', params: { message: 'cached remote reference' } });
      assert.equal(stale.status, 404, route);
      await stale.json();
    }
    const cachedInvoke = await callDreammateTool('dreammate_invoke', { service_id: 'mcp-private', method: 'mcp-private.echo' }, { agentUrl: remote, embeddingUrl: '' });
    assert.equal(cachedInvoke.isError, true);
    assert.equal(toolData(cachedInvoke).http_status, 404);
    assert.equal(fixture.calls.length, 1, 'a remote caller cannot keep using a tool after sharing is revoked');
    assert.deepEqual(fixture.methods.filter(method => method === 'initialize' || method === 'tools/list'), discoveryRequests,
      'both HTTP and direct manager sharing changes must preserve the upstream connection');

    const localInvoke = await request(base, '/services/mcp-private/invoke', 'POST', { method: 'mcp-private.echo' });
    assert.equal(localInvoke.status, 200);
    await localInvoke.json();
    assert.equal(fixture.calls.length, 2);
  }, '0.0.0.0'));
});

test('MCP sharing revocation also blocks remote invocations already reading their request body', { timeout: 20000 }, async t => {
  const address = Object.values(networkInterfaces()).flat().find(entry => entry && !entry.internal && entry.family === 'IPv4')?.address;
  if (!address) { t.skip('No non-loopback IPv4 interface is available'); return; }
  await withFixture(async fixture => withAgent(async ({ base, server, mcpSources }) => {
    await importSources(base, fixture.url);
    const remote = base.replace('127.0.0.1', address);
    for (const route of ['/services/mcp-private/invoke', '/capabilities/mcp-private.echo/invoke']) {
      await mcpSources.setSharing('mcp-private', 'network');
      const raw = JSON.stringify({ method: 'mcp-private.echo', params: { message: 'revoked while uploading' } });
      const readingBody = new Promise<void>(resolve => {
        server.once('request', incoming => {
          const onListener = (event: string | symbol) => {
            if (event === 'data') {
              incoming.off('newListener', onListener);
              resolve();
            }
          };
          incoming.on('newListener', onListener);
        });
      });
      let pending!: ClientRequest;
      const finished = new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        pending = httpRequest(`${remote}${route}`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) },
        }, response => {
          let text = '';
          response.on('data', chunk => { text += String(chunk); });
          response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(text) }));
          response.on('error', reject);
        });
        pending.on('error', reject);
        pending.write(raw.slice(0, 1));
      });
      try {
        await readingBody;
        await mcpSources.setSharing('mcp-private', 'local');
        pending.end(raw.slice(1));
        assert.equal((await finished).status, 404, route);
      } finally {
        pending.destroy();
      }
    }
    assert.deepEqual(fixture.calls, [], 'revocation must be checked immediately before dispatch to the upstream');
  }, '0.0.0.0'));
});

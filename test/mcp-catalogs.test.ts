import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createAgent } from '../src/server.js';
import { ServiceRegistry } from '../src/registry.js';
import { callDreammateTool } from '../src/mcp.js';
import { CatalogError, catalogData, detectCatalogAdapters } from '../src/mcp-catalogs.js';
import { CallToolResultSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const fixture = fileURLToPath(new URL('./fixtures/mcp-catalog-server.mjs', import.meta.url));
async function withCatalog(mode: string, body: (ctx: { base: string; manager: ReturnType<typeof createAgent>['mcpSources']; registry: ServiceRegistry }) => Promise<void>) {
  const registry = new ServiceRegistry({ storagePath: false });
  const { server, mcpSources: manager } = createAgent({ registry, mcpSources: { storagePath: false, timeoutMs: 3000 } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const result = await manager.import({ command: process.execPath, args: [fixture, mode] }, 'fixture');
    assert.equal(result.sources[0]!.status, 'connected');
    assert.equal(result.sources[0]!.catalog!.status, 'ready');
    await body({ base, manager, registry });
  } finally { await manager.stop(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
const data = (result: Awaited<ReturnType<typeof callDreammateTool>>) => result.structuredContent ?? JSON.parse((result.content[0] as { text: string }).text);

async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Condition did not become true');
}

test('generic catalog auto-discovers pages, lazily describes schemas, validates and routes same-name actions', async () => {
  await withCatalog('generic', async ({ base, manager, registry }) => {
    const options = { agentUrl: base, embeddingUrl: '' };
    const search = data(await callDreammateTool('dreammate_search_tools', { node: 'localhost', query: 'GitHub list repositories' }, options));
    const method = (search.results as { method: string; toolset?: string }[]).find(r => r.toolset === 'github')!.method;
    assert.match(method, /^mcp-fixture\.actions\.github\./);
    assert.equal((registry.get('mcp-fixture')!.methods![method] as { parameters?: unknown }).parameters, undefined);
    const stats = () => manager.invoke('mcp-fixture', { method: 'fixture_stats' }).then(r => (r.data as { structuredContent: { calls: { name: string }[] } }).structuredContent.calls);
    assert.equal((await stats()).filter(c => c.name === 'catalog_describe').length, 0);
    const [inspected, again] = await Promise.all([1, 2].map(() => callDreammateTool('dreammate_inspect', { service_id: 'mcp-fixture', method: 'github.list' }, options)));
    assert.equal(data(inspected).method, method);
    assert.equal(data(inspected).schema_loaded, true);
    assert.equal(data(again).details.parameters.properties.message.type, 'string');
    assert.equal((await stats()).filter(c => c.name === 'catalog_describe').length, 1);
    assert.equal(registry.get('mcp-fixture')!.methods![method]!.parameters, undefined, 'directory never embeds child schemas');
    const response = await callDreammateTool('dreammate_invoke', { service_id: 'mcp-fixture', method, params: { message: 'hello' } }, options);
    assert.deepEqual(response.structuredContent, { group: 'github', action: 'list', params: { message: 'hello' } });
    assert.equal(response._meta?.upstream, 'catalog-fixture');
    assert.equal((await manager.invoke('mcp-fixture', { method, params: { message: 12 } })).status, 400);
    assert.equal((await manager.invoke('mcp-fixture', { method: 'list', params: {} })).status, 409);
    assert.equal((await manager.invoke('mcp-fixture', { method: 'gitlab.list', params: { message: 12 } })).status, 200, 'same schema $id across toolsets is isolated');
    for (const name of ['foo/bar', 'foo bar', 'foo_bar', '工具 名称']) {
      const result = await manager.invoke('mcp-fixture', { method: `mcp-fixture.${name}`, params: {} });
      assert.equal(result.status, 200);
      assert.equal((result.data as { structuredContent: { tool: string } }).structuredContent.tool, name);
    }
    const before = Object.keys(registry.get('mcp-fixture')!.methods!);
    await manager.refresh('mcp-fixture');
    assert.deepEqual(Object.keys(registry.get('mcp-fixture')!.methods!), before);
    await manager.invoke('mcp-fixture', { method: 'fixture_update', params: { renamed: true } });
    await manager.refresh('mcp-fixture');
    assert.equal((await manager.invoke('mcp-fixture', { method, params: { message: 'stale' } })).status, 404);
    assert.equal((await manager.invoke('mcp-fixture', { method: 'github.lookup', params: { message: 'new' } })).status, 200);
    await manager.remove('mcp-fixture');
    assert.equal(registry.get('mcp-fixture'), undefined);
  });
});

test('a resident MCP connection reloads legacy inspect handlers and fetches only the selected schema', async () => {
  await withCatalog('generic', async ({ base, manager }) => {
    const client = new Client({ name: 'reload-test', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', 'tsx', fileURLToPath(new URL('./fixtures/mcp-reload-server.mjs', import.meta.url)), base], stderr: 'pipe' });
    transport.stderr?.on('data', () => {});
    try {
      await client.connect(transport);
      const inspect = async () => CallToolResultSchema.parse(await client.callTool({ name: 'dreammate_inspect', arguments: { service_id: 'mcp-fixture', method: 'github.list' } }));
      assert.equal(data(await inspect()).legacy, true);
      const inFlight = client.callTool({ name: 'dreammate_inspect', arguments: { delay_ms: 250 } });
      await client.ping();
      const pid = transport.pid!;
      process.kill(pid, 'SIGHUP');
      await until(async () => data(await inspect()).schema_loaded === true);
      const result = data(await inspect());
      assert.equal(result.details.parameters.properties.message.type, 'string');
      assert.equal(result.requested_method, 'github.list');
      assert.equal(transport.pid, pid, 'the client connection and process survive reload');
      assert.equal(data(CallToolResultSchema.parse(await inFlight)).legacy, true, 'requests already running complete with their original handler');
      await client.ping();
      const directory = data(CallToolResultSchema.parse(await client.callTool({ name: 'dreammate_inspect', arguments: { service_id: 'mcp-fixture' } })));
      assert.equal(directory.schema_loaded, false);
      assert.ok(Object.values(directory.methods).every(value => !(value as { parameters?: unknown }).parameters));
      const stats = await manager.invoke('mcp-fixture', { method: 'fixture_stats' });
      assert.equal((stats.data as { structuredContent: { calls: { name: string }[] } }).structuredContent.calls.filter(c => c.name === 'catalog_describe').length, 1);
    } finally { await client.close(); }
  });
});

test('catalog notifications refresh actions and an in-flight old schema cannot execute after refresh', async () => {
  await withCatalog('generic', async ({ manager }) => {
    await manager.invoke('mcp-fixture', { method: 'fixture_update', params: { describe_delay_ms: 150 } });
    const invoking = manager.invoke('mcp-fixture', { method: 'github.list', params: { message: 'old' } });
    await until(async () => {
      const stats = await manager.invoke('mcp-fixture', { method: 'fixture_stats' });
      return (stats.data as { structuredContent: { calls: { name: string }[] } }).structuredContent.calls.some(c => c.name === 'catalog_describe');
    });
    await manager.invoke('mcp-fixture', { method: 'fixture_update', params: { renamed: true, notify: true, list_delay_ms: 30 } });
    await manager.refresh('mcp-fixture');
    assert.equal((await invoking).status, 409);
    assert.equal(manager.list()[0]!.catalog!.status, 'ready');
    const stats = await manager.invoke('mcp-fixture', { method: 'fixture_stats' });
    assert.equal((stats.data as { structuredContent: { calls: { name: string }[] } }).structuredContent.calls.filter(c => c.name === 'catalog_invoke').length, 0);
    assert.equal((await manager.invoke('mcp-fixture', { method: 'github.lookup', params: { message: 'new' } })).status, 200);
  });
});

test('declared catalogs require advertised tools and bounded complete structured data', async () => {
  const make = (name: string, extra = {}): Tool => ({ name, inputSchema: { type: 'object' }, ...extra });
  const advertised = make('list', { _meta: { 'dreammate/catalog': { version: 1, list: 'list', describe: 'describe', invoke: 'invoke' } } });
  assert.deepEqual(detectCatalogAdapters(new Map([['list', advertised]])), [], 'ordinary names never trigger guessed business calls');
  const [adapter] = detectCatalogAdapters(new Map([advertised, make('describe'), make('invoke')].map(t => [t.name, t])));
  let pages = 0;
  await assert.rejects(adapter!.discover(async () => {
    pages++;
    return { content: [], structuredContent: { tools: [], nextCursor: 'repeated' } };
  }), (error: unknown) => error instanceof CatalogError && error.status === 502);
  assert.equal(pages, 2);
  assert.throws(() => catalogData({ content: [], structuredContent: { private: 'x'.repeat(2_000_001) } }), CatalogError);
  assert.deepEqual(catalogData({ content: [{ type: 'text', text: 'Schema:\n{"nested":{"brace":"} \\\""}}\n\nExample:\n{}' }] }), { nested: { brace: '} "' } });
});

test('Activepieces is recognized automatically; toolsets and connection selection cannot collide', async () => {
  await withCatalog('activepieces', async ({ manager, registry }) => {
    assert.equal(manager.list()[0]!.action_count, 4);
    const methods = Object.keys(registry.get('mcp-fixture')!.methods!).filter(m => m.includes('.actions.'));
    assert.equal(new Set(methods).size, 4);
    const description = await manager.describe('mcp-fixture', 'github.list_my_repositories');
    const parameters = description.details.parameters as Record<string, any>;
    assert.deepEqual(parameters.properties.input.properties.visibility.enum, ['all', 'private']);
    assert.deepEqual(parameters.properties.input.properties.url.required, ['url']);
    assert.equal(parameters.properties.input.properties.labels.type, 'array');
    assert.deepEqual(parameters.properties.input.properties.labels.items.enum, ['bug', 'feature']);
    assert.equal(parameters.properties.input.properties.unresolved.enum, undefined);
    assert.equal(parameters.properties.input.properties.unresolved['x-activepieces-note'], 'Resolve options with known input');
    const result = await manager.invoke('mcp-fixture', { method: description.method, params: { input: { visibility: 'all' } } });
    assert.deepEqual((result.data as { structuredContent: unknown }).structuredContent, { piece: '@activepieces/piece-github', action: 'list_my_repositories', connection: 'github-one', input: { visibility: 'all' } });
    assert.equal((await manager.invoke('mcp-fixture', { method: 'list_my_repositories', params: { input: {} } })).status, 409);
    assert.equal((await manager.invoke('mcp-fixture', { method: description.method, params: { input: { visibility: 'invalid' } } })).status, 400);
    assert.equal((await manager.invoke('mcp-fixture', { method: description.method, params: { input: { url: {} } } })).status, 400);
    assert.equal((await manager.invoke('mcp-fixture', { method: description.method, params: { input: { labels: ['other'] } } })).status, 400);
    assert.equal((await manager.invoke('mcp-fixture', { method: description.method, params: { input: { url: { url: '/user/repos' }, labels: ['bug'], body: [1, 2], unresolved: 'resolved-id' } } })).status, 200);
    await manager.invoke('mcp-fixture', { method: 'fixture_update', params: { multiple: true } });
    await manager.refresh('mcp-fixture');
    assert.equal((await manager.describe('mcp-fixture', 'github.list_my_repositories')).method, description.method);
    assert.equal((await manager.invoke('mcp-fixture', { method: description.method, params: { input: {} } })).status, 400);
    const chosen = await manager.invoke('mcp-fixture', { method: description.method, params: { input: {}, connection_id: 'github-two' } });
    assert.equal((chosen.data as { structuredContent: { connection: string } }).structuredContent.connection, 'github-two');
    await manager.invoke('mcp-fixture', { method: 'fixture_update', params: { broken: true } });
    await manager.refresh('mcp-fixture');
    assert.equal(manager.list()[0]!.status, 'connected');
    assert.equal(manager.list()[0]!.catalog!.status, 'error');
    assert.equal((await manager.invoke('mcp-fixture', { method: 'echo', params: {} })).status, 200);
    assert.equal((await manager.invoke('mcp-fixture', { method: description.method, params: { input: {} } })).status, 404);
    await manager.invoke('mcp-fixture', { method: 'fixture_update', params: { broken: false } });
    await manager.refresh('mcp-fixture');
    assert.equal(manager.list()[0]!.catalog!.status, 'ready');
    assert.ok(registry.get('mcp-fixture')!.methods![description.method]);
  });
});

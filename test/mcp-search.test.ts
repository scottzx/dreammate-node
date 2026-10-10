import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { callDreammateTool, MCP_TOOLS } from '../src/mcp.js';
import type { RegisteredService } from '../src/registry.js';
import type { NodeDirectory } from '../src/node-directory.js';

const options = { agentUrl: 'http://local.test:36908', embeddingUrl: '' };
const jsonResponse = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json' },
});
const dataOf = (result: Awaited<ReturnType<typeof callDreammateTool>>) => {
  return (result.structuredContent ?? JSON.parse((result.content[0] as { text: string }).text)) as Record<string, any>;
};
const service = (id: string, methods: RegisteredService['methods'] = {}): RegisteredService => ({
  id, name: id, methods, registeredAt: '2026-10-10T00:00:00Z', liveness: 'unknown', failures: 0,
});
const schema = { type: 'object', properties: { secretSchemaNeedle: { type: 'string' } } };

function fixture(t: TestContext, services: RegisteredService[]) {
  return t.mock.method(globalThis, 'fetch', (url: string) => Promise.resolve(String(url).endsWith('/nodes')
    ? jsonResponse({ nodes: [{ name: 'local', node_id: 'local', is_self: true, online: true, network_online: true }] })
    : jsonResponse({ node: 'local', services })));
}

test('method search is the primary discovery entry and requires an explicit query', () => {
  const search = MCP_TOOLS.find(tool => tool.name === 'dreammate_search_tools');
  assert.ok(search);
  assert.deepEqual(search.inputSchema.required, ['query']);
  assert.ok(MCP_TOOLS.indexOf(search) < MCP_TOOLS.findIndex(tool => tool.name === 'dreammate_list_services'));
  assert.equal((search.inputSchema.properties?.node as { default?: string })?.default, 'all');
  assert.equal((search.inputSchema.properties?.limit as { default?: number })?.default, 15);
  assert.equal((search.inputSchema.properties?.max_chars as { default?: number })?.default, 12000);
});

test('method search defaults to all discovered nodes and 15 results, while localhost stays explicit', async t => {
  const requests: string[] = [];
  const methods = (prefix: string) => Object.fromEntries(Array.from({ length: 10 }, (_, i) => [
    `${prefix}.lookup${i}`, { description: '查询工具' },
  ]));
  t.mock.method(globalThis, 'fetch', (rawUrl: string) => {
    const url = String(rawUrl);
    requests.push(url);
    if (url.endsWith('/nodes')) return Promise.resolve(jsonResponse({ nodes: [
      { name: 'local', node_id: 'local', is_self: true, online: true, network_online: true },
      { name: 'remote', node_id: 'remote', ipv4: '100.64.0.2', is_self: false, online: true },
    ] }));
    return Promise.resolve(url.includes('100.64.0.2')
      ? jsonResponse({ node: 'remote', services: [service('remote-svc', methods('remote'))] })
      : jsonResponse({ node: 'local', services: [service('local-svc', methods('local'))] }));
  });
  const network = dataOf(await callDreammateTool('dreammate_search_tools', { query: '查询工具' }, options));
  assert.equal(network.scope, 'all');
  assert.equal(network.partial, false);
  assert.equal(network.limit, 15);
  assert.equal(network.max_chars, 12000);
  assert.equal(network.returned, 15);
  assert.equal(network.total_matched, 20);
  assert.deepEqual(new Set(network.results.map((card: any) => card.node)), new Set(['local', 'remote']));
  assert.equal(network.scan_count, 2);
  assert.ok(requests.includes('http://100.64.0.2:36908/services'));
  requests.length = 0;
  const local = dataOf(await callDreammateTool('dreammate_search_tools', { query: '查询工具', node: 'localhost' }, options));
  assert.equal(local.scope, 'localhost');
  assert.equal(local.total_matched, 10);
  assert.ok(local.results.every((card: any) => card.node === 'local'));
  assert.deepEqual(requests, ['http://local.test:36908/services']);
});

test('default cross-node search scans every imported directory entry without live topology requests', async t => {
  const nodeDirectory: NodeDirectory = {
    format: 'dreammate.nodes', version: 1, exported_at: '2026-10-10T00:00:00Z', default_node: 'first',
    nodes: [
      { node_id: 'first', name: 'first', type: 'macos', agent_url: 'http://100.64.0.4:36908' },
      { node_id: 'second', name: 'second', type: 'linux', agent_url: 'http://100.64.0.5:36908' },
    ],
  };
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', (rawUrl: string) => {
    const url = String(rawUrl);
    requests.push(url);
    assert.ok(url.endsWith('/services'), 'imported mode must not request live topology');
    const name = url.includes('100.64.0.4') ? 'first' : 'second';
    return Promise.resolve(jsonResponse({ node: name, services: [service(`${name}-svc`, {
      [`${name}.lookup`]: { description: '查询工具' },
    })] }));
  });
  const data = dataOf(await callDreammateTool('dreammate_search_tools', { query: '查询工具' }, { ...options, nodeDirectory }));
  assert.equal(data.scope, 'all');
  assert.equal(data.discovery.status, 'cached');
  assert.equal(data.discovery.scope, 'imported_nodes_only');
  assert.equal(data.total_matched, 2);
  assert.deepEqual(requests.sort(), ['http://100.64.0.4:36908/services', 'http://100.64.0.5:36908/services']);
});

test('empty queries fail before any discovery request', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected discovery'); });
  for (const query of [undefined, '', ' \n\t ', 42]) {
    const result = await callDreammateTool('dreammate_search_tools', { query, node: 'all' }, options);
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(dataOf(result)), /非空/);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('oversized queries and invalid page options fail before discovery', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected discovery'); });
  for (const args of [
    { query: '音频'.repeat(1001) }, { query: '音频', limit: 21 },
    { query: '音频', offset: -1 }, { query: '音频', max_chars: 999 },
  ]) {
    const result = await callDreammateTool('dreammate_search_tools', args, options);
    assert.equal(result.isError, true);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('search returns matching methods with filters and never leaks schemas', async t => {
  fixture(t, [
    { ...service('audio', {
      'audio.transcribe': { description: '转写音频，生成字幕', parameters: schema },
      'audio.delete': { description: '删除文件', parameters: schema },
    }), kind: 'generic' },
    service('other', { 'other.transcribe': { description: '转写音频', parameters: schema } }),
    { ...service('disabled', { transcribe: { description: '转写音频', parameters: schema } }), metadata: { enabled: false } },
  ]);
  const result = await callDreammateTool('dreammate_search_tools', {
    query: '转写音频', service_id: 'audio', kind: 'generic', limit: 2,
  }, options);
  const data = dataOf(result);
  assert.equal(result.isError, undefined);
  assert.equal(data.results.length, 1);
  assert.equal(data.results[0].method, 'audio.transcribe');
  assert.equal(data.results[0].service_id, 'audio');
  assert.doesNotMatch(JSON.stringify(data), /secretSchemaNeedle|"parameters"/);
  assert.equal(data.partial, false);
});

test('service keyword matching includes method descriptions and returns only matching names', async t => {
  fixture(t, [service('multitool', {
    'alpha.first': { description: '转写音频并生成字幕', parameters: schema },
    'alpha.second': { description: '转写音频并翻译', parameters: schema },
    'alpha.third': { description: '管理项目和任务', parameters: schema },
  })]);
  for (const tool of ['dreammate_list_services', 'dreammate_list_capabilities']) {
    const data = dataOf(await callDreammateTool(tool, { keyword: '转写音频' }, options));
    assert.equal(data.total_matched, 1);
    assert.deepEqual(data.services[0].methods, ['alpha.first', 'alpha.second']);
    assert.doesNotMatch(JSON.stringify(data), /alpha.third|secretSchemaNeedle|"parameters"/);
  }
});

test('service browsing is bounded without a keyword and pagination does not repeat services', async t => {
  const methods = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [
    `method.${i}`, { description: '工具方法摘要', parameters: schema },
  ]));
  fixture(t, Array.from({ length: 23 }, (_, i) => service(`service-${i}`, methods)));
  const first = dataOf(await callDreammateTool('dreammate_list_services', {}, options));
  assert.equal(first.total_matched, 23);
  assert.equal(first.max_chars, 6000);
  assert.ok(first.services.length > 0 && first.services.length <= 10);
  assert.equal(first.has_more, true);
  assert.ok(first.services.every((s: any) => s.methods.length <= 6 && s.methods_omitted === 24));
  const next = dataOf(await callDreammateTool('dreammate_list_services', { offset: first.next_offset }, options));
  assert.ok(next.services.every((s: any) => !first.services.some((prior: any) => prior.service_id === s.service_id)));
  assert.doesNotMatch(JSON.stringify(next), /secretSchemaNeedle|"parameters"/);
});

test('inspect without method only returns a paged description directory; exact inspect loads one schema', async t => {
  const methods = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [
    `method.${i}`, { description: `工具用途 ${i}`, parameters: schema },
  ]));
  const registered = service('large', methods);
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(jsonResponse(registered)));
  const first = dataOf(await callDreammateTool('dreammate_inspect', { service_id: 'large' }, options));
  assert.equal(first.total_matched, 24);
  assert.equal(first.max_chars, 6000);
  assert.equal(first.returned, 10);
  assert.equal(first.schema_loaded, false);
  assert.equal(first.methods['method.0'].description, '工具用途 0');
  assert.doesNotMatch(JSON.stringify(first), /secretSchemaNeedle|"parameters"/);
  const second = dataOf(await callDreammateTool('dreammate_inspect', {
    service_id: 'large', offset: first.next_offset, limit: 4,
  }, options));
  assert.deepEqual(Object.keys(second.methods), ['method.10', 'method.11', 'method.12', 'method.13']);
  const exact = dataOf(await callDreammateTool('dreammate_inspect', { service_id: 'large', method: 'method.10' }, options));
  assert.deepEqual(exact.details.parameters, schema);
  assert.equal(exact.method, 'method.10');
});

test('method search preserves mesh failure evidence even when no tools match', async t => {
  t.mock.method(globalThis, 'fetch', (url: string) => {
    if (String(url).endsWith('/nodes')) return Promise.resolve(jsonResponse({ nodes: [
      { name: 'up', node_id: 'up', ipv4: '100.64.0.2', is_self: false, online: true },
      { name: 'down', node_id: 'down', ipv4: '100.64.0.3', is_self: false, online: true },
    ] }));
    return Promise.resolve(String(url).includes('100.64.0.2')
      ? jsonResponse({ services: [service('project', { search: { description: '查询项目' } })] })
      : jsonResponse({ error: 'failed' }, 503));
  });
  const result = await callDreammateTool('dreammate_search_tools', { query: '音频转写', node: 'all' }, options);
  const data = dataOf(result);
  assert.equal(result.isError, undefined);
  assert.equal(data.partial, true);
  assert.equal(data.results.length, 0);
  assert.deepEqual(data.scans.map((scan: any) => scan.status), ['ok', 'http_error']);
  assert.equal(data.scan_status_counts.http_error, 1);
  assert.equal(data.scans[0].url, 'http://100.64.0.2:36908');
  assert.ok(data.scans[0].checked_at);
});

test('response character budget includes discovery diagnostics and service descriptions', async t => {
  fixture(t, Array.from({ length: 20 }, (_, i) => service(`svc-${i}`, {
    [`audio.transcribe.${i}`]: { description: '转写音频'.repeat(300), parameters: schema },
  })));
  for (const tool of ['dreammate_list_services', 'dreammate_search_tools']) {
    const result = await callDreammateTool(tool, { query: '转写音频', max_chars: 1400, limit: 20 }, options);
    assert.equal(result.isError, undefined);
    const text = (result.content[0] as { text: string }).text;
    assert.ok(text.length <= 1400, `${tool} exceeded its budget: ${text.length}`);
    const data = dataOf(result);
    assert.ok(data.has_more || data.omitted_oversized > 0);
    assert.doesNotMatch(text, /secretSchemaNeedle|"parameters"/);
  }
});

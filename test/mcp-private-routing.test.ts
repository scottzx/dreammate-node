import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { callDreammateTool, MCP_TOOLS, type McpOptions } from '../src/mcp.js';
import type { PrivateMcpSources } from '../src/mcp-client-sources.js';
import type { RegisteredService } from '../src/registry.js';

const serviceId = 'mcp-erp';
const method = 'mcp-erp.erp_list';
const schema = { type: 'object', properties: { doctype: { type: 'string' } }, required: ['doctype'] };
const json = (value: unknown) => JSON.stringify(value);
const dataOf = (result: Awaited<ReturnType<typeof callDreammateTool>>) => {
  if (result.structuredContent) return result.structuredContent as Record<string, any>;
  const content = result.content[0];
  assert.equal(content?.type, 'text');
  return JSON.parse((content as { text: string }).text) as Record<string, any>;
};
const service = (): RegisteredService => ({
  id: serviceId, name: 'ERP projects', kind: 'generic',
  methods: { [method]: { description: 'List ERP projects' } },
  registeredAt: '2026-10-17T00:00:00Z', liveness: 'up', failures: 0,
  metadata: { mcp_source: serviceId },
});

function privateSources(identity = 'site-readonly') {
  const registered = service();
  const calls: { operation: string; id: string; payload?: unknown }[] = [];
  const sources: PrivateMcpSources = {
    list: () => [registered],
    get: id => id === registered.id ? registered : undefined,
    describe: async (id, requested) => {
      calls.push({ operation: 'describe', id, payload: requested });
      if (id !== registered.id || ![method, 'erp_list'].includes(requested)) throw new Error('Unknown private method');
      return { method, details: { description: 'List ERP projects', parameters: schema, schema_loaded: true } };
    },
    invoke: async (id, payload) => {
      calls.push({ operation: 'invoke', id, payload });
      const input = payload as Record<string, unknown>;
      if (id !== registered.id || ![method, 'erp_list'].includes(String(input.method))) {
        return { status: 403, data: { error: 'Private identity does not permit this method' } };
      }
      const result = { origin: 'private', identity, params: input.params };
      return { status: 200, data: { content: [{ type: 'text', text: json(result) }], structuredContent: result } };
    },
    stop: async () => {},
  };
  return { sources, calls };
}

async function gateway(t: TestContext, catalogNode = 'local', topologyNode = 'local') {
  const requests: { method: string; url: string; body: string; authorization: string | undefined }[] = [];
  const registered = service();
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method ?? 'GET', url: req.url ?? '', body, authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/nodes') {
      res.end(json({ nodes: [{ name: topologyNode, node_id: 'local', is_self: true, online: true, network_online: true }] }));
    } else if (req.url === '/services') {
      res.end(json({ node: catalogNode, services: [registered] }));
    } else if (req.url === `/services/${serviceId}`) {
      res.end(json(registered));
    } else if (req.url?.startsWith(`/services/${serviceId}/methods/`)) {
      res.end(json({ method, details: { description: 'Shared ERP projects', parameters: schema, schema_loaded: true } }));
    } else if (req.url === `/services/${serviceId}/invoke`) {
      res.end(json({ origin: 'shared', params: JSON.parse(body).params }));
    } else {
      res.statusCode = 404;
      res.end(json({ error: 'Unexpected gateway route' }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const agentUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fetch = globalThis.fetch;
  const unexpectedRequests: string[] = [];
  t.mock.method(globalThis, 'fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).origin !== agentUrl) {
      unexpectedRequests.push(url);
      throw new Error('Unexpected network request outside test gateway');
    }
    return fetch(input, init);
  });
  return { options: { agentUrl, embeddingUrl: '' }, requests, unexpectedRequests };
}

test('private MCP search, inspect and invoke use @client without gateway registration or requests', async t => {
  const network = await gateway(t);
  const local = privateSources();
  const options: McpOptions = { ...network.options, privateMcpSources: local.sources };
  const search = await callDreammateTool('dreammate_search_tools', { node: '@client', query: 'List ERP projects' }, options);
  assert.notEqual(search.isError, true);
  const found = dataOf(search);
  assert.equal(found.total_matched, 1);
  const selected = found.results[0];
  assert.equal(selected.node, '@client');
  assert.equal(selected.service_id, serviceId);
  assert.equal(selected.method, method);
  assert.doesNotMatch(json(found), /"parameters"|Authorization|Bearer|token_file/);

  const inspect = await callDreammateTool('dreammate_inspect', {
    node: selected.node, service_id: selected.service_id, method: 'erp_list',
  }, options);
  assert.notEqual(inspect.isError, true);
  const contract = dataOf(inspect);
  assert.equal(contract.method, method);
  assert.equal(contract.schema_loaded, true);
  assert.deepEqual(contract.details.parameters, schema);

  const params = { doctype: 'Project' };
  const invoke = await callDreammateTool('dreammate_invoke', {
    node: selected.node, service_id: selected.service_id, method: contract.method, params,
  }, options);
  assert.notEqual(invoke.isError, true);
  assert.deepEqual(dataOf(invoke), { origin: 'private', identity: 'site-readonly', params });
  assert.equal(invoke._meta?.dreammate && (invoke._meta.dreammate as { node?: string }).node, '@client');
  assert.deepEqual(local.calls.map(call => call.operation), ['describe', 'invoke']);
  assert.deepEqual(network.requests, []);
  assert.deepEqual(network.unexpectedRequests, []);
});

test('default and all discovery merge private services with shared services under distinct nodes', async t => {
  const network = await gateway(t);
  const options: McpOptions = { ...network.options, privateMcpSources: privateSources().sources };
  for (const name of ['dreammate_list_services', 'dreammate_list_capabilities', 'dreammate_search_tools']) {
    for (const node of [undefined, 'all']) {
      const result = await callDreammateTool(name, { ...(node ? { node } : {}), query: 'List ERP projects' }, options);
      assert.notEqual(result.isError, true);
      const data = dataOf(result);
      const records = name === 'dreammate_search_tools' ? data.results : data.services;
      assert.equal(records.length, 2, `${name} ${node ?? 'default'} must keep both matching service IDs`);
      assert.deepEqual(new Set(records.map((record: { node: string }) => record.node)), new Set(['local', '@client']));
    }
  }
  assert.ok(network.requests.length > 0);
  assert.ok(network.requests.every(request => request.method === 'GET'));
  assert.ok(network.requests.every(request => request.url === '/nodes' || request.url === '/services'));
  assert.ok(network.requests.every(request => request.authorization === undefined && request.body === ''));
  assert.deepEqual(network.unexpectedRequests, []);
});

test('explicit network node discovery excludes private services, including localhost', async t => {
  const network = await gateway(t);
  const options: McpOptions = { ...network.options, privateMcpSources: privateSources().sources };
  for (const name of ['dreammate_list_services', 'dreammate_list_capabilities', 'dreammate_search_tools']) {
    for (const node of ['localhost', network.options.agentUrl]) {
      const result = await callDreammateTool(name, { node, query: 'List ERP projects' }, options);
      assert.notEqual(result.isError, true);
      const data = dataOf(result);
      const records = name === 'dreammate_search_tools' ? data.results : data.services;
      assert.equal(records.length, 1);
      assert.ok(records.every((record: { node: string }) => record.node !== '@client'));
    }
  }
  assert.deepEqual(network.unexpectedRequests, []);
});

test('shared HTTP catalogs cannot impersonate the reserved @client node', async t => {
  const network = await gateway(t, '@client');
  const options: McpOptions = { ...network.options, privateMcpSources: privateSources().sources };
  const result = await callDreammateTool('dreammate_search_tools', { query: 'List ERP projects' }, options);
  assert.notEqual(result.isError, true);
  const data = dataOf(result);
  assert.equal(data.results.length, 2);
  assert.equal(data.results.filter((record: { node: string }) => record.node === '@client').length, 1);
  assert.equal(data.results.filter((record: { node: string }) => record.node === 'local').length, 1);
  const explicit = await callDreammateTool('dreammate_list_services', { node: 'localhost' }, options);
  assert.notEqual(explicit.isError, true);
  assert.equal(dataOf(explicit).services.length, 1);
  assert.equal(dataOf(explicit).services[0].node, 'localhost');
  assert.deepEqual(network.unexpectedRequests, []);
});

test('private discovery remains available when the shared gateway is offline', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Shared gateway is offline'); });
  const options: McpOptions = {
    agentUrl: 'http://127.0.0.1:1', embeddingUrl: '', privateMcpSources: privateSources().sources,
  };
  for (const name of ['dreammate_search_tools', 'dreammate_list_services']) {
    const result = await callDreammateTool(name, { query: 'List ERP projects' }, options);
    assert.notEqual(result.isError, true);
    const data = dataOf(result);
    assert.equal(data.partial, true);
    const records = name === 'dreammate_search_tools' ? data.results : data.services;
    assert.equal(records.length, 1);
    assert.equal(records[0].node, '@client');
  }
});

test('a shared topology cannot use @client to impersonate private discovery', async t => {
  const network = await gateway(t, '@client', '@client');
  const result = await callDreammateTool('dreammate_search_tools', { query: 'List ERP projects' },
    { ...network.options, privateMcpSources: privateSources().sources });
  const records = dataOf(result).results;
  assert.equal(records.length, 2);
  assert.equal(records.filter((record: { node: string }) => record.node === '@client').length, 1);
  assert.equal(records.filter((record: { node: string }) => record.node === network.options.agentUrl).length, 1);
  assert.deepEqual(network.unexpectedRequests, []);
});

test('private services cannot shadow the same shared service on default inspect and invoke', async t => {
  const network = await gateway(t);
  const local = privateSources();
  const options: McpOptions = { ...network.options, privateMcpSources: local.sources };
  const inspect = await callDreammateTool('dreammate_inspect', { service_id: serviceId, method }, options);
  assert.notEqual(inspect.isError, true);
  assert.equal(dataOf(inspect).details.description, 'Shared ERP projects');
  const invoke = await callDreammateTool('dreammate_invoke', { service_id: serviceId, method, params: { doctype: 'Task' } }, options);
  assert.notEqual(invoke.isError, true);
  assert.equal(dataOf(invoke).origin, 'shared');
  assert.deepEqual(local.calls, []);
  assert.ok(network.requests.some(request => request.url === `/services/${serviceId}/invoke`));
  assert.deepEqual(network.unexpectedRequests, []);
});

test('@client fails closed for missing configurations and missing private services', async t => {
  const network = await gateway(t);
  const configurations: McpOptions[] = [
    network.options,
    { ...network.options, privateMcpSources: privateSources().sources },
  ];
  for (const options of configurations) {
    const missingId = options.privateMcpSources ? 'shared-service-only' : serviceId;
    for (const name of ['dreammate_inspect', 'dreammate_invoke']) {
      const result = await callDreammateTool(name, { node: '@client', service_id: missingId, method }, options);
      assert.equal(result.isError, true, `${name} must never fall back to a shared gateway`);
    }
  }
  for (const name of ['dreammate_search_tools', 'dreammate_list_services']) {
    const result = await callDreammateTool(name, { node: '@client', query: 'List ERP projects' }, network.options);
    assert.equal(result.isError, true);
  }
  assert.deepEqual(network.requests, []);
  assert.deepEqual(network.unexpectedRequests, []);
});

test('private upstream permission failures are returned without invoking shared services', async t => {
  const network = await gateway(t);
  const local = privateSources();
  const result = await callDreammateTool('dreammate_invoke', {
    node: '@client', service_id: serviceId, method: 'mcp-erp.erp_delete', params: { doctype: 'Project', name: 'PROJ-1' },
  }, { ...network.options, privateMcpSources: local.sources });
  assert.equal(result.isError, true);
  assert.match(json(dataOf(result)), /403|does not permit/);
  assert.deepEqual(local.calls.map(call => call.operation), ['invoke']);
  assert.deepEqual(network.requests, []);
  assert.deepEqual(network.unexpectedRequests, []);
});

test('@client cannot resolve into an HTTP node for service lifecycle or skill routes', async t => {
  const network = await gateway(t);
  const options: McpOptions = { ...network.options, privateMcpSources: privateSources().sources };
  for (const action of ['start', 'stop', 'status']) {
    const result = await callDreammateTool('dreammate_manage_service', { node: '@client', service_id: serviceId, action }, options);
    assert.equal(result.isError, true);
  }
  const download = await callDreammateTool('dreammate_download_skill', {
    node: '@client', service_id: serviceId, skill: 'erp-guide', install: false,
  }, options);
  assert.equal(download.isError, true);
  const read = await callDreammateTool('dreammate_read_skill', {
    node: '@client', skill_id: 'erp-guide', revision: 'a'.repeat(64),
  }, options);
  assert.equal(read.isError, true);
  await callDreammateTool('dreammate_search_skills', { node: '@client', query: 'ERP projects' }, options);
  assert.deepEqual(network.requests, []);
  assert.deepEqual(network.unexpectedRequests, []);
});

test('each private client keeps its selected identity and does not accept model-selected credentials', async t => {
  const network = await gateway(t);
  for (const identity of ['site-readonly', 'site-admin']) {
    const local = privateSources(identity);
    const result = await callDreammateTool('dreammate_invoke', {
      node: '@client', service_id: serviceId, method, params: { doctype: 'Project' },
      profile: identity === 'site-readonly' ? 'site-admin' : 'site-readonly',
      token: 'untrusted-model-token', token_file: '/not/a/client/token', headers: { Authorization: 'Bearer untrusted' },
    }, { ...network.options, privateMcpSources: local.sources });
    assert.notEqual(result.isError, true);
    assert.equal(dataOf(result).identity, identity);
    assert.equal(local.calls.length, 1);
    assert.doesNotMatch(json(local.calls), /untrusted|token_file|profile|Authorization/);
  }
  for (const tool of MCP_TOOLS) {
    const properties = tool.inputSchema.properties ?? {};
    for (const secretArgument of ['profile', 'client_config', 'token', 'token_file', 'headers', 'authorization']) {
      assert.equal(Object.hasOwn(properties, secretArgument), false, `${tool.name} must not expose ${secretArgument}`);
    }
  }
  assert.deepEqual(network.requests, []);
  assert.deepEqual(network.unexpectedRequests, []);
});

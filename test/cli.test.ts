import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../bin/dreammate-node.ts', import.meta.url));

async function cli(args: string[], agent = '', input?: string) {
  const home = await mkdtemp(path.join(tmpdir(), 'dreammate-cli-'));
  try {
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = execFile(process.execPath, ['--import', 'tsx', entry, 'cli', ...args], {
        env: { ...process.env, HOME: home, DREAMMATE_AGENT_URL: agent, TSX_DISABLE_CACHE: '1' },
        timeout: 10_000,
      }, (error, stdout, stderr) => {
        if (error && (error.killed || typeof error.code !== 'number')) return reject(error);
        resolve({ code: error?.code as number ?? 0, stdout, stderr });
      });
      child.stdin!.end(input);
    });
    assert.deepEqual(await readdir(home), [], 'CLI must not create identity, registry or configuration files');
    return result;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function gateway(handler: RequestListener, body: (url: string) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await body(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('CLI help and schemas work offline and exit without creating local state', async () => {
  assert.match((await cli(['--help'])).stdout, /执行一次/);
  const result = await cli(['tools']);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  const tools = JSON.parse(result.stdout).tools as { name: string; inputSchema: { required?: string[] } }[];
  assert.ok(tools.some(t => t.name === 'dreammate_invoke'));
  assert.deepEqual(tools.find(t => t.name === 'dreammate_search_tools')?.inputSchema.required, ['query']);
});

test('CLI rejects invalid arguments before sending any request', async () => {
  let requests = 0;
  await gateway((_req, res) => { requests++; res.end('{}'); }, async url => {
    for (const args of [
      ['invoke', '--service', 's'],
      ['invoke', '--service', 's', '--method', 'm', '--params', '[]'],
      ['invoke', '--service', 's', '--method', 'm', '--params', '{'],
      ['manage', '--service', 's', '--action', 'delete'],
      ['services', '--method', 'm'],
      ['services', '--agnet', url],
      ['inspect', '--service', 's', '--node', 'all'],
      ['search'],
      ['search', '--query', '   '],
      ['search', '--query', 'x'.repeat(2001)],
      ['search', '--query', 'notes', '--limit', '0'],
      ['search', '--query', 'notes', '--limit', '21'],
      ['search', '--query', 'notes', '--limit', '1.5'],
      ['search', '--query', 'notes', '--limit', '1e1'],
      ['services', '--offset', '-1'],
      ['services', '--offset', '1000001'],
      ['inspect', '--service', 's', '--max-chars', '999'],
      ['inspect', '--service', 's', '--max-chars', '12001'],
      ['inspect', '--service', 's', '--offset', 'Infinity'],
      ['toString'],
    ]) {
      const result = await cli(args, url);
      assert.equal(result.code, 2, args.join(' '));
      assert.equal(JSON.parse(result.stdout).isError, true);
      assert.ok(JSON.parse(result.stderr).error);
    }
    assert.equal(requests, 0);
  });
  assert.equal((await cli(['services'])).code, 2);
  assert.equal((await cli(['services', '--agent', 'file:///tmp'])).code, 2);
});

test('CLI searches bounded method summaries across nodes and passes filters and pagination', async () => {
  const service = { id: 'notes', kind: 'tool', description: 'Notes management', methods: {
    list: { description: 'List notes', parameters: { cursor: { type: 'string' } } },
    read: { description: 'Read notes', parameters: { secretSchemaMarker: { type: 'string' } } },
    write: { description: 'Write notes', parameters: { content: { type: 'string' } } },
  }, liveness: 'up' };
  await gateway((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/nodes') res.end(JSON.stringify({ node: 'remote', nodes: [
      { node_id: 'remote-id', name: 'remote', type: 'linux', is_self: true, online: true, network_online: true },
    ] }));
    else if (req.url === '/services') res.end(JSON.stringify({ node: 'remote', services: [service,
      { ...service, id: 'hidden', metadata: { enabled: false } },
    ] }));
    else res.end(JSON.stringify(service));
  }, async url => {
    const result = await cli(['search', '--query', ' notes ', '--node', 'all', '--service', 'notes',
      '--kind', 'tool', '--limit', '1', '--offset', '1', '--max-chars', '1500'], url);
    assert.equal(result.code, 0, result.stdout);
    const data = JSON.parse(result.stdout).structuredContent;
    assert.equal(data.results.length, 1);
    assert.ok(JSON.stringify(data, null, 2).length <= 1500);
    assert.equal(data.results[0].service_id, 'notes');
    assert.ok(['list', 'read', 'write'].includes(data.results[0].method));
    assert.ok(!result.stdout.includes('secretSchemaMarker'), 'search must not expand parameter schemas');
    const filtered = await cli(['search', '--query', 'notes', '--service', 'other'], url);
    assert.equal(filtered.code, 0, filtered.stdout);
    assert.deepEqual(JSON.parse(filtered.stdout).structuredContent.results, []);
    const hidden = await cli(['search', '--query', 'notes', '--service', 'hidden'], url);
    assert.equal(hidden.code, 0, hidden.stdout);
    assert.deepEqual(JSON.parse(hidden.stdout).structuredContent.results, []);
    const included = await cli(['search', '--query', 'notes', '--service', 'hidden', '--include-disabled'], url);
    assert.equal(included.code, 0, included.stdout);
    assert.equal(JSON.parse(included.stdout).structuredContent.results.length, 3);
  });
});

test('CLI search defaults to known nodes and 15 results while browsing remains local', async () => {
  const requests: string[] = [];
  const service = { id: 'notes', kind: 'tool', methods: Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => [`read_${i}`, { description: `Read note ${i}` }]),
  ), liveness: 'up' };
  await gateway((req, res) => {
    requests.push(req.url!);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/nodes') res.end(JSON.stringify({ node: 'remote', nodes: [
      { node_id: 'remote-id', name: 'remote', type: 'linux', is_self: true, online: true, network_online: true },
    ] }));
    else if (req.url === '/services') res.end(JSON.stringify({ node: 'remote', services: [service] }));
    else { res.statusCode = 404; res.end('{}'); }
  }, async url => {
    const search = await cli(['search', '--query', 'notes'], url);
    assert.equal(search.code, 0, search.stdout);
    const data = JSON.parse(search.stdout).structuredContent;
    assert.equal(data.scope, 'all');
    assert.equal(data.limit, 15);
    assert.equal(data.max_chars, 12000);
    assert.equal(data.results.length, 15);
    assert.deepEqual(requests, ['/nodes', '/services']);

    requests.length = 0;
    const local = await cli(['search', '--query', 'notes', '--node', 'localhost'], url);
    assert.equal(local.code, 0, local.stdout);
    assert.deepEqual(requests, ['/services'], 'explicit local search must skip topology discovery');

    requests.length = 0;
    const services = await cli(['services'], url);
    assert.equal(services.code, 0, services.stdout);
    const listing = JSON.parse(services.stdout).structuredContent;
    assert.equal(listing.scope, 'local');
    assert.equal(listing.limit, 10);
    assert.equal(listing.max_chars, 6000);
    assert.deepEqual(requests, ['/services']);
  });
});

test('CLI uses remote gateway topology, discovers services and inspects contracts', async () => {
  const requests: string[] = [];
  await gateway((req, res) => {
    requests.push(req.url!);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/nodes') res.end(JSON.stringify({ node: 'remote', nodes: [
      { node_id: 'remote-id', name: 'remote', type: 'linux', is_self: true, online: true, network_online: true },
    ] }));
    else if (req.url === '/health') res.end(JSON.stringify({ service: 'node-agent', status: 'ok' }));
    else {
      const service = { id: 'notes', methods: { read: { description: 'read a note',
        parameters: { noteSchemaMarker: { type: 'string' } } } }, liveness: 'up' };
      res.end(JSON.stringify(req.url === '/services' ? { node: 'remote', services: [service] } : service));
    }
  }, async url => {
    const nodes = await cli(['nodes', '--agent', url], 'http://127.0.0.1:1');
    assert.equal(nodes.code, 0, nodes.stdout);
    assert.equal(JSON.parse(JSON.parse(nodes.stdout).content[0].text).nodes[0].gateway_reachable, true);
    const services = await cli(['services', '--node', 'all', '--keyword', 'notes'], url);
    assert.equal(services.code, 0);
    assert.equal(JSON.parse(services.stdout).structuredContent.services[0].service_id, 'notes');
    const directory = await cli(['inspect', '--node', 'remote-id', '--service', 'notes', '--limit', '1',
      '--offset', '0', '--max-chars', '1000'], url);
    assert.equal(directory.code, 0, directory.stdout);
    assert.equal(JSON.parse(directory.stdout).structuredContent.schema_loaded, false);
    assert.ok(!directory.stdout.includes('noteSchemaMarker'), 'inspect without a method must not load schemas');
    const inspect = await cli(['inspect', '--node', 'remote-id', '--service', 'notes', '--method', 'read'], url);
    assert.equal(inspect.code, 0);
    assert.equal(JSON.parse(JSON.parse(inspect.stdout).content[0].text).declared, true);
    assert.ok(inspect.stdout.includes('noteSchemaMarker'));
    assert.ok(requests.includes('/services/notes'));
  });
});

test('CLI invokes once, preserves structured/multimodal errors and supports stdin JSON', async () => {
  let requests = 0;
  const resultBody = { content: [{ type: 'text', text: '失败' }, { type: 'image', data: 'AA==', mimeType: 'image/png' }],
    structuredContent: { reason: 'denied' }, isError: true };
  await gateway(async (req, res) => {
    requests++;
    assert.equal(req.url, '/services/notes%2Fprivate/invoke');
    assert.equal(req.method, 'POST');
    let body = '';
    for await (const chunk of req) body += chunk;
    assert.deepEqual(JSON.parse(body), { method: 'read', capability: 'read', params: { text: '中文' } });
    res.end(JSON.stringify(resultBody));
  }, async url => {
    const result = await cli(['invoke', '--service', 'notes/private', '--method', 'read', '--params', '-'], url, '{"text":"中文"}');
    assert.equal(result.code, 1);
    assert.equal(result.stderr, '');
    const data = JSON.parse(result.stdout);
    assert.deepEqual(data.content, resultBody.content);
    assert.deepEqual(data.structuredContent, resultBody.structuredContent);
    assert.equal(data.isError, true);
    assert.equal(requests, 1);
  });
});

test('CLI returns success JSON, HTTP failures and network failures without retrying writes', async () => {
  let requests = 0;
  let urlAfterClose = '';
  await gateway((_req, res) => {
    requests++;
    if (requests === 1) res.end('{"ok":true}');
    else { res.statusCode = 503; res.end('{"error":"unavailable"}'); }
  }, async url => {
    urlAfterClose = url;
    const args = ['invoke', '--service', 's', '--method', 'm', '--params', '{}'];
    const success = await cli(args, url);
    assert.equal(success.code, 0);
    assert.deepEqual(JSON.parse(success.stdout).structuredContent, { ok: true });
    const failure = await cli(args, url);
    assert.equal(failure.code, 1);
    assert.equal(JSON.parse(failure.stdout).structuredContent.http_status, 503);
    assert.equal(requests, 2);
  });
  const disconnected = await cli(['services'], urlAfterClose);
  assert.equal(disconnected.code, 1);
  assert.equal(JSON.parse(disconnected.stdout).isError, true);
});

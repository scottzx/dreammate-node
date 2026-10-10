import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { directoryNodeUrl, parseDirectory, validateDirectory, type NodeDirectory } from '../src/node-directory.js';

const entry = fileURLToPath(new URL('../bin/dreammate-node.ts', import.meta.url));
function home(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dreammate-directory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function snapshot(agentUrl: string): NodeDirectory {
  return { format: 'dreammate.nodes', version: 1, exported_at: '2001-01-01T00:00:00Z', default_node: 'pc-id', nodes: [
    { node_id: 'pc-id', name: 'scott-pc-1', type: 'windows', dnsName: 'scott-pc-1.example.ts.net', ipv4: '100.64.0.8', agent_url: agentUrl },
  ] };
}

test('cached node addresses bypass MagicDNS without rewriting TLS or proxy hosts', () => {
  const node = snapshot('http://scott-pc-1.example.ts.net:1234/prefix').nodes[0]!;
  assert.equal(directoryNodeUrl(node), 'http://100.64.0.8:1234/prefix');
  assert.equal(directoryNodeUrl({ ...node, agent_url: 'http://scott-pc-1:1234' }), 'http://100.64.0.8:1234');
  for (const agent_url of ['https://scott-pc-1.example.ts.net:1234', 'http://proxy.example.test:1234', 'http://100.64.0.9:1234']) {
    assert.equal(directoryNodeUrl({ ...node, agent_url }), agent_url);
  }
  assert.equal(directoryNodeUrl({ ...node, ipv4: undefined }), node.agent_url);
});

test('cached default, alias and all-node scans use the stored IP without changing the cache', async t => {
  const dir = home(t);
  const data = snapshot('http://scott-pc-1.example.ts.net:36908');
  data.nodes[0]!.ipv4 = '127.0.0.2';
  // Refuse hostname URLs in the transport to verify actual route selection.
  const hook = path.join(dir, 'fetch.mjs');
  fs.writeFileSync(hook, `globalThis.fetch = async url => {
    if (!url.startsWith('http://127.0.0.2:')) throw new Error('DNS was used: '+url);
    return new Response('{"services":[]}');
  };`);
  const file = path.join(dir, 'directory.json');
  fs.writeFileSync(file, JSON.stringify(data));
  for (const args of [[], ['--node', 'scott-pc-1'], ['--node', 'all']]) {
    const result = await cli(dir, ['services', '--nodes-file', file, ...args], undefined,
      { NODE_OPTIONS: `--import=${pathToFileURL(hook).href}` });
    assert.equal(result.code, 0, result.stdout);
    assert.match(JSON.parse(result.stdout).structuredContent.scans[0].url, /127\.0\.0\.2/);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(data));
});
async function cli(home: string, args: string[], input?: string, env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(process.execPath, ['--import', 'tsx', entry, 'cli', ...args], {
      env: { ...process.env, HOME: home, DREAMMATE_AGENT_URL: '', DREAMMATE_NODES_FILE: '',
        DREAMMATE_TAILSCALE_BIN: path.join(home, 'must-not-run-tailscale'), TSX_DISABLE_CACHE: '1', ...env },
      timeout: 10_000,
    }, (error, stdout, stderr) => {
      if (error && (error.killed || typeof error.code !== 'number')) return reject(error);
      resolve({ code: error?.code as number ?? 0, stdout, stderr });
    });
    child.stdin!.end(input);
  });
}
async function gateway(t: TestContext, handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('portable directory validates aliases and strips identity, status and extra secrets', () => {
  const raw = snapshot('http://100.64.0.8:36908');
  const parsed = validateDirectory({ ...raw, credential: 'do-not-copy', nodes: [{ ...raw.nodes[0], is_self: true, online: true, metadata: { token: 'secret' } }] });
  assert.deepEqual(parsed, raw);
  for (const invalid of [
    { ...raw, version: 2 }, { ...raw, nodes: [] }, { ...raw, default_node: 'missing' },
    { ...raw, nodes: [...raw.nodes, { ...raw.nodes[0], node_id: 'different-id', name: 'SCOTT-PC-1' }] },
    { ...raw, nodes: [{ ...raw.nodes[0], agent_url: 'https://user:password@example.com' }] },
    { ...raw, nodes: [{ ...raw.nodes[0], agent_url: 'file:///tmp/a' }] },
    { ...raw, nodes: [{ ...raw.nodes[0], ipv4: 'invalid' }] },
  ]) assert.throws(() => validateDirectory(invalid));
  assert.throws(() => parseDirectory(' '.repeat(2 * 1024 * 1024 + 1)), /2 MiB/);
});

test('Mac export includes offline peers and rewrites self loopback to portable address', async t => {
  const dir = home(t);
  const url = await gateway(t, (req, res) => {
    assert.equal(req.url, '/nodes');
    res.end(JSON.stringify({ nodes: [
      { node_id: 'mac-id', name: 'mac', type: 'macos', ipv4: '100.64.0.2', is_self: true, online: true },
      { node_id: 'pc-id', name: 'scott-pc-1', type: 'windows', ipv4: '100.64.0.8', online: false },
    ] }));
  });
  const result = await cli(dir, ['nodes', 'export', '--agent', url, '--default-node', 'scott-pc-1']);
  assert.equal(result.code, 0, result.stderr);
  const data = parseDirectory(result.stdout);
  assert.equal(data.default_node, 'pc-id');
  assert.equal(data.nodes.length, 2);
  assert.equal(data.nodes[0]!.agent_url, url.replace('127.0.0.1', '100.64.0.2'));
  assert.equal(data.nodes[1]!.agent_url, 'http://100.64.0.8:36908');
  assert.ok(!result.stdout.includes('is_self'));
  assert.ok(!result.stdout.includes('online'));
  assert.deepEqual(fs.readdirSync(dir), []);
  const output = path.join(dir, 'transfer.json');
  const saved = await cli(dir, ['nodes', 'export', '--agent', url, '--file', output]);
  assert.equal(saved.code, 0);
  assert.equal(parseDirectory(fs.readFileSync(output, 'utf8')).default_node, 'mac-id');
});

test('import persists once; cached list is offline and subsequent calls route by aliases without discovery', async t => {
  const dir = home(t);
  const requests: string[] = [];
  const url = await gateway(t, (req, res) => {
    requests.push(req.url!);
    const service = { id: 'notes', methods: { read: { description: 'Read note' } }, liveness: 'up' };
    if (req.url === '/services') res.end(JSON.stringify({ services: [service] }));
    else if (req.url === '/services/notes/invoke') res.end('{"note":"123"}');
    else if (req.url === '/services/notes') res.end(JSON.stringify(service));
    else { res.statusCode = 503; res.end('{}'); }
  });
  assert.equal((await cli(dir, ['nodes', 'import', '--file', '-'], JSON.stringify(snapshot(url)))).code, 0);
  const cache = path.join(dir, '.1agents/nodes.json');
  const before = fs.readFileSync(cache, 'utf8');
  const mtime = fs.statSync(cache).mtimeMs;
  const listed = await cli(dir, ['nodes']);
  assert.equal(listed.code, 0);
  const data = JSON.parse(listed.stdout).structuredContent;
  assert.equal(data.source, 'imported');
  assert.equal(data.live_status, false);
  assert.equal(data.nodes[0].network_online, null);
  assert.equal(data.nodes[0].gateway_reachable, null);
  assert.equal(requests.length, 0);
  for (const alias of ['scott-pc-1', 'pc-id', 'SCOTT-PC-1.EXAMPLE.TS.NET.', '100.64.0.8']) {
    assert.equal((await cli(dir, ['services', '--node', alias])).code, 0);
  }
  assert.equal((await cli(dir, ['inspect', '--node', 'pc-id', '--service', 'notes', '--method', 'read'])).code, 0);
  assert.equal((await cli(dir, ['manage', '--node', 'pc-id', '--service', 'notes', '--action', 'status'])).code, 0);
  const invoked = await cli(dir, ['invoke', '--service', 'notes', '--method', 'read', '--params', '{"id":"123"}']);
  assert.equal(invoked.code, 0, invoked.stdout);
  assert.deepEqual(JSON.parse(invoked.stdout).structuredContent, { note: '123' });
  assert.equal((await cli(dir, ['services', '--node', 'unknown-node'])).code, 1);
  assert.equal(requests.filter(p => p === '/services/notes/invoke').length, 1);
  assert.ok(!requests.includes('/nodes'));
  assert.equal(fs.readFileSync(cache, 'utf8'), before);
  assert.equal(fs.statSync(cache).mtimeMs, mtime);
  assert.deepEqual(fs.readdirSync(path.join(dir, '.1agents')), ['nodes.json']);
});

test('invalid import preserves good cache; valid reimport replaces removed nodes', async t => {
  const dir = home(t);
  const raw = snapshot('http://100.64.0.8:36908');
  assert.equal((await cli(dir, ['nodes', 'import', '--file', '-'], JSON.stringify(raw))).code, 0);
  const cache = path.join(dir, '.1agents/nodes.json');
  const before = fs.readFileSync(cache, 'utf8');
  for (const input of ['{', JSON.stringify({ ...raw, version: 9 }), JSON.stringify({ ...raw, default_node: 'missing' })]) {
    assert.equal((await cli(dir, ['nodes', 'import', '--file', '-'], input)).code, 2);
    assert.equal(fs.readFileSync(cache, 'utf8'), before);
  }
  const changed = { ...raw, default_node: 'new-id', nodes: [{ node_id: 'new-id', name: 'new-node', type: 'linux', agent_url: 'http://100.64.0.9:36908' }] };
  const source = path.join(dir, 'new.json');
  fs.writeFileSync(source, JSON.stringify(changed));
  assert.equal((await cli(dir, ['nodes', 'import', '--file', source])).code, 0);
  assert.deepEqual(parseDirectory(fs.readFileSync(cache, 'utf8')).nodes, changed.nodes);
});

test('all scans cached addresses even if default is down, reporting live results and snapshot scope', async t => {
  const dir = home(t);
  const requests: string[] = [];
  const url = await gateway(t, (req, res) => { requests.push(req.url!); res.end('{"services":[{"id":"notes"}]}'); });
  const raw = snapshot(url);
  raw.nodes.push({ node_id: 'offline', name: 'old-mac', type: 'macos', agent_url: 'http://127.0.0.1:1' });
  raw.default_node = 'offline';
  await cli(dir, ['nodes', 'import', '--file', '-'], JSON.stringify(raw));
  const result = await cli(dir, ['services', '--node', 'all']);
  assert.equal(result.code, 0);
  const data = JSON.parse(result.stdout).structuredContent;
  assert.equal(data.discovery.status, 'cached');
  assert.equal(data.discovery.scope, 'imported_nodes_only');
  assert.equal(data.partial, true);
  assert.equal(data.services[0].service_id, 'notes');
  assert.equal(data.scans.length, 2);
  assert.deepEqual(requests, ['/services']);
});

test('custom cache path and live override work; unreachable write is never replayed', async t => {
  const dir = home(t);
  let mutations = 0;
  const url = await gateway(t, (req, res) => {
    if (req.method === 'POST') { mutations++; req.socket.destroy(); }
    else res.end('{"services":[]}');
  });
  const cache = path.join(dir, 'config/custom.json');
  assert.equal((await cli(dir, ['nodes', 'import', '--file', '-', '--nodes-file', cache], JSON.stringify(snapshot(url)))).code, 0);
  const invoked = await cli(dir, ['invoke', '--nodes-file', cache, '--service', 'notes', '--method', 'write']);
  assert.equal(invoked.code, 1);
  assert.equal(mutations, 1);
  assert.equal((await cli(dir, ['nodes'], undefined, { DREAMMATE_NODES_FILE: cache })).code, 0);
  assert.equal((await cli(dir, ['nodes', '--nodes-file', `${cache}.missing`])).code, 2);
  fs.writeFileSync(cache, 'broken JSON');
  assert.equal((await cli(dir, ['services', '--nodes-file', cache])).code, 2);
  assert.equal((await cli(dir, ['services', '--nodes-file', cache, '--live', '--agent', url])).code, 0);
  assert.equal(fs.readFileSync(cache, 'utf8'), 'broken JSON');
  assert.ok(!fs.existsSync(path.join(dir, '.1agents')));
});

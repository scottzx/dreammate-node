import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { loadPrivateMcpSources } from '../src/mcp-client-sources.js';
import { MAX_MCP_CONFIG_BYTES } from '../src/mcp-source-config.js';

const stdioFixture = fileURLToPath(new URL('./fixtures/mcp-source-stdio.mjs', import.meta.url));

function workspace(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-client-sources-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.DREAMMATE_MCP_CONFIG;
  delete process.env.DREAMMATE_MCP_CONFIG;
  t.after(() => {
    if (previous === undefined) delete process.env.DREAMMATE_MCP_CONFIG;
    else process.env.DREAMMATE_MCP_CONFIG = previous;
  });
  t.mock.method(os, 'homedir', () => dir);
  return dir;
}

function writeConfig(dir: string, config: unknown, name = 'client.json'): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config), { mode: 0o600 });
  return file;
}

async function authFixture(t: TestContext) {
  const calls: { token: string; tool?: string; args?: unknown }[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const token = req.headers.authorization ?? '';
    if (!['Bearer test-admin-secret', 'Bearer test-readonly-secret'].includes(token)) {
      res.writeHead(401).end('private auth diagnostics test-admin-secret'); return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw) as { id?: number; method: string; params?: Record<string, any> };
    if (request.id === undefined) { res.writeHead(202).end(); return; }
    const role = token === 'Bearer test-admin-secret' ? 'admin' : 'readonly';
    const tools = [
      { name: 'erp_read', description: 'Read ERP', inputSchema: { type: 'object' } },
      ...(role === 'admin' ? [{ name: 'erp_write', description: 'Write ERP', inputSchema: { type: 'object' } }] : []),
    ];
    const result = request.method === 'initialize'
      ? { protocolVersion: request.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'auth-fixture', version: '1' } }
      : request.method === 'tools/list' ? { tools }
        : request.method === 'tools/call'
          ? { content: [{ type: 'text', text: role }], structuredContent: { role } } : {};
    if (request.method === 'tools/call') calls.push({ token, tool: request.params?.name, args: request.params?.arguments });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const config = (role: 'admin' | 'readonly') => ({ mcpServers: { erp: {
    url, headers: { Authorization: `Bearer test-${role}-secret` },
  } } });
  return { url, config, calls };
}

test('private sources are optional only when the default is absent, and none overrides environment', async t => {
  const dir = workspace(t);
  assert.equal(await loadPrivateMcpSources(), undefined);
  process.env.DREAMMATE_MCP_CONFIG = path.join(dir, 'missing-env.json');
  assert.equal(await loadPrivateMcpSources('none'), undefined);
  await assert.rejects(loadPrivateMcpSources(), /无法读取客户端私有 MCP/);
  delete process.env.DREAMMATE_MCP_CONFIG;
  await assert.rejects(loadPrivateMcpSources(path.join(dir, 'missing-explicit.json')), /无法读取客户端私有 MCP/);
  process.env.DREAMMATE_MCP_CONFIG = 'none';
  assert.equal(await loadPrivateMcpSources(), undefined);
  await assert.rejects(loadPrivateMcpSources(''), /路径无效/);
  await assert.rejects(loadPrivateMcpSources('bad\0path'), /路径无效/);
});

test('private configuration rejects unsafe modes, symlinks, directories, oversized and invalid files', async t => {
  const dir = workspace(t);
  const file = writeConfig(dir, '{}');
  for (const mode of [0o644, 0o660, 0o601]) {
    fs.chmodSync(file, mode);
    await assert.rejects(loadPrivateMcpSources(file), /仅所有者可访问/);
  }
  fs.chmodSync(file, 0o600);
  const link = path.join(dir, 'link.json');
  fs.symlinkSync(file, link);
  await assert.rejects(loadPrivateMcpSources(link), /不能是符号链接/);
  await assert.rejects(loadPrivateMcpSources(dir), /必须是普通文件/);
  fs.writeFileSync(file, 'x'.repeat(MAX_MCP_CONFIG_BYTES + 1));
  await assert.rejects(loadPrivateMcpSources(file), /不能超过 256 KiB/);
  fs.writeFileSync(file, '{"headers":"do-not-print-this-secret",invalid');
  await assert.rejects(loadPrivateMcpSources(file), error => {
    assert.doesNotMatch(String(error), /do-not-print-this-secret|headers/);
    return /未加载任何私有工具/.test(String(error));
  });
  if (process.getuid) {
    const anotherUid = process.getuid() + 1;
    t.mock.method(process as NodeJS.Process & { getuid(): number }, 'getuid', () => anotherUid);
    await assert.rejects(loadPrivateMcpSources(file), /属于当前用户/);
  }
});

test('explicit configuration takes precedence over environment and an invalid default fails closed', async t => {
  const dir = workspace(t);
  const fixture = await authFixture(t);
  const file = writeConfig(dir, fixture.config('readonly'));
  process.env.DREAMMATE_MCP_CONFIG = path.join(dir, 'missing-env.json');
  const sources = await loadPrivateMcpSources(file);
  assert.ok(sources);
  try { assert.equal(Object.keys(sources.list()[0]!.methods!).length, 1); }
  finally { await sources.stop(); }
  delete process.env.DREAMMATE_MCP_CONFIG;
  fs.mkdirSync(path.join(dir, '.1agents'));
  writeConfig(path.join(dir, '.1agents'), '{invalid', 'mcp-client.json');
  await assert.rejects(loadPrivateMcpSources(), /未加载任何私有工具/);
});

test('the owner-only default loads privately without changing shared node configuration', async t => {
  const dir = workspace(t);
  const fixture = await authFixture(t);
  const stateDir = path.join(dir, '.1agents');
  fs.mkdirSync(stateDir, { mode: 0o700 });
  writeConfig(stateDir, fixture.config('readonly'), 'mcp-client.json');
  const sentinel = '{"shared":"keep-this-exactly"}\n';
  fs.writeFileSync(path.join(stateDir, 'mcp-sources.json'), sentinel);
  fs.writeFileSync(path.join(stateDir, 'registry.json'), sentinel);
  const before = fs.readdirSync(stateDir).sort();
  const sources = await loadPrivateMcpSources();
  assert.ok(sources);
  try {
    assert.equal(sources.list()[0]!.id, 'mcp-erp');
    assert.equal((await sources.invoke('mcp-erp', { method: 'erp_read' })).status, 200);
  } finally { await sources.stop(); }
  assert.deepEqual(fs.readdirSync(stateDir).sort(), before);
  assert.equal(fs.readFileSync(path.join(stateDir, 'mcp-sources.json'), 'utf8'), sentinel);
  assert.equal(fs.readFileSync(path.join(stateDir, 'registry.json'), 'utf8'), sentinel);
});

test('two private managers isolate credentials and method catalogs even with the same service ID', async t => {
  const dir = workspace(t);
  const fixture = await authFixture(t);
  const adminPath = writeConfig(dir, fixture.config('admin'), 'admin.json');
  const readonlyPath = writeConfig(dir, fixture.config('readonly'), 'readonly.json');
  const [admin, readonly] = await Promise.all([loadPrivateMcpSources(adminPath), loadPrivateMcpSources(readonlyPath)]);
  assert.ok(admin && readonly);
  try {
    assert.equal(admin.list()[0]!.id, 'mcp-erp');
    assert.equal(readonly.list()[0]!.id, 'mcp-erp');
    assert.equal(Object.keys(admin.get('mcp-erp')!.methods!).length, 2);
    assert.equal(Object.keys(readonly.get('mcp-erp')!.methods!).length, 1);
    const described = await readonly.describe('mcp-erp', 'erp_read');
    assert.equal(described.details.schema_loaded, true);
    assert.ok(described.details.parameters);
    const [adminResult, readonlyResult] = await Promise.all([
      admin.invoke('mcp-erp', { method: 'erp_write' }),
      readonly.invoke('mcp-erp', { method: 'erp_read', params: { profile: 'admin', Authorization: 'pretend-admin' } }),
    ]);
    assert.deepEqual((adminResult.data as { structuredContent: unknown }).structuredContent, { role: 'admin' });
    assert.deepEqual((readonlyResult.data as { structuredContent: unknown }).structuredContent, { role: 'readonly' });
    const before = fixture.calls.length;
    assert.equal((await readonly.invoke('mcp-erp', { method: 'erp_write' })).status, 404);
    assert.equal((await readonly.invoke('mcp-admin', { method: 'erp_read' })).status, 404);
    assert.equal(fixture.calls.length, before);
    assert.doesNotMatch(JSON.stringify({ services: admin.list(), described, adminResult, readonlyResult }), /test-admin-secret|test-readonly-secret|Bearer|127\.0\.0\.1/);
    await readonly.stop();
    assert.equal((await readonly.invoke('mcp-erp', { method: 'erp_read' })).status, 502);
    assert.equal((await admin.invoke('mcp-erp', { method: 'erp_read' })).status, 200);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['admin.json', 'readonly.json']);
  } finally { await Promise.all([admin.stop(), readonly.stop()]); }
});

test('a failed connection rejects all configured sources without exposing server diagnostics', async t => {
  const dir = workspace(t);
  const fixture = await authFixture(t);
  const config = fixture.config('readonly');
  Object.assign(config.mcpServers, { bad: { url: fixture.url, headers: { Authorization: 'Bearer invalid-private-secret' } } });
  const file = writeConfig(dir, config);
  await assert.rejects(loadPrivateMcpSources(file), error => {
    assert.doesNotMatch(String(error), /invalid-private-secret|test-admin-secret|127\.0\.0\.1/);
    return /未加载任何私有工具/.test(String(error));
  });
});

test('private stdio sources are stopped and their child process exits', async t => {
  const dir = workspace(t);
  const file = writeConfig(dir, { mcpServers: { local: { command: process.execPath, args: [stdioFixture] } } });
  const sources = await loadPrivateMcpSources(file);
  assert.ok(sources);
  let pid: number;
  try {
    const result = await sources.invoke('mcp-local', { method: 'process_id' });
    pid = (result.data as { structuredContent: { pid: number } }).structuredContent.pid;
    assert.doesNotThrow(() => process.kill(pid, 0));
  } finally { await sources.stop(); }
  assert.throws(() => process.kill(pid!, 0), /ESRCH/);
});

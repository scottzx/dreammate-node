import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const sourceModule = new URL('../src/mcp-source-cli.ts', import.meta.url).href;
const runner = `import { runMcpSourceCli } from ${JSON.stringify(sourceModule)}; process.exitCode = await runMcpSourceCli(process.argv.slice(1));`;
const executable = fileURLToPath(new URL('../bin/dreammate-node.ts', import.meta.url));

async function cli(args: string[], agent = '', input?: string, useExecutable = false) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const invocation = useExecutable ? ['--import', 'tsx', executable, 'mcp', ...args]
      : ['--import', 'tsx', '--input-type=module', '-e', runner, '--', ...args];
    const child = execFile(process.execPath, invocation, {
      env: { ...process.env, DREAMMATE_AGENT_URL: agent, TSX_DISABLE_CACHE: '1' }, timeout: 10_000,
    }, (error, stdout, stderr) => {
      if (error && (error.killed || typeof error.code !== 'number')) return reject(error);
      resolve({ code: error?.code as number ?? 0, stdout, stderr });
    });
    child.stdin!.end(input);
  });
}

async function gateway(handler: RequestListener, body: (url: string) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await body(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('MCP CLI help works offline', async () => {
  const result = await cli(['--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /add --config/);
  assert.match(result.stdout, /OAuth/);
});

test('MCP CLI imports pasted configurations and redacts credentials in server responses', async () => {
  const config = { mcpServers: { activepieces: { url: 'https://ap.example/mcp/private-url-token',
    headers: { Authorization: 'Bearer private-header-token', 'x-forwarded-proto': 'http' } } } };
  await gateway(async (req, res) => {
    assert.equal(req.url, '/mcp/sources');
    assert.equal(req.method, 'POST');
    let body = '';
    for await (const chunk of req) body += chunk;
    assert.deepEqual(JSON.parse(body), { config });
    res.end(JSON.stringify({ sources: [{ id: 'mcp-activepieces', type: 'http', transport: 'http', status: 'connected', tool_count: 12 }],
      headers: { Authorization: 'Bearer private-header-token' },
      error_detail: 'https://ap.example/mcp/private-url-token Bearer private-header-token' }));
  }, async url => {
    const result = await cli(['add', '--config', JSON.stringify(config)], url);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(JSON.parse(result.stdout).sources[0].tool_count, 12);
    assert.equal(JSON.parse(result.stdout).sources[0].type, 'http');
    assert.equal(JSON.parse(result.stdout).sources[0].transport, 'http');
    assert.ok(!result.stdout.includes('private-header-token'));
    assert.ok(!result.stdout.includes('private-url-token'));
    assert.equal(result.stderr, '');
  });
});

test('MCP CLI accepts single source JSON from stdin or a file with --name', async () => {
  let calls = 0;
  await gateway(async (req, res) => {
    calls++;
    let body = '';
    for await (const chunk of req) body += chunk;
    assert.deepEqual(JSON.parse(body), { config: { command: 'node', args: ['server.mjs'] }, name: 'local' });
    res.end('{"sources":[{"id":"mcp-local","status":"connected"}]}');
  }, async url => {
    const config = JSON.stringify({ command: 'node', args: ['server.mjs'] });
    assert.equal((await cli(['add', '--file', '-', '--name', 'local'], url, config)).code, 0);
    const dir = await mkdtemp(path.join(tmpdir(), 'mcp-cli-'));
    try {
      const file = path.join(dir, 'source.json');
      await writeFile(file, config);
      assert.equal((await cli(['add', '--file', file, '--name', 'local', '--agent', url], 'http://192.0.2.1')).code, 0);
    } finally { await rm(dir, { recursive: true, force: true }); }
    assert.equal(calls, 2);
  });
});

test('MCP CLI list, remove and refresh use the management endpoints', async () => {
  const requests: string[] = [];
  await gateway((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.end(req.method === 'DELETE' ? '{"removed":"mcp-source"}' : '{"sources":[{"status":"connected"}]}');
  }, async url => {
    assert.equal((await cli(['list'], url)).code, 0);
    assert.equal((await cli(['remove', 'mcp-source'], url)).code, 0);
    assert.equal((await cli(['refresh', 'mcp-source'], url)).code, 0);
    assert.deepEqual(requests, ['GET /mcp/sources', 'DELETE /mcp/sources/mcp-source', 'POST /mcp/sources/mcp-source/refresh']);
  });
});

test('MCP CLI rejects invalid arguments, unsafe management targets and invalid configs before HTTP', async () => {
  let requests = 0;
  await gateway((_req, res) => { requests++; res.end('{}'); }, async url => {
    for (const args of [
      ['add'], ['add', '--config', '{}', '--file', '-'], ['add', '--config', '{"command":"node"}'],
      ['add', '--config', '{malformed-private-marker'], ['refresh'], ['remove', '../source'],
      ['remove', 'mcp-source', 'extra'], ['list', '--config', '{}'], ['list', '--timeout-ms', '1.5'],
      ['list', '--timeout-ms', '3600001'], ['list', '--unknown', 'private-marker'],
      ['list', '--agent', 'https://example.com'], ['list', '--agent', 'http://192.168.1.2:36908'],
      ['list', '--agent', 'http://user:private-marker@127.0.0.1:36908'],
      ['list', '--agent', `${url}/?token=private-marker`],
    ]) {
      const result = await cli(args, url);
      assert.equal(result.code, 2, args.join(' '));
      assert.equal(JSON.parse(result.stdout).isError, true);
      assert.ok(!result.stdout.includes('private-marker'));
    }
    assert.equal(requests, 0);
  });
});

test('MCP CLI returns exit 1 on partial import failures, server failures and invalid JSON', async () => {
  let mode = 0;
  await gateway((_req, res) => {
    if (mode === 0) res.end('{"sources":[{"status":"connected"},{"status":"error","error":"MCP connection failed"}]}');
    else if (mode === 1) { res.statusCode = 503; res.end('{"error":"unavailable"}'); }
    else res.end('not JSON');
  }, async url => {
    const partial = await cli(['add', '--config', '{"remote":{"url":"https://example.com"}}'], url);
    assert.equal(partial.code, 1);
    assert.equal(JSON.parse(partial.stdout).sources.length, 2);
    mode = 1;
    assert.equal((await cli(['list'], url)).code, 1);
    mode = 2;
    assert.equal((await cli(['list'], url)).code, 1);
  });
});

test('MCP CLI respects an HTTP request deadline', async () => {
  await gateway((_req, _res) => {}, async url => {
    const result = await cli(['list', '--timeout-ms', '50'], url);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /50 ms/);
  });
});

test('MCP executable dispatches one-shot management commands without starting the stdio gateway', async () => {
  const help = await cli(['add', '--help'], '', undefined, true);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /add --config/);
  await gateway((req, res) => {
    assert.equal(req.url, '/mcp/sources');
    assert.equal(req.method, 'GET');
    res.end('{"sources":[{"id":"mcp-example","status":"connected","tool_count":3}]}');
  }, async url => {
    const result = await cli(['list'], url, undefined, true);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(JSON.parse(result.stdout).sources[0].id, 'mcp-example');
    assert.equal(result.stderr, '');
  });
});

test('MCP CLI accepts OAuth grants and redacts the complete grant and reflected grant values', async () => {
  const oauth = {
    tokenUrl: 'https://oauth.example/token/private-token-path', clientId: 'oauth-client-marker',
    refreshToken: 'xyz', accessToken: 'access-token-marker', expiresAt: 1_800_000_000_000,
    clientSecret: 'client-secret-marker', scope: 'tools:read',
  };
  const config = { mcpServers: { activepieces: { url: 'https://mcp.example/mcp', oauth } } };
  await gateway(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    assert.deepEqual(JSON.parse(body), { config });
    res.end(JSON.stringify({ sources: [{ id: 'mcp-activepieces', status: 'connected', tool_count: 2, oauth }],
      error_detail: Object.values(oauth).filter(value => typeof value === 'string').join(' ') }));
  }, async url => {
    const result = await cli(['add', '--config', JSON.stringify(config)], url);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).sources[0].oauth, '[redacted]');
    assert.equal(JSON.parse(result.stdout).sources[0].status, 'connected');
    for (const value of Object.values(oauth)) {
      if (typeof value === 'string') assert.ok(!result.stdout.includes(value), `grant value was exposed`);
    }
  });
});

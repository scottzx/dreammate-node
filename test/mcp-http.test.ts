import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpHttpServer } from '../src/mcp-http.js';

const entry = fileURLToPath(new URL('../bin/dreammate-node.ts', import.meta.url));
const apiKey = 'local-test-key-0123456789';

async function post(url: string, headers: Record<string, string>, body?: string) {
  const response = await fetch(url, { method: 'POST', headers, body });
  const text = await response.text();
  return { status: response.status, text, www: response.headers.get('www-authenticate') };
}

test('HTTP MCP stays on loopback, requires the bearer token, and lists tools without a session', async () => {
  await assert.rejects(() => startMcpHttpServer({ apiKey, host: '0.0.0.0', port: 0 }), /回环/);
  const endpoint = await startMcpHttpServer({ apiKey, port: 0, mcpConfig: 'none' });
  try {
    assert.match(endpoint.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const missing = await post(endpoint.url, { 'content-type': 'application/json' }, '{}');
    assert.equal(missing.status, 401);
    assert.equal(missing.www, 'Bearer');
    const wrong = await post(endpoint.url, { authorization: 'Bearer not-the-local-test-key', 'content-type': 'application/json' }, '{}');
    assert.equal(wrong.status, 401);
    const browser = await post(endpoint.url, {
      authorization: `Bearer ${apiKey}`,
      origin: 'https://example.com',
      'content-type': 'application/json',
    }, '{}');
    assert.equal(browser.status, 403);
    const missingPath = await fetch(endpoint.url.replace(/\/mcp$/, '/other'), {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
    });
    assert.equal(missingPath.status, 404);
    const get = await fetch(endpoint.url, { headers: { authorization: `Bearer ${apiKey}`, accept: 'text/event-stream' } });
    assert.equal(get.status, 405);

    const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
    });
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      assert.ok(listed.tools.some(tool => tool.name === 'dreammate_invoke'));
      assert.equal(transport.sessionId, undefined);
    } finally {
      await client.close();
    }
  } finally {
    await endpoint.close();
  }
});

test('HTTP transport refuses to start without an API key', async () => {
  const result = await new Promise<{ code: number; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, ['--import', 'tsx', entry, 'mcp', '--transport', 'http', '--port', '0'], {
      env: { ...process.env, DREAMMATE_MCP_API_KEY: '', TSX_DISABLE_CACHE: '1' },
      timeout: 10_000,
    }, (error, _stdout, stderr) => {
      if (error && typeof error.code !== 'number') return reject(error);
      resolve({ code: error?.code as number ?? 0, stderr });
    });
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /API key/);
  assert.doesNotMatch(result.stderr, /0\.0\.0\.0/);
});

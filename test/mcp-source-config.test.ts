import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_MCP_CONFIG_BYTES, parseMcpSourceConfig } from '../src/mcp-source-config.js';

test('MCP config parses standard local and remote configurations without expanding placeholders', () => {
  const sources = parseMcpSourceConfig(JSON.stringify({ mcpServers: {
    local: { command: 'npx', args: ['-y', 'test-mcp', ''], env: { TOKEN: '${SECRET}' }, cwd: '/tmp' },
    activepieces: { url: 'https://ap.example/api/v1/mcp/token/sse?session=secret', headers: { Authorization: 'Bearer ${TOKEN}' } },
  } }));
  assert.deepEqual(sources, [
    { id: 'mcp-local', name: 'local', type: 'stdio', command: 'npx', args: ['-y', 'test-mcp', ''], env: { TOKEN: '${SECRET}' }, cwd: '/tmp' },
    { id: 'mcp-activepieces', name: 'activepieces', type: 'http', url: 'https://ap.example/api/v1/mcp/token/sse?session=secret', headers: { Authorization: 'Bearer ${TOKEN}' } },
  ]);
});

test('MCP config supports named maps, explicit SSE, and streamable HTTP aliases', () => {
  assert.deepEqual(parseMcpSourceConfig({ url: { url: 'https://example.com', type: 'sse' } }), [
    { id: 'mcp-url', name: 'url', type: 'sse', url: 'https://example.com' },
  ]);
  for (const alias of ['http', 'streamable-http', 'streamableHttp', 'streamable_http']) {
    assert.equal(parseMcpSourceConfig({ url: 'http://127.0.0.1:5000/mcp', transport: alias }, 'local-http')[0]?.type, 'http');
  }
  assert.equal(parseMcpSourceConfig({ command: 'node', transport: 'stdio' }, 'node')[0]?.type, 'stdio');
  assert.equal(parseMcpSourceConfig({ url: 'https://${MCP_HOST}/mcp/${MCP_TOKEN}' }, 'remote')[0]?.url,
    'https://${MCP_HOST}/mcp/${MCP_TOKEN}');
});

test('MCP config requires an unambiguous source name and rejects duplicate JSON keys', () => {
  for (const input of [
    { command: 'node' }, {}, { mcpServers: {} }, { 'invalid/name': { command: 'node' } },
    { ['x'.repeat(65)]: { command: 'node' } },
    '{"mcpServers":{"same":{"command":"node"},"same":{"url":"https://example.com"}}}',
    '{"mcpServers":{"one":{"command":"node","command":"other"}}}',
    '{"mcpServers":{"same":{"command":"node"},"s\\u0061me":{"command":"other"}}}',
  ]) assert.throws(() => parseMcpSourceConfig(input));
  assert.throws(() => parseMcpSourceConfig({ mcpServers: { one: { command: 'node' } } }, 'two'));
  assert.throws(() => parseMcpSourceConfig({ one: { command: 'node' } }, 'two'));
});

test('MCP config validates transport-specific fields before execution', () => {
  for (const config of [
    { command: 'node', url: 'https://example.com' }, { command: 'node', headers: {} },
    { command: 'node', type: 'sse' }, { url: 'https://example.com', type: 'stdio' },
    { command: 'node', type: 'stdio', transport: 'sse' }, { command: 'node', type: 'websocket' },
    { command: 'node\nwrong' }, { command: '' }, { command: 'node', args: [1] },
    { command: 'node', cwd: './relative' }, { command: 'node', env: { TOKEN: 1 } },
    { command: 'node', env: { 'BAD=KEY': 'value' } }, { url: 'https://example.com', env: {} },
    { url: 'https://example.com', headers: { bad: 'x\r\nInjected: true' } },
    { url: 'https://example.com', headers: { 'invalid key': 'token' } },
    { url: 'https://example.com', unsupported: true },
    { mcpServers: { one: { command: 'node' } }, unexpected: true },
  ]) assert.throws(() => parseMcpSourceConfig(config, 'one'));
});

test('MCP config only accepts HTTP(S) remote URLs without URL userinfo', () => {
  for (const url of ['file:///secret', 'ws://localhost/mcp', 'no URL', 'https://user:secret@example.com', 'https://example.com/#secret']) {
    assert.throws(() => parseMcpSourceConfig({ url }, 'remote'));
  }
  assert.equal(parseMcpSourceConfig({ url: 'http://localhost:3000/mcp' }, 'remote')[0]?.url, 'http://localhost:3000/mcp');
});

test('MCP configuration errors omit credential values and bound source counts and input size', () => {
  const secret = 'sensitive-config-marker';
  for (const value of [`{"secret":"${secret}"`, { url: `file:///${secret}` }, { url: 'https://example.com', headers: { Authorization: 123, secret } }]) {
    assert.throws(() => parseMcpSourceConfig(value, 'source'), error => error instanceof Error && !error.message.includes(secret));
  }
  assert.throws(() => parseMcpSourceConfig(' '.repeat(MAX_MCP_CONFIG_BYTES + 1)));
  assert.throws(() => parseMcpSourceConfig({ command: 'node', args: ['a'.repeat(MAX_MCP_CONFIG_BYTES)] }, 'node'));
  const tooMany = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`source-${i}`, { command: 'node' }]));
  assert.throws(() => parseMcpSourceConfig(tooMany));
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => parseMcpSourceConfig(cycle));
});

test('MCP config supports optional OAuth refresh grants for both remote transports and preserves placeholders', () => {
  const oauth = {
    tokenUrl: 'https://${OAUTH_HOST}/oauth/${OAUTH_PATH}',
    clientId: '${OAUTH_CLIENT_ID}', refreshToken: '${OAUTH_REFRESH_TOKEN}',
    accessToken: '${OAUTH_ACCESS_TOKEN}', expiresAt: 1_800_000_000_000,
    clientSecret: '${OAUTH_CLIENT_SECRET}', scope: 'tools:read tools:write',
  };
  for (const type of ['http', 'sse']) {
    const sources = parseMcpSourceConfig({ url: 'https://mcp.example/mcp', type, oauth,
      headers: { 'X-Forwarded-Host': 'mcp.example', 'X-Forwarded-Proto': 'https' } }, 'oauth-source');
    assert.deepEqual(sources[0]?.oauth, oauth);
    assert.equal(sources[0]?.headers?.['X-Forwarded-Host'], 'mcp.example');
  }
  const minimal = { tokenUrl: 'http://localhost:3000/oauth/token', clientId: 'client', refreshToken: 'refresh' };
  assert.deepEqual(parseMcpSourceConfig({ url: 'https://mcp.example/mcp', oauth: minimal }, 'remote')[0]?.oauth, minimal);
  const unknownExpiry = { ...minimal, accessToken: 'existing-token' };
  assert.deepEqual(parseMcpSourceConfig({ url: 'https://mcp.example/mcp', oauth: unknownExpiry }, 'remote')[0]?.oauth, unknownExpiry);
});

test('MCP config rejects malformed OAuth grants, unsafe token endpoints and stdio OAuth', () => {
  const valid = { tokenUrl: 'https://oauth.example/token', clientId: 'client', refreshToken: 'refresh' };
  const invalid: unknown[] = [
    null, [], 'grant', {}, { ...valid, unexpected: 'unsupported' },
    { ...valid, tokenUrl: undefined }, { ...valid, clientId: undefined }, { ...valid, refreshToken: undefined },
    { ...valid, tokenUrl: 'file:///tmp/token' }, { ...valid, tokenUrl: 'https://user:pass@oauth.example/token' },
    { ...valid, tokenUrl: 'https://oauth.example/token#fragment' },
    { ...valid, clientId: 5 }, { ...valid, refreshToken: true }, { ...valid, accessToken: '' },
    { ...valid, clientSecret: ' ' }, { ...valid, scope: [] }, { ...valid, refreshToken: 'bad\nvalue' },
    { ...valid, accessToken: 'token', expiresAt: '1800000000000' },
    { ...valid, accessToken: 'token', expiresAt: 0 }, { ...valid, accessToken: 'token', expiresAt: -1 },
    { ...valid, accessToken: 'token', expiresAt: 1.5 }, { ...valid, accessToken: 'token', expiresAt: Infinity },
    { ...valid, accessToken: 'token', expiresAt: NaN }, { ...valid, expiresAt: 1_800_000_000_000 },
  ];
  for (const oauth of invalid) assert.throws(() => parseMcpSourceConfig({ url: 'https://mcp.example/mcp', oauth }, 'remote'));
  assert.throws(() => parseMcpSourceConfig({ command: 'node', oauth: valid }, 'local'));
});

test('MCP OAuth validation errors do not expose grant credentials', () => {
  const marker = 'sensitive-oauth-grant-marker';
  for (const oauth of [
    { tokenUrl: `https://user:${marker}@oauth.example/token`, clientId: marker, refreshToken: marker },
    { tokenUrl: 'https://oauth.example/token', clientId: marker, refreshToken: marker, accessToken: `${marker}\ninvalid` },
    { tokenUrl: 'https://oauth.example/token', clientId: marker, refreshToken: marker, clientSecret: marker, expiresAt: 'invalid' },
  ]) assert.throws(() => parseMcpSourceConfig({ url: 'https://mcp.example/mcp', oauth }, 'remote'),
    error => error instanceof Error && !error.message.includes(marker));
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAgent } from '../src/server.js';
import { ServiceRegistry } from '../src/registry.js';
import { startAccessControl } from '../src/access-server.js';
import { runAccessCli } from '../src/access-cli.js';
import {
  decidePublicAccess,
  defaultAccessState,
  generateToken,
  hashToken,
  isTrustedZone,
  parseTrustedZones,
  readAccessState,
  verifyToken,
  writeAccessState,
} from '../src/access-control.js';
import type { AddressInfo } from 'node:net';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dreammate-access-'));
}

test('公网默认关闭，局域网和 Tailnet 免 token', () => {
  const snapshot = { ...defaultAccessState(), corrupt: false };
  const zones = parseTrustedZones(snapshot.public_access.trusted_zones);
  assert.equal(isTrustedZone('192.168.1.20', zones), true);
  assert.equal(isTrustedZone('100.88.227.56', zones), true);
  assert.equal(isTrustedZone('203.0.113.7', zones), false);
  assert.deepEqual(decidePublicAccess({ isLoopback: true, clientIp: '127.0.0.1', snapshot }), { allow: true });
  assert.deepEqual(decidePublicAccess({ isLoopback: false, clientIp: '192.168.1.20', snapshot }), { allow: true });
  assert.equal(decidePublicAccess({ isLoopback: false, clientIp: '203.0.113.7', snapshot }).status, 403);
});

test('打开后公网要 token，token 不改变判定函数本身的网段豁免', () => {
  const token = generateToken();
  const snapshot = {
    ...defaultAccessState(),
    corrupt: false,
    public_access: {
      ...defaultAccessState().public_access,
      enabled: true,
      token_hash: hashToken(token),
    },
  };
  assert.equal(verifyToken(token, snapshot.public_access.token_hash), true);
  assert.equal(verifyToken(`${token}x`, snapshot.public_access.token_hash), false);
  assert.equal(decidePublicAccess({ isLoopback: false, clientIp: '203.0.113.7', snapshot }).status, 401);
  assert.deepEqual(
    decidePublicAccess({ isLoopback: false, clientIp: '203.0.113.7', snapshot, token }),
    { allow: true },
  );
});

test('控制面只在回环上签发、掩码和展示 token', async () => {
  const dir = tempDir();
  const statePath = path.join(dir, 'access.json');
  const tokenPath = path.join(dir, 'token');
  const control = await startAccessControl({ port: 0, statePath, tokenPath });
  const base = `http://127.0.0.1:${control.port}`;
  try {
    await assert.rejects(() => startAccessControl({ port: 0, host: '0.0.0.0', statePath, tokenPath }), /回环/);
    const before = await fetch(`${base}/access`);
    assert.equal((await before.json() as { enabled: boolean }).enabled, false);

    const enabled = await fetch(`${base}/access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'enable' }),
    });
    const created = await enabled.json() as { enabled: boolean; token: string; token_hint: string };
    assert.equal(created.enabled, true);
    assert.match(created.token, /^dmk_/);
    assert.equal(created.token_hint.includes(created.token), false);
    assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
    const stored = readAccessState(statePath);
    assert.equal(stored.public_access.token_hash, hashToken(created.token));
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).public_access.token, undefined);

    const status = await fetch(`${base}/access`);
    const masked = await status.json() as { token?: string; token_hint: string };
    assert.equal(masked.token, undefined);
    assert.equal(masked.token_hint, created.token_hint);

    const shown = await fetch(`${base}/access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'show-token' }),
    });
    assert.equal((await shown.json() as { token: string }).token, created.token);

    const code = await runAccessCli(['disable', '--agent', base]);
    assert.equal(code, 0);
    assert.equal(readAccessState(statePath).public_access.enabled, false);
  } finally {
    await control.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('公网来源在关闭时被拒，打开后凭 token 进入，但仍看不到 local 服务', async () => {
  const dir = tempDir();
  const statePath = path.join(dir, 'access.json');
  const token = 'dmk_gatewaytesttoken0123456789abcd';
  const state = defaultAccessState();
  state.public_access.enabled = false;
  state.public_access.token_hash = hashToken(token);
  writeAccessState(state, statePath);

  const registry = new ServiceRegistry();
  registry.register({ id: 'secret', capabilities: ['secret.read'], port: 9, sharing: 'local' });
  registry.register({ id: 'shared', capabilities: ['shared.read'], port: 9, sharing: 'network' });
  const { server } = createAgent({
    registry,
    trustedProxyIps: ['127.0.0.1'],
    enforcePublicAccess: true,
    accessStatePath: statePath,
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const publicHeaders = { 'x-forwarded-for': '203.0.113.7' };
  const lanHeaders = { 'x-forwarded-for': '192.168.8.8' };

  try {
    const closed = await fetch(`${base}/health`, { headers: publicHeaders });
    assert.equal(closed.status, 403);

    const lan = await fetch(`${base}/health`, { headers: lanHeaders });
    assert.equal(lan.status, 200);

    state.public_access.enabled = true;
    writeAccessState(state, statePath);
    const missing = await fetch(`${base}/health`, { headers: publicHeaders });
    assert.equal(missing.status, 401);
    const opened = await fetch(`${base}/services`, {
      headers: { ...publicHeaders, authorization: `Bearer ${token}` },
    });
    assert.equal(opened.status, 200);
    const body = await opened.json() as { services: { id: string }[] };
    assert.deepEqual(body.services.map(service => service.id), ['shared']);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

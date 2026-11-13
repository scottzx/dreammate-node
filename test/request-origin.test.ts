import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { createAgent } from '../src/server.js';
import { ServiceRegistry } from '../src/registry.js';
import {
  forwardedClientIp,
  isLoopbackAddress,
  normalizeIp,
  parseTrustedProxyIps,
  resolveRequestOrigin,
} from '../src/request-origin.js';

function fakeRequest(
  remoteAddress: string | undefined,
  headers: Record<string, string | string[]> = {},
): IncomingMessage {
  return { socket: { remoteAddress }, headers } as unknown as IncomingMessage;
}

test('normalizeIp 去掉 IPv4-mapped 前缀、方括号和 zone id', () => {
  assert.equal(normalizeIp('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeIp('[::1]'), '::1');
  assert.equal(normalizeIp('fe80::1%en0'), 'fe80::1');
  assert.equal(normalizeIp('  192.168.1.5 '), '192.168.1.5');
});

test('isLoopbackAddress 覆盖 IPv4、IPv6 和映射形式', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('127.1.2.3'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('192.168.1.5'), false);
  assert.equal(isLoopbackAddress('100.88.227.56'), false);
});

test('parseTrustedProxyIps 只收裸 IP 字面量', () => {
  assert.deepEqual(
    parseTrustedProxyIps('127.0.0.1, 10.0.0.5,10.0.0.5, 10.0.0.0/8, example.com, 10.0.0.5:8080, ::1'),
    ['127.0.0.1', '10.0.0.5', '::1'],
  );
  assert.deepEqual(parseTrustedProxyIps(undefined), []);
  assert.deepEqual(parseTrustedProxyIps(''), []);
});

test('forwardedClientIp 只接受单个 IP，多值头视为不可用', () => {
  assert.equal(forwardedClientIp(fakeRequest('127.0.0.1', { 'x-forwarded-for': '203.0.113.7' })).ip, '203.0.113.7');
  assert.equal(forwardedClientIp(fakeRequest('127.0.0.1', { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })).present, true);
  assert.equal(forwardedClientIp(fakeRequest('127.0.0.1', { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })).ip, undefined);
  assert.equal(forwardedClientIp(fakeRequest('127.0.0.1', { 'x-forwarded-for': 'not-an-ip' })).ip, undefined);
  assert.equal(forwardedClientIp(fakeRequest('127.0.0.1', { 'x-real-ip': '203.0.113.9' })).ip, '203.0.113.9');
  assert.equal(forwardedClientIp(fakeRequest('127.0.0.1')).present, false);
});

test('直连回环算本机，直连非回环算远端', () => {
  const local = resolveRequestOrigin(fakeRequest('127.0.0.1'));
  assert.equal(local.isLoopback, true);
  assert.equal(local.clientIp, '127.0.0.1');

  const remote = resolveRequestOrigin(fakeRequest('100.88.227.56'));
  assert.equal(remote.isLoopback, false);
  assert.equal(remote.clientIp, '100.88.227.56');
  assert.equal(remote.forwarded, false);
});

test('回环对端带转发头时不再算本机请求', () => {
  const origin = resolveRequestOrigin(fakeRequest('127.0.0.1', { 'x-forwarded-for': '203.0.113.7' }));
  assert.equal(origin.isLoopback, false);
  assert.equal(origin.forwarded, true);
  assert.equal(origin.trustedForward, false);
  assert.equal(origin.clientIp, '127.0.0.1');
});

test('登记过的可信代理给出的客户端 IP 才会被采信', () => {
  const trusted = resolveRequestOrigin(
    fakeRequest('127.0.0.1', { 'x-forwarded-for': '203.0.113.7' }),
    ['127.0.0.1'],
  );
  assert.equal(trusted.isLoopback, false);
  assert.equal(trusted.trustedForward, true);
  assert.equal(trusted.clientIp, '203.0.113.7');

  const untrusted = resolveRequestOrigin(
    fakeRequest('10.0.0.9', { 'x-forwarded-for': '203.0.113.7' }),
    ['127.0.0.1'],
  );
  assert.equal(untrusted.trustedForward, false);
  assert.equal(untrusted.clientIp, '10.0.0.9');
});

test('登记过的代理没带转发头时按非本机处理', () => {
  const origin = resolveRequestOrigin(fakeRequest('127.0.0.1'), ['127.0.0.1']);
  assert.equal(origin.isLoopback, false);
  assert.equal(origin.forwarded, true);
});

test('反向代理挡在网关前面时，报备不再被当成本机请求', async () => {
  const { server } = createAgent({ registry: new ServiceRegistry() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  // 模拟反向代理：监听回环，转发到网关，并带上 X-Forwarded-For。
  const proxy = http.createServer((req, res) => {
    const upstream = http.request(
      { host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers },
      up => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502).end();
    });
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = (proxy.address() as AddressInfo).port;

  try {
    const entry = { id: 'via-proxy', capabilities: ['probe'], port: 7788 };
    const viaProxy = await fetch(`http://127.0.0.1:${proxyPort}/services`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
      body: JSON.stringify(entry),
    });
    assert.equal(viaProxy.status, 403);

    // 直连网关仍然是本机请求，报备照旧可用。
    const direct = await fetch(`http://127.0.0.1:${port}/services`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(entry),
    });
    assert.equal(direct.status, 201);
  } finally {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('反向代理挡在网关前面时，local 共享服务不再对转发请求可见', async () => {
  const { server, registry } = createAgent({ registry: new ServiceRegistry() });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const proxy = http.createServer((req, res) => {
    const upstream = http.request(
      { host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers },
      up => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502).end();
    });
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = (proxy.address() as AddressInfo).port;

  try {
    registry.register({ id: 'secret-service', capabilities: ['secret.read'], port: 7789, sharing: 'local' });
    const viaProxy = await fetch(`http://127.0.0.1:${proxyPort}/services`, {
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    const body = await viaProxy.json() as { services: { id: string }[] };
    assert.equal(body.services.some(service => service.id === 'secret-service'), false);

    const direct = await fetch(`http://127.0.0.1:${port}/services`);
    const directBody = await direct.json() as { services: { id: string }[] };
    assert.equal(directBody.services.some(service => service.id === 'secret-service'), true);
  } finally {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

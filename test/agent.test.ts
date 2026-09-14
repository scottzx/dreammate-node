import assert from 'node:assert/strict';
import os from 'node:os';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { createAgent } from '../src/server.js';
import { ServiceRegistry, EVICT_AFTER_FAILURES } from '../src/registry.js';
import { nodeIdentity, nodeTypeOf, resetIdentityCache } from '../src/identity.js';
import { reportToAgent, withdrawFromAgent } from '../src/client.js';

/** 起在临时端口上，测试之间不会抢 36908。 */
async function withAgent<T>(
  registry: ServiceRegistry,
  body: (base: string, port: number) => Promise<T>,
  host = '127.0.0.1',
): Promise<T> {
  const { server } = createAgent({ registry });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await body(`http://127.0.0.1:${port}`, port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const sample = { id: 'session-registry', capabilities: ['sessions.read'], port: 7777 };

test('报备后出现在 /services 与 /manifest 里', async () => {
  await withAgent(new ServiceRegistry(), async (base) => {
    const created = await fetch(`${base}/services`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sample),
    });
    assert.equal(created.status, 201);

    const listed = (await (await fetch(`${base}/services`)).json()) as { services: { id: string }[] };
    assert.equal(listed.services.length, 1);
    assert.equal(listed.services[0]!.id, 'session-registry');

    const manifest = (await (await fetch(`${base}/manifest`)).json()) as {
      node_id: string;
      services: { id: string; port: number; reachability: string }[];
    };
    assert.ok(manifest.node_id);
    assert.equal(manifest.services[0]!.port, 7777);
    // 省略 reachability 时按 network 理解——大多数服务是对外的。
    assert.equal(manifest.services[0]!.reachability, 'network');
  });
});

test('reachability=localhost 的服务在 manifest 里给的是回环地址', async () => {
  const registry = new ServiceRegistry();
  registry.register({ ...sample, reachability: 'localhost' });
  await withAgent(registry, async (base) => {
    const manifest = (await (await fetch(`${base}/manifest`)).json()) as {
      services: { access: { base_url: string }[] }[];
    };
    // 如实写 127.0.0.1，让对方一眼看出连不上，而不是给个连上就超时的地址。
    assert.match(manifest.services[0]!.access[0]!.base_url, /^http:\/\/127\.0\.0\.1:7777$/);
  });
});

test('报备只接受回环请求', async (t) => {
  // 找一个本机的非回环地址，从它连回来，remoteAddress 就不是 127.0.0.1 了。
  const external = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  if (!external) return t.skip('本机没有非回环 IPv4');

  const { server } = createAgent({ registry: new ServiceRegistry() });
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const post = (host: string): Promise<Response> =>
      fetch(`http://${host}:${port}/services`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sample),
      });
    // 同一个请求，只是来源地址不同。
    assert.equal((await post('127.0.0.1')).status, 201, '回环应该放行');
    assert.equal((await post(external)).status, 403, '非回环必须拒绝');
    // 注销同理，否则别人能把你的服务从网络上摘掉。
    const del = await fetch(`http://${external}:${port}/services/session-registry`, { method: 'DELETE' });
    assert.equal(del.status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('报备内容不合法就拒绝', async () => {
  await withAgent(new ServiceRegistry(), async (base) => {
    const bad = async (body: unknown): Promise<number> =>
      (await fetch(`${base}/services`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })).status;
    assert.equal(await bad({ capabilities: [], port: 1 }), 400, '缺 id');
    assert.equal(await bad({ id: 'x', capabilities: [] }), 400, '缺 port');
    assert.equal(await bad({ id: 'x', capabilities: [], port: 99999 }), 400, '端口越界');
    assert.equal(await bad({ id: 'x', port: 1, capabilities: 'nope' }), 400, 'capabilities 不是数组');
    assert.equal(await bad({ id: 'x', port: 1, capabilities: [], reachability: 'maybe' }), 400, '可达性取值非法');
  });
});

test('重复报备是更新，不是新增', async () => {
  const registry = new ServiceRegistry();
  registry.register(sample);
  registry.register({ ...sample, port: 8888 });
  assert.equal(registry.list().length, 1);
  assert.equal(registry.get('session-registry')!.port, 8888, '服务换端口重启后应该盖掉旧的');
});

test('探活把死掉的服务标 down，连续失败够多次就清掉', async () => {
  let alive = true;
  const registry = new ServiceRegistry({ probe: async () => alive });
  registry.register(sample);
  assert.equal(registry.get('session-registry')!.liveness, 'unknown', '还没探过 ≠ 探过且不通');

  await registry.probeAll();
  assert.equal(registry.get('session-registry')!.liveness, 'up');

  alive = false;
  await registry.probeAll();
  assert.equal(registry.get('session-registry')!.liveness, 'down');
  assert.equal(registry.list().length, 1, '抖一下不该立刻被清掉');

  for (let i = 1; i < EVICT_AFTER_FAILURES; i++) await registry.probeAll();
  assert.equal(registry.list().length, 0, '连续失败够多次就该移除');
});

test('client 在 agent 没起来时不抛错，只是报告失败', async () => {
  // 报备是可选的：agent 没装没起，服务都该照常工作。
  const base = 'http://127.0.0.1:1';
  const reported = await reportToAgent(sample, { baseUrl: base, timeoutMs: 300 });
  assert.equal(reported.ok, false);
  assert.match(reported.reason ?? '', /未运行/);
  const withdrawn = await withdrawFromAgent('session-registry', { baseUrl: base, timeoutMs: 300 });
  assert.equal(withdrawn.ok, false);
});

test('client 报备到真 agent 能成功', async () => {
  await withAgent(new ServiceRegistry(), async (base) => {
    assert.deepEqual(await reportToAgent(sample, { baseUrl: base }), { ok: true });
    assert.deepEqual(await withdrawFromAgent('session-registry', { baseUrl: base }), { ok: true });
    assert.equal((await withdrawFromAgent('session-registry', { baseUrl: base })).ok, false, '重复注销应失败');
  });
});

test('节点身份可用，tailscale 来源时名字不是 localhost', async () => {
  resetIdentityCache();
  const identity = await nodeIdentity();
  assert.ok(identity.node_id && identity.name && identity.type);
  assert.ok(['tailscale', 'local'].includes(identity.source));
  if (identity.source === 'tailscale') assert.notEqual(identity.name, 'localhost');
});

test('nodeTypeOf 映射 tailscale 的 OS，未知值原样降级', () => {
  assert.equal(nodeTypeOf('macOS'), 'macos');
  assert.equal(nodeTypeOf('iOS'), 'ios');
  assert.equal(nodeTypeOf('plan9'), 'plan9');
});

test('PATH 里没有 tailscale 时仍能从已知位置找到它', async (t) => {
  const { resetBinCache } = await import('../src/identity.js');
  const savedPath = process.env.PATH;
  // 模拟 launchd 的环境：PATH 里没有 homebrew。
  process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  try {
    resetIdentityCache();
    resetBinCache();
    const identity = await nodeIdentity({ force: true });
    if (identity.source === 'local') {
      return t.skip('本机没装 tailscale 或未登录，无从验证');
    }
    // 关键断言：PATH 里找不到，但候选路径兜住了，身份仍是 tailnet 的。
    assert.equal(identity.source, 'tailscale');
    assert.notEqual(identity.name, 'localhost');
  } finally {
    process.env.PATH = savedPath;
    resetIdentityCache();
    resetBinCache();
  }
});

test('对外服务给 MagicDNS 与 IP 两个 access，回环服务只给 127.0.0.1', () => {
  const registry = new ServiceRegistry();
  registry.register({ ...sample, reachability: 'network' });
  const services = registry.toServices('scott-mac.tailfb4720.ts.net', '100.88.227.56');
  const urls = services[0]!.access!.map((a) => a.base_url);
  // 顺序有意义：名字在前（可读、IP 变了不用改），IP 兜底。
  assert.deepEqual(urls, [
    'http://scott-mac.tailfb4720.ts.net:7777',
    'http://100.88.227.56:7777',
  ]);

  // 只听回环的服务给 IP 没有意义——外部本来就连不上。
  const loopback = new ServiceRegistry();
  loopback.register({ ...sample, reachability: 'localhost' });
  assert.deepEqual(
    loopback.toServices('scott-mac.tailfb4720.ts.net', '100.88.227.56')[0]!.access!.map((a) => a.base_url),
    ['http://127.0.0.1:7777'],
  );
});

test('没有 tailnet 时不给重复的 access', () => {
  const registry = new ServiceRegistry();
  registry.register({ ...sample, reachability: 'network' });
  // 回退身份下 host 就是主机名，没有单独的 tailnet IP。
  assert.equal(registry.toServices('some-host')[0]!.access!.length, 1);
  // host 与 ipv4 相同也不该给两条一样的。
  assert.equal(registry.toServices('100.88.227.56', '100.88.227.56')[0]!.access!.length, 1);
});

/* ---------- 启动时重建注册表 ---------- */

/** 起一个假服务，只回答 /manifest 与 /health——刚好是重建需要的两个端点。 */
async function withFakeService(
  manifest: unknown,
  body: (port: number) => Promise<void>,
  host = '127.0.0.1',
): Promise<void> {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    const ok = (payload: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.url === '/manifest') return ok(manifest);
    if (req.url === '/health') return ok({ status: 'ok' });
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  try {
    await body((server.address() as import('node:net').AddressInfo).port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const fakeManifest = {
  node_id: 'n1',
  name: 'x',
  type: 'linux',
  services: [
    { id: 'session-registry', name: 'session-reader', kind: 'session_registry', capabilities: ['sessions.read'] },
  ],
};

test('重建：扫约定端口，把还在跑的服务捡回来', async () => {
  const { rediscover } = await import('../src/rediscover.js');
  await withFakeService(fakeManifest, async (port) => {
    const registry = new ServiceRegistry();
    // agent 重启后注册表是空的——这正是要修的场景。
    assert.equal(registry.list().length, 0);
    const rebuilt = await rediscover(registry, { ports: [port] });
    assert.equal(rebuilt, 1);
    const service = registry.get('session-registry')!;
    assert.equal(service.port, port);
    assert.deepEqual(service.capabilities, ['sessions.read']);
    assert.equal(service.metadata?.rediscovered, true, '应标明是捡回来的，不是自己报的');
  });
});

test('重建：reachability 是探出来的，不是服务说的', async () => {
  const { rediscover } = await import('../src/rediscover.js');
  await withFakeService(fakeManifest, async (port) => {
    // 服务只在回环上，给一个连不上的"对外地址"——探不通就该判定 localhost。
    const registry = new ServiceRegistry();
    await rediscover(registry, { ports: [port], ipv4: '192.0.2.1', timeoutMs: 500 });
    assert.equal(registry.get('session-registry')!.reachability, 'localhost');
  });
});

test('重建：端口没人应答就跳过，不留下幽灵条目', async () => {
  const { rediscover } = await import('../src/rediscover.js');
  const registry = new ServiceRegistry();
  // 1 号端口不会有人应答。悬空条目比没有条目更糟。
  assert.equal(await rediscover(registry, { ports: [1], timeoutMs: 300 }), 0);
  assert.equal(registry.list().length, 0);
});

test('serveAgent 启动时会重建，可以关掉', async () => {
  const { serveAgent } = await import('../src/server.js');
  const quiet = await serveAgent({ port: 0, host: '127.0.0.1', rediscover: false });
  try {
    assert.equal(quiet.rebuilt, 0);
  } finally {
    quiet.registry.stop();
    await new Promise<void>((resolve) => quiet.server.close(() => resolve()));
  }
});

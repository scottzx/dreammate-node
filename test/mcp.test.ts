import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAgent } from '../src/server.js';
import { ServiceRegistry } from '../src/registry.js';
import { createMcpServer, MCP_TOOLS } from '../src/mcp.js';

/** 起在临时端口上的 agent 辅助函数。 */
async function withTestAgent<T>(
  registry: ServiceRegistry,
  body: (agentUrl: string) => Promise<T>,
): Promise<T> {
  const { server } = createAgent({ registry });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const agentUrl = `http://127.0.0.1:${port}`;
  try {
    return await body(agentUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** 启动连接好的 MCP Client/Server 配对。 */
async function withMcpClient<T>(
  agentUrl: string,
  body: (client: Client) => Promise<T>,
): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ agentUrl });
  await server.connect(serverTransport);

  const client = new Client({ name: 'test-harness', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);

  try {
    return await body(client);
  } finally {
    await client.close();
    await server.close();
  }
}

test('MCP_TOOLS 声明了固化的元工具', () => {
  const names = MCP_TOOLS.map((t) => t.name);
  assert.ok(names.includes('dreammate_list_nodes'));
  assert.ok(names.includes('dreammate_list_services'));
  assert.ok(names.includes('dreammate_list_capabilities'));
  assert.ok(names.includes('dreammate_inspect'));
  assert.ok(names.includes('dreammate_invoke'));
  assert.ok(names.includes('dreammate_download_skill'));
});

test('MCP: dreammate_list_nodes 能够发现网络中的设备节点', async () => {
  const registry = new ServiceRegistry();
  await withTestAgent(registry, async (agentUrl) => {
    await withMcpClient(agentUrl, async (client) => {
      const res = await client.callTool({
        name: 'dreammate_list_nodes',
        arguments: {},
      });
      assert.equal(res.isError, undefined);
      const data = JSON.parse((res.content as [{ text: string }])[0].text) as {
        current_node: string;
        total_matched: number;
        nodes: { name: string; is_self: boolean; online: boolean }[];
      };
      assert.ok(data.current_node);
      assert.ok(data.total_matched >= 1);
      const selfNode = data.nodes.find((n) => n.is_self);
      assert.ok(selfNode);
      assert.equal(selfNode.online, true);
    });
  });
});

test('MCP: dreammate_list_capabilities 与 dreammate_list_services 能够检索服务并过滤', async () => {
  const registry = new ServiceRegistry();
  registry.register({
    id: 'podcast-tool',
    name: '播客服务',
    capabilities: ['podcast.list', 'podcast.transcribe'],
    port: 7780,
    methods: {
      'podcast.transcribe': { description: '转写音频', parameters: { type: 'object' } },
    },
  });
  registry.register({
    id: 'wechat-tool',
    name: '微信管道',
    capabilities: ['wechat.messages'],
    port: 7781,
  });
  registry.register({
    id: 'disabled-tool',
    name: '维护中服务',
    capabilities: ['offline.job'],
    port: 7782,
    metadata: { enabled: false },
  });

  await withTestAgent(registry, async (agentUrl) => {
    await withMcpClient(agentUrl, async (client) => {
      // 1. 无过滤：使用 dreammate_list_services 检索
      const resAll = await client.callTool({
        name: 'dreammate_list_services',
        arguments: {},
      });
      const dataAll = JSON.parse((resAll.content as [{ text: string }])[0].text) as {
        total_matched: number;
        services: { service_id: string }[];
      };
      assert.equal(dataAll.total_matched, 2);
      assert.deepEqual(
        dataAll.services.map((s) => s.service_id).sort(),
        ['podcast-tool', 'wechat-tool'].sort(),
      );

      // 2. 关键词过滤：'transcribe'
      const resFilter = await client.callTool({
        name: 'dreammate_list_capabilities',
        arguments: { keyword: 'transcribe' },
      });
      const dataFilter = JSON.parse((resFilter.content as [{ text: string }])[0].text) as {
        total_matched: number;
        services: { service_id: string }[];
      };
      assert.equal(dataFilter.total_matched, 1);
      assert.equal(dataFilter.services[0]!.service_id, 'podcast-tool');

      // 3. 包含已禁用的服务
      const resDisabled = await client.callTool({
        name: 'dreammate_list_services',
        arguments: { include_disabled: true },
      });
      const dataDisabled = JSON.parse((resDisabled.content as [{ text: string }])[0].text) as {
        total_matched: number;
      };
      assert.equal(dataDisabled.total_matched, 3);
    });
  });
});

test('MCP: dreammate_inspect 能够按需返回详细方法契约与参数 Schema', async () => {
  const registry = new ServiceRegistry();
  registry.register({
    id: 'tingqi-service',
    name: '听奇播客转写服务',
    capabilities: ['podcast.transcribe'],
    port: 7780,
    methods: {
      'podcast.transcribe': {
        description: '将指定音频离线转写为 SRT 字幕',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: '本地文件路径' },
          },
          required: ['file_path'],
        },
      },
    },
  });

  await withTestAgent(registry, async (agentUrl) => {
    await withMcpClient(agentUrl, async (client) => {
      // 1. 检查整个服务
      const fullRes = await client.callTool({
        name: 'dreammate_inspect',
        arguments: { service_id: 'tingqi-service' },
      });
      const fullData = JSON.parse((fullRes.content as [{ text: string }])[0].text) as {
        service_id: string;
        methods: Record<string, { description: string }>;
      };
      assert.equal(fullData.service_id, 'tingqi-service');
      assert.ok(fullData.methods['podcast.transcribe']);

      // 2. 检查单项 method
      const singleRes = await client.callTool({
        name: 'dreammate_inspect',
        arguments: { service_id: 'tingqi-service', method: 'podcast.transcribe' },
      });
      const singleData = JSON.parse((singleRes.content as [{ text: string }])[0].text) as {
        method: string;
        details: { description: string };
      };
      assert.equal(singleData.method, 'podcast.transcribe');
      assert.equal(singleData.details.description, '将指定音频离线转写为 SRT 字幕');

      // 3. 查询不存在的服务
      const notFoundRes = await client.callTool({
        name: 'dreammate_inspect',
        arguments: { service_id: 'no-such-service' },
      });
      assert.equal(notFoundRes.isError, true);
      assert.match((notFoundRes.content as [{ text: string }])[0].text, /未找到服务/);
    });
  });
});

test('MCP: dreammate_inspect 能够按需返回业务 SOP / 技能指南并支持未声明 capabilities 的服务', async () => {
  const registry = new ServiceRegistry();
  // 报备一个 capabilities 省略，但带有 skills 的服务
  registry.register({
    id: 'session-reader',
    name: '会话管理服务',
    port: 7788,
    skills: {
      '1session-remote-guide': {
        name: '1session-remote-guide',
        description: '远程会话分析与增量提取',
        sop: '# 远程会话分析 SOP\n1. 调用 dreammate_invoke 查会话',
      },
    },
  });

  await withTestAgent(registry, async (agentUrl) => {
    await withMcpClient(agentUrl, async (client) => {
      // 1. 列表能看到 skills 并且 capabilities 为空数组
      const listRes = await client.callTool({
        name: 'dreammate_list_capabilities',
        arguments: { keyword: 'session' },
      });
      const listData = JSON.parse((listRes.content as [{ text: string }])[0].text) as {
        services: { service_id: string; capabilities: string[]; skills: string[] }[];
      };
      assert.equal(listData.services.length, 1);
      assert.deepEqual(listData.services[0]!.capabilities, []);
      assert.deepEqual(listData.services[0]!.skills, ['1session-remote-guide']);

      // 2. 检查特定 skill
      const skillRes = await client.callTool({
        name: 'dreammate_inspect',
        arguments: { service_id: 'session-reader', skill: '1session-remote-guide' },
      });
      const skillData = JSON.parse((skillRes.content as [{ text: string }])[0].text) as {
        skill: string;
        defined: boolean;
        details: { sop: string };
      };
      assert.equal(skillData.skill, '1session-remote-guide');
      assert.equal(skillData.defined, true);
      assert.match(skillData.details.sop, /远程会话分析 SOP/);

      // 3. 检查不存在的 skill
      const missingSkillRes = await client.callTool({
        name: 'dreammate_inspect',
        arguments: { service_id: 'session-reader', skill: 'non-existent-skill' },
      });
      const missingData = JSON.parse((missingSkillRes.content as [{ text: string }])[0].text) as {
        defined: boolean;
        details: { message: string };
      };
      assert.equal(missingData.defined, false);
      assert.match(missingData.details.message, /未找到名为 "non-existent-skill"/);
    });
  });
});

test('MCP: dreammate_invoke 能够通过通用路由触发下游业务服务', async () => {
  let receivedAction: string | undefined;
  let receivedParams: Record<string, unknown> | undefined;

  // 模拟真实运行的下游业务微服务
  const downstream = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/invoke') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { capability: string; params: Record<string, unknown> };
        receivedAction = parsed.capability;
        receivedParams = parsed.params;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', task_id: 'job-999', output: 'Transcribed successfully' }));
      });
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => downstream.listen(0, '127.0.0.1', resolve));
  const downstreamPort = (downstream.address() as AddressInfo).port;

  try {
    const registry = new ServiceRegistry();
    registry.register({
      id: 'audio-processor',
      capabilities: ['audio.process'],
      port: downstreamPort,
    });

    await withTestAgent(registry, async (agentUrl) => {
      await withMcpClient(agentUrl, async (client) => {
        const invokeRes = await client.callTool({
          name: 'dreammate_invoke',
          arguments: {
            service_id: 'audio-processor',
            capability: 'audio.process',
            params: { file: 'sample.wav', speed: 1.5 },
          },
        });

        assert.equal(invokeRes.isError, undefined);
        const data = JSON.parse((invokeRes.content as [{ text: string }])[0].text) as {
          status: string;
          output: string;
        };
        assert.equal(data.status, 'ok');
        assert.equal(data.output, 'Transcribed successfully');

        assert.equal(receivedAction, 'audio.process');
        assert.deepEqual(receivedParams, { file: 'sample.wav', speed: 1.5 });
      });
    });
  } finally {
    await new Promise<void>((resolve) => downstream.close(() => resolve()));
  }
});

test('MCP: 在 node-agent 未启动时返回友好引导提示', async () => {
  // 连到一个无效端口
  await withMcpClient('http://127.0.0.1:1', async (client) => {
    const res = await client.callTool({
      name: 'dreammate_list_capabilities',
      arguments: {},
    });
    assert.equal(res.isError, true);
    assert.match((res.content as [{ text: string }])[0].text, /无法连接到/);
  });
});

test('MCP: dreammate_download_skill 能够下载并安装/预览远程技能包', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');

  const registry = new ServiceRegistry();
  registry.register({
    id: 'writer-service',
    name: '写作服务',
    port: 7799,
    skills: {
      'xhs-card': {
        name: 'xhs-card',
        description: '小红书卡片排版技能',
        sop: '# XHS Card SOP\nGenerate cards cleanly.',
      },
    },
  });

  await withTestAgent(registry, async (agentUrl) => {
    await withMcpClient(agentUrl, async (client) => {
      // 1. 内存预览模式 (install: false)
      const previewRes = await client.callTool({
        name: 'dreammate_download_skill',
        arguments: {
          service_id: 'writer-service',
          skill: 'xhs-card',
          install: false,
        },
      });
      assert.equal(previewRes.isError, undefined);
      const previewData = JSON.parse((previewRes.content as [{ text: string }])[0].text) as {
        status: string;
        files: string[];
      };
      assert.equal(previewData.status, 'preview');
      assert.ok(previewData.files.some((f) => f.includes('SKILL.md')));

      // 2. 安装落盘模式 (install: true)
      const tmpDest = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-mcp-skills-'));
      const installRes = await client.callTool({
        name: 'dreammate_download_skill',
        arguments: {
          service_id: 'writer-service',
          skill: 'xhs-card',
          target_dir: tmpDest,
          install: true,
        },
      });
      assert.equal(installRes.isError, undefined);
      const installData = JSON.parse((installRes.content as [{ text: string }])[0].text) as {
        status: string;
        installed_path: string;
      };
      assert.equal(installData.status, 'installed');
      assert.ok(fs.existsSync(path.join(installData.installed_path, 'SKILL.md')));
      const content = fs.readFileSync(path.join(installData.installed_path, 'SKILL.md'), 'utf8');
      assert.match(content, /Generate cards cleanly/);

      fs.rmSync(tmpDest, { recursive: true, force: true });
    });
  });
});

test('MCP: dreammate_list_services 返回 execution/lifecycle 且 dreammate_manage_service 能管理启停', async () => {
  const http = await import('node:http');

  let stopped = false;
  const mockServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/shutdown') {
      stopped = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'shutting down' }));
      mockServer.close();
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((r) => mockServer.listen(0, '127.0.0.1', r));
  const port = (mockServer.address() as any).port;

  const registry = new ServiceRegistry();
  registry.register({
    id: 'transcribe-svc',
    name: 'ASR 语音转写服务',
    port,
    execution: 'hybrid',
    command: 'transcribe',
    lifecycle: {
      can_shutdown: true,
      stop_endpoint: '/shutdown',
      can_spawn: true,
      start_command: 'transcribe serve',
    },
  });

  await withTestAgent(registry, async (agentUrl) => {
    await withMcpClient(agentUrl, async (client) => {
      // 1. dreammate_list_services 能看到 execution 与 lifecycle
      const listRes = await client.callTool({
        name: 'dreammate_list_services',
        arguments: { keyword: 'transcribe' },
      });
      const listData = JSON.parse((listRes.content as [{ text: string }])[0].text) as {
        services: any[];
      };
      assert.equal(listData.services.length, 1);
      assert.equal(listData.services[0].execution, 'hybrid');
      assert.equal(listData.services[0].command, 'transcribe');
      assert.equal(listData.services[0].lifecycle.can_shutdown, true);

      // 2. dreammate_manage_service: status
      const statusRes = await client.callTool({
        name: 'dreammate_manage_service',
        arguments: { service_id: 'transcribe-svc', action: 'status' },
      });
      const statusData = JSON.parse((statusRes.content as [{ text: string }])[0].text) as any;
      assert.equal(statusData.service_id, 'transcribe-svc');
      assert.equal(statusData.execution, 'hybrid');

      // 3. dreammate_manage_service: stop
      const stopRes = await client.callTool({
        name: 'dreammate_manage_service',
        arguments: { service_id: 'transcribe-svc', action: 'stop' },
      });
      assert.equal(stopRes.isError, undefined);
      assert.equal(stopped, true);
    });
  });
});

// Deterministic mesh fixtures: no dependency on the developer's DNS or Tailnet.
const fixturePeer = { node_id: 'peer-1', name: 'peer', dnsName: 'peer.test', ipv4: '100.64.0.2', online: true, is_self: false, type: 'linux' };
const fixtureService = { id: 'plane-pm', methods: {}, liveness: 'unknown', registeredAt: '2026-01-01T00:00:00Z' };
const jsonResponse = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const toolData = (r: any) => r.structuredContent ?? JSON.parse(r.content[0].text);

async function withMesh(t: any, handler: (url: string, init?: RequestInit) => Promise<Response> | Response, body: (client: Client) => Promise<void>) {
  const mock = t.mock.method(globalThis, 'fetch', (url: string, init?: RequestInit) => handler(String(url), init));
  try { await withMcpClient('http://local.test:36908', body); }
  finally { mock.mock.restore(); }
}

test('DMN-1/2: all uses registered IP and reports partial discovery', async t => {
  await withMesh(t, url => {
    if (url.endsWith('/nodes')) return jsonResponse({ nodes: [fixturePeer, { ...fixturePeer, name: 'broken', ipv4: '100.64.0.3' }] });
    if (url === 'http://100.64.0.2:36908/services') return jsonResponse({ node: 'peer', services: [fixtureService] });
    return jsonResponse({ error: 'unavailable' }, 503);
  }, async client => {
    const r = await client.callTool({ name: 'dreammate_list_services', arguments: { node: 'all', keyword: 'plane' } });
    const d = toolData(r);
    assert.equal(d.total_matched, 1);
    assert.equal(d.partial, true);
    assert.deepEqual(d.scans.map((s: any) => s.status), ['ok', 'http_error']);
    assert.equal(r.isError, undefined);
  });
});

test('DMN-1: all failed differs from complete zero matches and topology fallback', async t => {
  let mode = 'failed';
  await withMesh(t, url => {
    if (url.endsWith('/nodes')) return mode === 'fallback' ? jsonResponse({}, 500) : jsonResponse({ nodes: [fixturePeer] });
    return mode === 'failed' ? jsonResponse({}, 500) : jsonResponse({ services: [] });
  }, async client => {
    const call = () => client.callTool({ name: 'dreammate_list_services', arguments: { node: 'all' } });
    let r = await call(); assert.equal(r.isError, true); assert.equal(toolData(r).partial, true);
    mode = 'empty'; r = await call(); assert.equal(r.isError, undefined); assert.equal(toolData(r).partial, false);
    mode = 'fallback'; r = await call(); assert.equal(toolData(r).partial, true); assert.equal(toolData(r).discovery.status, 'failed');
  });
});

test('DMN-1: stalled response body times out and is reported', async t => {
  await withMesh(t, (url, init) => {
    if (url.endsWith('/nodes')) return jsonResponse({ nodes: [fixturePeer] });
    const stream = new ReadableStream({ start(controller) {
      const fail = () => controller.error(new DOMException('Timed out', 'TimeoutError'));
      if (init?.signal?.aborted) fail(); else init?.signal?.addEventListener('abort', fail, { once: true });
    } });
    return new Response(stream);
  }, async client => {
    const r = await client.callTool({ name: 'dreammate_list_services', arguments: { node: 'all' } });
    assert.equal(r.isError, true); assert.equal(toolData(r).scans[0].status, 'timeout');
  });
});

test('DMN-2: names, FQDN, IP and explicit URLs route consistently; writes are never retried', async t => {
  const requests: string[] = [];
  await withMesh(t, (url, init) => {
    if (url.endsWith('/nodes')) return jsonResponse({ nodes: [fixturePeer] });
    requests.push(url);
    if (init?.method === 'POST') throw new Error('response lost after send');
    if (url.endsWith('/services')) return jsonResponse({ services: [fixtureService] });
    return jsonResponse(fixtureService);
  }, async client => {
    for (const node of ['peer', 'peer.test', '100.64.0.2']) {
      await client.callTool({ name: 'dreammate_list_services', arguments: { node } });
      await client.callTool({ name: 'dreammate_inspect', arguments: { node, service_id: 'plane-pm' } });
      await client.callTool({ name: 'dreammate_manage_service', arguments: { node, service_id: 'plane-pm', action: 'status' } });
    }
    assert.ok(requests.every(u => u.startsWith('http://100.64.0.2:36908/')));
    await client.callTool({ name: 'dreammate_inspect', arguments: { node: 'http://other.test:1234/', service_id: 'plane-pm' } });
    assert.equal(requests.at(-1), 'http://other.test:1234/services/plane-pm');
    const before = requests.length;
    const r = await client.callTool({ name: 'dreammate_invoke', arguments: { node: 'peer', service_id: 'plane-pm', method: 'create' } });
    assert.equal(r.isError, true); assert.equal(requests.length - before, 1);
  });
});

test('DMN-3: preserve MCP errors, structured data, media and metadata; wrap ordinary JSON', async t => {
  let value: any = { isError: true, content: [{ type: 'text', text: 'business rejection' }], structuredContent: { error: 'denied' }, _meta: { upstream: true } };
  let status = 200;
  await withMesh(t, () => jsonResponse(value, status), async client => {
    const call = () => client.callTool({ name: 'dreammate_invoke', arguments: { service_id: 's', method: 'read' } });
    let r = await call(); assert.equal(r.isError, true); assert.deepEqual(r.structuredContent, value.structuredContent); assert.deepEqual(r.content, value.content); assert.equal((r._meta as any).upstream, true);
    value = { content: [{ type: 'image', data: 'YWJj', mimeType: 'image/png' }, { type: 'resource_link', uri: 'https://example.test/r', name: 'r' }] };
    r = await call(); assert.deepEqual(r.content, value.content);
    value = { task_id: 'plain' }; r = await call(); assert.deepEqual(toolData(r), value);
    value = { task_id: 'ok', content: 'ordinary business field' }; r = await call(); assert.deepEqual(toolData(r), value);
    value = { content: [], structuredContent: { denied: true } }; status = 403; r = await call(); assert.equal(r.isError, true); assert.equal((r._meta as any).dreammate.http_status, 403);
  });
});

test('DMN-5: network online does not imply gateway or service health', async t => {
  await withMesh(t, url => {
    if (url.endsWith('/nodes')) return jsonResponse({ node: 'local', nodes: [fixturePeer, { ...fixturePeer, name: 'down', ipv4: '100.64.0.3' }] });
    if (url === 'http://100.64.0.2:36908/health') return jsonResponse({ status: 'ok', service: 'node-agent' });
    if (url.endsWith('/services')) return jsonResponse({ services: [fixtureService, { ...fixtureService, id: 'healthy', port: 7792, liveness: 'up', lastProbedAt: '2026-01-02T00:00:00Z' }] });
    return jsonResponse({}, 503);
  }, async client => {
    let d = toolData(await client.callTool({ name: 'dreammate_list_nodes', arguments: {} }));
    assert.equal(d.nodes[0].network_online, true); assert.equal(d.nodes[0].gateway_reachable, true);
    assert.equal(d.nodes[1].network_online, true); assert.equal(d.nodes[1].gateway_reachable, false);
    assert.ok(d.nodes[0].gateway_checked_at);
    d = toolData(await client.callTool({ name: 'dreammate_list_services', arguments: {} }));
    assert.equal(d.services[0].service_health.status, 'unknown');
    assert.equal(d.services[0].service_health.checked_at, null);
    assert.equal(d.services[1].service_health.status, 'up');
    assert.equal(d.services[1].method_availability, undefined);
  });
});

test('DMN-1: malformed node responses are not empty successful scans', async t => {
  await withMesh(t, url => url.endsWith('/nodes') ? jsonResponse({ nodes: [fixturePeer] }) : jsonResponse({ unexpected: [] }), async client => {
    const r = await client.callTool({ name: 'dreammate_list_services', arguments: { node: 'all' } });
    assert.equal(r.isError, true); assert.equal(toolData(r).scans[0].status, 'invalid_response');
  });
});

test('DMN-2/6: skill/lifecycle routes use IP and inspect separates declared from availability', async t => {
  const requested: string[] = [];
  const availability = { state: 'unsupported', checked_at: '2026-09-29T00:00:00Z', reason: 'deployment evidence' };
  await withMesh(t, url => {
    if (url.endsWith('/nodes')) return jsonResponse({ nodes: [fixturePeer] });
    requested.push(url);
    return jsonResponse({ ...fixtureService, methods: { 'plane.page': { description: 'Page', parameters: { type: 'object' } } }, metadata: { method_availability: { 'plane.page': availability } } });
  }, async client => {
    const args = { node: 'peer', service_id: 'plane-pm' };
    const d = toolData(await client.callTool({ name: 'dreammate_inspect', arguments: { ...args, method: 'plane.page' } }));
    assert.equal(d.declared, true); assert.deepEqual(d.availability, availability);
    const unknown = toolData(await client.callTool({ name: 'dreammate_inspect', arguments: { ...args, method: 'other' } }));
    assert.equal(unknown.declared, false); assert.equal(unknown.availability.state, 'unknown');
    await client.callTool({ name: 'dreammate_download_skill', arguments: { ...args, skill: 's', install: false } });
    for (const action of ['start', 'stop']) await client.callTool({ name: 'dreammate_manage_service', arguments: { ...args, action } });
    assert.ok(requested.every(url => url.startsWith('http://100.64.0.2:36908/')));
    assert.ok(requested.some(url => url.endsWith('/archive')));
    assert.ok(requested.some(url => url.endsWith('/start')));
    assert.ok(requested.some(url => url.endsWith('/stop')));
  });
});

test('DMN-3: arrays and text are preserved; malformed content does not become an MCP result', async t => {
  let response = new Response('plain text');
  await withMesh(t, () => response, async client => {
    const call = () => client.callTool({ name: 'dreammate_invoke', arguments: { service_id: 's', method: 'read' } });
    assert.deepEqual((await call()).content, [{ type: 'text', text: 'plain text' }]);
    response = jsonResponse([1, 2]); assert.deepEqual(toolData(await call()), [1, 2]);
    response = jsonResponse({ content: [{ wrong: true }] });
    assert.deepEqual(toolData(await call()), { content: [{ wrong: true }] });
    response = new Response('denied', { status: 403 });
    const r = await call(); assert.equal(r.isError, true); assert.equal(toolData(r).http_status, 403);
  });
});

test('DMN-4: node HTTP transport distinguishes connection failure and timeout without retry', async t => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let timeout = false;
  const mocked = t.mock.method(globalThis, 'fetch', (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) !== 'http://127.0.0.1:32123/invoke') return originalFetch(url, init);
    calls++;
    if (!timeout) return Promise.reject(new Error('connection refused'));
    return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
  });
  try {
    const registry = new ServiceRegistry({ storagePath: false });
    registry.register({ id: 'downstream', execution: 'http', port: 32123 });
    await withTestAgent(registry, async url => {
      const invoke = () => originalFetch(`${url}/services/downstream/invoke`, { method: 'POST', body: JSON.stringify({ method: 'create' }) });
      let response = await invoke(); assert.equal(response.status, 502); assert.equal(((await response.json()) as { kind: string }).kind, 'transport');
      timeout = true; response = await invoke(); assert.equal(response.status, 504); assert.equal(((await response.json()) as { kind: string }).kind, 'timeout');
      assert.equal(calls, 2);
    });
  } finally { mocked.mock.restore(); }
});

test('DMN-1: self-only Tailnet fallback is not complete global discovery', async t => {
  let networkOnline: boolean | null = null;
  await withMesh(t, url => url.endsWith('/nodes')
    ? jsonResponse({ nodes: [{ ...fixturePeer, is_self: true, network_online: networkOnline }] })
    : jsonResponse({ services: [] }), async client => {
    for (const value of [null, false]) {
      networkOnline = value;
      const d = toolData(await client.callTool({ name: 'dreammate_list_services', arguments: { node: 'all' } }));
      assert.equal(d.partial, true); assert.equal(d.discovery.status, 'partial'); assert.equal(d.total_matched, 0);
    }
  });
});

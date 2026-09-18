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

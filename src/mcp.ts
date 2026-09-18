/**
 * DreamMate MCP Gateway — 基于 Model Context Protocol 的分布式大模型能力网关。
 *
 * 采用「两阶段渐进式发现（Progressive Discovery）」与全网分布式节点拓扑架构：
 * 1. dreammate_list_nodes: 列出局域网/Tailnet 内所有在线设备节点（设备级发现）；
 * 2. dreammate_list_capabilities: 轻量检索本机或指定远端节点上的服务与能力概况；
 * 3. dreammate_inspect: 按需获取目标节点上特定服务的方法契约与参数 Schema；
 * 4. dreammate_invoke: 通用分布式执行器，透明跨节点路由并执行服务。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { DEFAULT_PORTS } from '@1agents/dreammate-network';
import type { RegisteredService } from './registry.js';
import type { NetworkNode } from './identity.js';
import { installSkillPackage, listSkillArchive } from './skills.js';

export interface McpOptions {
  agentUrl?: string;
}

const DEFAULT_AGENT_URL = `http://127.0.0.1:${DEFAULT_PORTS['node-agent']}`;

function resolveNodeBaseUrl(localAgentUrl: string, node?: string): string {
  if (!node || node === 'localhost' || node === '127.0.0.1') {
    return localAgentUrl;
  }
  if (node.startsWith('http://') || node.startsWith('https://')) {
    return node;
  }
  return `http://${node}:${DEFAULT_PORTS['node-agent']}`;
}

function extractSkillsMap(service: RegisteredService): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (service.skills) {
    if (Array.isArray(service.skills)) {
      for (const item of service.skills) {
        if (item && typeof item === 'object' && 'name' in item) {
          result[String(item.name)] = item;
        }
      }
    } else if (typeof service.skills === 'object') {
      Object.assign(result, service.skills);
    }
  }
  if (service.metadata?.skills && typeof service.metadata.skills === 'object') {
    if (Array.isArray(service.metadata.skills)) {
      for (const item of service.metadata.skills) {
        if (item && typeof item === 'object' && 'name' in item) {
          result[String(item.name)] = item;
        }
      }
    } else {
      Object.assign(result, service.metadata.skills);
    }
  }
  if (service.metadata?.remote_skill && typeof service.metadata.remote_skill === 'object') {
    const rs = service.metadata.remote_skill as { name?: string };
    const key = rs.name || 'default';
    if (!result[key]) {
      result[key] = rs;
    }
  }
  return result;
}

export const MCP_TOOLS: Tool[] = [
  {
    name: 'dreammate_list_nodes',
    description:
      '发现局域网/Tailnet 中所有已知设备节点（包括本机与远端 Linux、Windows PC、Mac、移动设备等），展示其在线状态、操作系统与地址。',
    inputSchema: {
      type: 'object',
      properties: {
        online_only: {
          type: 'boolean',
          description: '是否仅列出当前在线的设备节点（默认 true）',
        },
        keyword: {
          type: 'string',
          description: '可选关键词（模糊匹配节点名称或操作系统类型）',
        },
      },
    },
  },
  {
    name: 'dreammate_list_services',
    description:
      '轻量检索指定节点（或本机、或全网 "all"）中已报备的服务列表与概要（两阶段发现第 1 步）。不包含庞大的入参 Schema，避免上下文溢出。支持关键词模糊匹配。',
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: '可选：指定设备节点名称或 IP（例如 "spark-e72e" 或 "all" 扫描全网）。省略时默认查询本机。',
        },
        keyword: {
          type: 'string',
          description: '可选关键词（模糊匹配服务 ID、名称、分类、方法契约或技能名称）',
        },
        kind: {
          type: 'string',
          description: '可选服务类型过滤（如 generic, agent_runtime, session_registry, resource_provider 等）',
        },
        include_disabled: {
          type: 'boolean',
          description: '是否包含已被软禁用的服务（默认 false）',
        },
      },
    },
  },
  {
    name: 'dreammate_list_capabilities',
    description:
      '(向后兼容别名，推荐使用 dreammate_list_services) 轻量检索指定节点中已报备的服务与能力概要。',
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: '可选：指定设备节点名称或 IP（省略时默认本机）',
        },
        keyword: {
          type: 'string',
          description: '可选关键词',
        },
        kind: {
          type: 'string',
          description: '可选服务类型过滤',
        },
        include_disabled: {
          type: 'boolean',
          description: '是否包含已禁用服务',
        },
      },
    },
  },
  {
    name: 'dreammate_inspect',
    description:
      '按需查看指定服务的方法契约、详细描述与入参 JSON Schema，或查看其附带的业务 SOP / 技能指南（两阶段发现第 2 步）。在准备调用具体工具前使用。',
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: '可选：目标服务所在的设备节点名称或 IP（省略时为本机）',
        },
        service_id: {
          type: 'string',
          description: '要查询的目标服务 ID',
        },
        method: {
          type: 'string',
          description: '可选：指定要查询的具体某项方法契约与入参 JSON Schema（例如 "asr.transcribe"）',
        },
        skill: {
          type: 'string',
          description: '可选：指定要查看的配套业务 SOP 或技能指南名称（查看操作规范、多步骤指导书）',
        },
        capability: {
          type: 'string',
          description: '可选（向后兼容别名，同 method）：指定要查询的方法名',
        },
      },
      required: ['service_id'],
    },
  },
  {
    name: 'dreammate_invoke',
    description:
      '通用分布式执行器：通过 DreamMate 网关透明路由并执行指定节点与服务的方法。',
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: '可选：目标服务所在的设备节点名称或 IP（省略时为本机）',
        },
        service_id: {
          type: 'string',
          description: '目标服务 ID',
        },
        method: {
          type: 'string',
          description: '要调用的方法名（例如 "asr.transcribe"）',
        },
        capability: {
          type: 'string',
          description: '可选（向后兼容别名，同 method）：要调用的方法名',
        },
        params: {
          type: 'object',
          description: '传递给该方法的参数键值对对象',
        },
      },
      required: ['service_id'],
    },
  },
  {
    name: 'dreammate_download_skill',
    description:
      '分布式 SkillsHub：从目标节点下载指定服务的配套完整技能包（包含 SKILL.md、脚本与静态资源），可直接安装到本地技能目录供 Agent 使用，或以内存预览模式查看。',
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: '可选：目标服务所在的设备节点名称或 IP（省略时为本机）',
        },
        service_id: {
          type: 'string',
          description: '目标服务 ID（例如 "transcribe"）',
        },
        skill: {
          type: 'string',
          description: '要下载的技能名称（例如 "transcribe"）',
        },
        target_dir: {
          type: 'string',
          description: '安装目标根目录（默认 "~/.gemini/config/skills"）。若 install 为 true，则解压到该目录下以技能名命名的子目录。',
        },
        install: {
          type: 'boolean',
          description: '是否落盘解压安装到 target_dir（默认 true；若为 false 则仅在内存中解析并返回技能文件列表与 SOP 内容）。',
        },
      },
      required: ['service_id', 'skill'],
    },
  },
];

export function createMcpServer(options: McpOptions = {}): Server {
  const agentUrl = options.agentUrl ?? DEFAULT_AGENT_URL;

  const server = new Server(
    {
      name: 'dreammate-mcp',
      version: '0.6.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: MCP_TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      if (name === 'dreammate_list_nodes') {
        const onlineOnly = args.online_only !== false;
        const keyword = (args.keyword as string | undefined)?.toLowerCase().trim();

        let res: Response;
        try {
          res = await fetch(`${agentUrl}/nodes`);
        } catch {
          return {
            content: [
              {
                type: 'text',
                text: `无法连接到 DreamMate node-agent (${agentUrl})。请确认本地 dreammate-node 守护进程是否已启动。`,
              },
            ],
            isError: true,
          };
        }

        if (!res.ok) {
          return {
            content: [{ type: 'text', text: `node-agent 响应异常: HTTP ${res.status}` }],
            isError: true,
          };
        }

        const data = (await res.json()) as { node: string; nodes: NetworkNode[] };
        let nodes = data.nodes ?? [];

        if (onlineOnly) {
          nodes = nodes.filter((n) => n.online);
        }
        if (keyword) {
          nodes = nodes.filter((n) => {
            const matchName = n.name.toLowerCase().includes(keyword);
            const matchType = n.type.toLowerCase().includes(keyword);
            const matchId = n.node_id.toLowerCase().includes(keyword);
            return matchName || matchType || matchId;
          });
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  current_node: data.node,
                  total_matched: nodes.length,
                  nodes,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      if (name === 'dreammate_list_services' || name === 'dreammate_list_capabilities') {
        const node = args.node as string | undefined;
        const keyword = (args.keyword as string | undefined)?.toLowerCase().trim();
        const kind = args.kind as string | undefined;
        const includeDisabled = Boolean(args.include_disabled);

        const fetchServicesForNode = async (targetUrl: string, nodeLabel: string) => {
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 3_000);
            const res = await fetch(`${targetUrl}/services`, { signal: controller.signal }).finally(() =>
              clearTimeout(timer),
            );
            if (!res.ok) return [];
            const data = (await res.json()) as { node?: string; services: RegisteredService[] };
            return (data.services ?? []).map((s) => ({ ...s, node: data.node ?? nodeLabel }));
          } catch {
            return [];
          }
        };

        let rawServices: (RegisteredService & { node?: string })[] = [];

        if (node === 'all') {
          // 扫描全网所有在线节点
          let nodesRes: Response | undefined;
          try {
            nodesRes = await fetch(`${agentUrl}/nodes`);
          } catch {
            // ignore
          }
          if (nodesRes && nodesRes.ok) {
            const nodeData = (await nodesRes.json()) as { nodes: NetworkNode[] };
            const onlinePeers = (nodeData.nodes ?? []).filter((n) => n.online);
            const batch = await Promise.all(
              onlinePeers.map((n) => {
                const target = n.is_self ? agentUrl : `http://${n.name}:${DEFAULT_PORTS['node-agent']}`;
                return fetchServicesForNode(target, n.name);
              }),
            );
            rawServices = batch.flat();
          } else {
            rawServices = await fetchServicesForNode(agentUrl, 'local');
          }
        } else {
          const targetUrl = resolveNodeBaseUrl(agentUrl, node);
          try {
            const res = await fetch(`${targetUrl}/services`);
            if (!res.ok) {
              return {
                content: [{ type: 'text', text: `节点 (${targetUrl}) 响应异常: HTTP ${res.status}` }],
                isError: true,
              };
            }
            const data = (await res.json()) as { node?: string; services: RegisteredService[] };
            rawServices = (data.services ?? []).map((s) => ({ ...s, node: data.node ?? (node || 'local') }));
          } catch {
            return {
              content: [
                {
                  type: 'text',
                  text: `无法连接到节点 (${targetUrl}) 的 36908 端口。请确认该设备是否在线并已启动 dreammate-node。`,
                },
              ],
              isError: true,
            };
          }
        }

        let services = rawServices;
        if (!includeDisabled) {
          services = services.filter((s) => s.metadata?.enabled !== false);
        }
        if (kind) {
          services = services.filter((s) => s.kind === kind);
        }
        if (keyword) {
          services = services.filter((s) => {
            const skillsMap = extractSkillsMap(s);
            const matchId = s.id.toLowerCase().includes(keyword);
            const matchName = s.name ? s.name.toLowerCase().includes(keyword) : false;
            const matchKind = s.kind ? s.kind.toLowerCase().includes(keyword) : false;
            const matchCaps = (s.capabilities ?? []).some((c) => c.toLowerCase().includes(keyword));
            const matchMethods = s.methods
              ? Object.keys(s.methods).some((m) => m.toLowerCase().includes(keyword))
              : false;
            const matchSkills = Object.keys(skillsMap).some((k) => k.toLowerCase().includes(keyword));
            return matchId || matchName || matchKind || matchCaps || matchMethods || matchSkills;
          });
        }

        const summary = services.map((s) => {
          const skillsMap = extractSkillsMap(s);
          return {
            node: s.node,
            service_id: s.id,
            name: s.name ?? s.id,
            kind: s.kind ?? 'generic',
            methods: s.methods ? Object.keys(s.methods) : [],
            skills: Object.keys(skillsMap),
            capabilities: s.capabilities ?? [],
            liveness: s.liveness,
            enabled: s.metadata?.enabled !== false,
            reachability: s.reachability ?? 'network',
          };
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  scope: node || 'local',
                  total_matched: summary.length,
                  services: summary,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      if (name === 'dreammate_inspect') {
        const node = args.node as string | undefined;
        const serviceId = args.service_id as string;
        const method = (args.method as string | undefined) ?? (args.capability as string | undefined);
        const skill = args.skill as string | undefined;

        if (!serviceId) {
          return {
            content: [{ type: 'text', text: '缺少必填参数: service_id' }],
            isError: true,
          };
        }

        const targetUrl = resolveNodeBaseUrl(agentUrl, node);
        let res: Response;
        try {
          res = await fetch(`${targetUrl}/services/${encodeURIComponent(serviceId)}`);
        } catch {
          return {
            content: [{ type: 'text', text: `无法连接到目标节点 (${targetUrl})。` }],
            isError: true,
          };
        }

        if (res.status === 404) {
          return {
            content: [{ type: 'text', text: `在节点 (${targetUrl}) 上未找到服务: ${serviceId}` }],
            isError: true,
          };
        }
        if (!res.ok) {
          return {
            content: [{ type: 'text', text: `节点响应异常: HTTP ${res.status}` }],
            isError: true,
          };
        }

        const service = (await res.json()) as RegisteredService;
        const skillsMap = extractSkillsMap(service);

        if (skill) {
          const skillDef = skillsMap[skill];
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    node: node || 'local',
                    service_id: service.id,
                    name: service.name,
                    skill,
                    defined: Boolean(skillDef),
                    details: skillDef ?? {
                      message: `在服务 ${service.id} 中未找到名为 "${skill}" 的技能。可用技能: ${Object.keys(skillsMap).join(', ') || '无'}`,
                    },
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        if (method) {
          const methodDef = service.methods?.[method];
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    node: node || 'local',
                    service_id: service.id,
                    name: service.name,
                    method,
                    defined: Boolean(methodDef),
                    details: methodDef ?? {
                      description: `方法 ${method} 尚未在 methods 契约中声明入参 Schema，可直接使用 params 对象传参`,
                    },
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  node: node || 'local',
                  service_id: service.id,
                  name: service.name,
                  kind: service.kind,
                  methods: service.methods ?? {},
                  skills: Object.keys(skillsMap),
                  capabilities: service.capabilities ?? [],
                  reachability: service.reachability,
                  liveness: service.liveness,
                  enabled: service.metadata?.enabled !== false,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      if (name === 'dreammate_invoke') {
        const node = args.node as string | undefined;
        const serviceId = args.service_id as string;
        const method = (args.method as string | undefined) ?? (args.capability as string | undefined);
        const params = (args.params as Record<string, unknown> | undefined) ?? {};

        if (!serviceId || !method) {
          return {
            content: [{ type: 'text', text: '缺少必填参数: service_id 和 method (或 capability)' }],
            isError: true,
          };
        }

        const targetUrl = resolveNodeBaseUrl(agentUrl, node);
        let res: Response;
        try {
          res = await fetch(`${targetUrl}/services/${encodeURIComponent(serviceId)}/invoke`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ method, capability: method, params }),
          });
        } catch (err: unknown) {
          return {
            content: [
              {
                type: 'text',
                text: `无法通过 DreamMate 路由执行调用 (${targetUrl}): ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }

        const rawText = await res.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawText);
        } catch {
          parsed = rawText;
        }

        if (!res.ok) {
          return {
            content: [
              {
                type: 'text',
                text: `执行失败 (HTTP ${res.status}): ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2)}`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2),
            },
          ],
        };
      }

      if (name === 'dreammate_download_skill') {
        const node = args.node as string | undefined;
        const serviceId = args.service_id as string;
        const skill = args.skill as string;
        const targetDir = (args.target_dir as string | undefined) || '~/.gemini/config/skills';
        const install = args.install !== false;

        if (!serviceId || !skill) {
          return {
            content: [{ type: 'text', text: '缺少必填参数: service_id 和 skill' }],
            isError: true,
          };
        }

        const targetUrl = resolveNodeBaseUrl(agentUrl, node);
        let res: Response;
        try {
          res = await fetch(
            `${targetUrl}/services/${encodeURIComponent(serviceId)}/skills/${encodeURIComponent(skill)}/archive`,
          );
        } catch (err: unknown) {
          return {
            content: [
              {
                type: 'text',
                text: `无法从目标节点 (${targetUrl}) 下载技能归档: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }

        if (res.status === 404) {
          return {
            content: [
              {
                type: 'text',
                text: `在节点 (${targetUrl}) 的服务 "${serviceId}" 中未找到技能 "${skill}" 的归档包。`,
              },
            ],
            isError: true,
          };
        }
        if (!res.ok) {
          return {
            content: [{ type: 'text', text: `下载技能失败: HTTP ${res.status}` }],
            isError: true,
          };
        }

        const arrayBuffer = await res.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        if (install) {
          try {
            const installedPath = await installSkillPackage(buffer, targetDir, skill);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      status: 'installed',
                      service_id: serviceId,
                      skill,
                      target_dir: targetDir,
                      installed_path: installedPath,
                      node: node || 'local',
                      message: `技能 "${skill}" 已成功从节点分发并安装到本地: ${installedPath}。当前 Agent 即可直接激活使用此技能。`,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          } catch (err: unknown) {
            return {
              content: [
                {
                  type: 'text',
                  text: `解压并安装技能包失败: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              isError: true,
            };
          }
        } else {
          // 预览模式
          try {
            const files = await listSkillArchive(buffer);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      status: 'preview',
                      service_id: serviceId,
                      skill,
                      node: node || 'local',
                      archive_bytes: buffer.byteLength,
                      files,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          } catch (err: unknown) {
            return {
              content: [
                {
                  type: 'text',
                  text: `解析技能归档包清单失败: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              isError: true,
            };
          }
        }
      }

      return {
        content: [{ type: 'text', text: `未知工具调用: ${name}` }],
        isError: true,
      };
    } catch (err: unknown) {
      return {
        content: [
          {
            type: 'text',
            text: `执行异常: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

export async function runMcpServer(options: McpOptions = {}): Promise<void> {
  const server = createMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

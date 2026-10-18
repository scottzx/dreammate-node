/**
 * DreamMate MCP Gateway — 基于 Model Context Protocol 的分布式大模型能力网关。
 *
 * 采用「两阶段渐进式发现（Progressive Discovery）」与全网分布式节点拓扑架构：
 * 1. dreammate_list_nodes: 列出局域网/Tailnet 内所有在线设备节点（设备级发现）；
 * 2. dreammate_search_tools: 按用户意图检索少量具体方法摘要（推荐）；
 *    dreammate_search_skills / dreammate_read_skill: 独立项目技能的检索与固定版本按需读取；
 *    dreammate_list_services: 有界分页浏览本机或远端节点上的服务概况；
 *    dreammate_list_capabilities 为其向后兼容别名；
 * 3. dreammate_inspect: 按需获取目标节点上特定服务的方法契约与参数 Schema；
 * 4. dreammate_invoke: 通用分布式执行器，透明跨节点路由并执行服务；
 * 5. dreammate_download_skill: 从目标节点下载并安装/预览配套技能包；
 * 6. dreammate_manage_service: 部分生命周期管理（start / stop / status）。
 */
import { isIP } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  type Tool,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { DEFAULT_PORTS } from '@1agents/dreammate-network';
import type { RegisteredService, MethodDescriptor } from './registry.js';
import type { NetworkNode } from './identity.js';
import { directoryNodeUrl, findDirectoryNode, type NodeDirectory } from './node-directory.js';
import { installSkillPackage, listSkillArchive } from './skills.js';
import { withRequestTimeout } from './request-timeout.js';
import { pageResponse, parsePageOptions, searchTools, searchSkills } from './tool-search.js';
import { discoverEmbeddingProviders } from './embedding-providers.js';
import { scanSkillCatalog } from './skill-catalog.js';
import { installMcpReload } from './mcp-runtime.js';
import { loadPrivateMcpSources, type PrivateMcpSources } from './mcp-client-sources.js';

export interface McpOptions {
  agentUrl?: string;
  /** Startup-only private sources. Never registered with an HTTP node or selected by tool arguments. */
  privateMcpSources?: PrivateMcpSources;
  /** Private client configuration file; used by the stdio entry point only. */
  mcpConfig?: string;
  /** Explicitly imported address snapshot. No live topology queries in this mode. */
  nodeDirectory?: NodeDirectory;
  /** Optional local embedding endpoint, shared by method and skill searches. */
  embeddingUrl?: string;
  embeddingModel?: string;
  embeddingTimeoutMs?: number;
}

const DEFAULT_AGENT_URL = `http://127.0.0.1:${DEFAULT_PORTS['node-agent']}`;

function nodeBaseUrl(localAgentUrl: string, node: NetworkNode): string {
  return node.is_self ? localAgentUrl : `http://${node.ipv4 || node.dnsName || node.name}:${DEFAULT_PORTS['node-agent']}`;
}

/** Resolve before sending a request. Never replay a mutation after a network error. */
async function resolveNodeBaseUrl(localAgentUrl: string, node?: string, directory?: NodeDirectory): Promise<string> {
  if (node === '@client') throw new Error('@client 仅支持当前进程私有 MCP 的 search/services/inspect/invoke，不是网络节点');
  if (!node || node === 'localhost' || node === '127.0.0.1') return localAgentUrl;
  if (/^https?:\/\//.test(node)) return node.replace(/\/+$/, '');
  const cached = directory ? findDirectoryNode(directory, node) : undefined;
  if (cached) return directoryNodeUrl(cached);
  if (isIP(node)) return `http://${isIP(node) === 6 ? `[${node}]` : node}:${DEFAULT_PORTS['node-agent']}`;
  // Preserve an explicitly supplied host:port.
  if (node.includes(':')) return `http://${node}`;
  if (directory) {
    throw new Error(`节点不在导入的地址簿中: ${node}；请重新导入、指定完整 URL 或使用 --live`);
  }
  const wanted = node.toLowerCase().replace(/\.$/, '');
  let nodes: NetworkNode[] = [];
  try {
    const response = await fetch(`${localAgentUrl}/nodes`, { signal: AbortSignal.timeout(3000) });
    if (response.ok) {
      const data = await response.json() as { nodes?: NetworkNode[] };
      if (Array.isArray(data.nodes)) nodes = data.nodes;
    } else await response.body?.cancel();
  } catch { /* An unregistered DNS host remains usable without the local agent. */ }
  const matches = nodes.filter(n => n && [n.node_id, n.name, n.dnsName, n.ipv4]
    .some(alias => typeof alias === 'string' && alias.toLowerCase().replace(/\.$/, '') === wanted));
  if (matches.length > 1) throw new Error(`节点名称不唯一: ${node}，请指定 IP 或完整域名`);
  return matches[0] ? nodeBaseUrl(localAgentUrl, matches[0]) : `http://${node}:${DEFAULT_PORTS['node-agent']}`;
}

function serviceHealth(service: RegisteredService) {
  return {
    status: service.lastProbedAt ? service.liveness : 'unknown',
    checked_at: service.lastProbedAt ?? null,
    scope: 'registered_health_endpoint',
    methods_verified: false,
  };
}

function jsonResult(data: Record<string, unknown>, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    structuredContent: data, ...(isError ? { isError: true } : {}) };
}

function timedOut(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

interface NodeScan {
  node: string;
  url: string;
  status: 'ok' | 'http_error' | 'timeout' | 'unreachable' | 'invalid_response' | 'unsupported';
  checked_at: string;
  http_status?: number;
  error?: string;
  error_code?: string;
}

async function scanServices(url: string, node: string) {
  const networkNode = node === '@client' ? url : node;
  const scan: NodeScan = { node: networkNode, url, status: 'ok', checked_at: new Date().toISOString() };
  let services: (RegisteredService & { node: string; gateway_url: string })[] = [];
  try {
    const res = await withRequestTimeout(async signal => {
      const response = await fetch(`${url}/services`, { signal });
      const data = response.ok ? await response.json() : await response.body?.cancel();
      return { status: response.status, ok: response.ok, data };
    }, 3000);
    scan.http_status = res.status;
    if (!res.ok) {
      scan.status = 'http_error';
    } else {
      const data = res.data as { node?: string; services: RegisteredService[] } | null;
      if (!data || !Array.isArray(data.services) || data.services.some(s => !s || typeof s.id !== 'string')) {
        scan.status = 'invalid_response';
      } else services = data.services.map(s => ({ ...s, node: data.node === '@client' ? networkNode : data.node ?? networkNode, gateway_url: url }));
    }
  } catch (error) {
    scan.status = timedOut(error) ? 'timeout' : error instanceof SyntaxError ? 'invalid_response' : 'unreachable';
    scan.error = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error ? error.cause as { code?: string } | undefined : undefined;
    if (typeof cause?.code === 'string') scan.error_code = cause.code;
  }
  return { scan, services };
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

/** Shared discovery preserves failed scans even when a search has no matches. */
async function discoverTargets(agentUrl: string, node: string | undefined, options: McpOptions) {
  let discovery: { status: string; error?: string; exported_at?: string; scope?: string } = { status: 'ok' };
  let targets: { url: string; name: string }[];
  if (node === 'all' && options.nodeDirectory) {
    discovery = { status: 'cached', exported_at: options.nodeDirectory.exported_at, scope: 'imported_nodes_only' };
    targets = options.nodeDirectory.nodes.map(n => ({ url: directoryNodeUrl(n), name: n.name }));
  } else if (node === 'all') {
    try {
      const response = await fetch(`${agentUrl}/nodes`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
      const data = await response.json() as { nodes: NetworkNode[] };
      if (!Array.isArray(data.nodes) || data.nodes.length === 0) throw new Error('Invalid or empty node topology');
      const self = data.nodes.find(n => n.is_self);
      if (self && self.network_online !== undefined && self.network_online !== true) {
        discovery = { status: 'partial', error: 'Tailnet 状态不可用，节点清单可能仅包含本机' };
      }
      targets = data.nodes.filter(n => n.online || n.is_self).map(n => ({ url: nodeBaseUrl(agentUrl, n), name: n.name }));
    } catch (error) {
      discovery = { status: 'failed', error: `节点发现失败，仅扫描本机: ${error instanceof Error ? error.message : String(error)}` };
      targets = [{ url: agentUrl, name: 'local' }];
    }
  } else targets = [{ url: await resolveNodeBaseUrl(agentUrl, node, options.nodeDirectory), name: node || 'local' }];
  return { targets, discovery };
}

async function discoverServices(agentUrl: string, node: string | undefined, options: McpOptions) {
  const { targets, discovery } = node === '@client' ? { targets: [], discovery: { status: 'ok' } }
    : await discoverTargets(agentUrl, node, options);
  const batches = await Promise.all(targets.map(t => scanServices(t.url, t.name)));
  if (node === undefined || node === 'all' || node === '@client') {
    if (options.privateMcpSources) batches.push({
      scan: { node: '@client', url: 'client-private:', status: 'ok', checked_at: new Date().toISOString() },
      services: options.privateMcpSources.list().map(service => ({ ...service,
        node: '@client', gateway_url: 'client-private:', metadata: { ...service.metadata, client_private: true } })),
    });
    else if (node === '@client') batches.push({ scan: { node: '@client', url: 'client-private:',
      status: 'unsupported', checked_at: new Date().toISOString(), error: '未配置当前进程私有 MCP' }, services: [] });
  }
  const scans = batches.map(b => b.scan);
  return {
    services: batches.flatMap(b => b.services),
    evidence: {
      scope: node || 'local',
      partial: discovery.status !== 'ok' || scans.length === 0 || scans.some(s => s.status !== 'ok'),
      discovery,
      scans,
    },
    allFailed: scans.length === 0 || scans.every(s => s.status !== 'ok'),
  };
}

async function discoverSkills(agentUrl: string, node: string, options: McpOptions) {
  const { targets, discovery } = await discoverTargets(agentUrl, node, options);
  const batches = await Promise.all(targets.map(async target => {
    // A failed gateway probe already bounds unreachable nodes to three seconds.
    // Reachable skill providers get a separate budget for each catalog page.
    const services = await scanServices(target.url, target.name);
    if (services.scan.status !== 'ok') return { scan: services.scan, skills: [], services: [], providerScan: services.scan };
    const catalog = await scanSkillCatalog(target.url, target.name);
    return { ...catalog, services: services.services, providerScan: services.scan };
  }));
  const scans = batches.map(batch => batch.scan);
  return {
    skills: batches.flatMap(batch => batch.skills), services: batches.flatMap(batch => batch.services),
    providerDiscoveryPartial: batches.some(batch => batch.providerScan.status !== 'ok'),
    evidence: { scope: node, discovery, scans,
      partial: discovery.status !== 'ok' || scans.length === 0
        || scans.some(scan => scan.status !== 'ok' || ('catalog_truncated' in scan && scan.catalog_truncated)
          || ('diagnostics_count' in scan && scan.diagnostics_count)),
    },
    allFailed: batches.every(batch => batch.skills.length === 0) && (scans.length === 0 || scans.every(scan => scan.status !== 'ok')),
  };
}

const PAGE_PROPERTIES = {
  limit: { type: 'integer', minimum: 1, maximum: 20, description: '每页最多返回条数（浏览默认 10，上限 20）' },
  offset: { type: 'integer', minimum: 0, description: '分页起始位置（默认 0）；优先细化查询，需要更多候选时使用 next_offset' },
  max_chars: { type: 'integer', minimum: 1000, maximum: 12000, description: '返回摘要的字符预算（默认 6000，上限 12000）' },
};

function shortText(value: unknown, max = 240): string {
  const text = typeof value === 'string' ? value : '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function methodNames(service: RegisteredService) {
  return [...new Set([...Object.keys(service.methods ?? {}), ...(service.capabilities ?? [])])];
}

function boundedEvidence(evidence: Awaited<ReturnType<typeof discoverServices>>['evidence'], args: Record<string, unknown>) {
  const { maxChars } = parsePageOptions(args);
  const scanLimit = Math.min(4, Math.max(1, Math.floor(maxChars / 2000)));
  const scans = evidence.scans.length > scanLimit
    ? [...evidence.scans.filter(s => s.status !== 'ok'), ...evidence.scans.filter(s => s.status === 'ok')].slice(0, scanLimit)
    : evidence.scans;
  const result = {
    scope: shortText(evidence.scope, 40), partial: evidence.partial,
    discovery: { ...evidence.discovery, ...(evidence.discovery.error ? { error: shortText(evidence.discovery.error, 80) } : {}) },
    scan_count: evidence.scans.length,
    scans_omitted: evidence.scans.length - scans.length,
    scan_status_counts: Object.fromEntries([...new Set(evidence.scans.map(s => s.status))]
      .map(status => [status, evidence.scans.filter(s => s.status === status).length])),
    scans: scans.map(s => ({ node: shortText(s.node, 40), url: shortText(s.url, 160),
      status: s.status, checked_at: s.checked_at,
      ...(s.http_status ? { http_status: s.http_status } : {}),
      ...(s.error ? { error: shortText(s.error, 60) } : {}),
      ...(s.error_code ? { error_code: shortText(s.error_code, 40) } : {}),
      ...('catalog_truncated' in s && s.catalog_truncated ? { catalog_truncated: true } : {}),
      ...('diagnostics_count' in s && s.diagnostics_count ? { diagnostics_count: s.diagnostics_count } : {}),
    })),
  };
  // Reserve most of even the smallest budget for method/service results and paging metadata.
  const evidenceBudget = Math.min(1000, Math.max(500, maxChars - 500));
  while (result.scans.length > 1 && JSON.stringify(result, null, 2).length > evidenceBudget) {
    result.scans.pop();
    result.scans_omitted++;
  }
  return result;
}

export const MCP_TOOLS: Tool[] = [
  {
    name: 'dreammate_search_skills',
    description: '按任务跨节点检索项目或独立目录发布的 Skill，只返回名称、用途、来源和内容版本；关键词检索可用时结合已发现的本地向量模型。选中后用 dreammate_read_skill 读取完整指南及按需资源。搜索不会安装技能或执行脚本。',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', minLength: 1, maxLength: 2000, description: '任务描述或技能名称，不能为空' },
      node: { type: 'string', default: 'all', description: '默认跨已知节点；localhost 限定入口网关，也可指定节点名、IP 或 URL' },
      source_id: { type: 'string', description: '可选技能来源 ID，来自搜索结果或本机 skills list' },
      ...PAGE_PROPERTIES,
      limit: { ...PAGE_PROPERTIES.limit, default: 15 },
      max_chars: { ...PAGE_PROPERTIES.max_chars, default: 12000 },
    }, required: ['query'] },
  },
  {
    name: 'dreammate_read_skill',
    description: '从搜索结果指定的节点读取完整 Skill 指南，或按相对路径读取一个配套资源。必须带搜索返回的 revision；源文件变化会返回版本冲突，应重新检索。内容来自源节点，路径和运行依赖属于该节点；读取不会安装技能或执行脚本。',
    inputSchema: { type: 'object', properties: {
      skill_id: { type: 'string', description: '搜索结果中的技能 id' },
      revision: { type: 'string', pattern: '^[a-f0-9]{64}$', description: '搜索结果中的整包内容哈希，保证指南与资源版本一致' },
      node: { type: 'string', description: '搜索结果中的节点名、IP 或 URL；省略时读取入口网关' },
      resource: { type: 'string', description: '可选技能包内相对文件路径，例如 references/stages.md；省略时返回完整指南和资源清单' },
    }, required: ['skill_id', 'revision'] },
  },
  {
    name: 'dreammate_search_tools',
    description:
      '首选工具发现入口：默认跨节点搜索具体方法，最多返回 15 条相关方法摘要，并遵守字符预算；相关性允许时优先覆盖 2–3 个工具集。支持本地语义检索，未配置或不可用时降级为有界词法检索。先搜索，再对选中的方法 dreammate_inspect 获取 Schema；低匹配时细化 query 或分页。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 2000, description: '要完成的具体任务或工具名称；应描述动作和对象，不能为空' },
        node: { type: 'string', default: 'all', description: '默认 all：扫描已知节点与本进程私有来源；@client 仅查私有 MCP，localhost 仅查入口网关，也可指定节点名/IP/URL' },
        kind: { type: 'string', description: '可选服务类型过滤' },
        service_id: { type: 'string', description: '可选：仅搜索指定服务的方法' },
        include_disabled: { type: 'boolean', description: '是否包含禁用服务（默认 false）' },
        ...PAGE_PROPERTIES,
        limit: { ...PAGE_PROPERTIES.limit, default: 15, description: '每页最多返回条数（默认 15，上限 20）；字符预算不足时可能更少' },
        max_chars: { ...PAGE_PROPERTIES.max_chars, default: 12000, description: '搜索摘要的字符预算（默认及上限 12000）；可调小以节省上下文，返回条数可能相应减少' },
      },
      required: ['query'],
    },
  },
  {
    name: 'dreammate_list_nodes',
    description:
      '发现局域网/Tailnet 中所有已知设备节点（包括本机与远端 Linux、Windows PC、Mac、移动设备等），展示网络在线状态、网关探测结果、操作系统与地址；网络在线不代表服务可用。',
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
      '分页浏览已注册服务的短摘要；寻找具体任务的方法时优先使用 dreammate_search_tools。默认最多 10 个服务，每个服务最多 6 项方法名；支持描述关键词，不返回入参 Schema。',
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: '指定设备名/IP 或 all；@client 仅查本进程私有 MCP。省略时查询入口网关与私有来源。',
        },
        keyword: {
          type: 'string',
          description: '可选关键词（匹配服务 ID、名称、分类、方法名称和描述、技能名称和描述）',
        },
        kind: {
          type: 'string',
          description: '可选服务类型过滤（如 generic, agent_runtime, session_registry, resource_provider 等）',
        },
        include_disabled: {
          type: 'boolean',
          description: '是否包含已被软禁用的服务（默认 false）',
        },
        ...PAGE_PROPERTIES,
      },
    },
  },
  {
    name: 'dreammate_list_capabilities',
    description:
      'dreammate_list_services 的分页浏览兼容别名。寻找具体任务的方法时优先使用 dreammate_search_tools。',
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: '指定设备名/IP；@client 仅查私有 MCP。省略时查询入口网关与私有来源。',
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
        ...PAGE_PROPERTIES,
      },
    },
  },
  {
    name: 'dreammate_inspect',
    description:
      '搜索选定方法后，指定 service_id 和 method 获取该方法完整 Schema；省略 method 仅返回分页方法描述目录（默认 10 项），不会展开整个服务的参数。也可指定 skill 查看业务 SOP。',
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: '使用搜索结果的 node；@client 表示本进程私有 MCP。省略时为入口网关。',
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
        ...PAGE_PROPERTIES,
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
          description: '使用搜索结果的 node；@client 表示本进程私有 MCP。省略时为入口网关。',
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
  {
    name: 'dreammate_manage_service',
    description:
      '管理服务的生命周期（按需启动常驻 HTTP 服务、优雅停止常驻服务释放显存/内存、或查看运行状态与执行模式）。',
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
        action: {
          type: 'string',
          enum: ['start', 'stop', 'status'],
          description: '操作类型：start（按需启动常驻服务）、stop（停止服务释放资源）、status（查询服务状态与启停能力）',
        },
      },
      required: ['service_id', 'action'],
    },
  },
];

export function createMcpServer(options: McpOptions = {}): Server {
  const server = new Server(
    {
      name: 'dreammate-mcp',
      version: '0.10.0',
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

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callDreammateTool(request.params.name, request.params.arguments ?? {}, options),
  );

  return server;
}

/** One request, no listener, registration, identity file or background probe. */
export async function callDreammateTool(
  name: string,
  args: Record<string, unknown> = {},
  options: McpOptions = {},
): Promise<CallToolResult> {
  const agentUrl = (options.agentUrl ?? DEFAULT_AGENT_URL).replace(/\/+$/, '');

    try {
      if (name === 'dreammate_search_skills') {
        if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 2000) {
          return jsonResult({ error: 'query 必须是 1–2000 字符的非空任务描述' }, true);
        }
        if (args.source_id !== undefined && (typeof args.source_id !== 'string' || !/^skills-[A-Za-z0-9_-]{1,64}$/.test(args.source_id))) {
          return jsonResult({ error: 'source_id 必须是有效的 skills- 来源 ID' }, true);
        }
        if (args.node !== undefined && (typeof args.node !== 'string' || !args.node.trim())) return jsonResult({ error: 'node 必须是非空字符串' }, true);
        const searchArgs = { ...args, limit: args.limit ?? 15, max_chars: args.max_chars ?? 12000 };
        parsePageOptions(searchArgs);
        const found = await discoverSkills(agentUrl, (args.node as string | undefined) ?? 'all', options);
        const embeddingProviders = discoverEmbeddingProviders(found.services, options.embeddingModel ?? process.env.DREAMMATE_EMBEDDING_MODEL);
        const result = await searchSkills(found.skills, searchArgs, { ...options, embeddingProviders, responseBase: {
          ...boundedEvidence(found.evidence, searchArgs),
          provider_discovery_partial: found.providerDiscoveryPartial,
          ...(found.allFailed ? { error: '未能读取任何节点的技能目录；请核对网关连通性和技能目录接口版本' } : {}),
        } });
        return jsonResult(result, found.allFailed);
      }

      if (name === 'dreammate_read_skill') {
        const skillId = args.skill_id;
        const revision = args.revision;
        const resource = args.resource;
        if (typeof skillId !== 'string' || !skillId.trim() || skillId.length > 256 || skillId.includes('\0')
          || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) {
          return jsonResult({ error: 'skill_id 和搜索返回的 64 位 revision 必填' }, true);
        }
        if (args.node !== undefined && (typeof args.node !== 'string' || !args.node.trim() || args.node === 'all')) {
          return jsonResult({ error: '读取技能必须指定单个节点，不能使用 node: all' }, true);
        }
        if (resource !== undefined && (typeof resource !== 'string' || !resource || resource.length > 1024
          || resource.startsWith('/') || resource.includes('\\') || resource.includes('\0') || resource.split('/').some(part => part === '..' || part === '.' || part === '')
          || /^[A-Za-z]:/.test(resource))) return jsonResult({ error: 'resource 必须是技能包内的相对文件路径' }, true);
        const node = args.node as string | undefined;
        const target = await resolveNodeBaseUrl(agentUrl, node, options.nodeDirectory);
        const url = new URL(`${target}/skills/${encodeURIComponent(skillId)}`);
        url.searchParams.set('revision', revision);
        if (typeof resource === 'string') url.searchParams.set('resource', resource);
        const response = await withRequestTimeout(async signal => {
          const res = await fetch(url, { signal, redirect: 'error' });
          return { status: res.status, ok: res.ok, data: await res.json() as Record<string, unknown> };
        }, 5000);
        if (!response.ok) return jsonResult({ ...response.data, http_status: response.status,
          ...(response.status === 409 ? { code: 'SKILL_REVISION_CHANGED', next_action: '重新检索技能并使用新 revision 读取指南和资源' } : {}),
        }, true);
        if (!response.data || response.data.id !== skillId || response.data.revision !== revision
          || typeof response.data.content !== 'string' || !['utf8', 'base64'].includes(String(response.data.encoding))) {
          return jsonResult({ error: '技能接口返回了无效内容或不同版本', code: 'INVALID_SKILL_RESPONSE' }, true);
        }
        return jsonResult({ ...response.data, node: node || 'local', origin_gateway: target,
          execution: { performed: false, note: '内容来自来源节点；相对资源通过同一技能接口读取，脚本执行位置和依赖需按指南确定' },
        });
      }

      if (name === 'dreammate_list_nodes') {
        const onlineOnly = args.online_only !== false;
        const keyword = (args.keyword as string | undefined)?.toLowerCase().trim();

        if (options.nodeDirectory) {
          const directory = options.nodeDirectory;
          const nodes = directory.nodes.filter(n => !keyword || [n.node_id, n.name, n.type]
            .some(v => v.toLowerCase().includes(keyword))).map(n => ({
              ...n, gateway_url: n.agent_url, online: null, network_online: null,
              network_checked_at: null, gateway_reachable: null, gateway_checked_at: null,
              service_health: 'unknown',
            }));
          return jsonResult({ source: 'imported', exported_at: directory.exported_at,
            imported_at: directory.imported_at ?? null, default_node: directory.default_node,
            live_status: false, online_filter_applied: false, total_matched: nodes.length, nodes });
        }

        let res: Response;
        try {
          res = await fetch(`${agentUrl}/nodes`, { signal: AbortSignal.timeout(3000) });
        } catch {
          return {
            content: [
              {
                type: 'text',
                text: `无法连接到 DreamMate node-agent (${agentUrl})。请确认该网关可达且 dreammate-node 已启动。`,
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
                  nodes: await Promise.all(nodes.map(async n => {
                    const url = nodeBaseUrl(agentUrl, n);
                    let reachable = false;
                    let reason: string | undefined;
                    try {
                      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
                      if (response.ok) {
                        const health = await response.json() as { service?: string; status?: string };
                        reachable = health.service === 'node-agent' && health.status === 'ok';
                        if (!reachable) reason = 'unexpected_health_response';
                      } else { reason = `HTTP ${response.status}`; await response.body?.cancel(); }
                    } catch (error) { reason = timedOut(error) ? 'timeout' : 'unreachable'; }
                    return { ...n, network_online: n.network_online !== undefined ? n.network_online : n.is_self ? null : n.online,
                      network_checked_at: n.network_checked_at ?? null,
                      online_semantics: 'legacy network presence; self may be local-only',
                      gateway_reachable: reachable, gateway_url: url,
                      gateway_checked_at: new Date().toISOString(), ...(reason ? { gateway_error: reason } : {}),
                      service_health: 'unknown' };
                  })),
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      if (name === 'dreammate_search_tools') {
        // Reject empty queries before discovery, so they cannot become a full listing.
        if (typeof args.query !== 'string' || !args.query.trim()) {
          return jsonResult({ error: '缺少非空必填参数: query；请描述要完成的任务' }, true);
        }
        if (args.query.length > 2000) {
          return jsonResult({ error: 'query 最多允许 2000 个字符，请缩短任务描述' }, true);
        }
        const searchArgs = { ...args, limit: args.limit ?? 15, max_chars: args.max_chars ?? 12000 };
        parsePageOptions(searchArgs);
        const node = (args.node as string | undefined) ?? 'all';
        const found = await discoverServices(agentUrl, node, options);
        const embeddingProviders = discoverEmbeddingProviders(found.services, options.embeddingModel ?? process.env.DREAMMATE_EMBEDDING_MODEL);
        const result = await searchTools(found.services, searchArgs, { ...options, embeddingProviders, responseBase: {
          ...boundedEvidence(found.evidence, searchArgs),
          ...(found.allFailed ? { error: '无法连接到任何可查询节点，不能据此判断工具不存在' } : {}),
        } });
        return jsonResult(result, found.allFailed);
      }

      if (name === 'dreammate_list_services' || name === 'dreammate_list_capabilities') {
        parsePageOptions(args, { limit: 10 });
        const node = args.node as string | undefined;
        const keyword = typeof args.keyword === 'string' ? args.keyword.toLowerCase().trim() : '';
        const kind = args.kind as string | undefined;
        const found = await discoverServices(agentUrl, node, options);
        const matches = (value: unknown) => typeof value === 'string' && value.toLowerCase().includes(keyword);
        const services = found.services.filter(s => (args.include_disabled === true || s.metadata?.enabled !== false)
          && (!kind || s.kind === kind));
        const summary = services.flatMap(s => {
          const skillsMap = extractSkillsMap(s);
          const allMethods = methodNames(s);
          const matchedMethods = keyword ? allMethods.filter(m => matches(m) || matches(s.methods?.[m]?.description)) : allMethods;
          const matchedSkills = keyword ? Object.entries(skillsMap).filter(([name, definition]) => matches(name)
            || matches((definition as { description?: string } | null)?.description)).map(([name]) => name) : Object.keys(skillsMap);
          const serviceMatch = !keyword || [s.id, s.name, s.kind, s.metadata?.description].some(matches);
          if (!serviceMatch && matchedMethods.length === 0 && matchedSkills.length === 0) return [];
          const visibleMethods = (keyword && matchedMethods.length ? matchedMethods : allMethods).slice(0, 6);
          const visibleSkills = (keyword && matchedSkills.length ? matchedSkills : Object.keys(skillsMap)).slice(0, 6);
          const availability = s.metadata?.method_availability as Record<string, { state?: string; checked_at?: string }> | undefined;
          return [{
            node: s.node, service_id: s.id, name: shortText(s.name ?? s.id, 160),
            kind: s.kind ?? 'generic', execution: s.execution ?? (s.command ? 'hybrid' : 'http'),
            command: s.command ? shortText(s.command, 160) : undefined,
            lifecycle: s.lifecycle ? {
              can_shutdown: s.lifecycle.can_shutdown, can_spawn: s.lifecycle.can_spawn,
            } : undefined,
            methods: visibleMethods,
            method_count: allMethods.length,
            methods_omitted: (keyword && matchedMethods.length ? matchedMethods : allMethods).length - visibleMethods.length,
            method_descriptions: Object.fromEntries(visibleMethods.map(m => [m, shortText(s.methods?.[m]?.description)])),
            skills: visibleSkills, skills_omitted: Object.keys(skillsMap).length - visibleSkills.length,
            capabilities: (s.capabilities ?? []).filter(m => visibleMethods.includes(m)).slice(0, 6),
            liveness: s.liveness, service_health: serviceHealth(s),
            ...(availability ? { method_availability: Object.fromEntries(visibleMethods.filter(m => availability[m]).map(m => [m, {
              state: shortText(availability[m]?.state ?? 'unknown', 40), checked_at: availability[m]?.checked_at ?? null,
            }])) } : {}),
            enabled: s.metadata?.enabled !== false, reachability: s.reachability ?? 'network',
          }];
        });
        return jsonResult(pageResponse(summary, { ...args, limit: args.limit ?? 10 }, {
          ...boundedEvidence(found.evidence, args),
          next_step: '按任务使用 dreammate_search_tools；选定方法后指定 method 调用 dreammate_inspect',
          ...(found.allFailed ? { error: '无法连接到任何可查询节点，不能据此判断服务不存在' } : {}),
        }, 'services'), found.allFailed);
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

        if (!method && !skill) parsePageOptions(args, { limit: 10 });

        const privateSource = node === '@client' ? options.privateMcpSources : undefined;
        let service: RegisteredService;
        let targetUrl = '';
        if (node === '@client') {
          const found = privateSource?.get(serviceId);
          if (!found) return jsonResult({ node, service_id: serviceId, error: '当前私有 MCP 配置中没有此服务' }, true);
          service = found;
        } else {
          targetUrl = await resolveNodeBaseUrl(agentUrl, node, options.nodeDirectory);
          let res: Response;
          try {
            res = await fetch(`${targetUrl}/services/${encodeURIComponent(serviceId)}`, { signal: AbortSignal.timeout(5000) });
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

          service = (await res.json()) as RegisteredService;
        }
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
          let methodDef = service.methods?.[method];
          let resolvedMethod = method;
          if (privateSource) {
            const details = await privateSource.describe(serviceId, method);
            methodDef = details.details;
            resolvedMethod = details.method;
          } else if (service.metadata?.mcp_source) {
            const details = await withRequestTimeout(async signal => {
              const response = await fetch(`${targetUrl}/services/${encodeURIComponent(serviceId)}/methods/${encodeURIComponent(method)}`, { signal });
              return { ok: response.ok, status: response.status, data: await response.json() };
            }, 35000);
            if (details.ok) {
              const data = details.data as { method?: string; details?: MethodDescriptor & { schema_loaded?: boolean } };
              if (typeof data?.method !== 'string' || !data.details?.parameters || data.details.schema_loaded === false
                || typeof data.details.parameters !== 'object' || Array.isArray(data.details.parameters)) {
                return jsonResult({ error: 'MCP method schema is unavailable; received a summary instead of full parameters',
                  service_id: serviceId, method, schema_loaded: false, http_status: 502 }, true);
              }
              methodDef = data.details;
              resolvedMethod = data.method;
            } else if (details.status !== 404 || !methodDef || (methodDef as { schema_loaded?: boolean }).schema_loaded === false) {
              return jsonResult({ error: details.data, service_id: serviceId, method, schema_loaded: false, http_status: details.status }, true);
            }
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
                    method: resolvedMethod,
                    ...(resolvedMethod !== method ? { requested_method: method } : {}),
                    defined: Boolean(methodDef),
                    declared: Boolean(methodDef),
                    schema_loaded: Boolean(methodDef?.parameters),
                    availability: (service.metadata?.method_availability as Record<string, unknown> | undefined)?.[method]
                      ?? { state: 'unknown', checked_at: null, observations: [] },
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

        const directory = methodNames(service).map(methodName => ({
          method: methodName,
          description: shortText(service.methods?.[methodName]?.description),
          declared: Boolean(service.methods?.[methodName]),
          ...(() => {
            const availability = (service.metadata?.method_availability as Record<string, { state?: string; checked_at?: string }> | undefined)?.[methodName];
            return availability ? { availability: { state: shortText(availability.state ?? 'unknown', 40), checked_at: availability.checked_at ?? null } } : {};
          })(),
        }));
        const paged = pageResponse(directory, { ...args, limit: args.limit ?? 10 }, {
          node: node || 'local', service_id: service.id, name: shortText(service.name),
          kind: service.kind, execution: service.execution ?? (service.command ? 'hybrid' : 'http'),
          skills: Object.keys(skillsMap).slice(0, 6), skills_omitted: Math.max(0, Object.keys(skillsMap).length - 6),
          reachability: service.reachability, liveness: service.liveness, service_health: serviceHealth(service),
          enabled: service.metadata?.enabled !== false,
          schema_loaded: false,
          next_step: '指定 method 调用 dreammate_inspect，仅加载选中方法的完整 Schema',
        }, 'methods');
        const entries = paged.methods as typeof directory;
        return jsonResult({ ...paged, methods: Object.fromEntries(entries.map(({ method: methodName, ...details }) => [methodName, details])) });
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

        if (node === '@client') {
          const source = options.privateMcpSources;
          if (!source?.get(serviceId)) return jsonResult({ node, service_id: serviceId,
            error: '当前私有 MCP 配置中没有此服务', retryable: false }, true);
          const result = await source.invoke(serviceId, { method, params });
          const mcp = CallToolResultSchema.safeParse(result.data);
          const context = { node, service_id: serviceId, method, upstream_status: result.status, client_private: true };
          if (mcp.success && result.data && typeof result.data === 'object'
            && Array.isArray((result.data as { content?: unknown }).content)) return { ...mcp.data, ...(result.status >= 400 ? { isError: true } : {}),
            _meta: { ...mcp.data._meta, dreammate: context } };
          return jsonResult({ ...context, error: result.data, retryable: false }, true);
        }

        const targetUrl = await resolveNodeBaseUrl(agentUrl, node, options.nodeDirectory);
        let res: Response;
        try {
          res = await fetch(`${targetUrl}/services/${encodeURIComponent(serviceId)}/invoke`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ method, capability: method, params }),
            signal: AbortSignal.timeout(130000),
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

        // A valid MCP result has content blocks, not just a business field named content.
        const mcp = CallToolResultSchema.safeParse(parsed);
        const context = { node: node || 'local', service_id: serviceId, method, http_status: res.status };
        if (mcp.success && parsed && typeof parsed === 'object' && Array.isArray((parsed as { content?: unknown }).content)) {
          return { ...mcp.data, ...(!res.ok ? { isError: true } : {}),
            _meta: { ...mcp.data._meta, dreammate: context } };
        }
        if (!res.ok) {
          return jsonResult({ ...context, error: parsed, retryable: false }, true);
        }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return jsonResult(parsed as Record<string, unknown>);
        }
        return { content: [{ type: 'text', text: typeof parsed === 'string' ? parsed : JSON.stringify(parsed) }] };
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

        const targetUrl = await resolveNodeBaseUrl(agentUrl, node, options.nodeDirectory);
        let res: Response;
        try {
          res = await fetch(
            `${targetUrl}/services/${encodeURIComponent(serviceId)}/skills/${encodeURIComponent(skill)}/archive`,
            { signal: AbortSignal.timeout(30000) },
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

      if (name === 'dreammate_manage_service') {
        const node = args.node as string | undefined;
        const serviceId = args.service_id as string;
        const action = args.action as 'start' | 'stop' | 'status';

        if (!serviceId || !action) {
          return {
            content: [{ type: 'text', text: '缺少必填参数: service_id 和 action' }],
            isError: true,
          };
        }

        const targetUrl = await resolveNodeBaseUrl(agentUrl, node, options.nodeDirectory);

        if (action === 'status') {
          let res: Response;
          try {
            res = await fetch(`${targetUrl}/services/${encodeURIComponent(serviceId)}`, { signal: AbortSignal.timeout(5000) });
          } catch {
            return {
              content: [{ type: 'text', text: `无法连接到节点 (${targetUrl})。` }],
              isError: true,
            };
          }
          if (!res.ok) {
            return {
              content: [{ type: 'text', text: `获取服务状态失败: HTTP ${res.status}` }],
              isError: true,
            };
          }
          const service = (await res.json()) as RegisteredService;
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    node: node || 'local',
                    service_id: service.id,
                    name: service.name,
                    liveness: service.liveness,
                    service_health: serviceHealth(service),
                    method_availability: service.metadata?.method_availability,
                    execution: service.execution ?? (service.command ? 'hybrid' : 'http'),
                    command: service.command,
                    lifecycle: service.lifecycle,
                    port: service.port,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        if (action === 'start') {
          let res: Response;
          try {
            res = await fetch(`${targetUrl}/services/${encodeURIComponent(serviceId)}/start`, {
              method: 'POST',
              signal: AbortSignal.timeout(15000),
            });
          } catch (err: unknown) {
            return {
              content: [
                { type: 'text', text: `启动服务失败: ${err instanceof Error ? err.message : String(err)}` },
              ],
              isError: true,
            };
          }
          const data = (await res.json()) as Record<string, unknown>;
          if (!res.ok) {
            return {
              content: [
                { type: 'text', text: `启动服务失败 (HTTP ${res.status}): ${JSON.stringify(data, null, 2)}` },
              ],
              isError: true,
            };
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          };
        }

        if (action === 'stop') {
          let res: Response;
          try {
            res = await fetch(`${targetUrl}/services/${encodeURIComponent(serviceId)}/stop`, {
              method: 'POST',
              signal: AbortSignal.timeout(15000),
            });
          } catch (err: unknown) {
            return {
              content: [
                { type: 'text', text: `停止服务失败: ${err instanceof Error ? err.message : String(err)}` },
              ],
              isError: true,
            };
          }
          const data = (await res.json()) as Record<string, unknown>;
          if (!res.ok) {
            return {
              content: [
                { type: 'text', text: `停止服务失败 (HTTP ${res.status}): ${JSON.stringify(data, null, 2)}` },
              ],
              isError: true,
            };
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          };
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
}

export async function runMcpServer(options: McpOptions = {}): Promise<void> {
  let ownedSources: PrivateMcpSources | undefined;
  let server: Server | undefined;
  let removeReloadHandler = () => {};
  let stopping = false;
  const startupInput: Buffer[] = [];
  let startupBytes = 0;
  const bufferStartupInput = (chunk: Buffer) => {
    startupBytes += chunk.length;
    // Match the SDK's default read-buffer limit while private sources initialize.
    if (startupBytes > 10 * 1024 * 1024) {
      console.error('DreamMate MCP startup input exceeds the 10 MiB limit');
      shutdown();
      return;
    }
    startupInput.push(chunk);
  };
  const pauseStartupInput = () => {
    process.stdin.pause();
    process.stdin.off('data', bufferStartupInput);
  };
  const cleanup = async () => {
    pauseStartupInput();
    startupInput.length = 0;
    removeReloadHandler();
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    process.stdin.off('end', shutdown);
    await ownedSources?.stop();
  };
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void (async () => { try { await server?.close(); } finally { await cleanup(); process.exit(0); } })();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.stdin.once('end', shutdown);
  // An end listener alone does not read a paused pipe. Consume into a temporary
  // buffer so EOF can close private subprocesses even during initialization.
  process.stdin.on('data', bufferStartupInput);
  try {
    if (!options.privateMcpSources) {
      await loadPrivateMcpSources(options.mcpConfig, source => {
        ownedSources = source;
        if (stopping) void source.stop();
      });
    }
    if (stopping) { await cleanup(); return; }
    pauseStartupInput();
    if (startupBytes > 0) process.stdin.unshift(Buffer.concat(startupInput, startupBytes));
    startupInput.length = 0;
    if (ownedSources) options = { ...options, privateMcpSources: ownedSources };
    server = createMcpServer(options);
    removeReloadHandler = installMcpReload(server, options);
    server.onclose = () => { void cleanup(); };
    await server.connect(new StdioServerTransport());
    if (!stopping) process.stdin.resume();
  }
  catch (error) { await cleanup(); throw error; }
}

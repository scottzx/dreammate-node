import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';
import { cliError, CLI_OPTIONS } from './cli-process.js';
import { callDreammateTool, MCP_TOOLS } from './mcp.js';
import { directoryNodeUrl, directoryPath, exportDirectory, findDirectoryNode, gatewayUrl, loadDirectory,
  parseDirectory, saveDirectory, type NodeDirectory } from './node-directory.js';

export const CLI_USAGE = `dreammate-node cli — 执行一次，输出 JSON 后退出；不启动本机 agent

  nodes                     有缓存时离线列出设备；否则查询入口网关
  nodes export [--file nodes.json] [--default-node NAME]   在 Mac/在线网关侧导出地址簿
  nodes import --file nodes.json                          导入并替换本地地址簿（- 读 stdin）
  search --query TEXT       按任务跨节点查找方法摘要（默认最多 15 条）
  services                  分页浏览服务摘要（--node all 扫描全网）
  inspect --service ID      分页查看方法摘要；--method NAME 才展开该方法契约
                            --skill NAME 查看配套业务指南
  invoke --service ID --method NAME [--params '{"key":"value"}']
  manage --service ID --action start|stop|status
  tools                     输出工具名称和参数 Schema，无需联网

公共参数：
  --agent URL               已在线设备的网关，如 http://100.x.y.z:36908
                            优先于 DREAMMATE_AGENT_URL，再使用缓存默认节点
  --nodes-file PATH         本地缓存文件（或 DREAMMATE_NODES_FILE），默认 ~/.1agents/nodes.json
  --live                    忽略缓存，使用入口网关实时发现
  --node NAME|IP|URL|all     search 省略时扫描已知节点；其他命令默认入口网关设备
                            search --node localhost 可限定入口网关所在设备
  --keyword TEXT            nodes/services 关键词
  --query TEXT              search 必填的非空任务描述，最多 2000 字符
  --kind TYPE               search/services 类型
  --service ID              search 可选服务过滤；inspect/invoke/manage 必填
  --limit N                 search/services/inspect 每页 1–20 条；search 默认 15，其余 10
  --offset N                search/services/inspect 起始偏移 0–1000000，默认 0
  --max-chars N             摘要 JSON 预算 1000–12000 字符；search 默认 12000，其余 6000
  --include-disabled        包含已禁用服务
  --all                     nodes 包含离线设备
  --params -                invoke 从标准输入读取 JSON 对象
  --timeout-ms N            整条命令截止时间，默认 30000；invoke 默认 150000

stdout 为完整 MCP 结果 JSON（保留 content、structuredContent、isError）。
搜索在相关性与预算允许时尽量覆盖 2–3 个工具集（service_id），候选不足时可少于 15 条。
模型可集中运行在一台内网设备；在执行 CLI/MCP 的环境配置同一 DREAMMATE_EMBEDDING_URL。
退出码：0 成功，1 远端/业务/网络失败，2 参数错误；错误也输出 JSON，参数错误同时写 stderr。
只在手动导入时更新地址缓存；不启动后台刷新，不读写本机身份或服务注册表。
缓存记录不是在线证明。仍需 Node.js >=22.5。`;

const COMMANDS: Record<string, { tool: string; flags: string[]; required?: string[] }> = {
  nodes: { tool: 'dreammate_list_nodes', flags: ['keyword', 'all'] },
  search: { tool: 'dreammate_search_tools', flags: ['query', 'node', 'service', 'kind', 'include-disabled', 'limit', 'offset', 'max-chars'], required: ['query'] },
  services: { tool: 'dreammate_list_services', flags: ['node', 'keyword', 'kind', 'include-disabled', 'limit', 'offset', 'max-chars'] },
  inspect: { tool: 'dreammate_inspect', flags: ['node', 'service', 'method', 'skill', 'limit', 'offset', 'max-chars'], required: ['service'] },
  invoke: { tool: 'dreammate_invoke', flags: ['node', 'service', 'method', 'params'], required: ['service', 'method'] },
  manage: { tool: 'dreammate_manage_service', flags: ['node', 'service', 'action'], required: ['service', 'action'] },
  tools: { tool: '', flags: [] },
};

const NODE_HELP: Record<string, string> = {
  export: `dreammate-node cli nodes export [--agent URL] [--default-node NAME] [--file PATH|-]
从已在线网关导出所有已知节点（包括离线节点），不读取本地缓存。
--agent：优先于 DREAMMATE_AGENT_URL，默认 http://127.0.0.1:36908。
--default-node：默认使用来源网关自身节点，可指定清单内的名称或 ID。
--file：写入文件；省略或 - 时将可导入的 JSON 写到 stdout。
可用 --timeout-ms N 设置命令截止时间。`,
  import: `dreammate-node cli nodes import --file PATH|- [--nodes-file PATH]
校验后完整替换本地地址簿，不联网；非法文件保留旧缓存。
--file：必填，- 从 stdin 读取。
--nodes-file：优先于 DREAMMATE_NODES_FILE，默认 ~/.1agents/nodes.json。
导入后用 dreammate-node cli nodes 离线验证。
可用 --timeout-ms N 设置命令截止时间。`,
};

async function stdinJson(option = '--params'): Promise<string> {
  if (process.stdin.isTTY) throw new Error(`${option} - 需要通过管道传入 JSON`);
  let body = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) body += chunk;
  return body;
}

/** One-shot execution, optionally using a manually imported persistent address book. */
export async function runCli(argv: string[]): Promise<number> {
  let tool: string;
  let agentUrl: string;
  let nodeDirectory: NodeDirectory | undefined;
  const args: Record<string, unknown> = {};
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: CLI_OPTIONS,
    });
    if (values.help || positionals.length === 0) {
      console.log(positionals[0] === 'nodes' && NODE_HELP[positionals[1]!] ? NODE_HELP[positionals[1]!] : CLI_USAGE);
      return 0;
    }
    const command = positionals[0]!;
    if (command === 'nodes' && positionals.length === 2) {
      const action = positionals[1];
      const allowed = action === 'export' ? ['agent', 'file', 'default-node']
        : action === 'import' ? ['file', 'nodes-file'] : [];
      if (!['export', 'import'].includes(action!)) throw new Error('nodes 子命令必须是 export 或 import');
      for (const key of Object.keys(values)) {
        if (key !== 'timeout-ms' && !allowed.includes(key)) throw new Error(`nodes ${action} 不支持 --${key}`);
      }
      if (action === 'import') {
        if (!values.file) throw new Error('nodes import 需要 --file PATH（- 从 stdin 读取）');
        const text = values.file === '-' ? await stdinJson('--file') : fs.readFileSync(values.file, 'utf8');
        const directory = parseDirectory(text);
        directory.imported_at = new Date().toISOString();
        const file = directoryPath(values['nodes-file']);
        saveDirectory(directory, file);
        console.log(JSON.stringify({ imported: directory.nodes.length, file,
          default_node: directory.default_node, exported_at: directory.exported_at, imported_at: directory.imported_at }, null, 2));
        return 0;
      }
      const source = values.agent ?? (process.env.DREAMMATE_AGENT_URL?.trim() || 'http://127.0.0.1:36908');
      // Export always reads the source gateway, never the importing device's cache.
      let directory: NodeDirectory;
      try { directory = await exportDirectory(source, values['default-node']); }
      catch (error) {
        cliError(error instanceof Error ? error.message : String(error));
        return 1;
      }
      if (values.file && values.file !== '-') {
        saveDirectory(directory, path.resolve(values.file));
        console.log(JSON.stringify({ exported: directory.nodes.length, file: path.resolve(values.file), default_node: directory.default_node }, null, 2));
      } else console.log(JSON.stringify(directory, null, 2));
      return 0;
    }
    const spec = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
    if (!spec || positionals.length !== 1) throw new Error(`未知命令或多余参数: ${positionals.join(' ')}`);
    for (const key of Object.keys(values)) {
      if (!['agent', 'help', 'nodes-file', 'live', 'timeout-ms', ...spec.flags].includes(key)) throw new Error(`${command} 不支持 --${key}`);
    }
    for (const key of spec.required ?? []) {
      if (!(values as Record<string, unknown>)[key]) throw new Error(`缺少必填参数: --${key}`);
    }
    if (values.query !== undefined) {
      if (!values.query.trim() || values.query.length > 2000) throw new Error('--query 必须是 1–2000 字符的非空任务描述');
      args.query = values.query.trim();
    }
    for (const [key, min, max] of [['limit', 1, 20], ['offset', 0, 1_000_000], ['max-chars', 1000, 12_000]] as const) {
      const raw = values[key];
      if (raw === undefined) continue;
      const value = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`--${key} 必须是 ${min}–${max} 之间的整数`);
      }
      args[key === 'max-chars' ? 'max_chars' : key] = value;
    }
    if (command === 'tools') {
      const names = new Set(Object.values(COMMANDS).map(s => s.tool).filter(Boolean));
      console.log(JSON.stringify({ tools: MCP_TOOLS.filter(t => names.has(t.name)) }, null, 2));
      return 0;
    }
    tool = spec.tool;
    nodeDirectory = values.live ? undefined : loadDirectory(values['nodes-file']);
    const configured = values.agent ?? (process.env.DREAMMATE_AGENT_URL?.trim() || undefined)
      ?? (nodeDirectory ? directoryNodeUrl(findDirectoryNode(nodeDirectory, nodeDirectory.default_node)!) : undefined)
      ?? (values.node && isIP(values.node) ? `http://${isIP(values.node) === 6 ? `[${values.node}]` : values.node}:36908` : undefined)
      ?? (values.node && /^https?:\/\//.test(values.node) ? values.node : undefined);
    if (!configured) throw new Error('请先 cli nodes import --file nodes.json，或用 --agent URL / DREAMMATE_AGENT_URL 指定在线网关');
    agentUrl = gatewayUrl(configured);
    if (values.node === 'all' && !['search', 'services'].includes(command)) throw new Error('--node all 仅用于 search/services');
    if (values.action && !['start', 'stop', 'status'].includes(values.action)) throw new Error('--action 必须是 start、stop 或 status');
    if (values.method && values.skill) throw new Error('--method 和 --skill 请只指定一个');

    for (const key of ['node', 'method', 'skill', 'keyword', 'kind', 'action'] as const) {
      if (values[key] !== undefined) args[key] = values[key];
    }
    if (values.service) args.service_id = values.service;
    if (values.all) args.online_only = false;
    if (values['include-disabled']) args.include_disabled = true;
    if (values.params !== undefined) {
      const params: unknown = JSON.parse(values.params === '-' ? await stdinJson() : values.params);
      if (params === null || typeof params !== 'object' || Array.isArray(params)) throw new Error('--params 必须是 JSON 对象');
      args.params = params;
    }
  } catch (error) {
    cliError(error instanceof Error ? error.message : String(error), 'INVALID_ARGUMENT');
    return 2;
  }

  const result = await callDreammateTool(tool, args, { agentUrl, nodeDirectory });
  console.log(JSON.stringify(result, null, 2));
  return result.isError ? 1 : 0;
}

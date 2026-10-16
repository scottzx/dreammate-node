import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { parseArgs } from 'node:util';
import { cliError } from './cli-process.js';
import { MAX_MCP_CONFIG_BYTES, parseMcpSourceConfig } from './mcp-source-config.js';

export const MCP_SOURCE_USAGE = `dreammate-node mcp — 管理本机自定义 MCP 数据源

  add --config 'JSON' [--name NAME]  粘贴 MCP 配置并自动发现工具
  add --file PATH|- [--name NAME]    从文件或 stdin 读取配置
  list                             列出数据源及连接状态
  remove ID                        移除数据源及其工具
  refresh ID                       重新连接并刷新工具目录

支持 {"mcpServers":{"名称":{"command":"npx","args":["..."]}}}、
{"mcpServers":{"名称":{"url":"https://example.com/mcp","headers":{"Authorization":"Bearer ..."}}}}
或单个 command/url 对象（此时必须指定 --name）。远程 type 支持 http、streamable-http、sse。
支持已有 OAuth refresh token 自动续期（oauth.tokenUrl/clientId/refreshToken）；不提供浏览器首次授权。
--agent URL：默认 DREAMMATE_AGENT_URL 或 http://127.0.0.1:36908；管理操作仅支持 loopback。
--timeout-ms N：1–3600000，默认 30000。stdout 输出 JSON；退出码 0 成功、1 连接失败、2 参数错误。
配置保存在本机；env/headers/URL/oauth 中的凭据不会出现在数据源清单中。`;

const OPTIONS = {
  config: { type: 'string' }, file: { type: 'string' }, name: { type: 'string' },
  agent: { type: 'string' }, 'timeout-ms': { type: 'string' }, help: { type: 'boolean', short: 'h' },
} as const;

function parseSourceArgs(args: string[]) {
  return parseArgs({ args, allowPositionals: true, strict: true, options: OPTIONS });
}

function localAgentUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('--agent 必须是有效的 loopback HTTP(S) URL'); }
  const host = url.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '[::1]' || (isIP(host) === 4 && host.startsWith('127.'));
  if (!['http:', 'https:'].includes(url.protocol) || !loopback || url.username || url.password
    || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('MCP 管理仅支持无凭据、查询串和路径的 loopback --agent URL');
  }
  return url.origin;
}

async function stdinConfig(signal: AbortSignal): Promise<string> {
  if (process.stdin.isTTY) throw new Error('--file - 需要通过管道传入 JSON');
  const chunks: Buffer[] = [];
  let size = 0;
  const onAbort = () => process.stdin.destroy(new Error('读取配置超时'));
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const item of process.stdin) {
      const chunk = Buffer.isBuffer(item) ? item : Buffer.from(item);
      size += chunk.byteLength;
      if (size > MAX_MCP_CONFIG_BYTES) throw new Error('MCP 配置不能超过 256 KiB');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { signal.removeEventListener('abort', onAbort); }
}

/** Defense in depth: the management API also returns a credential-free view. */
function sanitize(value: unknown, secrets: string[], key = '', depth = 0): unknown {
  if (depth > 20) return '[truncated]';
  if (/^(headers|env|config|command|args|cwd|oauth)$/i.test(key)
    || /token|password|authorization|api[_-]?key|secret/i.test(key)) return '[redacted]';
  if (typeof value === 'string') {
    // A harmless header value such as x-forwarded-proto:http must not hide
    // the API's fixed transport/status labels when values happen to match.
    if (['type', 'transport'].includes(key) && ['stdio', 'http', 'sse'].includes(value)) return value;
    if (key === 'status' && ['connected', 'connecting', 'disconnected', 'error'].includes(value)) return value;
    let result = value;
    for (const secret of secrets) result = result.split(secret).join('[redacted]');
    // Remote MCP addresses can carry credentials in their path and query.
    return result.replace(/https?:\/\/[^\s"<>]+/gi, match => {
      try { const url = new URL(match); return `${url.origin}/[redacted]`; } catch { return '[redacted URL]'; }
    });
  }
  if (Array.isArray(value)) return value.map(item => sanitize(item, secrets, '', depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([itemKey, item]) => [itemKey, sanitize(item, secrets, itemKey, depth + 1)]));
  }
  return value;
}

function failedSources(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(failedSources);
  const data = value as Record<string, unknown>;
  if (data.isError === true || data.ok === false || data.success === false || data.error
    || (typeof data.status === 'string' && ['error', 'failed', 'disconnected', 'connecting', 'unavailable'].includes(data.status))) return true;
  return ['sources', 'results', 'source', 'imported', 'catalog'].some(key => failedSources(data[key]));
}

/** One-shot MCP management. argv starts with add/list/remove/refresh, after `mcp`. */
export async function runMcpSourceCli(argv: string[]): Promise<number> {
  let request: { url: string; method: string; body?: string };
  let timeoutMs = 30_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const secrets: string[] = [];
  const grantSecrets: string[] = [];
  try {
    const args = argv[0] === 'mcp' ? argv.slice(1) : argv;
    let parsed: ReturnType<typeof parseSourceArgs>;
    try { parsed = parseSourceArgs(args); }
    catch { throw new Error('MCP 命令参数无效；运行 dreammate-node mcp --help 查看用法'); }
    const { values, positionals } = parsed;
    if (values.help || positionals.length === 0) { console.log(MCP_SOURCE_USAGE); return 0; }
    const command = positionals[0];
    if (!['add', 'list', 'remove', 'refresh'].includes(command!)) throw new Error('MCP 子命令必须是 add、list、remove 或 refresh');
    if (positionals.length !== (command === 'remove' || command === 'refresh' ? 2 : 1)) throw new Error('MCP 子命令参数数量无效');
    const allowed = command === 'add' ? ['config', 'file', 'name', 'agent', 'timeout-ms'] : ['agent', 'timeout-ms'];
    if (Object.keys(values).some(key => !allowed.includes(key))) throw new Error('当前 MCP 子命令不支持此参数');
    if (values['timeout-ms'] !== undefined) {
      timeoutMs = Number(values['timeout-ms']);
      if (!/^\d+$/.test(values['timeout-ms']) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
        throw new Error('--timeout-ms 必须是 1–3600000 之间的整数');
      }
    }
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const agent = localAgentUrl(values.agent ?? (process.env.DREAMMATE_AGENT_URL?.trim() || 'http://127.0.0.1:36908'));
    const base = `${agent}/mcp/sources`;
    if (command === 'add') {
      if ((values.config === undefined) === (values.file === undefined)) throw new Error('mcp add 需要且只能指定 --config 或 --file');
      let configText: string;
      try {
        configText = values.config ?? (values.file === '-' ? await stdinConfig(controller.signal)
          : await readFile(values.file!, { encoding: 'utf8', signal: controller.signal }));
      } catch (error) {
        if (controller.signal.aborted) throw new Error('读取 MCP 配置超过命令截止时间');
        if (error instanceof Error && error.message.startsWith('MCP 配置')) throw error;
        throw new Error('无法读取 MCP 配置文件或标准输入');
      }
      const sources = parseMcpSourceConfig(configText, values.name);
      for (const source of sources) {
        if (source.url) secrets.push(source.url);
        secrets.push(...Object.values(source.headers ?? {}), ...Object.values(source.env ?? {}));
        if (source.oauth) grantSecrets.push(...Object.values(source.oauth).filter((value): value is string => typeof value === 'string'));
      }
      const config: unknown = JSON.parse(configText);
      request = { url: base, method: 'POST', body: JSON.stringify({ config, ...(values.name !== undefined ? { name: values.name } : {}) }) };
    } else if (command === 'list') request = { url: base, method: 'GET' };
    else {
      const id = positionals[1]!;
      if (!/^mcp-[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('MCP ID 必须是 mcp- 加有效的数据源名称');
      request = { url: `${base}/${encodeURIComponent(id)}${command === 'refresh' ? '/refresh' : ''}`,
        method: command === 'remove' ? 'DELETE' : 'POST' };
    }
  } catch (error) {
    clearTimeout(timer);
    cliError(error instanceof Error ? error.message : 'MCP 参数无效', 'INVALID_ARGUMENT');
    return 2;
  }

  try {
    const response = await fetch(request.url, { method: request.method, body: request.body,
      headers: request.body ? { 'content-type': 'application/json' } : undefined,
      signal: controller.signal, redirect: 'error' });
    let result: unknown;
    try { result = await response.json(); } catch {
      cliError(`MCP 管理接口返回无效 JSON（HTTP ${response.status}）`, 'MCP_SOURCE_ERROR');
      return 1;
    }
    console.log(JSON.stringify(sanitize(result, [...secrets.filter(secret => secret.length >= 4), ...grantSecrets]), null, 2));
    return !response.ok || failedSources(result) ? 1 : 0;
  } catch {
    cliError(controller.signal.aborted ? `MCP 命令超过 ${timeoutMs} ms` : '无法连接本机 MCP 管理接口', 'MCP_SOURCE_ERROR');
    return 1;
  } finally { clearTimeout(timer); }
}

import { isIP } from 'node:net';
import { parseArgs } from 'node:util';
import { cliError } from './cli-process.js';

export const ACCESS_USAGE = `dreammate-node access — 管理本机的公网访问开关

  status                查看当前状态（token 只显示掩码）
  enable                打开公网访问；没有 token 时生成一枚并显示一次
  disable               关闭公网访问
  rotate                轮换 token，旧 token 立即作废，明文显示一次
  show-token            显示本机保存的明文 token
  forget-token          丢弃本机保存的 token 并关闭公网访问
  zones --list          列出免 token 的可信网段
  zones --set A,B       设置免 token 的可信网段（裸 IP 或 CIDR）

控制面只监听本机回环，网关的数据面在别处也够不到它。
--agent URL：默认 http://127.0.0.1:36910；只接受 loopback。
--timeout-ms N：1–3600000，默认 30000。stdout 输出 JSON；退出码 0 成功、1 失败、2 参数错误。`;

const OPTIONS = {
  agent: { type: 'string' }, 'timeout-ms': { type: 'string' },
  list: { type: 'boolean' }, set: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

function parseAccessArgs(args: string[]) {
  return parseArgs({ args, allowPositionals: true, strict: true, options: OPTIONS });
}

function localAgentUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('--agent 必须是有效的 loopback HTTP(S) URL'); }
  const host = url.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '[::1]' || (isIP(host) === 4 && host.startsWith('127.'));
  if (!['http:', 'https:'].includes(url.protocol) || !loopback || url.username || url.password
    || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('访问控制仅支持无凭据、查询串和路径的 loopback --agent URL');
  }
  return url.origin;
}

/** One-shot access control. argv starts with the subcommand, after `access`. */
export async function runAccessCli(argv: string[]): Promise<number> {
  let request: { url: string; method: string; body?: string } | undefined;
  let timeoutMs = 30_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    const args = argv[0] === 'access' ? argv.slice(1) : argv;
    let parsed: ReturnType<typeof parseAccessArgs>;
    try { parsed = parseAccessArgs(args); }
    catch { throw new Error('access 命令参数无效；运行 dreammate-node access --help 查看用法'); }
    const { values, positionals } = parsed;
    if (values.help || positionals.length === 0) { console.log(ACCESS_USAGE); return 0; }
    const command = positionals[0];
    const commands = ['status', 'enable', 'disable', 'rotate', 'show-token', 'forget-token', 'zones'];
    if (!commands.includes(command!)) throw new Error('access 子命令必须是 status、enable、disable、rotate、show-token、forget-token 或 zones');
    if (positionals.length !== 1) throw new Error('access 子命令参数数量无效');
    const allowed = command === 'zones' ? ['agent', 'timeout-ms', 'list', 'set'] : ['agent', 'timeout-ms'];
    if (Object.keys(values).some(key => !allowed.includes(key))) throw new Error('当前 access 子命令不支持此参数');
    if (command !== 'zones' && (values.list || values.set !== undefined)) {
      throw new Error('--list 和 --set 只属于 zones 子命令');
    }
    if (values['timeout-ms'] !== undefined) {
      timeoutMs = Number(values['timeout-ms']);
      if (!/^\d+$/.test(values['timeout-ms']) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
        throw new Error('--timeout-ms 必须是 1–3600000 之间的整数');
      }
    }
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const agent = localAgentUrl(values.agent ?? (process.env.DREAMMATE_ACCESS_URL?.trim() || 'http://127.0.0.1:36910'));
    if (command === 'status') request = { url: `${agent}/access`, method: 'GET' };
    else if (command === 'zones') {
      if (values.list === undefined && values.set === undefined) throw new Error('access zones 需要 --list 或 --set');
      if (values.list && values.set !== undefined) throw new Error('access zones 不能同时使用 --list 和 --set');
      if (values.set !== undefined) {
        const zones = values.set.split(',').map(zone => zone.trim()).filter(Boolean);
        if (!zones.length) throw new Error('--set 需要至少一个网段');
        request = { url: `${agent}/access/zones`, method: 'PATCH', body: JSON.stringify({ trusted_zones: zones }) };
      } else {
        request = { url: `${agent}/access`, method: 'GET' };
      }
    } else if (command === 'forget-token') request = { url: `${agent}/access/token`, method: 'DELETE' };
    else request = { url: `${agent}/access`, method: 'POST', body: JSON.stringify({ action: command }) };
  } catch (error) {
    clearTimeout(timer);
    cliError(error instanceof Error ? error.message : 'access 参数无效', 'INVALID_ARGUMENT');
    return 2;
  }

  try {
    const response = await fetch(request!.url, { method: request!.method, body: request!.body,
      headers: request!.body ? { 'content-type': 'application/json' } : undefined,
      signal: controller.signal, redirect: 'error' });
    let result: unknown;
    try { result = await response.json(); } catch {
      cliError(`访问控制接口返回无效 JSON（HTTP ${response.status}）`, 'ACCESS_ERROR');
      return 1;
    }
    console.log(JSON.stringify(result, null, 2));
    return response.ok ? 0 : 1;
  } catch {
    cliError(controller.signal.aborted ? `access 命令超过 ${timeoutMs} ms` : '无法连接本机访问控制接口', 'ACCESS_ERROR');
    return 1;
  } finally { clearTimeout(timer); }
}

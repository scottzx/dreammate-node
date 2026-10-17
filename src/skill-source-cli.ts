import { isIP } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { cliError } from './cli-process.js';

export const SKILL_SOURCE_USAGE = `dreammate-node skills — 管理本机 Skill 来源与内置入口 Skill

  discover [--no-projects]        自动登记常见共享目录和 1session 工作目录内的技能
  add --name NAME --project PATH  登记项目的约定 Skill 目录
  add --name NAME --dir PATH      登记单个技能包或技能目录
  list                           列出已登记来源及扫描状态
  remove ID                      移除来源及其索引，保留源文件
  refresh [ID]                   重新扫描指定来源；省略 ID 刷新全部
  install [--profile auto|ish|terminal] [--dir PATH]
                                 安装/更新 DreamMate 内置入口 Skill

--agent URL：默认 DREAMMATE_AGENT_URL 或 http://127.0.0.1:36908；来源管理仅支持 loopback。
--timeout-ms N：1–3600000，默认 30000。stdout 输出 JSON；退出码 0 成功、1 接口失败、2 参数错误。
路径在当前设备解析为绝对路径，支持 ~/；技能正文及资源保留在来源目录，按需读取。
discover 默认发现常见智能体共享目录并调用本机 1session 查找项目；--no-projects 仅发现共享目录。
独立本机管理可使用 dreammate-skills，无需运行网关。`;

const OPTIONS = {
  name: { type: 'string' }, dir: { type: 'string' }, project: { type: 'string' },
  'no-projects': { type: 'boolean' },
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
    throw new Error('Skill 来源管理仅支持无凭据、查询串和路径的 loopback --agent URL');
  }
  return url.origin;
}

function localPath(value: string, option: string): string {
  if (!value.trim() || value.includes('\0')) throw new Error(`${option} 必须是非空本机路径`);
  if (value.startsWith('~') && value !== '~' && !value.startsWith('~/')) {
    throw new Error(`${option} 只支持 ~ 或 ~/ 形式的用户目录`);
  }
  return path.resolve(value === '~' ? homedir() : value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value);
}

function failedSources(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(failedSources);
  const data = value as Record<string, unknown>;
  if (data.isError === true || data.ok === false || data.success === false || data.error
    || (typeof data.status === 'string' && ['error', 'failed', 'unavailable'].includes(data.status))) return true;
  return ['sources', 'results', 'source', 'diagnostics'].some(key => failedSources(data[key]));
}

/** One-shot source management; argv starts after `skills`. */
export async function runSkillSourceCli(argv: string[]): Promise<number> {
  let request: { url: string; method: string; body?: string };
  let timeoutMs = 30_000;
  const controller = new AbortController();
  try {
    const args = argv[0] === 'skills' ? argv.slice(1) : argv;
    let parsed: ReturnType<typeof parseSourceArgs>;
    try { parsed = parseSourceArgs(args); }
    catch { throw new Error('Skill 命令参数无效；运行 dreammate-node skills --help 查看用法'); }
    const { values, positionals } = parsed;
    if (values.help || positionals.length === 0) { console.log(SKILL_SOURCE_USAGE); return 0; }
    const command = positionals[0];
    if (!['discover', 'add', 'list', 'remove', 'refresh'].includes(command!)) throw new Error('Skill 来源子命令必须是 discover、add、list、remove 或 refresh');
    const validCount = command === 'remove' ? positionals.length === 2 : command === 'refresh'
      ? positionals.length >= 1 && positionals.length <= 2 : positionals.length === 1;
    if (!validCount) throw new Error('Skill 来源子命令参数数量无效');
    const allowed = command === 'add' ? ['name', 'dir', 'project', 'agent', 'timeout-ms']
      : command === 'discover' ? ['no-projects', 'agent', 'timeout-ms'] : ['agent', 'timeout-ms'];
    if (Object.keys(values).some(key => !allowed.includes(key))) throw new Error('当前 Skill 来源子命令不支持此参数');
    if (values['timeout-ms'] !== undefined) {
      timeoutMs = Number(values['timeout-ms']);
      if (!/^\d+$/.test(values['timeout-ms']) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
        throw new Error('--timeout-ms 必须是 1–3600000 之间的整数');
      }
    }
    const agent = localAgentUrl(values.agent ?? (process.env.DREAMMATE_AGENT_URL?.trim() || 'http://127.0.0.1:36908'));
    const base = `${agent}/skills/sources`;
    if (command === 'add') {
      if (!values.name || !/^[A-Za-z0-9_-]{1,64}$/.test(values.name)) throw new Error('--name 必须是 1–64 位字母、数字、下划线或连字符');
      if ((values.dir === undefined) === (values.project === undefined)) throw new Error('skills add 需要且只能指定 --dir 或 --project');
      const source = values.dir !== undefined ? { dir: localPath(values.dir, '--dir') }
        : { project: localPath(values.project!, '--project') };
      request = { url: base, method: 'POST', body: JSON.stringify({ name: values.name, ...source }) };
    } else if (command === 'discover') request = { url: `${base}/discover`, method: 'POST', body: JSON.stringify({ projects: !values['no-projects'] }) };
    else if (command === 'list') request = { url: base, method: 'GET' };
    else {
      const id = positionals[1];
      if (id !== undefined && !/^skills-[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('Skill 来源 ID 必须是 skills- 加有效的来源名称');
      request = { url: id === undefined ? `${base}/refresh` : `${base}/${encodeURIComponent(id)}${command === 'refresh' ? '/refresh' : ''}`,
        method: command === 'remove' ? 'DELETE' : 'POST' };
    }
  } catch (error) {
    cliError(error instanceof Error ? error.message : 'Skill 来源参数无效', 'INVALID_ARGUMENT');
    return 2;
  }

  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(request.url, { method: request.method, body: request.body,
      headers: request.body ? { 'content-type': 'application/json' } : undefined,
      signal: controller.signal, redirect: 'error' });
    let result: unknown;
    try { result = await response.json(); } catch {
      cliError(`Skill 来源接口返回无效 JSON（HTTP ${response.status}）`, 'SKILL_SOURCE_ERROR');
      return 1;
    }
    console.log(JSON.stringify(result, null, 2));
    return !response.ok || failedSources(result) ? 1 : 0;
  } catch {
    cliError(controller.signal.aborted ? `Skill 来源命令超过 ${timeoutMs} ms` : '无法连接本机 Skill 来源接口', 'SKILL_SOURCE_ERROR');
    return 1;
  } finally { clearTimeout(timer); }
}

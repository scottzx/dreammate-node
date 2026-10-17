#!/usr/bin/env node
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SkillSourceManager, SkillSourceError } from './manager.js';
import { serveSkillService } from './service.js';
import { installSkillService, uninstallSkillService, skillServiceStatus } from './daemon.js';

export const SKILL_MANAGER_USAGE = `dreammate-skills — 独立管理本机 Skill 来源，无需 DreamMate 网关

  discover [--no-projects]        自动登记常见共享目录和 1session 工作目录内的技能
  sources                        列出已登记来源及扫描状态
  list                           输出当前技能摘要、内容版本和扫描诊断
  add --name NAME --dir PATH      登记单个技能包或技能目录
  add --name NAME --project PATH  登记项目的约定技能目录
  remove SOURCE_ID               移除来源，保留技能原文件
  read --skill ID --revision HASH [--resource relative/path]
                                 按版本读取完整指南或指定资源
  serve [--port 36909] [--agent URL] [--no-projects] [--no-register]
                                 独立运行技能服务，向本机 Node 报备并自动重连
  install [--port 36909] [--agent URL] [--no-projects]
                                 安装用户级常驻服务（macOS launchd / Linux systemd）
  uninstall                      卸载用户级常驻服务，保留来源配置和技能文件
  status [--port 36909]           查看独立技能服务状态

--config PATH：覆盖来源配置文件，默认 ~/.1agents/skill-sources.json。
目录支持绝对路径、相对路径和 ~/。discover 默认调用本机 1session projects；
--no-projects 仅发现共享目录，不调用 1session。未安装 1session 时仍返回共享目录发现结果和诊断。
sources/list/read 仅使用已登记来源，不自动发现、不联网、不启动网关、不执行脚本。
serve/install 的 --agent 默认为 http://127.0.0.1:36908；Node 未运行时服务仍可直接访问。
stdout 输出 JSON；退出码 0 成功、1 运行失败或部分发现/扫描失败、2 参数错误。`;

const OPTIONS = {
  name: { type: 'string' }, dir: { type: 'string' }, project: { type: 'string' },
  config: { type: 'string' }, 'no-projects': { type: 'boolean' },
  skill: { type: 'string' }, revision: { type: 'string' }, resource: { type: 'string' },
  port: { type: 'string' }, agent: { type: 'string' }, 'no-register': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

function parseCliArgs(args: string[]) {
  return parseArgs({ args, strict: true, allowPositionals: true, options: OPTIONS });
}

function expandedPath(value: string, option: string): string {
  if (!value.trim() || value.includes('\0') || value.length > 4096) throw new Error(`${option} 必须是非空本机路径`);
  if (value.startsWith('~') && value !== '~' && !value.startsWith('~/')) throw new Error(`${option} 只支持 ~ 或 ~/ 形式的用户目录`);
  return path.resolve(value === '~' ? homedir() : value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value);
}

function failedResult(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(failedResult);
  const data = value as Record<string, unknown>;
  if (data.error || data.ok === false || data.success === false || data.isError === true
    || (Array.isArray(data.diagnostics) && data.diagnostics.length > 0)
    || (typeof data.status === 'string' && ['error', 'failed', 'unavailable'].includes(data.status))) return true;
  return ['sources', 'results', 'source'].some(key => failedResult(data[key]));
}

function reportError(error: unknown, code: string): void {
  const result = { error: error instanceof Error ? error.message : String(error), code,
    ...(error instanceof SkillSourceError ? { status: error.status } : {}) };
  const serialized = JSON.stringify(result);
  console.log(serialized);
  console.error(serialized);
}

/** Independent local CLI. Argument validation finishes before opening source configuration. */
export async function runSkillManagerCli(argv: string[]): Promise<number> {
  let command: string;
  let config: string;
  let source: { name: string; dir?: string; project?: string } | undefined;
  let sourceId: string | undefined;
  let skillId: string | undefined;
  let revision: string | undefined;
  let resource: string | undefined;
  let projects = true;
  let port = 36909;
  let agentUrl: string | undefined;
  let register = true;
  try {
    let parsed: ReturnType<typeof parseCliArgs>;
    try { parsed = parseCliArgs(argv); }
    catch { throw new Error('命令参数无效；运行 dreammate-skills --help 查看用法'); }
    const { values, positionals } = parsed;
    if (values.help || positionals.length === 0) { console.log(SKILL_MANAGER_USAGE); return 0; }
    command = positionals[0]!;
    if (!['discover', 'sources', 'list', 'add', 'remove', 'read', 'serve', 'install', 'uninstall', 'status'].includes(command)) {
      throw new Error('子命令必须是 discover、sources、list、add、remove、read、serve、install、uninstall 或 status');
    }
    if (positionals.length !== (command === 'remove' ? 2 : 1)) throw new Error('子命令参数数量无效');
    const allowed = command === 'add' ? ['name', 'dir', 'project'] : command === 'read' ? ['skill', 'revision', 'resource']
      : command === 'discover' ? ['no-projects'] : command === 'serve' ? ['port', 'agent', 'no-projects', 'no-register']
        : command === 'install' ? ['port', 'agent', 'no-projects'] : command === 'status' ? ['port'] : [];
    for (const key of Object.keys(values)) if (!(key === 'config' && command !== 'uninstall' && command !== 'status') && !allowed.includes(key)) {
      throw new Error(`${command} 不支持 --${key}`);
    }
    config = values.config === undefined ? path.join(homedir(), '.1agents', 'skill-sources.json') : expandedPath(values.config, '--config');
    if (command === 'add') {
      if (!values.name || !/^[A-Za-z0-9_-]{1,64}$/.test(values.name)) throw new Error('--name 必须是 1–64 位字母、数字、下划线或连字符');
      if ((values.dir === undefined) === (values.project === undefined)) throw new Error('add 需要且只能指定 --dir 或 --project');
      source = { name: values.name, ...(values.dir !== undefined ? { dir: expandedPath(values.dir, '--dir') }
        : { project: expandedPath(values.project!, '--project') }) };
    } else if (command === 'remove') {
      sourceId = positionals[1]!;
      if (!/^skills-[A-Za-z0-9_-]{1,64}$/.test(sourceId)) throw new Error('来源 ID 必须是 skills- 加有效的来源名称');
    } else if (command === 'read') {
      skillId = values.skill;
      if (!skillId?.trim() || skillId.length > 256 || skillId.includes('\0')) throw new Error('--skill 必须是非空技能 ID（最多 256 字符）');
      if (!values.revision || !/^[a-fA-F0-9]{64}$/.test(values.revision)) throw new Error('--revision 必须是 64 位十六进制 SHA256 内容版本');
      revision = values.revision.toLowerCase();
      resource = values.resource;
      if (resource !== undefined && (!resource || resource.length > 1024 || resource.includes('\0') || resource.includes('\\')
        || path.posix.isAbsolute(resource) || /^[A-Za-z]:/.test(resource)
        || resource.split('/').some(part => !part || part === '.' || part === '..'))) {
        throw new Error('--resource 必须是无 .. 的包内相对文件路径');
      }
    }
    projects = !values['no-projects'];
    register = !values['no-register'];
    if (values.port !== undefined) {
      if (!/^\d{1,5}$/.test(values.port)) throw new Error('--port 必须是整数端口');
      port = Number(values.port);
      if (port < (command === 'serve' ? 0 : 1) || port > 65535) throw new Error('--port 不在有效范围内');
    }
    agentUrl = values.agent;
    if (agentUrl !== undefined) {
      const url = new URL(agentUrl);
      if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('--agent 必须是无额外路径的本机 loopback URL');
      agentUrl = url.origin;
    }
  } catch (error) {
    reportError(error, 'INVALID_ARGUMENT');
    return 2;
  }

  try {
    if (command === 'serve') {
      const service = await serveSkillService({ port, agentUrl, register,
        managerOptions: { storagePath: config, autoDiscover: true, discovery: { projects } } });
      console.log(JSON.stringify({ service: service.descriptor.id, url: `http://127.0.0.1:${service.descriptor.port}`, registration: service.registration }));
      return await new Promise<number>((resolve) => {
        let stopping = false;
        const stop = () => {
          if (stopping) return;
          stopping = true;
          process.off('SIGINT', stop);
          process.off('SIGTERM', stop);
          void service.close().then(() => resolve(0), error => { reportError(error, 'SKILL_SERVICE_ERROR'); resolve(1); });
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    }
    if (command === 'install' || command === 'uninstall' || command === 'status') {
      const result = command === 'install' ? await installSkillService({ port, agentUrl, config, projects })
        : command === 'uninstall' ? await uninstallSkillService() : await skillServiceStatus(port);
      console.log(JSON.stringify(result, null, 2));
      if (command === 'status' && 'installed' in result && result.installed && !result.responding) return 1;
      return failedResult(result) ? 1 : 0;
    }
    const manager = new SkillSourceManager({ storagePath: config });
    let result: unknown;
    if (command === 'discover') result = await manager.discover({ projects });
    else if (command === 'sources') result = { sources: await manager.list() };
    else if (command === 'list') result = await manager.catalog();
    else if (command === 'add') result = await manager.add(source!);
    else if (command === 'remove') result = await manager.remove(sourceId!);
    else result = await manager.read(skillId!, revision!, resource);
    console.log(JSON.stringify(result, null, 2));
    return failedResult(result) ? 1 : 0;
  } catch (error) {
    reportError(error, 'SKILL_SOURCE_ERROR');
    return 1;
  }
}

let isEntry = false;
try { isEntry = Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]!) === fileURLToPath(import.meta.url); }
catch { /* Importing the command as a module has no process side effects. */ }
if (isEntry) process.exitCode = await runSkillManagerCli(process.argv.slice(2));

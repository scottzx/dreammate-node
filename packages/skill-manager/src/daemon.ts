import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const SKILL_SERVICE_LABEL = 'work.dreammate.skills';
export const SKILL_SYSTEMD_UNIT = 'dreammate-skills.service';
type Platform = 'launchd' | 'systemd';

export interface SkillServiceInstallOptions {
  port?: number;
  agentUrl?: string;
  config?: string;
  projects?: boolean;
  nodeBin?: string;
  script?: string;
}

function platform(): Platform {
  if (process.platform === 'darwin') return 'launchd';
  if (process.platform === 'linux') return 'systemd';
  throw new Error(`当前平台 ${process.platform} 不支持用户级服务安装，请运行 dreammate-skills serve`);
}

function serviceFile(kind: Platform): string {
  return kind === 'launchd'
    ? path.join(os.homedir(), 'Library', 'LaunchAgents', `${SKILL_SERVICE_LABEL}.plist`)
    : path.join(os.homedir(), '.config', 'systemd', 'user', SKILL_SYSTEMD_UNIT);
}

function validPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('服务端口必须是 1–65535 之间的整数');
  return port;
}

function argumentsFor(options: SkillServiceInstallOptions): string[] {
  const script = path.resolve(options.script ?? fileURLToPath(new URL('./cli.js', import.meta.url)));
  if (script.endsWith('.ts')) throw new Error('不能将 TypeScript 源码安装为常驻服务；请先构建或安装 npm 包');
  if (!fs.statSync(script, { throwIfNoEntry: false })?.isFile()) throw new Error(`入口脚本不存在：${script}`);
  const node = path.resolve(options.nodeBin ?? process.execPath);
  const agent = new URL(options.agentUrl ?? 'http://127.0.0.1:36908');
  const host = agent.hostname.toLowerCase();
  if (!['http:', 'https:'].includes(agent.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(host)
    || agent.username || agent.password || agent.search || agent.hash || agent.pathname !== '/') {
    throw new Error('--agent 必须是无凭据和额外路径的本机 loopback URL');
  }
  const args = [node, script, 'serve', '--port', String(validPort(options.port ?? 36909)), '--agent', agent.origin];
  if (options.config !== undefined) {
    if (!options.config.trim() || options.config.includes('\0')) throw new Error('--config 必须是非空路径');
    const config = options.config === '~' ? os.homedir() : options.config.startsWith('~/')
      ? path.join(os.homedir(), options.config.slice(2)) : path.resolve(options.config);
    args.push('--config', config);
  }
  if (options.projects === false) args.push('--no-projects');
  if (args.some(value => /[\r\n\0]/.test(value))) throw new Error('服务参数不能包含换行或空字符');
  return args;
}

const xml = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const unitArgument = (value: string, expandVariables = true): string => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  .replaceAll('%', '%%').replaceAll('$', () => expandVariables ? '$$' : '$') + '"';

function discoveryEnvironment(): [string, string][] {
  const keys = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME', 'GROK_HOME', 'DSH_HOME', 'DSH_AGENTS_HOME', 'DSH_BUNDLED_SKILL_DIR'];
  return keys.flatMap(key => {
    const value = process.env[key];
    if (!value) return [];
    if (/[\r\n\0]/.test(value)) throw new Error(`${key} 不能包含换行或空字符`);
    return [[key, value] as [string, string]];
  });
}

/** Renderers expose the exact command for review without changing the process manager. */
export function renderSkillServicePlist(options: SkillServiceInstallOptions = {}): string {
  const args = argumentsFor(options);
  const logs = path.join(os.homedir(), '.1agents', 'logs');
  // Keep the calling environment's PATH for optional 1session project discovery.
  const runtimePath = process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${SKILL_SERVICE_LABEL}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(runtimePath)}</string>${discoveryEnvironment().map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join('')}</dict>
<key>StandardOutPath</key><string>${xml(path.join(logs, 'dreammate-skills.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(logs, 'dreammate-skills.err.log'))}</string>
<key>ProcessType</key><string>Background</string>
</dict></plist>
`;
}

export function renderSkillServiceUnit(options: SkillServiceInstallOptions = {}): string {
  const args = argumentsFor(options);
  const runtimePath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  if (/[\r\n\0]/.test(runtimePath)) throw new Error('PATH 不能包含换行或空字符');
  return `[Unit]
Description=DreamMate Skill Manager
After=network-online.target

[Service]
Type=simple
ExecStart=${args.map(arg => unitArgument(arg)).join(' ')}
Environment=${unitArgument(`PATH=${runtimePath}`, false)}
${discoveryEnvironment().map(([key, value]) => `Environment=${unitArgument(`${key}=${value}`, false)}`).join('\n')}
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
}

export async function installSkillService(options: SkillServiceInstallOptions = {}): Promise<{ platform: Platform; file: string; notes: string[] }> {
  const kind = platform();
  // Resolve and validate all arguments before writing any service files.
  const content = kind === 'launchd' ? renderSkillServicePlist(options) : renderSkillServiceUnit(options);
  if (kind === 'systemd') {
    try { await run('systemctl', ['--user', 'show-environment'], { timeout: 3000 }); }
    catch { throw new Error('没有可用的 systemd 用户管理器；请使用 dreammate-skills serve，未写入服务文件'); }
  }
  const file = serviceFile(kind);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.join(os.homedir(), '.1agents', 'logs'), { recursive: true });
  const previous = fs.existsSync(file) ? fs.readFileSync(file) : undefined;
  const target = `gui/${process.getuid?.() ?? 0}`;
  let previousLoaded = false;
  let newLoaded = false;
  const previousActive = kind === 'systemd' && await run('systemctl', ['--user', 'is-active', SKILL_SYSTEMD_UNIT], { timeout: 3000 })
    .then(() => true).catch(() => false);
  const previousEnabled = kind === 'systemd' && await run('systemctl', ['--user', 'is-enabled', SKILL_SYSTEMD_UNIT], { timeout: 3000 })
    .then(() => true).catch(() => false);
  const replace = () => fs.writeFileSync(file, content, { mode: 0o600 });
  try {
    if (kind === 'launchd') {
      previousLoaded = await run('launchctl', ['bootout', `${target}/${SKILL_SERVICE_LABEL}`], { timeout: 5000 }).then(() => true).catch(() => false);
      replace();
      await run('launchctl', ['bootstrap', target, file], { timeout: 5000 });
      newLoaded = true;
      await run('launchctl', ['enable', `${target}/${SKILL_SERVICE_LABEL}`], { timeout: 5000 });
    } else {
      replace();
      await run('systemctl', ['--user', 'daemon-reload'], { timeout: 5000 });
      await run('systemctl', ['--user', 'enable', SKILL_SYSTEMD_UNIT], { timeout: 5000 });
      await run('systemctl', ['--user', 'restart', SKILL_SYSTEMD_UNIT], { timeout: 5000 });
    }
  } catch (error) {
    const failures: string[] = [];
    const restore = async (command: string, args: string[]) => {
      await run(command, args, { timeout: 5000 }).catch(failure => failures.push(String(failure)));
    };
    if (kind === 'launchd' && newLoaded) await restore('launchctl', ['bootout', `${target}/${SKILL_SERVICE_LABEL}`]);
    if (kind === 'systemd') {
      await restore('systemctl', ['--user', 'stop', SKILL_SYSTEMD_UNIT]);
      if (!previousEnabled) await restore('systemctl', ['--user', 'disable', SKILL_SYSTEMD_UNIT]);
    }
    if (previous) fs.writeFileSync(file, previous, { mode: 0o600 });
    else fs.rmSync(file, { force: true });
    if (previous && previousLoaded && kind === 'launchd') await restore('launchctl', ['bootstrap', target, file]);
    if (kind === 'systemd') {
      await restore('systemctl', ['--user', 'daemon-reload']);
      if (previousEnabled) await restore('systemctl', ['--user', 'enable', SKILL_SYSTEMD_UNIT]);
      if (previousActive) await restore('systemctl', ['--user', 'restart', SKILL_SYSTEMD_UNIT]);
    }
    if (failures.length) throw new Error(`${String(error)}; service rollback was incomplete: ${failures.join('; ')}`);
    throw error;
  }
  const notes: string[] = [];
  if (kind === 'systemd') {
    const linger = await run('loginctl', ['show-user', os.userInfo().username, '--property=Linger'], { timeout: 3000 })
      .then(result => result.stdout.includes('Linger=yes')).catch(() => false);
    if (!linger) notes.push('用户级服务会在登出后停止；持续运行需由管理员为当前用户启用 linger');
  }
  return { platform: kind, file, notes };
}

export async function uninstallSkillService(): Promise<{ platform: Platform; file: string; removed: boolean }> {
  const kind = platform();
  const file = serviceFile(kind);
  const removed = fs.existsSync(file);
  if (kind === 'launchd') {
    const target = `gui/${process.getuid?.() ?? 0}/${SKILL_SERVICE_LABEL}`;
    const loaded = await run('launchctl', ['print', target], { timeout: 5000 }).then(() => true).catch((error: { stderr?: string }) => {
      if (/Could not find (?:specified )?service|No such process/i.test(error.stderr ?? '')) return false;
      throw error;
    });
    if (loaded) await run('launchctl', ['bootout', target], { timeout: 5000 });
  } else {
    const state = await run('systemctl', ['--user', 'show', '--property=LoadState', '--value', SKILL_SYSTEMD_UNIT], { timeout: 5000 });
    if (removed || state.stdout.trim() !== 'not-found') await run('systemctl', ['--user', 'disable', '--now', SKILL_SYSTEMD_UNIT], { timeout: 5000 });
  }
  if (removed) fs.rmSync(file);
  if (kind === 'systemd') await run('systemctl', ['--user', 'daemon-reload'], { timeout: 5000 });
  return { platform: kind, file, removed };
}

export async function skillServiceStatus(port = 36909): Promise<{ platform: Platform; installed: boolean; file: string; managerSays: string; responding: boolean; port: number }> {
  validPort(port);
  const kind = platform();
  const file = serviceFile(kind);
  const installed = fs.existsSync(file);
  const managerSays = !installed ? '未安装' : kind === 'launchd'
    ? await run('launchctl', ['print', `gui/${process.getuid?.() ?? 0}/${SKILL_SERVICE_LABEL}`], { timeout: 3000 })
      .then(result => /state = (\w+)/.exec(result.stdout)?.[1] ?? 'loaded').catch(() => '未加载')
    : await run('systemctl', ['--user', 'is-active', SKILL_SYSTEMD_UNIT], { timeout: 3000 })
      .then(result => result.stdout.trim()).catch(() => 'inactive');
  const responding = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
    .then(async response => response.ok && (await response.json() as { service?: string }).service === 'dreammate-skill-manager')
    .catch(() => false);
  return { platform: kind, installed, file, managerSays, responding, port };
}

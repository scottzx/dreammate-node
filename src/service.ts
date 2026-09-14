/**
 * 把 agent 装成开机自启的常驻服务。
 *
 * macOS 用 launchd（用户级 LaunchAgent），Linux 用 systemd（用户级 unit）。
 * 两边都**不需要 sudo**——agent 只读本机服务清单，没有要 root 的理由。
 *
 * 零运行时依赖：只用 node: 内置模块。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NODE_AGENT_PORT } from './server.js';

const run = promisify(execFile);

/** launchd 的 Label / systemd 的 unit 名，卸载时靠它找回来。 */
export const SERVICE_LABEL = 'work.dreammate.node';
export const SYSTEMD_UNIT = 'dreammate-node.service';

export type Platform = 'launchd' | 'systemd';

export function platformOf(): Platform {
  if (process.platform === 'darwin') return 'launchd';
  if (process.platform === 'linux') return 'systemd';
  throw new Error(`不支持的平台：${process.platform}（只支持 macOS 与 Linux）`);
}

export function plistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

export function unitPath(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', SYSTEMD_UNIT);
}

export function logDir(): string {
  return path.join(os.homedir(), '.1agents', 'logs');
}

export interface InstallOptions {
  host?: string;
  port?: number;
  /** 入口脚本的绝对路径。默认取当前运行的这一个。 */
  script?: string;
  /** node 可执行文件。默认 process.execPath——PATH 在 launchd/systemd 里几乎是空的。 */
  nodeBin?: string;
}

interface Resolved {
  nodeBin: string;
  script: string;
  host: string;
  port: number;
}

function resolve(options: InstallOptions, defaultScript: string): Resolved {
  const script = path.resolve(options.script ?? defaultScript);
  // .ts 要先判：用 tsx 跑源码时文件是存在的，但服务里只有裸 node，跑不起来。
  // 反过来先判存在性，用户会收到"文件不存在"这种完全指错方向的提示。
  if (script.endsWith('.ts')) {
    throw new Error(
      `不能把 TypeScript 源码 (${path.basename(script)}) 装成服务：launchd/systemd 里只有裸 node。\n` +
        `先 npm run build，或全局安装后用 dist 里的 dreammate-node.js。`,
    );
  }
  if (!fs.existsSync(script)) throw new Error(`入口脚本不存在：${script}`);
  return {
    nodeBin: path.resolve(options.nodeBin ?? process.execPath),
    script,
    host: options.host ?? '0.0.0.0',
    port: options.port ?? NODE_AGENT_PORT,
  };
}

/** plist 是 XML，路径里的 & < > 会把文件弄坏。 */
const xml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderPlist(r: Resolved): string {
  const logs = logDir();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(r.nodeBin)}</string>
    <string>${xml(r.script)}</string>
    <string>--host</string><string>${xml(r.host)}</string>
    <string>--port</string><string>${r.port}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(path.join(logs, 'dreammate-node.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logs, 'dreammate-node.err.log'))}</string>
  <key>ProcessType</key><string>Background</string>
  <!-- launchd 默认只给 /usr/bin:/bin:/usr/sbin:/sbin，找不到 homebrew 里的
       tailscale。identity.ts 还有一层候选路径兜底，这里是第一道。 -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
`;
}

export function renderUnit(r: Resolved): string {
  return `[Unit]
Description=DreamMate Network node agent
After=network-online.target

[Service]
Type=simple
ExecStart=${r.nodeBin} ${r.script} --host ${r.host} --port ${r.port}
# systemd 给的 PATH 同样很小，找不到装在 /usr/local 的 tailscale。
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
Restart=always
RestartSec=5
# 只读本机服务清单，没有要 root 的理由。
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
}

export interface InstallResult {
  platform: Platform;
  file: string;
  /** 用户还需要自己做的事（比如 enable-linger）。 */
  notes: string[];
}

export async function installService(options: InstallOptions = {}, defaultScript = ''): Promise<InstallResult> {
  const platform = platformOf();
  const r = resolve(options, defaultScript);
  fs.mkdirSync(logDir(), { recursive: true });
  const notes: string[] = [];

  if (platform === 'launchd') {
    const file = plistPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 先卸旧的，否则 bootstrap 会因为已加载而失败。
    await run('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}/${SERVICE_LABEL}`]).catch(() => undefined);
    fs.writeFileSync(file, renderPlist(r));
    await run('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 0}`, file]);
    await run('launchctl', ['enable', `gui/${process.getuid?.() ?? 0}/${SERVICE_LABEL}`]).catch(() => undefined);
    return { platform, file, notes };
  }

  const file = unitPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderUnit(r));
  await run('systemctl', ['--user', 'daemon-reload']);
  await run('systemctl', ['--user', 'enable', SYSTEMD_UNIT]);
  // 必须 restart 而不是 `enable --now`：对已经 active 的服务，start 是 no-op，
  // 于是 npm 更新了文件、进程却还在跑旧代码——实测升级后 manifest 少了一条
  // access，查了半天才发现是没重启。launchd 那边 bootout+bootstrap 本来就是
  // 真重启，没这个问题。
  await run('systemctl', ['--user', 'restart', SYSTEMD_UNIT]);
  // 用户级 unit 默认在登出后被杀，服务器上必须开 linger 才算真常驻。
  const lingering = await run('loginctl', ['show-user', os.userInfo().username, '--property=Linger'])
    .then((out) => out.stdout.includes('Linger=yes'))
    .catch(() => false);
  if (!lingering) {
    notes.push(
      `用户级 systemd 服务在登出后会被停掉。要让它一直跑：sudo loginctl enable-linger ${os.userInfo().username}`,
    );
  }
  return { platform, file, notes };
}

export async function uninstallService(): Promise<{ platform: Platform; file: string; removed: boolean }> {
  const platform = platformOf();
  if (platform === 'launchd') {
    const file = plistPath();
    await run('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}/${SERVICE_LABEL}`]).catch(() => undefined);
    const removed = fs.existsSync(file);
    if (removed) fs.rmSync(file);
    return { platform, file, removed };
  }
  const file = unitPath();
  await run('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]).catch(() => undefined);
  const removed = fs.existsSync(file);
  if (removed) fs.rmSync(file);
  await run('systemctl', ['--user', 'daemon-reload']).catch(() => undefined);
  return { platform, file, removed };
}

export interface ServiceStatus {
  platform: Platform;
  installed: boolean;
  file: string;
  /** 服务管理器怎么说。 */
  managerSays: string;
  /** 端口上是不是真的有人应答——管理器说 running 不等于服务健康。 */
  responding: boolean;
  port: number;
}

export async function serviceStatus(port: number = NODE_AGENT_PORT): Promise<ServiceStatus> {
  const platform = platformOf();
  const file = platform === 'launchd' ? plistPath() : unitPath();
  const installed = fs.existsSync(file);

  let managerSays = '未安装';
  if (installed) {
    managerSays =
      platform === 'launchd'
        ? await run('launchctl', ['print', `gui/${process.getuid?.() ?? 0}/${SERVICE_LABEL}`])
            .then((out) => (/state = (\w+)/.exec(out.stdout)?.[1] ?? 'loaded'))
            .catch(() => '未加载')
        : await run('systemctl', ['--user', 'is-active', SYSTEMD_UNIT])
            .then((out) => out.stdout.trim())
            .catch((error: { stdout?: string }) => error.stdout?.trim() || 'inactive');
  }

  // 管理器说 running 不代表端口通，所以再探一次。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  const responding = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal })
    .then((res) => res.ok)
    .catch(() => false)
    .finally(() => clearTimeout(timer));

  return { platform, installed, file, managerSays, responding, port };
}

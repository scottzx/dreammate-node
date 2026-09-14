/**
 * 节点身份：优先取自 tailnet，拿不到就回退到本地。
 *
 * tailnet 已经维护着稳定 ID、唯一名字和操作系统，本机所有进程读到的是同一份，
 * 不会各自生成 id 把一台机器裂成几个 Node。
 *
 * 零运行时依赖：只用 node: 内置模块。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { IdentitySource } from '@1agents/dreammate-network';

export interface NodeIdentity {
  node_id: string;
  name: string;
  type: string;
  source: IdentitySource;
  /** MagicDNS 名，仅 tailscale 来源时有。 */
  dnsName?: string;
  /** tailnet IPv4，仅 tailscale 来源时有。 */
  ipv4?: string;
}

const OS_TO_NODE_TYPE: Record<string, string> = {
  macOS: 'macos',
  linux: 'linux',
  windows: 'windows',
  iOS: 'ios',
  android: 'android',
};

/** tailscale 的 OS 值转成协议的 node.type，未知值原样降级——不要把新平台挡在网络外。 */
export function nodeTypeOf(os: string): string {
  return OS_TO_NODE_TYPE[os] ?? os.toLowerCase();
}

const PLATFORM_TYPE: Record<string, string> = {
  darwin: 'macos',
  linux: 'linux',
  win32: 'windows',
};

/** 回退身份的存放位置。注意是**节点级**路径，不是某个服务自己的目录。 */
export function localIdentityPath(): string {
  return path.join(os.homedir(), '.1agents', 'node.json');
}

interface RawStatus {
  BackendState?: string;
  Self?: { ID?: string; DNSName?: string; OS?: string; TailscaleIPs?: string[] };
}

/**
 * 跑一次 `tailscale status --json`。
 *
 * 任何不顺利都返回 undefined 而不是抛错：没装、没登录、CLI 卡住、输出换了格式——
 * 这些都只该让我们回退，不该让 agent 起不来。stderr 会有版本告警，只读 stdout。
 */
function readStatus(timeoutMs: number): Promise<RawStatus | undefined> {
  return new Promise((resolve) => {
    execFile('tailscale', ['status', '--json'], { timeout: timeoutMs, maxBuffer: 8 << 20 }, (error, stdout) => {
      if (error || !stdout) return resolve(undefined);
      try {
        resolve(JSON.parse(stdout) as RawStatus);
      } catch {
        resolve(undefined);
      }
    });
  });
}

let cache: { at: number; value: NodeIdentity } | undefined;

/** 身份几乎不变，而每个请求都 fork 一次 CLI 是浪费。 */
export const CACHE_MS = 60_000;

export function resetIdentityCache(): void {
  cache = undefined;
}

/**
 * 本机身份。
 *
 * `DREAMMATE_NODE_ID` / `DREAMMATE_NODE_NAME` 覆盖一切，容器或同机第二个实例用。
 */
export async function nodeIdentity(options: { force?: boolean; timeoutMs?: number } = {}): Promise<NodeIdentity> {
  const now = Date.now();
  if (!options.force && cache && now - cache.at < CACHE_MS) return cache.value;

  const envId = process.env.DREAMMATE_NODE_ID?.trim();
  const envName = process.env.DREAMMATE_NODE_NAME?.trim();
  const status = await readStatus(options.timeoutMs ?? 2_000);
  const self = status?.Self;

  let identity: NodeIdentity;
  // 未登录时 Self 仍在，但 BackendState 不是 Running，此时身份不可信。
  if (status?.BackendState === 'Running' && self?.ID && self.DNSName) {
    const dnsName = self.DNSName.replace(/\.$/, '');
    identity = {
      node_id: envId ?? self.ID,
      // 取 DNSName 而不是 HostName：iOS 设备的 HostName 全是 localhost。
      name: envName ?? dnsName.split('.')[0]!,
      type: nodeTypeOf(self.OS ?? ''),
      source: 'tailscale',
      dnsName,
      ...(self.TailscaleIPs?.find((ip) => ip.includes('.')) ? { ipv4: self.TailscaleIPs.find((ip) => ip.includes('.'))! } : {}),
    };
  } else {
    identity = localIdentity(envId, envName);
  }

  cache = { at: now, value: identity };
  return identity;
}

/** 没有 tailnet 时的身份。`name` 不保证跨设备唯一，只适合单机自用。 */
function localIdentity(envId?: string, envName?: string): NodeIdentity {
  const type = PLATFORM_TYPE[process.platform] ?? process.platform;
  if (envId && envName) return { node_id: envId, name: envName, type, source: 'local' };

  const file = localIdentityPath();
  let stored: Partial<NodeIdentity> = {};
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<NodeIdentity>;
  } catch {
    // 首次运行，或者文件坏了——下面会覆盖。
  }
  if (!stored.node_id) {
    stored = { node_id: `node_${randomUUID().replace(/-/g, '').slice(0, 12)}`, name: os.hostname(), type };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);
  }
  return {
    node_id: envId ?? stored.node_id!,
    name: envName ?? stored.name ?? os.hostname(),
    type,
    source: 'local',
  };
}

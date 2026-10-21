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

export interface NetworkNode {
  node_id: string;
  name: string;
  type: string;
  online: boolean;
  /** Explicit network presence; null means Tailscale status could not be read. */
  network_online?: boolean | null;
  network_checked_at?: string;
  is_self: boolean;
  dnsName?: string;
  ipv4?: string;
}

interface PeerStatus {
  ID?: string;
  HostName?: string;
  DNSName?: string;
  OS?: string;
  TailscaleIPs?: string[];
  Online?: boolean;
}

interface RawStatus {
  BackendState?: string;
  Self?: { ID?: string; DNSName?: string; OS?: string; TailscaleIPs?: string[]; HostName?: string; Online?: boolean };
  Peer?: Record<string, PeerStatus>;
}

/**
 * 去哪儿找 tailscale。
 *
 * 光靠 PATH 不够：launchd 给的 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，
 * systemd 的也好不到哪去。装成常驻服务后会找不到 homebrew 里的 tailscale，
 * 于是静默回退到本地身份——同一台机器在前台和服务模式下变成两个 Node，
 * 而且没人会注意到。
 */
const TAILSCALE_CANDIDATES = [
  'tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/usr/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
];

/** 找到过一次就记住，省得每次启动都试一遍。 */
let resolvedBin: string | undefined;

/** `DREAMMATE_TAILSCALE_BIN` 覆盖查找，装在别处时用。 */
function candidates(): string[] {
  const override = process.env.DREAMMATE_TAILSCALE_BIN?.trim();
  if (override) return [override];
  return [...new Set(resolvedBin ? [resolvedBin, ...TAILSCALE_CANDIDATES] : TAILSCALE_CANDIDATES)];
}

/**
 * 跑一次 `tailscale status --json`。
 *
 * 任何不顺利都返回 undefined 而不是抛错：没装、没登录、CLI 卡住、输出换了格式——
 * 这些都只该让我们回退，不该让 agent 起不来。stderr 会有版本告警，只读 stdout。
 */
function runOne(bin: string, timeoutMs: number): Promise<RawStatus | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value?: RawStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // execFile's callback can wait for inherited pipes even after the child dies.
    // Resolve independently, and do not let a CLI that ignores SIGTERM linger.
    const timer = setTimeout(() => {
      finish();
      child.kill('SIGKILL');
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, timeoutMs);
    const child = execFile(bin, ['status', '--json'], { maxBuffer: 8 << 20 }, (error, stdout) => {
      if (settled) return;
      if (error || !stdout) return finish();
      try {
        const parsed: unknown = JSON.parse(stdout);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return finish();
        resolvedBin = bin;
        finish(parsed as RawStatus);
      } catch {
        finish();
      }
    });
  });
}

interface StatusSnapshot { at: number; value: RawStatus | undefined }
const STATUS_CACHE_MS = 5_000;
let statusCache: StatusSnapshot | undefined;
let statusPending: Promise<StatusSnapshot> | undefined;

/** One total budget across candidates, shared by concurrent identity/topology reads. */
async function readStatus(timeoutMs: number, force = false): Promise<StatusSnapshot> {
  if (!force && statusCache && Date.now() - statusCache.at < STATUS_CACHE_MS) return statusCache;
  if (statusPending) return statusPending;
  const pending = (async () => {
    const bins = candidates();
    const deadline = performance.now() + timeoutMs;
    let value: RawStatus | undefined;
    for (const [index, bin] of bins.entries()) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      // Reserve time for alternatives when the preferred installation stalls.
      value = await runOne(bin, Math.max(1, Math.floor(remaining / (bins.length - index))));
      if (value) break;
    }
    return { at: Date.now(), value };
  })();
  statusPending = pending;
  try {
    const snapshot = await pending;
    if (statusPending === pending) statusCache = snapshot;
    return snapshot;
  }
  finally { if (statusPending === pending) statusPending = undefined; }
}

/** 测试用：忘掉已解析的 tailscale 路径。 */
export function resetBinCache(): void {
  resolvedBin = undefined;
  statusCache = undefined;
  statusPending = undefined;
}

let cache: { at: number; value: NodeIdentity } | undefined;
let identityPending: Promise<NodeIdentity> | undefined;

/** 身份几乎不变，而每个请求都 fork 一次 CLI 是浪费。 */
export const CACHE_MS = 60_000;

export function resetIdentityCache(): void {
  cache = undefined;
  identityPending = undefined;
}

/**
 * 本机身份。
 *
 * `DREAMMATE_NODE_ID` / `DREAMMATE_NODE_NAME` 覆盖一切，容器或同机第二个实例用。
 */
export async function nodeIdentity(options: { force?: boolean; timeoutMs?: number } = {}): Promise<NodeIdentity> {
  if (!options.force && cache) {
    // A stable identity must not make health, registration or invocation wait
    // for the network CLI every minute. Refresh once in the background.
    if (Date.now() - cache.at >= CACHE_MS) void refreshIdentity(options).catch(() => {});
    return cache.value;
  }
  return refreshIdentity(options);
}

function refreshIdentity(options: { force?: boolean; timeoutMs?: number }): Promise<NodeIdentity> {
  if (identityPending) return identityPending;
  const pending = readStatus(options.timeoutMs ?? 2_000, options.force).then(snapshot => {
    const identity = identityFromStatus(snapshot.value);
    if (identityPending === pending) cache = { at: snapshot.at, value: identity };
    return identity;
  });
  identityPending = pending;
  void pending.finally(() => { if (identityPending === pending) identityPending = undefined; }).catch(() => {});
  return pending;
}

function identityFromStatus(status: RawStatus | undefined): NodeIdentity {
  const envId = process.env.DREAMMATE_NODE_ID?.trim();
  const envName = process.env.DREAMMATE_NODE_NAME?.trim();
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
  } else if (!status && cache?.value.source === 'tailscale') {
    // A temporary status failure does not give this device a different ID.
    identity = { ...cache.value, node_id: envId ?? cache.value.node_id, name: envName ?? cache.value.name };
  } else {
    identity = localIdentity(envId, envName);
  }

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

/**
 * 获取局域网 / Tailnet 内已知的所有设备节点（包括本机与对端 Peers）。
 */
export async function listNetworkNodes(options: { timeoutMs?: number; force?: boolean } = {}): Promise<NetworkNode[]> {
  // Derive identity and peers from the same snapshot, never two CLI rounds.
  const snapshot = await readStatus(options.timeoutMs ?? 2_000, options.force);
  const self = identityFromStatus(snapshot.value);
  cache = { at: snapshot.at, value: self };
  const nodes: NetworkNode[] = [
    {
      node_id: self.node_id,
      name: self.name,
      type: self.type,
      online: true,
      is_self: true,
      dnsName: self.dnsName,
      ipv4: self.ipv4,
    },
  ];

  const status = snapshot.value;
  const checkedAt = new Date(snapshot.at).toISOString();
  nodes[0]!.network_online = status ? status.BackendState === 'Running' && status.Self?.Online !== false : null;
  nodes[0]!.network_checked_at = checkedAt;
  if (!status || status.BackendState !== 'Running' || !status.Peer) {
    return nodes;
  }

  for (const peer of Object.values(status.Peer)) {
    if (!peer.ID) continue;
    const dnsName = peer.DNSName ? peer.DNSName.replace(/\.$/, '') : undefined;
    const name = (dnsName ? dnsName.split('.')[0] : peer.HostName) ?? peer.ID;
    const ipv4 = peer.TailscaleIPs?.find((ip) => ip.includes('.'));
    nodes.push({
      node_id: peer.ID,
      name,
      type: nodeTypeOf(peer.OS ?? ''),
      online: Boolean(peer.Online),
      network_online: Boolean(peer.Online),
      network_checked_at: checkedAt,
      is_self: false,
      dnsName,
      ipv4,
    });
  }

  return nodes;
}


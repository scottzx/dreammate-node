/**
 * 公网访问的开关与凭证。
 *
 * 「这台机器要不要在公网上可达」只有本机能决定，所以状态放在本机文件里，
 * 变更只接受回环来源。凭证分两个文件：状态文件只存摘要，明文 token 单独放，
 * 这样状态文件被备份或同步时不会连带动用凭据。
 *
 * 网关侧的判定顺序是：先看来源网段，再看 token。免 token 的网段是
 * 「局域网 + Tailnet 虚拟局域网」——它们本来就只在本机可见，不构成公网暴露。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const ACCESS_STATE_VERSION = 1;

/** token 前缀。带上它是为了让人一眼看出这是凭据，而不是随机串。 */
export const TOKEN_PREFIX = 'dmk_';

/**
 * 默认免 token 的网段：回环、RFC1918 局域网、Tailscale 虚拟局域网。
 *
 * 100.64.0.0/10 是 CGNAT 段，Tailscale 用它；它同时也是公网地址空间的一部分，
 * 所以落在这一段的来源并不必然来自 Tailnet，只是默认值，不是安全边界。
 */
export const DEFAULT_TRUSTED_ZONES: readonly string[] = [
  '127.0.0.0/8',
  '::1/128',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  'fd7a:115c:a1e0::/48',
];

export interface PublicAccessState {
  /** 公网访问总开关。关着时任何公网来源都拿不到服务。 */
  enabled: boolean;
  /** token 的 SHA-256 摘要；状态文件里不存明文。 */
  token_hash: string | null;
  created_at: string | null;
  rotated_at: string | null;
  /** 免 token 的可信网段。 */
  trusted_zones: string[];
  /** 可信网段之外是否要求 token。 */
  require_token_outside_zones: boolean;
}

export interface AccessState {
  version: number;
  public_access: PublicAccessState;
}

export interface AccessSnapshot extends AccessState {
  /** 状态文件损坏时为 true；此时一律按「公网访问关闭」处理。 */
  corrupt: boolean;
}

export function agentHome(): string {
  return path.join(os.homedir(), '.1agents');
}

export function accessStatePath(): string {
  return path.join(agentHome(), 'access.json');
}

export function accessTokenPath(): string {
  return path.join(agentHome(), 'public-access.token');
}

export function defaultAccessState(): AccessState {
  return {
    version: ACCESS_STATE_VERSION,
    public_access: {
      enabled: false,
      token_hash: null,
      created_at: null,
      rotated_at: null,
      trusted_zones: [...DEFAULT_TRUSTED_ZONES],
      require_token_outside_zones: true,
    },
  };
}

function normalizeState(value: unknown): AccessState {
  const fallback = defaultAccessState();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const record = value as Record<string, unknown>;
  const publicAccess = (record.public_access ?? {}) as Record<string, unknown>;
  const zones = Array.isArray(publicAccess.trusted_zones)
    ? publicAccess.trusted_zones.filter((zone): zone is string => typeof zone === 'string')
    : fallback.public_access.trusted_zones;
  return {
    version: ACCESS_STATE_VERSION,
    public_access: {
      enabled: publicAccess.enabled === true,
      token_hash: typeof publicAccess.token_hash === 'string' ? publicAccess.token_hash : null,
      created_at: typeof publicAccess.created_at === 'string' ? publicAccess.created_at : null,
      rotated_at: typeof publicAccess.rotated_at === 'string' ? publicAccess.rotated_at : null,
      trusted_zones: zones,
      require_token_outside_zones: publicAccess.require_token_outside_zones !== false,
    },
  };
}

/**
 * 读当前状态。文件不存在就是默认状态（公网访问关闭）。
 *
 * 文件损坏时不按默认值里的「关闭」处理——直接报错，让调用方 fail closed，
 * 免得一个写坏的状态文件被当成「什么都没配」。
 */
export function readAccessState(file = accessStatePath()): AccessSnapshot {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...defaultAccessState(), corrupt: false };
    }
    throw error;
  }
  try {
    return { ...normalizeState(JSON.parse(raw)), corrupt: false };
  } catch {
    return { ...defaultAccessState(), corrupt: true };
  }
}

/** 写状态文件。目录按 0700、文件按 0600，避免同机其他账号读到。 */
export function writeAccessState(state: AccessState, file = accessStatePath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

export function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 常量时间比对，避免按字节猜摘要。 */
export function verifyToken(token: string, hash: string | null): boolean {
  if (!hash) return false;
  const provided = Buffer.from(hashToken(token), 'hex');
  const expected = Buffer.from(hash, 'hex');
  if (provided.length !== expected.length || expected.length === 0) return false;
  return timingSafeEqual(provided, expected);
}

/** 明文 token 只落在这个文件里，0600。 */
export function writeTokenFile(token: string, file = accessTokenPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function readTokenFile(file = accessTokenPath()): string | undefined {
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    return value || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function removeTokenFile(file = accessTokenPath()): void {
  try {
    fs.rmSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * 把网段列表编译成可判断的集合。
 *
 * 只接受裸 IP 或 CIDR。主机名不收：域名会解析到别处，判定就不确定了。
 */
export function parseTrustedZones(zones: readonly string[]): net.BlockList {
  const list = new net.BlockList();
  for (const zone of zones) {
    const value = zone.trim();
    if (!value) continue;
    const slash = value.indexOf('/');
    const address = slash === -1 ? value : value.slice(0, slash);
    const ip = net.isIP(address);
    if (ip === 0) continue;
    const type = ip === 4 ? 'ipv4' : 'ipv6';
    if (slash === -1) {
      list.addAddress(address, type);
      continue;
    }
    const prefix = Number(value.slice(slash + 1));
    const max = ip === 4 ? 32 : 128;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) continue;
    list.addSubnet(address, prefix, type);
  }
  return list;
}

/** 判断一个客户端 IP 是否落在可信网段里。 */
export function isTrustedZone(ip: string, zones: net.BlockList): boolean {
  const version = net.isIP(ip);
  if (version === 0) return false;
  return zones.check(ip, version === 4 ? 'ipv4' : 'ipv6');
}

/** 网段是否写得对：裸 IP 或 CIDR，前缀长度要落在对应地址族的范围内。 */
export function isValidZone(zone: string): boolean {
  const value = zone.trim();
  if (!value) return false;
  const slash = value.indexOf('/');
  const address = slash === -1 ? value : value.slice(0, slash);
  const version = net.isIP(address);
  if (version === 0) return false;
  if (slash === -1) return true;
  const prefix = value.slice(slash + 1);
  if (!/^\d+$/.test(prefix)) return false;
  const max = version === 4 ? 32 : 128;
  const length = Number(prefix);
  return length >= 0 && length <= max;
}

export interface AccessDecision {
  allow: boolean;
  status?: number;
  error?: string;
}

/**
 * 数据面准入：回环和可信网段免 token；公网在开关打开时要 token，关着则直接拒绝。
 * token 只决定进不进得来，不提高 local 共享服务的可见性。
 */
export function decidePublicAccess(input: {
  isLoopback: boolean;
  clientIp: string;
  snapshot: AccessSnapshot;
  token?: string;
}): AccessDecision {
  if (input.isLoopback) return { allow: true };
  const zones = parseTrustedZones(input.snapshot.corrupt
    ? DEFAULT_TRUSTED_ZONES
    : input.snapshot.public_access.trusted_zones);
  if (isTrustedZone(input.clientIp, zones)) return { allow: true };
  if (input.snapshot.corrupt || !input.snapshot.public_access.enabled) {
    return { allow: false, status: 403, error: '公网访问未开启' };
  }
  if (!input.snapshot.public_access.require_token_outside_zones) return { allow: true };
  if (!input.token || !verifyToken(input.token, input.snapshot.public_access.token_hash)) {
    return { allow: false, status: 401, error: '公网访问需要有效 token' };
  }
  return { allow: true };
}

/** 展示用的掩码，只给尾部，避免整个 token 出现在终端历史里。 */
export function maskToken(token: string | undefined): string | null {
  if (!token) return null;
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

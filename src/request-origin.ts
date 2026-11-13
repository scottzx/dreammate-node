/**
 * 请求来源判定。
 *
 * 网关是整台机器对网络的唯一入口，所以「这个请求是不是本机来的」决定了
 * 报备、来源管理和 local 共享服务能不能对它开放。
 *
 * 关键点：只看 socket 对端地址会被反向代理绕过——代理连到 127.0.0.1:36908 时，
 * 对端就是回环，公网流量会被误判成本机请求，报备口和 local 共享服务就一起敞开。
 * 所以这里把「对端」和「客户端」分开：
 *
 *   - 经过转发的请求一律不算本机请求（转发头存在本身就说明中间有代理）；
 *   - 客户端身份只从已登记的可信代理的转发头里取，转发头必须被覆盖成单个 IP。
 */
import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

export interface RequestOrigin {
  /** 有效客户端 IP。直连=对端地址；经可信代理=转发头里的单个 IP。 */
  clientIp: string;
  /** 是否来自本机回环，且未经任何转发。 */
  isLoopback: boolean;
  /** 请求是否带有转发头。 */
  forwarded: boolean;
  /** 转发头是否来自已登记的可信代理。 */
  trustedForward: boolean;
}

/** 去掉 IPv4-mapped IPv6 前缀、方括号和 zone id，得到可比较的裸地址。 */
export function normalizeIp(value: string): string {
  let ip = value.trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  if (ip.toLowerCase().startsWith('::ffff:') && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return ip.toLowerCase();
}

export function isLoopbackAddress(ip: string): boolean {
  const value = normalizeIp(ip);
  if (value === '::1') return true;
  return /^127\./.test(value);
}

/**
 * 解析可信代理列表。只接受裸 IP 字面量：端口、CIDR 和主机名一律忽略。
 * 代理身份必须精确到一台机器，模糊匹配会让「谁能代表客户端发言」变得不可控。
 */
export function parseTrustedProxyIps(value: string | undefined | null): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const part of value.split(',')) {
    const ip = normalizeIp(part);
    if (!ip || isIP(ip) === 0) continue;
    if (!out.includes(ip)) out.push(ip);
  }
  return out;
}

interface Forwarded {
  /** 请求是否带了转发头。 */
  present: boolean;
  /** 可用的单个客户端 IP；头缺失、多值或非法时为 undefined。 */
  ip?: string;
}

/**
 * 取转发头里的客户端 IP。
 *
 * 只接受单个 IP：多值意味着链式转发或伪造，每个值都不可单独采信。
 * `x-forwarded-for` 优先，`x-real-ip` 作为 nginx 常见写法的兜底。
 */
export function forwardedClientIp(req: IncomingMessage): Forwarded {
  const raw = req.headers['x-forwarded-for'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value === 'string' && value.trim()) {
    const parts = value.split(',').map(part => part.trim()).filter(Boolean);
    if (parts.length === 1) {
      const ip = normalizeIp(parts[0]!);
      if (isIP(ip) !== 0) return { present: true, ip };
    }
    return { present: true };
  }
  const real = req.headers['x-real-ip'];
  const realValue = Array.isArray(real) ? real[0] : real;
  if (typeof realValue === 'string' && realValue.trim()) {
    const ip = normalizeIp(realValue);
    if (isIP(ip) !== 0) return { present: true, ip };
    return { present: true };
  }
  return { present: false };
}

/**
 * 判定请求来源。
 *
 * @param trustedProxyIps 已登记的可信代理地址；只有它们说出来的客户端 IP 才采信。
 */
export function resolveRequestOrigin(
  req: IncomingMessage,
  trustedProxyIps: readonly string[] = [],
): RequestOrigin {
  const peer = normalizeIp(req.socket.remoteAddress ?? '');
  const forwarded = forwardedClientIp(req);
  const peerIsTrustedProxy = trustedProxyIps.includes(peer);

  // 对端不是回环：它就是客户端，除非对端本身是登记过的代理。
  if (!isLoopbackAddress(peer)) {
    if (peerIsTrustedProxy && forwarded.ip) {
      return { clientIp: forwarded.ip, isLoopback: false, forwarded: true, trustedForward: true };
    }
    return { clientIp: peer, isLoopback: false, forwarded: forwarded.present, trustedForward: false };
  }

  // 对端是回环，但请求带了转发头：中间有代理。这条请求不是直接落到本机的，
  // 不能当成本机请求。转发头只有在代理已登记时才采信。
  if (forwarded.present) {
    return {
      clientIp: peerIsTrustedProxy && forwarded.ip ? forwarded.ip : peer,
      isLoopback: false,
      forwarded: true,
      trustedForward: peerIsTrustedProxy && forwarded.ip !== undefined,
    };
  }

  // 登记过的代理却没带转发头：无法证明来源，按非本机处理。
  if (peerIsTrustedProxy) {
    return { clientIp: peer, isLoopback: false, forwarded: true, trustedForward: true };
  }

  return { clientIp: peer, isLoopback: true, forwarded: false, trustedForward: false };
}

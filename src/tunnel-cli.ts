/**
 * 用可选依赖 cloudflared 开一条临时 Quick Tunnel。
 *
 * 默认把本机 HTTP MCP（127.0.0.1:8787）送出去。命令本身不启动 MCP，
 * 也不打开网关的公网访问开关。域名由 Cloudflare 临时分配，进程退出即失效。
 */
import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import { parseArgs } from 'node:util';

export const DEFAULT_TUNNEL_URL = 'http://127.0.0.1:8787';

export const TUNNEL_USAGE = `dreammate-node tunnel — 用 cloudflared 临时公开一个本机回环服务

  dreammate-node tunnel
  dreammate-node tunnel --url http://127.0.0.1:8787

默认指向 HTTP MCP 的来源地址 http://127.0.0.1:8787。先另开：
  dreammate-node mcp --transport http --port 8787 --api-key "$TOKEN"
本命令不启动 MCP，也不打开网关公网访问。--url 只接受没有账号、查询串和路径的回环地址。

stdout 打印 https://*.trycloudflare.com。HTTP MCP 的客户端地址是该域名下的 /mcp，仍要带 Bearer token。
域名不固定，进程退出后立即失效。Cloudflare 终结 TLS，能看到经过隧道的请求。
cloudflared 是可选依赖；未安装时本命令失败，其余命令不受影响。`;

const OPTIONS = {
  url: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

export interface QuickTunnel {
  stop(): void;
  on(event: 'url', listener: (url: string) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

export interface TunnelStarter {
  start(origin: string, hostHeader: string): QuickTunnel;
}

interface CloudflaredModule {
  bin: string;
  Tunnel: {
    quick(url?: string, options?: Record<string, string | number | boolean>): QuickTunnel;
  };
}

/** 只接受能被 cloudflared 回连的本机地址，避免把这条命令当成任意转发器。 */
export function tunnelTarget(value: string): { origin: string; hostHeader: string } {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('--url 必须是本机回环的 HTTP(S) 地址'); }
  // Node 22 的 IPv6 hostname 会保留方括号，例如 [::1]。
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = hostname === 'localhost' || hostname === '::1'
    || (isIP(hostname) === 4 && hostname.startsWith('127.'));
  if (!['http:', 'https:'].includes(url.protocol) || !loopback || url.username || url.password
    || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('--url 只能是没有账号、查询串和路径的本机回环地址');
  }
  if (url.port === '0') throw new Error('--url 端口无效');
  return { origin: url.origin, hostHeader: url.host };
}

function isCloudflared(value: unknown): value is CloudflaredModule {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { bin?: unknown; Tunnel?: { quick?: unknown } };
  return typeof candidate.bin === 'string' && typeof candidate.Tunnel?.quick === 'function';
}

async function cloudflaredStarter(): Promise<TunnelStarter> {
  let loaded: unknown;
  try {
    const specifier = 'cloudflared';
    loaded = await import(specifier);
  } catch {
    throw new Error('未安装可选依赖 cloudflared。在本包目录执行 npm install，或单独安装 cloudflared；不要用 --omit=optional');
  }
  if (!isCloudflared(loaded)) throw new Error('已安装的 cloudflared 包没有可用的 Tunnel.quick');
  if (!existsSync(loaded.bin)) {
    throw new Error(`cloudflared 二进制不存在（${loaded.bin}）。在本包目录执行 npx cloudflared bin install`);
  }
  const api = loaded;
  return {
    start(origin, hostHeader) {
      // Host 必须改回本机地址。HTTP MCP 拒绝公网 Host，否则 Quick Tunnel 的域名过不了 DNS rebinding 保护。
      return api.Tunnel.quick(origin, {
        '--http-host-header': hostHeader,
        '--no-autoupdate': true,
      });
    },
  };
}

/** 前台打开隧道。argv 是 `tunnel` 后面的参数。测试可注入 starter，避免真的连出公网。 */
export async function runTunnelCli(argv: string[], starter?: TunnelStarter): Promise<number> {
  let target: { origin: string; hostHeader: string };
  try {
    const args = argv[0] === 'tunnel' ? argv.slice(1) : argv;
    const parsed = (() => {
      try { return parseArgs({ args, allowPositionals: true, strict: true, options: OPTIONS }); }
      catch { throw new Error('tunnel 命令参数无效；运行 dreammate-node tunnel --help 查看用法'); }
    })();
    if (parsed.values.help) {
      console.log(TUNNEL_USAGE);
      return 0;
    }
    if (parsed.positionals.length > 0) throw new Error('tunnel 不接受位置参数');
    const requested = parsed.values.url ?? DEFAULT_TUNNEL_URL;
    if (typeof requested !== 'string') throw new Error('--url 必须是本机回环的 HTTP(S) 地址');
    target = tunnelTarget(requested);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'tunnel 参数无效');
    return 2;
  }

  let tunnel: QuickTunnel;
  try {
    const start = starter ?? await cloudflaredStarter();
    tunnel = start.start(target.origin, target.hostHeader);
  } catch (error) {
    console.error(error instanceof Error ? error.message : '无法启动 cloudflared');
    return 1;
  }

  console.error(`正在打开 Quick Tunnel，指向 ${target.origin}`);
  console.error('本命令不启动本地服务。HTTP MCP 需已在该地址监听。');

  return await new Promise<number>(resolve => {
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve(code);
    };
    const stop = (): void => { tunnel.stop(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    let printed = false;
    tunnel.on('url', publicUrl => {
      if (printed || !/^https:\/\/\S+$/.test(publicUrl)) return;
      printed = true;
      const base = publicUrl.replace(/\/$/, '');
      console.log(base);
      console.error(`Quick Tunnel ${base} → ${target.origin}`);
      console.error(`域名不固定，本进程退出后失效。若目标是 HTTP MCP，客户端地址是 ${base}/mcp，仍要带 Bearer token。`);
      console.error('Cloudflare 终结这条 TLS，能看到经过隧道的请求。');
    });
    tunnel.on('error', error => {
      console.error(`cloudflared: ${error instanceof Error ? error.message : String(error)}`);
      try { tunnel.stop(); } catch { /* 进程可能还没起来。 */ }
      finish(1);
    });
    tunnel.on('exit', (code, signal) => {
      if (signal === 'SIGINT' || signal === 'SIGTERM' || code === 0) finish(0);
      else finish(typeof code === 'number' && code > 0 && code < 256 ? code : 1);
    });
  });
}

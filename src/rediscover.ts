/**
 * agent 启动时重建注册表。
 *
 * 报备只在服务启动时发生一次，所以 agent 一重启，那些还在跑的服务就从
 * 注册表里消失了——而 agent 升级是**正常运维**，不能要求每次都手动重启
 * 所有服务。实测过这个坑：升级 agent 之后 manifest 空了半天没人发现。
 *
 * 解法是 pull：扫一遍约定端口，谁应答 `/manifest` 就把谁登记回来。服务侧
 * 零改动，也不需要心跳——这正是「约定端口」除了"没有 agent 时回退"之外的
 * 第二个用途。
 */
import { DEFAULT_PORTS, type NodeManifest } from '@1agents/dreammate-network';
import type { ServiceRegistry } from './registry.js';
import { NODE_AGENT_PORT } from './server.js';

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function reachable(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return (await fetch(url, { signal: controller.signal })).ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface RediscoverOptions {
  /** 本机 tailnet IP。用它探同一个端口来判定服务对外可不可达。 */
  ipv4?: string;
  /** 单次探测超时，默认 1.5s——本机回环，慢不到哪去。 */
  timeoutMs?: number;
  /** 要扫的端口。默认是协议约定的那几个（不含 agent 自己）。 */
  ports?: number[];
}

/**
 * 扫描约定端口，把应答的服务登记回来。返回重建了几个。
 *
 * **reachability 是探出来的，不是服务说的**：先用 127.0.0.1 确认活着，
 * 再用本机 tailnet IP 探同一个端口——通就是 `network`，不通就是 `localhost`。
 * 实测比信声明可靠，服务自己也未必清楚 systemd 给它绑到哪去了。
 */
export async function rediscover(
  registry: ServiceRegistry,
  options: RediscoverOptions = {},
): Promise<number> {
  const timeoutMs = options.timeoutMs ?? 1_500;
  const ports =
    options.ports ?? Object.values(DEFAULT_PORTS).filter((port) => port !== NODE_AGENT_PORT);

  const found = await Promise.all(
    ports.map(async (port) => {
      const manifest = (await getJson(`http://127.0.0.1:${port}/manifest`, timeoutMs)) as
        | NodeManifest
        | undefined;
      if (!manifest?.services?.length) return 0;

      // 对外可达性实测一次，别信声明。
      const outward =
        options.ipv4 !== undefined &&
        (await reachable(`http://${options.ipv4}:${port}/health`, timeoutMs));

      let count = 0;
      for (const service of manifest.services) {
        if (!service.id || (service.capabilities !== undefined && !Array.isArray(service.capabilities))) continue;
        registry.register({
          id: service.id,
          ...(service.name ? { name: service.name } : {}),
          ...(service.kind ? { kind: service.kind } : {}),
          ...(service.capabilities ? { capabilities: service.capabilities } : {}),
          ...(service.resources ? { resources: service.resources } : {}),
          port,
          reachability: outward ? 'network' : 'localhost',
          ...(service.health ? { health: service.health } : {}),
          metadata: { ...service.metadata, rediscovered: true },
        });
        count++;
      }
      return count;
    }),
  );

  return found.reduce((sum, n) => sum + n, 0);
}

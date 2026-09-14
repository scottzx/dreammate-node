/**
 * 本机服务注册表 + 探活。
 *
 * 服务向本机 agent 报备自己在哪个端口、能做什么、外部连不连得上；agent 定期
 * 探它们的 health 端点。**Node 在线不代表 Service 在线**——tailnet 只知道机器
 * 开着，进程被 kill 了它照样报在线，所以这一层必须自己探。
 */
import type { Reachability, ResourceDescriptor, Service } from '@1agents/dreammate-network';

/** 服务报备时提交的内容。 */
export interface Registration {
  id: string;
  name?: string;
  kind?: Service['kind'];
  capabilities: string[];
  port: number;
  /** 省略按 `network` 理解——大多数服务是对外的，只监听回环的那个才特殊。 */
  reachability?: Reachability;
  /** 存活探测路径，默认 `/health`。 */
  health?: string;
  resources?: ResourceDescriptor[];
  metadata?: Record<string, unknown>;
}

export type Liveness = 'up' | 'down' | 'unknown';

export interface RegisteredService extends Registration {
  registeredAt: string;
  /** `unknown` 表示还没探过，与"探过且不通"是两回事。 */
  liveness: Liveness;
  lastProbedAt?: string;
  /** 连续探测失败次数，够多就该被清掉。 */
  failures: number;
}

/** 连续失败这么多次后从注册表移除——服务大概是真没了，不是抖一下。 */
export const EVICT_AFTER_FAILURES = 5;

export interface RegistryOptions {
  /** 探活间隔，默认 15s。 */
  probeIntervalMs?: number;
  /** 单次探测超时，默认 3s。 */
  probeTimeoutMs?: number;
  /** 注入用，方便测试不起真服务。 */
  probe?: (url: string, timeoutMs: number) => Promise<boolean>;
}

async function httpProbe(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export class ServiceRegistry {
  readonly #services = new Map<string, RegisteredService>();
  readonly #options: Required<Omit<RegistryOptions, 'probe'>> & Pick<RegistryOptions, 'probe'>;
  #timer?: NodeJS.Timeout;

  constructor(options: RegistryOptions = {}) {
    this.#options = {
      probeIntervalMs: options.probeIntervalMs ?? 15_000,
      probeTimeoutMs: options.probeTimeoutMs ?? 3_000,
      probe: options.probe,
    };
  }

  /** 重复报备同一个 id 就是更新——服务重启后换了端口应该能盖掉旧的。 */
  register(entry: Registration): RegisteredService {
    const existing = this.#services.get(entry.id);
    const record: RegisteredService = {
      ...entry,
      reachability: entry.reachability ?? 'network',
      health: entry.health ?? '/health',
      registeredAt: existing?.registeredAt ?? new Date().toISOString(),
      liveness: 'unknown',
      failures: 0,
    };
    this.#services.set(entry.id, record);
    return record;
  }

  deregister(id: string): boolean {
    return this.#services.delete(id);
  }

  list(): RegisteredService[] {
    return [...this.#services.values()];
  }

  get(id: string): RegisteredService | undefined {
    return this.#services.get(id);
  }

  /**
   * 转成协议的 Service 形状，放进节点 manifest。
   *
   * `access.base_url` 用调用方能用的地址：只监听回环的服务如实写 127.0.0.1，
   * 让对方一眼看出连不上，而不是给一个看着能连、连上却超时的地址。
   *
   * 对外服务给两个 access——MagicDNS 名在前，tailnet IP 兜底。调用方的 DNS
   * 可能被劫持（实测一台装了 fake-ip 代理的 Mac 会把 MagicDNS 名解析到
   * 198.18.x.x），只给名字的话那台机器就永远连不上。
   */
  toServices(host: string, ipv4?: string): Service[] {
    return this.list().map((s) => ({
      id: s.id,
      ...(s.name ? { name: s.name } : {}),
      ...(s.kind ? { kind: s.kind } : {}),
      capabilities: s.capabilities,
      ...(s.resources ? { resources: s.resources } : {}),
      access:
        s.reachability === 'localhost'
          ? [{ protocol: 'http' as const, base_url: `http://127.0.0.1:${s.port}` }]
          : [
              { protocol: 'http' as const, base_url: `http://${host}:${s.port}` },
              // 同一个 host 时不重复给（没有 tailnet 就只有一个地址）。
              ...(ipv4 && ipv4 !== host
                ? [{ protocol: 'http' as const, base_url: `http://${ipv4}:${s.port}` }]
                : []),
            ],
      reachability: s.reachability,
      port: s.port,
      health: s.health,
      metadata: { ...s.metadata, liveness: s.liveness, ...(s.lastProbedAt ? { last_probed_at: s.lastProbedAt } : {}) },
    }));
  }

  /** 探一轮所有服务。连续失败够多次就移除。 */
  async probeAll(): Promise<void> {
    const probe = this.#options.probe ?? httpProbe;
    await Promise.all(
      this.list().map(async (service) => {
        const url = `http://127.0.0.1:${service.port}${service.health}`;
        const alive = await probe(url, this.#options.probeTimeoutMs);
        const current = this.#services.get(service.id);
        if (!current) return; // 探测期间被注销了
        current.liveness = alive ? 'up' : 'down';
        current.lastProbedAt = new Date().toISOString();
        current.failures = alive ? 0 : current.failures + 1;
        if (current.failures >= EVICT_AFTER_FAILURES) this.#services.delete(service.id);
      }),
    );
  }

  start(): void {
    if (this.#timer) return;
    // unref：探活不该让进程无法退出。
    this.#timer = setInterval(() => void this.probeAll(), this.#options.probeIntervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

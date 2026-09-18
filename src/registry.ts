/**
 * 本机服务注册表 + 探活。
 *
 * 服务向本机 agent 报备自己在哪个端口、能做什么、外部连不连得上；agent 定期
 * 探它们的 health 端点。**Node 在线不代表 Service 在线**——tailnet 只知道机器
 * 开着，进程被 kill 了它照样报在线，所以这一层必须自己探。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type {
  Reachability,
  ResourceDescriptor,
  Service,
  MethodDescriptor,
  SkillDescriptor,
  ExecutionMode,
  ServiceLifecycle,
} from '@1agents/dreammate-network';
import { loadSkillsFromDir, type SkillDescriptorWithSource } from './skills.js';

export type {
  MethodDescriptor,
  SkillDescriptor,
  SkillDescriptorWithSource,
  ExecutionMode,
  ServiceLifecycle,
};

/** 服务报备时提交的内容。 */
export interface Registration {
  id: string;
  name?: string;
  kind?: Service['kind'];
  /** @deprecated 历史过渡字段，请使用 methods 与 skills */
  capabilities?: string[];
  /** 服务实际监听的端口。纯 CLI 模式可省略。 */
  port?: number;
  /** 省略按 `network` 理解——大多数服务是对外的，只监听回环的那个才特殊。 */
  reachability?: Reachability;
  /** 存活探测路径，默认 `/health`。 */
  health?: string;
  resources?: ResourceDescriptor[];
  /** 服务自声明的方法契约集合。 */
  methods?: Record<string, MethodDescriptor>;
  /** 服务配套声明的业务技能/SOP，支持对象、数组或本地技能目录路径。 */
  skills?: Record<string, SkillDescriptorWithSource> | SkillDescriptorWithSource[] | string;
  /** 服务调用执行模式：cli=仅本地CLI，http=仅HTTP，hybrid=双模优先CLI */
  execution?: ExecutionMode;
  /** 命令行执行所使用的命令或可执行文件名，如 'transcribe' */
  command?: string;
  /** 生命周期管理声明，包括拉起与优雅关闭命令 */
  lifecycle?: ServiceLifecycle;
  metadata?: Record<string, unknown>;
}

export type Liveness = 'up' | 'down' | 'unknown';

export interface RegisteredService extends Omit<Registration, 'skills'> {
  skills?: Record<string, SkillDescriptorWithSource> | SkillDescriptorWithSource[];
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
  /** 持久化文件路径。设置为 false 则禁用落盘。 */
  storagePath?: string | false;
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
  readonly #options: Required<Omit<RegistryOptions, 'probe' | 'storagePath'>> &
    Pick<RegistryOptions, 'probe'> & { storagePath: string | false };
  #timer?: NodeJS.Timeout;

  constructor(options: RegistryOptions = {}) {
    const isTest =
      process.env.NODE_ENV === 'test' ||
      Boolean(process.env.NODE_TEST_CONTEXT) ||
      process.execArgv.includes('--test') ||
      process.argv.some((arg) => arg.includes('test'));

    const defaultStorage = isTest
      ? false
      : path.join(os.homedir(), '.1agents', 'registry.json');

    this.#options = {
      probeIntervalMs: options.probeIntervalMs ?? 15_000,
      probeTimeoutMs: options.probeTimeoutMs ?? 3_000,
      probe: options.probe,
      storagePath: options.storagePath ?? defaultStorage,
    };

    this.#loadFromDisk();
  }

  #loadFromDisk(): void {
    if (!this.#options.storagePath) return;
    try {
      if (fs.existsSync(this.#options.storagePath)) {
        const raw = fs.readFileSync(this.#options.storagePath, 'utf8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          for (const item of list) {
            if (item && typeof item === 'object' && item.id) {
              this.#services.set(item.id, {
                ...item,
                registeredAt: item.registeredAt ?? new Date().toISOString(),
                liveness: item.port !== undefined ? 'unknown' : 'up',
                failures: 0,
              });
            }
          }
        }
      }
    } catch {
      // 容忍磁盘读取异常，不阻断 agent 初始化
    }
  }

  #saveToDisk(): void {
    if (!this.#options.storagePath) return;
    try {
      const dir = path.dirname(this.#options.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = JSON.stringify([...this.#services.values()], null, 2);
      fs.writeFileSync(this.#options.storagePath, data, 'utf8');
    } catch {
      // 容忍磁盘写入异常
    }
  }

  /** 重复报备同一个 id 就是更新——服务重启后换了端口应该能盖掉旧的。 */
  register(entry: Registration): RegisteredService {
    const existing = this.#services.get(entry.id);
    let skills = entry.skills;
    if (typeof skills === 'string') {
      skills = loadSkillsFromDir(skills);
    }
    const record: RegisteredService = {
      ...entry,
      skills,
      reachability: entry.reachability ?? 'network',
      health: entry.health ?? '/health',
      registeredAt: existing?.registeredAt ?? new Date().toISOString(),
      liveness: entry.port !== undefined ? 'unknown' : 'up',
      failures: 0,
    };
    this.#services.set(entry.id, record);
    this.#saveToDisk();
    return record;
  }

  deregister(id: string): boolean {
    const result = this.#services.delete(id);
    if (result) {
      this.#saveToDisk();
    }
    return result;
  }

  list(): RegisteredService[] {
    return [...this.#services.values()];
  }

  get(id: string): RegisteredService | undefined {
    return this.#services.get(id);
  }

  /**
   * 转成协议的 Service 形状，放进节点 manifest。
   */
  toServices(host: string, ipv4?: string): Service[] {
    return this.list().map((s) => ({
      id: s.id,
      ...(s.name ? { name: s.name } : {}),
      ...(s.kind ? { kind: s.kind } : {}),
      ...(s.methods ? { methods: s.methods } : {}),
      ...(s.skills
        ? {
            skills: Object.fromEntries(
              (Array.isArray(s.skills)
                ? s.skills
                : Object.values(s.skills)
              ).map((item) => [
                item.name,
                {
                  name: item.name,
                  ...(item.description ? { description: item.description } : {}),
                  ...(item.sop ? { sop: item.sop } : {}),
                },
              ]),
            ) as Record<string, SkillDescriptor>,
          }
        : {}),
      ...(s.capabilities ? { capabilities: s.capabilities } : {}),
      ...(s.resources ? { resources: s.resources } : {}),
      ...(s.execution ? { execution: s.execution } : {}),
      ...(s.command ? { command: s.command } : {}),
      ...(s.lifecycle ? { lifecycle: s.lifecycle } : {}),
      access:
        s.port !== undefined
          ? (s.reachability === 'localhost'
              ? [{ protocol: 'http' as const, base_url: `http://127.0.0.1:${s.port}` }]
              : [
                  { protocol: 'http' as const, base_url: `http://${host}:${s.port}` },
                  // 同一个 host 时不重复给（没有 tailnet 就只有一个地址）。
                  ...(ipv4 && ipv4 !== host
                    ? [{ protocol: 'http' as const, base_url: `http://${ipv4}:${s.port}` }]
                    : []),
                ])
          : (s.command
              ? [{ protocol: 'cli' as const, command: s.command }]
              : []),
      reachability: s.reachability,
      ...(s.port !== undefined ? { port: s.port } : {}),
      ...(s.health ? { health: s.health } : {}),
      metadata: {
        ...s.metadata,
        liveness: s.liveness,
        ...(s.lastProbedAt ? { last_probed_at: s.lastProbedAt } : {}),
      },
    }));
  }

  /** 探一轮所有服务。连续失败够多次就移除。纯 CLI 服务不发 HTTP 探针。 */
  async probeAll(): Promise<void> {
    const probe = this.#options.probe ?? httpProbe;
    await Promise.all(
      this.list().map(async (service) => {
        if (service.port === undefined) {
          // 纯 CLI 服务，无 HTTP 端口，始终标记 up
          const current = this.#services.get(service.id);
          if (current) current.liveness = 'up';
          return;
        }

        const url = `http://127.0.0.1:${service.port}${service.health ?? '/health'}`;
        const alive = await probe(url, this.#options.probeTimeoutMs);
        const current = this.#services.get(service.id);
        if (!current) return; // 探测期间被注销了
        current.liveness = alive ? 'up' : 'down';
        current.lastProbedAt = new Date().toISOString();
        current.failures = alive ? 0 : current.failures + 1;
        if (current.failures >= EVICT_AFTER_FAILURES) {
          // 仅驱逐无本地 CLI 命令的纯临时 HTTP 服务；具有 command 或 execution=hybrid/cli 的常驻元数据保留
          if (!service.command && service.execution !== 'cli' && service.execution !== 'hybrid') {
            this.#services.delete(service.id);
            this.#saveToDisk();
          }
        }
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

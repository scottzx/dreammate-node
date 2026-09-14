/**
 * 给服务用的报备客户端。
 *
 * **报备是可选的。** 不报备服务照样工作，只是外部得靠约定端口才找得到它；
 * 报备之后，探测方探一个 36908 就能看见这台机器上的一切。
 *
 * 这个入口刻意做得很薄——服务只是发几个 HTTP 请求，不该为此把整个 agent
 * 的实现拉进自己的进程。
 */
import { DEFAULT_PORTS, type Reachability } from '@1agents/dreammate-network';
import type { Registration } from './registry.js';

export type { Registration, Reachability };

const AGENT_BASE = `http://127.0.0.1:${DEFAULT_PORTS['node-agent']}`;

export interface ReportOptions {
  /** 默认本机 agent。跨机报备是无效的——agent 只接受回环请求。 */
  baseUrl?: string;
  timeoutMs?: number;
}

async function call(
  method: string,
  path: string,
  body: unknown,
  options: ReportOptions,
): Promise<Response | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 2_000);
  try {
    return await fetch(`${options.baseUrl ?? AGENT_BASE}${path}`, {
      method,
      signal: controller.signal,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch {
    // agent 没起来是正常情况，不是错误——报备本来就是可选的。
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 向本机 agent 报备。
 *
 * **永不抛错**：agent 没装、没起、版本对不上，服务都该照常工作。返回值告诉
 * 调用方成没成，想提示用户就自己提示。
 */
export async function reportToAgent(
  entry: Registration,
  options: ReportOptions = {},
): Promise<{ ok: boolean; reason?: string }> {
  const res = await call('POST', '/services', entry, options);
  if (!res) return { ok: false, reason: 'agent 未运行' };
  if (!res.ok) return { ok: false, reason: `agent 返回 ${res.status}` };
  return { ok: true };
}

/** 退场时注销。同样永不抛错。 */
export async function withdrawFromAgent(
  id: string,
  options: ReportOptions = {},
): Promise<{ ok: boolean; reason?: string }> {
  const res = await call('DELETE', `/services/${encodeURIComponent(id)}`, undefined, options);
  if (!res) return { ok: false, reason: 'agent 未运行' };
  if (!res.ok) return { ok: false, reason: `agent 返回 ${res.status}` };
  return { ok: true };
}

/**
 * 报备并在进程退出时自动注销。
 *
 * 注意退出时的注销是**尽力而为**：被 SIGKILL 或断电时根本没机会跑，所以
 * agent 侧的探活才是真正的清理机制，这里只是让正常退出快一点反映出来。
 */
export async function reportAndHoldRegistration(
  entry: Registration,
  options: ReportOptions = {},
): Promise<{ ok: boolean; reason?: string }> {
  const result = await reportToAgent(entry, options);
  if (!result.ok) return result;
  let done = false;
  const withdraw = (): void => {
    if (done) return;
    done = true;
    void withdrawFromAgent(entry.id, options);
  };
  process.once('SIGINT', withdraw);
  process.once('SIGTERM', withdraw);
  process.once('beforeExit', withdraw);
  return result;
}

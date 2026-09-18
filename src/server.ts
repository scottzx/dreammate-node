/**
 * node agent 的 HTTP 面。固定监听 36908。
 *
 * 它是整台机器对网络的唯一入口：外部节点探这一个端口就能知道这台机器上有什么，
 * 把 pull 探测的成本从「N 节点 × M 端口」降到「N × 1」。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_PORTS, PROTOCOL_VERSION, type NodeManifest, type MethodDescriptor } from '@1agents/dreammate-network';
import { nodeIdentity } from './identity.js';
import { ServiceRegistry, type Registration } from './registry.js';
import { archiveSkill, type SkillDescriptorWithSource } from './skills.js';

/** 固定端口。改它等于让全网的探测方同时失明。 */
export const NODE_AGENT_PORT: number = DEFAULT_PORTS['node-agent'];

export interface AgentOptions {
  port?: number;
  /**
   * 默认 0.0.0.0：agent 的存在意义就是让别的节点找到这台机器。它本身只暴露
   * 服务清单（不暴露服务内容），敏感数据仍由各服务自己把关。
   */
  host?: string;
  registry?: ServiceRegistry;
  /** 关掉启动时的注册表重建（测试用）。 */
  rediscover?: boolean;
}

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

/**
 * 报备只接受来自回环的请求。
 *
 * 否则网络上任何人都能往你的节点里塞一个假服务，把调用方引到别处去——
 * 这是整个 agent 唯一的写入口，也是唯一值得守的地方。
 */
function isLoopback(req: http.IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? '';
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  );
}

function readBody(req: http.IncomingMessage, limitBytes = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function validate(body: unknown): Registration {
  if (typeof body !== 'object' || body === null) throw new Error('body must be an object');
  const entry = body as Partial<Registration>;
  if (!entry.id?.trim()) throw new Error('missing id');
  if (typeof entry.port !== 'number' || entry.port < 1 || entry.port > 65535) {
    throw new Error('port must be 1-65535');
  }
  if (entry.capabilities !== undefined && !Array.isArray(entry.capabilities)) {
    throw new Error('capabilities must be an array');
  }
  if (entry.reachability && entry.reachability !== 'localhost' && entry.reachability !== 'network') {
    throw new Error('reachability must be "localhost" or "network"');
  }
  if (entry.methods !== undefined) {
    if (typeof entry.methods !== 'object' || entry.methods === null || Array.isArray(entry.methods)) {
      throw new Error('methods must be an object');
    }
    for (const [mName, mDesc] of Object.entries(entry.methods)) {
      if (!mDesc || typeof mDesc !== 'object') {
        throw new Error(`method "${mName}" must be an object`);
      }
      const desc = mDesc as MethodDescriptor;
      if (typeof desc.description !== 'string' || !desc.description.trim()) {
        throw new Error(`method "${mName}" requires a non-empty description`);
      }
      if (!desc.parameters || typeof desc.parameters !== 'object' || desc.parameters.type !== 'object') {
        throw new Error(`method "${mName}" parameters must be an object schema with type: "object"`);
      }
    }
  }
  if (entry.skills !== undefined) {
    if (typeof entry.skills !== 'string' && (typeof entry.skills !== 'object' || entry.skills === null)) {
      throw new Error('skills must be an object, array or directory path');
    }
  }
  return entry as Registration;
}

export function createAgent(options: AgentOptions = {}): { server: http.Server; registry: ServiceRegistry } {
  const registry = options.registry ?? new ServiceRegistry();

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const { pathname } = url;
        const identity = await nodeIdentity();

        if (req.method === 'GET' && pathname === '/health') {
          return json(res, 200, {
            status: 'ok',
            node_id: identity.node_id,
            service: 'node-agent',
            services: registry.list().length,
          });
        }

        if (req.method === 'GET' && pathname === '/manifest') {
          const host = identity.dnsName ?? identity.name;
          const manifest: NodeManifest = {
            node_id: identity.node_id,
            name: identity.name,
            type: identity.type,
            tailscale_name: identity.dnsName ?? null,
            online: true,
            metadata: { protocol_version: PROTOCOL_VERSION, identity_source: identity.source },
            services: registry.toServices(host, identity.ipv4),
          };
          return json(res, 200, manifest);
        }

        if (req.method === 'GET' && pathname === '/services') {
          return json(res, 200, { node: identity.name, services: registry.list() });
        }

        if (req.method === 'GET' && pathname === '/nodes') {
          const { listNetworkNodes } = await import('./identity.js');
          const nodes = await listNetworkNodes();
          return json(res, 200, { node: identity.name, nodes });
        }

        const getSkillArchive = /^\/services\/([^/]+)\/skills\/([^/]+)\/archive$/.exec(pathname);
        if (req.method === 'GET' && getSkillArchive) {
          const serviceId = decodeURIComponent(getSkillArchive[1]!);
          const skillName = decodeURIComponent(getSkillArchive[2]!);
          const service = registry.get(serviceId);
          if (!service) {
            return json(res, 404, { error: `no such service: ${serviceId}` });
          }
          let targetSkill: SkillDescriptorWithSource | undefined;
          if (service.skills) {
            if (Array.isArray(service.skills)) {
              targetSkill = service.skills.find((s) => s.name === skillName);
            } else {
              targetSkill = service.skills[skillName];
            }
          }
          if (!targetSkill) {
            return json(res, 404, { error: `no such skill "${skillName}" in service "${serviceId}"` });
          }

          const { stream, cleanup } = archiveSkill({ skill: targetSkill, skillName });
          res.writeHead(200, {
            'content-type': 'application/gzip',
            'content-disposition': `attachment; filename="${encodeURIComponent(skillName)}.tar.gz"`,
          });
          stream.pipe(res);
          req.on('close', () => {
            cleanup();
          });
          return;
        }

        const getSingle = /^\/services\/([^/]+)$/.exec(pathname);
        if (req.method === 'GET' && getSingle) {
          const id = decodeURIComponent(getSingle[1]!);
          const service = registry.get(id);
          return service
            ? json(res, 200, service)
            : json(res, 404, { error: `no such service: ${id}` });
        }

        if (req.method === 'POST' && pathname === '/services') {
          if (!isLoopback(req)) {
            return json(res, 403, { error: 'registration is loopback-only' });
          }
          const entry = validate(JSON.parse(await readBody(req)));
          return json(res, 201, registry.register(entry));
        }

        const invokeService = /^\/services\/([^/]+)\/invoke$/.exec(pathname);
        if (req.method === 'POST' && invokeService) {
          const id = decodeURIComponent(invokeService[1]!);
          const service = registry.get(id);
          if (!service) {
            return json(res, 404, { error: `no such service: ${id}` });
          }
          if (service.metadata?.enabled === false) {
            return json(res, 400, { error: `service "${id}" is disabled` });
          }
          const raw = await readBody(req);
          const payload = raw ? JSON.parse(raw) : {};
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15_000);
          try {
            const forwardRes = await fetch(`http://127.0.0.1:${service.port}/invoke`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
              signal: controller.signal,
            });
            const forwardText = await forwardRes.text();
            let parsed: unknown;
            try {
              parsed = JSON.parse(forwardText);
            } catch {
              parsed = forwardText;
            }
            return json(res, forwardRes.status, parsed);
          } catch (err: unknown) {
            return json(res, 502, {
              error: `failed to reach service "${id}" at port ${service.port}: ${err instanceof Error ? err.message : String(err)}`,
            });
          } finally {
            clearTimeout(timeout);
          }
        }

        const invokeCap = /^\/capabilities\/([^/]+)\/invoke$/.exec(pathname);
        if (req.method === 'POST' && invokeCap) {
          const capability = decodeURIComponent(invokeCap[1]!);
          const target = registry.list().find(
            (s) =>
              (Boolean(s.capabilities?.includes(capability)) || Boolean(s.methods && capability in s.methods)) &&
              s.metadata?.enabled !== false &&
              s.liveness !== 'down',
          );
          if (!target) {
            return json(res, 404, { error: `no active service found for capability/method: ${capability}` });
          }
          const raw = await readBody(req);
          const payload = raw ? JSON.parse(raw) : {};
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15_000);
          try {
            const forwardRes = await fetch(`http://127.0.0.1:${target.port}/invoke`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ method: capability, capability, ...payload }),
              signal: controller.signal,
            });
            const forwardText = await forwardRes.text();
            let parsed: unknown;
            try {
              parsed = JSON.parse(forwardText);
            } catch {
              parsed = forwardText;
            }
            return json(res, forwardRes.status, parsed);
          } catch (err: unknown) {
            return json(res, 502, {
              error: `failed to reach service "${target.id}" at port ${target.port}: ${err instanceof Error ? err.message : String(err)}`,
            });
          } finally {
            clearTimeout(timeout);
          }
        }

        const remove = /^\/services\/([^/]+)$/.exec(pathname);
        if (req.method === 'DELETE' && remove) {
          if (!isLoopback(req)) {
            return json(res, 403, { error: 'deregistration is loopback-only' });
          }
          const id = decodeURIComponent(remove[1]!);
          return registry.deregister(id)
            ? json(res, 200, { removed: id })
            : json(res, 404, { error: `no such service: ${id}` });
        }

        json(res, 404, { error: `no route: ${req.method} ${pathname}` });
      } catch (error: unknown) {
        json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });

  return { server, registry };
}

export async function serveAgent(
  options: AgentOptions = {},
): Promise<{ server: http.Server; registry: ServiceRegistry; port: number; rebuilt: number }> {
  const { server, registry } = createAgent(options);
  const host = options.host ?? '0.0.0.0';
  const port = options.port ?? NODE_AGENT_PORT;
  await new Promise<void>((resolve) => server.listen(port, host, resolve));

  // 报备只在服务启动时发生一次，所以 agent 一重启，还在跑的服务就从注册表里
  // 消失了。扫一遍约定端口把它们捡回来——端口不多且都在回环，代价很小。
  const { rediscover } = await import('./rediscover.js');
  const identity = await nodeIdentity();
  const rebuilt = options.rediscover === false
    ? 0
    : await rediscover(registry, { ...(identity.ipv4 ? { ipv4: identity.ipv4 } : {}) }).catch(() => 0);

  registry.start();
  return { server, registry, port: (server.address() as AddressInfo).port, rebuilt };
}

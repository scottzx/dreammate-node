/**
 * 本机访问控制面。
 *
 * 「这台机器要不要在公网上可达」是本机的决定，所以控制面单独绑一个只听回环的端口：
 * 即使网关的数据面被反代挡在后面、或者有人从别处改配置，控制面也够不着。
 *
 * 它是状态的唯一写入方。CLI 和 MCP 工具都走这里，不直接改文件。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  accessStatePath,
  accessTokenPath,
  defaultAccessState,
  generateToken,
  hashToken,
  isValidZone,
  maskToken,
  readAccessState,
  readTokenFile,
  removeTokenFile,
  verifyToken,
  writeAccessState,
  writeTokenFile,
  type AccessSnapshot,
  type AccessState,
} from './access-control.js';

/** 控制面端口。只听回环，不对外。 */
export const ACCESS_CONTROL_PORT = 36910;

export type AccessAction = 'enable' | 'disable' | 'rotate' | 'show-token';

export interface AccessControlOptions {
  port?: number;
  /** 只接受回环地址。 */
  host?: string;
  statePath?: string;
  tokenPath?: string;
}

export interface AccessStatus {
  enabled: boolean;
  require_token_outside_zones: boolean;
  trusted_zones: string[];
  token_hint: string | null;
  token_present: boolean;
  created_at: string | null;
  rotated_at: string | null;
  corrupt: boolean;
}

function statusOf(snapshot: AccessSnapshot, tokenFile: string): AccessStatus {
  const token = readTokenFile(tokenFile);
  return {
    enabled: snapshot.public_access.enabled,
    require_token_outside_zones: snapshot.public_access.require_token_outside_zones,
    trusted_zones: snapshot.public_access.trusted_zones,
    token_hint: maskToken(token),
    token_present: Boolean(token),
    created_at: snapshot.public_access.created_at,
    rotated_at: snapshot.public_access.rotated_at,
    corrupt: snapshot.corrupt,
  };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readJsonBody(req: http.IncomingMessage, limitBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > limitBytes) throw new Error('请求体过大');
    chunks.push(buffer);
  }
  if (!size) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求体必须是有效 JSON');
  }
}

function loopbackHost(host: string | undefined): string {
  const value = host ?? '127.0.0.1';
  if (value === 'localhost' || value === '::1' || value === '127.0.0.1') return '127.0.0.1';
  throw new Error('访问控制面只监听本机回环，不接受公网或局域网地址');
}

export function createAccessControl(options: AccessControlOptions = {}): http.Server {
  const statePath = options.statePath ?? accessStatePath();
  const tokenPath = options.tokenPath ?? accessTokenPath();

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const snapshot = readAccessState(statePath);

        if (req.method === 'GET' && url.pathname === '/access') {
          return json(res, 200, statusOf(snapshot, tokenPath));
        }

        if (req.method === 'POST' && url.pathname === '/access') {
          const body = await readJsonBody(req) as { action?: unknown } | undefined;
          const action = body?.action;
          if (action !== 'enable' && action !== 'disable' && action !== 'rotate' && action !== 'show-token') {
            return json(res, 400, { error: 'action 必须是 enable、disable、rotate 或 show-token' });
          }
          const state: AccessState = {
            version: snapshot.version,
            public_access: { ...snapshot.public_access },
          };

          if (action === 'enable') {
            let token = readTokenFile(tokenPath);
            if (!token) {
              token = generateToken();
              writeTokenFile(token, tokenPath);
              state.public_access.token_hash = hashToken(token);
              state.public_access.created_at = new Date().toISOString();
            }
            state.public_access.enabled = true;
            writeAccessState(state, statePath);
            return json(res, 200, { ...statusOf({ ...state, corrupt: false }, tokenPath), token });
          }

          if (action === 'disable') {
            state.public_access.enabled = false;
            writeAccessState(state, statePath);
            return json(res, 200, statusOf({ ...state, corrupt: false }, tokenPath));
          }

          if (action === 'rotate') {
            const token = generateToken();
            writeTokenFile(token, tokenPath);
            state.public_access.token_hash = hashToken(token);
            state.public_access.enabled = true;
            state.public_access.rotated_at = new Date().toISOString();
            if (!state.public_access.created_at) state.public_access.created_at = state.public_access.rotated_at;
            writeAccessState(state, statePath);
            return json(res, 200, { ...statusOf({ ...state, corrupt: false }, tokenPath), token });
          }

          // show-token：明文只在这一个出口出现，且只在文件还在时。
          const token = readTokenFile(tokenPath);
          if (!token) return json(res, 404, { error: '本机没有保存明文 token；用 rotate 生成一枚新的' });
          return json(res, 200, { ...statusOf({ ...state, corrupt: false }, tokenPath), token });
        }

        if (req.method === 'PATCH' && url.pathname === '/access/zones') {
          const body = await readJsonBody(req) as { trusted_zones?: unknown } | undefined;
          const zones = body?.trusted_zones;
          if (!Array.isArray(zones) || zones.some(zone => typeof zone !== 'string' || !isValidZone(zone))) {
            return json(res, 400, { error: 'trusted_zones 必须是裸 IP 或 CIDR 的数组' });
          }
          const state: AccessState = {
            version: snapshot.version,
            public_access: { ...snapshot.public_access, trusted_zones: zones.map(zone => zone.trim()) },
          };
          writeAccessState(state, statePath);
          return json(res, 200, statusOf({ ...state, corrupt: false }, tokenPath));
        }

        if (req.method === 'DELETE' && url.pathname === '/access/token') {
          removeTokenFile(tokenPath);
          const state: AccessState = {
            version: snapshot.version,
            public_access: { ...snapshot.public_access, enabled: false, token_hash: null },
          };
          writeAccessState(state, statePath);
          return json(res, 200, statusOf({ ...state, corrupt: false }, tokenPath));
        }

        return json(res, 404, { error: `no route: ${req.method} ${url.pathname}` });
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}

export async function startAccessControl(
  options: AccessControlOptions = {},
): Promise<{ server: http.Server; port: number; close: () => Promise<void> }> {
  const host = loopbackHost(options.host);
  const port = options.port ?? ACCESS_CONTROL_PORT;
  const server = createAccessControl(options);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const bound = server.address() as AddressInfo;
  return {
    server,
    port: bound.port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

/**
 * 数据面用这个判断一个请求要不要 token。
 *
 * 顺序：可信网段免 token；网段之外且开关打开时要求 token；
 * 开关关着时公网来源一律拿不到服务。
 */
export function requiresToken(snapshot: AccessSnapshot, clientIp: string, isLoopback: boolean, trusted: (ip: string) => boolean): boolean {
  if (isLoopback) return false;
  if (trusted(clientIp)) return false;
  if (!snapshot.public_access.enabled) return true;
  return snapshot.public_access.require_token_outside_zones;
}

export { defaultAccessState, readAccessState, verifyToken };

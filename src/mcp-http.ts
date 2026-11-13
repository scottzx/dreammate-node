/**
 * Stateless Streamable HTTP entry for the existing MCP server.
 * Loopback only. Each POST gets its own Server and transport so sessions cannot cross.
 */
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer, visibleMcpTools, type McpOptions } from './mcp.js';
import { loadPrivateMcpSources, type PrivateMcpSources } from './mcp-client-sources.js';

const MAX_BODY_BYTES = 10 * 1024 * 1024;

export interface McpHttpOptions extends McpOptions {
  apiKey: string;
  /** Defaults to 8787. 0 lets tests bind an ephemeral port. */
  port?: number;
  /** Only loopback is accepted. Defaults to 127.0.0.1. */
  host?: string;
  /** 只暴露这些工具名。本机管理工具始终排除。 */
  allowedTools?: readonly string[];
  /** 启动时把可见工具清单写到这里。 */
  catalogPath?: string;
  /** 启动时把可见工具清单 POST 到这个地址。失败只记在返回值里，不阻止监听。 */
  reportUrl?: string;
}

export interface McpHttpEndpoint {
  url: string;
  port: number;
  tools: string[];
  catalogReported: boolean;
  close: () => Promise<void>;
}

function loopbackHost(host: string | undefined): string {
  const value = host ?? '127.0.0.1';
  if (value === 'localhost' || value === '::1' || value === '127.0.0.1') return '127.0.0.1';
  throw new Error('HTTP MCP 只监听本机回环，不接受公网或局域网地址');
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(req: IncomingMessage): string | undefined {
  const count = req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization').length;
  const header = req.headers.authorization;
  if (count !== 1 || typeof header !== 'string') return;
  const match = /^Bearer ([!-~]{16,256})$/.exec(header);
  return match?.[1];
}

function jsonRpc(res: ServerResponse, status: number, message: string, extra?: Record<string, string>): void {
  const body = JSON.stringify({ jsonrpc: '2.0', error: { code: status === 401 ? -32001 : -32000, message }, id: null });
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...extra,
  });
  res.end(body);
}

export async function startMcpHttpServer(options: McpHttpOptions): Promise<McpHttpEndpoint> {
  if (typeof options.apiKey !== 'string' || !/^[!-~]{16,256}$/.test(options.apiKey)) {
    throw new Error('HTTP MCP 需要 16–256 个可见 ASCII 字符的 API key');
  }
  const host = loopbackHost(options.host);
  const port = options.port ?? 8787;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('HTTP MCP 端口无效');

  let ownedSources: PrivateMcpSources | undefined;
  let mcpOptions: McpOptions = {
    ...options,
    exposeAccessControl: false,
    allowedTools: options.allowedTools,
  };
  if (!options.privateMcpSources) {
    await loadPrivateMcpSources(options.mcpConfig, source => { ownedSources = source; });
    if (ownedSources) mcpOptions = { ...mcpOptions, privateMcpSources: ownedSources };
  }
  const tools = visibleMcpTools(mcpOptions).map(tool => tool.name);

  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const server = http.createServer((req, res) => {
    void handle(req, res, mcpOptions, options.apiKey, allowedHosts);
  });
  server.requestTimeout = 150_000;
  server.headersTimeout = 10_000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await ownedSources?.stop();
    throw error;
  }
  const bound = server.address();
  if (!bound || typeof bound === 'string') {
    await ownedSources?.stop();
    throw new Error('HTTP MCP 没有绑到本机端口');
  }
  const actualPort = bound.port;
  allowedHosts.splice(0, allowedHosts.length, `127.0.0.1:${actualPort}`, `localhost:${actualPort}`);
  const catalogReported = await reportCatalog({
    url: `http://127.0.0.1:${actualPort}/mcp`,
    tools,
    catalogPath: options.catalogPath,
    reportUrl: options.reportUrl,
  });
  return {
    url: `http://127.0.0.1:${actualPort}/mcp`,
    port: actualPort,
    tools,
    catalogReported,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await ownedSources?.stop();
    },
  };
}

async function reportCatalog(input: {
  url: string;
  tools: string[];
  catalogPath?: string;
  reportUrl?: string;
}): Promise<boolean> {
  const body = { url: input.url, tools: input.tools, reported_at: new Date().toISOString() };
  let wrote = false;
  if (input.catalogPath) {
    fs.mkdirSync(path.dirname(input.catalogPath), { recursive: true });
    fs.writeFileSync(input.catalogPath, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    wrote = true;
  }
  if (!input.reportUrl) return wrote;
  try {
    const response = await fetch(input.reportUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: McpOptions,
  apiKey: string,
  allowedHosts: string[],
): Promise<void> {
  try {
    if (req.headers.origin) return jsonRpc(res, 403, 'Browser-originated requests are not accepted.');
    const token = bearer(req);
    if (!token || !sameSecret(token, apiKey)) {
      return jsonRpc(res, 401, 'Unauthorized', { 'www-authenticate': 'Bearer' });
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/mcp') return jsonRpc(res, 404, 'Not found');
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
      return;
    }
    const length = Number(req.headers['content-length'] ?? 0);
    if (!Number.isFinite(length) || length < 0 || length > MAX_BODY_BYTES) return jsonRpc(res, 413, 'Request body is too large');

    const mcp = createMcpServer(options);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts,
    });
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      void transport.close();
      void mcp.close();
    };
    res.on('close', finish);
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) jsonRpc(res, 500, 'MCP request failed');
      finish();
    }
  } catch {
    if (!res.headersSent) jsonRpc(res, 500, 'MCP request failed');
  }
}

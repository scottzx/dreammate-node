import http from 'node:http';
import fs from 'node:fs';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

export function createBridge(client, tools, { port = 7792, workspace, appUrl, secret = '', health, methodSupport = {} }) {
  const catalog = new Map(tools.map(tool => [`plane.${tool.name}`, tool]));
  const redact = text => secret ? text.replaceAll(secret, '[REDACTED]') : text;
  // An observed result is evidence about one action and scope, not a whole tool.
  // Bounded, in-memory history: refreshes via windows-register every 15 seconds.
  const availability = Object.fromEntries([...catalog.keys()].map(name => [name, {
    state: 'unknown', checked_at: null, observations: [],
  }]));
  for (const [method, support] of Object.entries(methodSupport)) {
    if (!catalog.has(method) || support.state !== 'unsupported' || typeof support.reason !== 'string'
        || !support.reason.trim() || !Number.isFinite(Date.parse(support.checked_at))) {
      throw Error(`Invalid explicit capability restriction for ${method}`);
    }
    availability[method] = { ...availability[method], ...support, source: 'deployment_configuration' };
  }
  const checkHealth = async () => {
    const result = await health();
    const checked_at = new Date().toISOString();
    return { ...result, checked_at, methods_verified: false,
      service_health: { status: result.online ? 'up' : 'down', scope: 'api_credentials', checked_at } };
  };
  const errorInfo = (result, method) => {
    const message = (result.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    // The official MCP exposes HTTP status in this explicit error format, not a numeric field.
    const match = /^Error calling tool '[^']+': HTTP ([45]\d{2}):/m.exec(message);
    return { kind: 'business', method, upstream_status: match ? Number(match[1]) : null,
      status_source: match ? 'upstream_error_text' : 'unknown', retryable: false };
  };
  const record = (method, params, outcome, error) => {
    const scope = Object.fromEntries(Object.entries(params).filter(([key, value]) => key.endsWith('_id') && typeof value === 'string' && value).sort(([a], [b]) => a.localeCompare(b)));
    scope.workspace = workspace;
    const action = typeof params.action === 'string' ? params.action : null;
    const checked_at = new Date().toISOString();
    const observation = { action, scope, checked_at, outcome,
      availability: outcome === 'succeeded' ? 'available' : 'unknown',
      ...(error ? { error } : {}) };
    const entry = availability[method];
    const sameScope = o => o.action === action && JSON.stringify(o.scope) === JSON.stringify(scope);
    entry.observations = [...entry.observations.filter(o => !sameScope(o)), observation].slice(-20);
    entry.checked_at = checked_at;
  };
  const send = (res, status, data) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(redact(JSON.stringify(data)));
  };
  const service = {
    id: 'plane-pm', name: 'Plane 项目管理', kind: 'mcp', execution: 'http',
    port, health: '/health', reachability: 'localhost',
    methods: {
      'plane-pm.status': { description: '检查 Plane MCP 及 API 凭证状态。', parameters: { type: 'object', properties: {}, additionalProperties: false } },
      ...Object.fromEntries([...catalog].map(([name, tool]) => [name, {
        description: tool.description || tool.name,
        parameters: tool.inputSchema,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      }])),
    },
    skills: {
      'use-plane-pm': {
        name: 'use-plane-pm',
        description: '通过官方 Plane MCP 查询和操作项目、工作项、迭代、模块等。',
        sop: '# Plane 项目管理\n服务 ID 为 plane-pm。先 inspect 具体方法的参数，再 invoke。\n方法 plane.<tool> 对应官方 MCP 工具；例如 plane.project 的 action=list。\n工作区已绑定，凭证由服务器本地注入，不需要在调用参数中携带。\n查询按接口游标分页；执行前读取 Schema，不猜测 ID。\n同一工具的 action 可能包含读取、创建、更新和删除，按用户任务选择；错误后不要盲目重复写操作。\n保留官方 MCP 的 content、structuredContent 和 isError。只有成功结果才能视为操作完成。\n工具目录仅表示 declared，不代表部署支持所有 action。inspect 的 availability 保留具体 action/资源范围的观测；unknown 不是不可用，单资源 404 不得全局禁用工具。Page 失败时可按用户任务将 PRD 保存到工作项正文并回读，不自动重试写操作。\n',
      },
    },
    metadata: { bridge: true, upstream: 'plane-mcp-server', upstream_version: '0.3.3', workspace, application_url: appUrl, tool_count: tools.length, method_availability: availability, integration: 'official-mcp', auth_model: 'personal-demo-shared-credential' },
  };
  return http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && pathname === '/health') {
        const result = await checkHealth();
        return send(res, result.online ? 200 : 503, result);
      }
      if (req.method === 'GET' && pathname === '/manifest') return send(res, 200, { services: [service] });
      if (req.method !== 'POST' || pathname !== '/invoke') return send(res, 404, { error: 'not found' });
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 65536) return send(res, 413, { error: 'body too large' });
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString('utf8');
      let input;
      try { input = JSON.parse(body); } catch { return send(res, 400, { error: 'invalid JSON' }); }
      const { method, capability, params = {} } = input ?? {};
      if (!params || typeof params !== 'object' || Array.isArray(params)) return send(res, 400, { error: 'params must be an object' });
      const name = method ?? capability;
      if (name === 'plane-pm.status') {
        if (Object.keys(params).length) return send(res, 400, { error: 'status accepts no parameters' });
        const result = await checkHealth();
        return send(res, result.online ? 200 : 503, result);
      }
      const tool = catalog.get(name);
      if (!tool) return send(res, 404, { error: 'unknown method' });
      const support = availability[name];
      if (support.state === 'unsupported') {
        return send(res, 200, { isError: true,
          content: [{ type: 'text', text: `当前部署不支持 ${name}: ${support.reason}${support.fallback ? `。替代方案: ${support.fallback}` : ''}` }],
          _meta: { dreammate_upstream: { kind: 'unsupported', method: name, upstream_status: null,
            retryable: false, evidence: support } } });
      }
      // No retry: a timed-out upstream mutation may already have succeeded.
      try {
        const result = await client.callTool({ name: tool.name, arguments: params }, undefined, { timeout: 12000 });
        const error = result.isError ? errorInfo(result, name) : undefined;
        record(name, params, result.isError ? 'failed' : 'succeeded', error);
        // A completed MCP call may contain a business error. Keep its MCP semantics.
        return send(res, 200, error ? { ...result, _meta: { ...result._meta, dreammate_upstream: error } } : result);
      } catch (error) {
        const timeout = error?.code === ErrorCode.RequestTimeout || ['TimeoutError', 'AbortError'].includes(error?.name);
        const info = { kind: timeout ? 'timeout' : 'transport', method: name, upstream_status: null, retryable: false };
        record(name, params, 'failed', info);
        return send(res, timeout ? 504 : 502, { isError: true,
          content: [{ type: 'text', text: redact(String(error?.message ?? error)) }],
          _meta: { dreammate_upstream: info } });
      }
    } catch (error) {
      return send(res, 502, { isError: true, error: redact(String(error?.message ?? error)) });
    }
  });
}

async function main() {
  const { PLANE_API_KEY: secret, PLANE_WORKSPACE_SLUG: workspace, PLANE_BASE_URL: baseUrl } = process.env;
  if (!secret || !workspace || !baseUrl) throw Error('Missing Plane configuration; load the local EnvironmentFile');
  const command = process.env.PLANE_MCP_COMMAND || '/home/scott/.local/share/dreammate-plane/venv/bin/plane-mcp-server';
  const transport = new StdioClientTransport({
    command, args: ['stdio'], stderr: 'pipe',
    env: { ...getDefaultEnvironment(), PLANE_API_KEY: secret, PLANE_WORKSPACE_SLUG: workspace, PLANE_BASE_URL: baseUrl },
  });
  // Discard raw upstream stderr; application responses and health retain useful errors.
  transport.stderr?.resume();
  const client = new Client({ name: 'dreammate-plane-bridge', version: '0.1.1' });
  let stopping = false;
  client.onclose = () => { if (!stopping) { console.error('Plane MCP disconnected; restarting bridge'); process.exit(1); } };
  await client.connect(transport, { timeout: 30000 });
  const tools = [];
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 30000 });
    tools.push(...page.tools); cursor = page.nextCursor;
  } while (cursor);
  if (!tools.length) throw Error('Plane MCP advertised no tools');
  const health = async () => {
    try {
      const r = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/users/me/`, {
        headers: { 'x-api-key': secret }, signal: AbortSignal.timeout(2000), redirect: 'error',
      });
      await r.body?.cancel();
      return { service_id: 'plane-pm', online: r.ok, api_status: r.status, workspace, mcp_tools: tools.length, url: process.env.PLANE_APP_URL || baseUrl };
    } catch {
      return { service_id: 'plane-pm', online: false, workspace, error: 'Plane API unreachable' };
    }
  };
  // Opt-in restrictions require deployment evidence; never infer unsupported from a 404.
  const methodSupport = process.env.PLANE_CAPABILITIES_FILE
    ? JSON.parse(fs.readFileSync(process.env.PLANE_CAPABILITIES_FILE, 'utf8')).methods : {};
  const server = createBridge(client, tools, { workspace, secret, appUrl: process.env.PLANE_APP_URL || baseUrl, health, methodSupport });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(7792, '127.0.0.1', resolve); });
  console.log(`Plane bridge ready: ${tools.length} tools, workspace=${workspace}, localhost:7792`);
  const close = async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    setTimeout(() => process.exit(0), 3000).unref();
    await client.close();
    process.exit(0);
  };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Plane MCP startup failed; check package installation and local configuration'); process.exit(1); });
}

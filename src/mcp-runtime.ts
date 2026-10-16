import fs from 'node:fs';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpOptions } from './mcp.js';

/** Reload future requests without replacing the transport or replaying in-flight calls. */
export async function reloadMcpHandlers(server: Server, options: McpOptions = {}): Promise<void> {
  const url = new URL(import.meta.url.endsWith('.ts') ? './mcp.ts' : './mcp.js', import.meta.url);
  url.searchParams.set('build', String(fs.statSync(url).mtimeMs));
  const current = await import(url.href) as typeof import('./mcp.js');
  if (!Array.isArray(current.MCP_TOOLS) || typeof current.callDreammateTool !== 'function') throw new Error('Invalid MCP runtime');
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: current.MCP_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async request =>
    current.callDreammateTool(request.params.name, request.params.arguments ?? {}, options));
}

/** SIGHUP is deliberately opt-in for a running stdio server, not for library consumers. */
export function installMcpReload(server: Server, options: McpOptions = {}): () => void {
  let pending: Promise<void> | undefined;
  const reload = () => {
    if (pending) return;
    pending = reloadMcpHandlers(server, options).catch(() => {
      console.error('DreamMate MCP reload failed; previous handlers remain active');
    }).finally(() => { pending = undefined; });
  };
  process.on('SIGHUP', reload);
  return () => { process.off('SIGHUP', reload); };
}

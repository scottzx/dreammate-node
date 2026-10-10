import { MCP_TOOLS, createMcpServer } from '@1agents/dreammate-node';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createRequire } from 'node:module';
import { acquireService, resolveServiceOptions } from './service-process.js';

export const name = 'dreammate-node';
export const inject = ['tools'];

// Keep the complete MCP envelope, including structuredContent and non-text blocks.
// DSH's native tool output is JSON; nothing is silently flattened or discarded.
const render = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }];
const legacyInvoke = createRequire(import.meta.url)('@1agents/dreammate-node/package.json').version === '0.7.1';

function normalizeResult(name, result) {
  // 0.7.1 wraps successful HTTP JSON in a text block, even when that JSON is an
  // MCP error. Restore only its known invoke wrapper; newer gateways fix this.
  if (legacyInvoke && name === 'dreammate_invoke' && !result.isError
    && result.content.length === 1 && result.content[0].type === 'text') {
    try {
      const value = JSON.parse(result.content[0].text);
      const parsed = CallToolResultSchema.safeParse(value);
      if (parsed.success) return parsed.data;
    } catch { /* Ordinary non-MCP business output keeps its original envelope. */ }
  }
  return result;
}

export async function apply(ctx, input = {}) {
  const options = resolveServiceOptions(input);
  await ctx.effect(() => acquireService(options));
  // Use the published gateway API rather than duplicating its routing or relying
  // on an unpublished callDreammateTool export. No extra MCP process is needed.
  const client = new Client({ name: '@1agents/dsh-dreammate-node', version: '0.1.0' });
  await ctx.effect(async () => {
    const server = createMcpServer({ agentUrl: options.serviceUrl });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
    } catch (error) {
      await Promise.allSettled([client.close(), server.close()]);
      throw error;
    }
    return async () => { await Promise.allSettled([client.close(), server.close()]); };
  });
  for (const tool of MCP_TOOLS) {
    ctx.effect(() => ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      output: { schema: { type: 'object' }, render },
      async execute(args, exec) {
        exec?.signal?.throwIfAborted();
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new TypeError('DreamMate tool arguments must be an object');
        }
        // The upstream gateway owns request timeouts. Await settlement rather than
        // abandoning a write and giving the caller a false cancellation guarantee.
        const result = normalizeResult(tool.name,
          await client.callTool({ name: tool.name, arguments: args }, undefined, { timeout: 180_000 }));
        exec?.signal?.throwIfAborted();
        // Returning isError:true as a normal value would look successful to DSH.
        if (result.isError) throw new Error(JSON.stringify(result));
        return result;
      },
    }));
  }
}

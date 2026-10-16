import { createMcpServer } from '../../src/mcp.ts';
import { installMcpReload } from '../../src/mcp-runtime.ts';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const options = { agentUrl: process.argv[2] };
const server = createMcpServer(options);
server.setRequestHandler(CallToolRequestSchema, async request => {
  if (request.params.arguments?.delay_ms) await new Promise(resolve => setTimeout(resolve, Number(request.params.arguments.delay_ms)));
  return { content: [{ type: 'text', text: JSON.stringify({ details: { schema_loaded: false }, legacy: true }) }] };
});
server.onclose = installMcpReload(server, options);
await server.connect(new StdioServerTransport());

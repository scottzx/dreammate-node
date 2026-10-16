import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'stdio-source-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
const tools = [
  {
    name: 'local_echo', description: 'Echo a message from a local MCP subprocess',
    inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
  },
  { name: 'process_id', description: 'Read the fixture process ID', inputSchema: { type: 'object' } },
];
server.setRequestHandler(ListToolsRequestSchema, request => request.params?.cursor === 'second'
  ? { tools: [tools[1]] }
  : { tools: [tools[0]], nextCursor: 'second' });
server.setRequestHandler(CallToolRequestSchema, request => {
  if (request.params.name === 'process_id') {
    return { content: [{ type: 'text', text: String(process.pid) }], structuredContent: { pid: process.pid } };
  }
  if (request.params.name !== 'local_echo') throw new Error('Unknown fixture tool');
  return {
    content: [{ type: 'text', text: String(request.params.arguments?.message) }],
    structuredContent: { message: request.params.arguments?.message, configured_env: process.env.MCP_FIXTURE_SECRET === 'stdio-fixture-secret' },
    _meta: { fixture_transport: 'stdio' },
  };
});
await server.connect(new StdioServerTransport());

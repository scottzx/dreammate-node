import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const mode = process.argv[2] ?? 'generic';
let broken = false, multiple = false, renamed = false, describeDelay = 0, listDelay = 0;
const calls = [];
const makeTool = (name, extra = {}) => ({ name, description: name, inputSchema: { type: 'object' }, ...extra });
const tools = mode === 'activepieces'
  ? ['ap_list_connections', 'ap_research_pieces', 'ap_get_piece_props', 'ap_run_action'].map(name => makeTool(name))
  : [makeTool('catalog_list', { _meta: { 'dreammate/catalog': { version: 1, list: 'catalog_list', describe: 'catalog_describe', invoke: 'catalog_invoke' } } }), makeTool('catalog_describe'), makeTool('catalog_invoke')];
tools.push(...['echo', 'list', 'foo/bar', 'foo bar', 'foo_bar', '工具 名称', 'fixture_stats', 'fixture_update'].map(name => makeTool(name)));
const json = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const server = new Server({ name: 'catalog-fixture', version: '1' }, { capabilities: { tools: { listChanged: true } } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args = {} } = request.params;
  if (name === 'fixture_stats') return json({ calls });
  if (name === 'fixture_update') {
    broken = args.broken ?? broken; multiple = args.multiple ?? multiple; renamed = args.renamed ?? renamed;
    describeDelay = args.describe_delay_ms ?? describeDelay; listDelay = args.list_delay_ms ?? listDelay;
    if (args.notify) await server.sendToolListChanged();
    return json({ ok: true });
  }
  calls.push({ name, args });
  if (name === 'catalog_list') {
    if (listDelay) await new Promise(resolve => setTimeout(resolve, listDelay));
    if (broken) return { isError: true, content: [{ type: 'text', text: 'private catalog diagnostic' }] };
    return json({ tools: args.cursor ? [{ group: 'gitlab', name: 'list', description: 'GitLab list projects' }]
      : [{ group: 'github', name: renamed ? 'lookup' : 'list', description: 'GitHub list repositories and stars' }], ...(!args.cursor ? { nextCursor: 'second' } : {}) });
  }
  if (name === 'catalog_describe') {
    if (describeDelay) await new Promise(resolve => setTimeout(resolve, describeDelay));
    return json({ inputSchema: { $id: 'shared-upstream-schema-id', type: 'object', properties: { message: { type: args.group === 'github' ? 'string' : 'integer' } }, required: ['message'], additionalProperties: false } });
  }
  if (name === 'catalog_invoke') return { ...json({ group: args.group, action: args.name, params: args.params }), _meta: { upstream: 'catalog-fixture' } };
  if (name === 'ap_list_connections') return json({ connections: [
    { externalId: 'github-one', displayName: 'GitHub first', pieceName: '@activepieces/piece-github', status: 'ACTIVE' },
    ...(multiple ? [{ externalId: 'github-two', displayName: 'GitHub second', pieceName: '@activepieces/piece-github', status: 'ACTIVE' }] : []),
    { externalId: 'gitlab-one', displayName: 'GitLab', pieceName: '@activepieces/piece-gitlab', status: 'ACTIVE' },
  ] });
  if (name === 'ap_research_pieces') {
    if (broken) return { isError: true, content: [{ type: 'text', text: 'private action diagnostic' }] };
    return json({ pieces: args.pieceNames.map(piece => ({ name: piece, displayName: piece.endsWith('github') ? 'GitHub' : 'GitLab', actions: [{ name: 'list_my_repositories', description: 'List repositories' }, { name: 'list', description: 'List resources' }] })), missing: [] });
  }
  if (name === 'ap_get_piece_props') return { content: [{ type: 'text', text: 'Action schema:\n' + JSON.stringify({ props: [
    { name: 'visibility', type: 'STATIC_DROPDOWN', required: false, options: [{ value: 'all' }, { value: 'private' }] },
    { name: 'url', type: 'DYNAMIC', required: false, dynamicFields: [{ name: 'url', type: 'SHORT_TEXT', required: true }] },
    { name: 'labels', type: 'MULTI_SELECT_DROPDOWN', required: false, options: [{ value: 'bug' }, { value: 'feature' }] },
    { name: 'body', type: 'JSON', required: false },
    { name: 'unresolved', type: 'DROPDOWN', required: false, options: [], note: 'Resolve options with known input' },
  ] }, null, 2) + '\n\nExample:\n{}' }] };
  if (name === 'ap_run_action') return { ...json({ piece: args.pieceName, action: args.actionName, connection: args.connectionExternalId, input: args.input }), _meta: { upstream: 'activepieces-fixture' } };
  return json({ tool: name, params: args });
});
await server.connect(new StdioServerTransport());

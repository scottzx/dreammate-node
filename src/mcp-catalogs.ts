import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { MethodDescriptor } from './registry.js';

export type CatalogCall = (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
export interface CatalogTool {
  group: string;
  name: string;
  description: string;
  data?: Record<string, unknown>;
}
export interface CatalogAdapter {
  id: string;
  discover(call: CatalogCall): Promise<CatalogTool[]>;
  describe(call: CatalogCall, tool: CatalogTool): Promise<MethodDescriptor>;
  invoke(call: CatalogCall, tool: CatalogTool, params: Record<string, unknown>): Promise<CallToolResult>;
}
export class CatalogError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** MCP structured data is preferred. Text JSON may have a human-readable prefix/suffix. */
export function catalogData(result: CallToolResult): Record<string, unknown> {
  if (result.isError) throw new CatalogError(502, 'Upstream catalog request failed');
  if (isObject(result.structuredContent)) {
    if (JSON.stringify(result.structuredContent).length > 2_000_000) throw new CatalogError(502, 'Upstream catalog response is too large');
    return result.structuredContent;
  }
  for (const block of result.content) {
    if (block.type !== 'text') continue;
    const text = block.text;
    if (text.length > 2_000_000) throw new CatalogError(502, 'Upstream catalog response is too large');
    for (const match of text.matchAll(/(?:^|\n)\s*(\{)/g)) {
      const start = match.index! + match[0].lastIndexOf('{');
      let depth = 0, quoted = false, escaped = false;
      for (let end = start; end < text.length; end++) {
        const char = text[end];
        if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
        else if (char === '"') quoted = true;
        else if (char === '{') depth++;
        else if (char === '}' && --depth === 0) {
          try { const data: unknown = JSON.parse(text.slice(start, end + 1)); if (isObject(data)) return data; } catch { /* Try the next JSON block. */ }
          break;
        }
      }
    }
  }
  throw new CatalogError(502, 'Upstream catalog did not return structured JSON');
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\u0000-\u001f]/.test(value)) {
    throw new CatalogError(502, 'Invalid upstream catalog identifier');
  }
  return value;
}

function schema(value: unknown): Record<string, unknown> {
  if (!isObject(value) || value.type !== 'object') throw new CatalogError(502, 'Catalog action requires an object input schema');
  return value;
}

/** Optional, vendor-neutral discovery contract, advertised by an ordinary tools/list entry. */
function declaredAdapter(tool: Tool, tools: Map<string, Tool>): CatalogAdapter | undefined {
  const meta = tool._meta?.['dreammate/catalog'];
  if (!isObject(meta) || meta.version !== 1) return undefined;
  const names = ['list', 'describe', 'invoke'] as const;
  if (names.some(key => typeof meta[key] !== 'string' || !tools.has(meta[key] as string))) return undefined;
  const list = meta.list as string, describe = meta.describe as string, invoke = meta.invoke as string;
  return {
    id: `catalog:${tool.name}`,
    async discover(call) {
      const result: CatalogTool[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 100; page++) {
        const data = catalogData(await call(list, { limit: 100, ...(cursor ? { cursor } : {}) }));
        if (!Array.isArray(data.tools)) throw new CatalogError(502, 'Catalog list requires tools');
        for (const row of data.tools) {
          if (!isObject(row) || result.length >= 5000) throw new CatalogError(502, 'Catalog tool limit exceeded');
          result.push({ group: identifier(row.group), name: identifier(row.name), description: typeof row.description === 'string' ? row.description.slice(0, 1200) : identifier(row.name) });
        }
        if (data.nextCursor === undefined || data.nextCursor === null) return result;
        cursor = identifier(data.nextCursor);
        if (cursors.has(cursor)) throw new CatalogError(502, 'Repeated catalog cursor');
        cursors.add(cursor);
      }
      throw new CatalogError(502, 'Catalog page limit exceeded');
    },
    async describe(call, child) {
      const data = catalogData(await call(describe, { group: child.group, name: child.name }));
      return { description: child.description, parameters: schema(data.inputSchema), ...(isObject(data.outputSchema) ? { returns: data.outputSchema } : {}),
        ...(isObject(data.annotations) ? { annotations: data.annotations } : {}) };
    },
    invoke: (call, child, params) => call(invoke, { group: child.group, name: child.name, params }),
  };
}

interface Connection { id: string; label: string }
function connections(child: CatalogTool): Connection[] { return child.data?.connections as Connection[] ?? []; }
function connection(child: CatalogTool, id?: unknown): Connection {
  const available = connections(child);
  if (id !== undefined && typeof id !== 'string') throw new CatalogError(400, 'connection_id must be a string');
  if (id === undefined && available.length === 1) return available[0]!;
  const selected = available.find(value => value.id === id);
  if (!selected) throw new CatalogError(400, available.length > 1 ? 'Select connection_id from the inspected schema' : 'No active connection for this action');
  return selected;
}

function activepiecesProperty(prop: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 16) throw new CatalogError(502, 'Activepieces property nesting limit exceeded');
  const multiple = ['MULTI_SELECT_DROPDOWN', 'STATIC_MULTI_SELECT_DROPDOWN'].includes(String(prop.type));
  const type = prop.type === 'NUMBER' ? 'number' : prop.type === 'CHECKBOX' ? 'boolean'
    : prop.type === 'OBJECT' || prop.type === 'DYNAMIC' ? 'object'
      : prop.type === 'ARRAY' || multiple ? 'array' : ['SHORT_TEXT', 'LONG_TEXT', 'MARKDOWN', 'DATE_TIME'].includes(String(prop.type)) ? 'string' : undefined;
  const field: Record<string, unknown> = { ...(type ? { type } : {}),
    ...(typeof prop.displayName === 'string' ? { title: prop.displayName } : {}),
    ...(typeof prop.description === 'string' ? { description: prop.description } : {}),
    ...(typeof prop.note === 'string' ? { 'x-activepieces-note': prop.note } : {}),
    'x-activepieces-type': prop.type };
  if (prop.defaultValue !== undefined) field.default = prop.defaultValue;
  const values = Array.isArray(prop.options) ? prop.options.filter(isObject).filter(option => option.value !== undefined).map(option => option.value) : [];
  if (values.length) { if (multiple) field.items = { enum: values }; else field.enum = values; }
  if (Array.isArray(prop.dynamicFields)) {
    const nested: Record<string, unknown> = Object.create(null);
    const required: string[] = [];
    for (const child of prop.dynamicFields) {
      if (!isObject(child)) throw new CatalogError(502, 'Invalid Activepieces dynamic property');
      const key = identifier(child.name);
      nested[key] = activepiecesProperty(child, depth + 1);
      if (child.required) required.push(key);
    }
    field.properties = nested;
    if (required.length) field.required = required;
  }
  return field;
}

function activepiecesAdapter(): CatalogAdapter {
  return {
    id: 'activepieces',
    async discover(call) {
      const data = catalogData(await call('ap_list_connections', { status: ['ACTIVE'] }));
      if (!Array.isArray(data.connections) || data.trimmed || data.has_more) throw new CatalogError(502, 'Incomplete Activepieces connection catalog');
      const groups = new Map<string, Connection[]>();
      for (const row of data.connections) {
        if (!isObject(row) || row.status !== 'ACTIVE') continue;
        const piece = identifier(row.pieceName), id = identifier(row.externalId);
        const items = groups.get(piece) ?? [];
        if (!items.some(item => item.id === id)) items.push({ id, label: typeof row.displayName === 'string' ? row.displayName.slice(0, 160) : id });
        groups.set(piece, items);
      }
      if (groups.size > 128) throw new CatalogError(502, 'Too many connected Activepieces integrations');
      const result: CatalogTool[] = [];
      const pieces = [...groups.keys()].sort();
      for (let i = 0; i < pieces.length; i += 8) {
        const batch = pieces.slice(i, i + 8);
        const catalog = catalogData(await call('ap_research_pieces', { pieceNames: batch }));
        if (!Array.isArray(catalog.pieces) || catalog.trimmed || (Array.isArray(catalog.missing) && catalog.missing.length)) {
          throw new CatalogError(502, 'Incomplete Activepieces action catalog');
        }
        for (const pieceName of batch) {
          const piece = catalog.pieces.find(p => isObject(p) && p.name === pieceName);
          if (!isObject(piece) || !Array.isArray(piece.actions)) throw new CatalogError(502, 'Missing Activepieces action catalog');
          for (const action of piece.actions) {
            if (!isObject(action) || result.length >= 5000) throw new CatalogError(502, 'Invalid Activepieces action catalog');
            const name = identifier(action.name);
            result.push({ group: pieceName.replace(/^@activepieces\/piece-/, ''), name,
              description: `${typeof piece.displayName === 'string' ? piece.displayName : pieceName} / ${typeof action.displayName === 'string' ? action.displayName : name}: ${typeof action.aiDescription === 'string' ? action.aiDescription : action.description ?? name}`.slice(0, 1200),
              data: { pieceName, connections: groups.get(pieceName)!.sort((a, b) => a.id.localeCompare(b.id)) } });
          }
        }
      }
      return result;
    },
    async describe(call, child) {
      const data = catalogData(await call('ap_get_piece_props', { pieceName: child.data!.pieceName, actionOrTriggerName: child.name, type: 'action',
        ...(connections(child).length === 1 ? { auth: connections(child)[0]!.id } : {}) }));
      // Dynamic fields remain visible in metadata: never guess their resolved values.
      if (!Array.isArray(data.props)) throw new CatalogError(502, 'Activepieces action schema is unavailable');
      const properties: Record<string, unknown> = Object.create(null);
      const required: string[] = [];
      for (const prop of data.props) {
        if (!isObject(prop)) throw new CatalogError(502, 'Invalid Activepieces property');
        const key = identifier(prop.name);
        properties[key] = activepiecesProperty(prop);
        if (prop.required) required.push(key);
      }
      const bindings = connections(child);
      return { description: child.description, parameters: { type: 'object', properties: {
        input: { type: 'object', properties, ...(required.length ? { required } : {}) },
        connection_id: { type: 'string', enum: bindings.map(c => c.id), description: bindings.map(c => `${c.id}: ${c.label}`).join('; '),
          ...(bindings.length === 1 ? { default: bindings[0]!.id } : {}) },
      }, required: bindings.length > 1 ? ['input', 'connection_id'] : ['input'], additionalProperties: false } };
    },
    invoke(call, child, params) {
      if (!isObject(params.input) || Object.keys(params).some(key => !['input', 'connection_id'].includes(key))) {
        throw new CatalogError(400, 'Action arguments require { input: {...}, connection_id?: string }');
      }
      const selected = connection(child, params.connection_id);
      return call('ap_run_action', { pieceName: child.data!.pieceName, actionName: child.name, connectionExternalId: selected.id, input: params.input });
    },
  };
}

export function detectCatalogAdapters(tools: Map<string, Tool>): CatalogAdapter[] {
  const result = [...tools.values()].flatMap(tool => { const adapter = declaredAdapter(tool, tools); return adapter ? [adapter] : []; });
  if (['ap_list_connections', 'ap_research_pieces', 'ap_get_piece_props', 'ap_run_action'].every(name => tools.has(name))) result.push(activepiecesAdapter());
  return result;
}

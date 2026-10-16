import path from 'node:path';

/** A source is one MCP server. Its tools share this stable service ID. */
export interface McpSourceConfig {
  id: string;
  name: string;
  type: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  oauth?: {
    tokenUrl: string;
    clientId: string;
    refreshToken: string;
    accessToken?: string;
    /** Unix timestamp in milliseconds. A missing expiry requires refreshing before use. */
    expiresAt?: number;
    clientSecret?: string;
    scope?: string;
  };
}

export const MAX_MCP_CONFIG_BYTES = 256 * 1024;
const MAX_SOURCES = 64;
const SOURCE_FIELDS = new Set(['command', 'args', 'env', 'cwd', 'url', 'headers', 'type', 'transport', 'oauth']);

// JSON.parse silently keeps the last duplicate key, which could hide an MCP
// source or override its credentials. Check object keys after syntax validation.
function rejectDuplicateKeys(json: string): void {
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < json.length; i++) {
    const char = json[i];
    if (char === '{') stack.push(new Set());
    else if (char === '[') stack.push(null);
    else if (char === '}' || char === ']') stack.pop();
    else if (char === '"') {
      const start = i;
      while (++i < json.length) {
        if (json[i] === '\\') i++;
        else if (json[i] === '"') break;
      }
      let next = i + 1;
      while (/\s/.test(json[next] ?? '') && next < json.length) next++;
      const keys = stack.at(-1);
      if (json[next] === ':' && keys) {
        const key = JSON.parse(json.slice(start, i + 1)) as string;
        if (keys.has(key)) throw new Error('MCP JSON 配置包含重复字段或数据源名称');
        keys.add(key);
      }
    }
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)) {
    throw new Error(`${label} 必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max = 65_536): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new Error(`${label} 必须是非空字符串（最多 ${max} 字符）`);
  }
  return value;
}

function stringMap(value: unknown, label: 'env' | 'headers'): Record<string, string> {
  const raw = object(value, label);
  const entries = Object.entries(raw);
  if (entries.length > 128) throw new Error(`${label} 最多包含 128 个字段`);
  for (const [key, item] of entries) {
    const validKey = label === 'env' ? /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
      : /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key);
    if (!validKey || key.length > 256 || typeof item !== 'string' || item.length > 65_536
      || item.includes('\0') || (label === 'headers' && /[\r\n]/.test(item))) {
      throw new Error(`${label} 字段名无效或值不是有效字符串`);
    }
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function transport(value: unknown): McpSourceConfig['type'] {
  if (value === 'stdio' || value === 'http' || value === 'sse') return value;
  if (value === 'streamable-http' || value === 'streamableHttp' || value === 'streamable_http') return 'http';
  throw new Error('MCP type/transport 仅支持 stdio、http（streamable-http）或 sse');
}

function remoteUrl(value: unknown, label: string): string {
  const urlText = text(value, label, 16_384);
  let url: URL;
  try { url = new URL(urlText.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, 'placeholder')); }
  catch { throw new Error(`${label} 必须是有效的 HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error(`${label} 必须是无用户凭据和片段的 HTTP(S) URL`);
  }
  return urlText;
}

function oauthConfig(value: unknown): NonNullable<McpSourceConfig['oauth']> {
  const raw = object(value, 'oauth');
  const stringFields = ['clientId', 'refreshToken', 'accessToken', 'clientSecret', 'scope'] as const;
  const fields = new Set<string>(['tokenUrl', 'expiresAt', ...stringFields]);
  if (Object.keys(raw).some(key => !fields.has(key))) throw new Error('oauth 配置包含不支持的字段');
  const result: NonNullable<McpSourceConfig['oauth']> = {
    tokenUrl: remoteUrl(raw.tokenUrl, 'oauth.tokenUrl'),
    clientId: text(raw.clientId, 'oauth.clientId'),
    refreshToken: text(raw.refreshToken, 'oauth.refreshToken'),
  };
  for (const key of stringFields) {
    if (raw[key] === undefined) continue;
    const value = text(raw[key], `oauth.${key}`);
    if (/[\r\n]/.test(value)) throw new Error('oauth 字段不能包含换行');
    result[key] = value;
  }
  if (raw.expiresAt !== undefined) {
    if (typeof raw.expiresAt !== 'number' || !Number.isSafeInteger(raw.expiresAt) || raw.expiresAt <= 0) {
      throw new Error('oauth.expiresAt 必须是正整数的 Unix 毫秒时间戳');
    }
    if (raw.accessToken === undefined) throw new Error('oauth.expiresAt 需要同时提供 accessToken');
    result.expiresAt = raw.expiresAt;
  }
  return result;
}

function parseSource(name: string, value: unknown): McpSourceConfig {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    throw new Error('MCP 名称必须是 1–64 个 ASCII 字母、数字、下划线或连字符');
  }
  const raw = object(value, 'MCP 配置');
  if (Object.keys(raw).some(key => !SOURCE_FIELDS.has(key))) throw new Error('MCP 配置包含不支持的字段');
  const type = raw.type !== undefined ? transport(raw.type)
    : raw.transport !== undefined ? transport(raw.transport) : raw.command !== undefined ? 'stdio' : 'http';
  if (raw.transport !== undefined && transport(raw.transport) !== type) {
    throw new Error('MCP type 与 transport 不一致');
  }
  const result: McpSourceConfig = { id: `mcp-${name}`, name, type };
  if (type === 'stdio') {
    if (raw.url !== undefined || raw.headers !== undefined || raw.oauth !== undefined) throw new Error('stdio MCP 不支持 url、headers 或 oauth');
    result.command = text(raw.command, 'command', 4096);
    if (/[\r\n]/.test(result.command)) throw new Error('command 不能包含换行');
    if (raw.args !== undefined) {
      if (!Array.isArray(raw.args) || raw.args.length > 256
        || raw.args.some(arg => typeof arg !== 'string' || arg.length > 65_536 || arg.includes('\0'))) {
        throw new Error('args 必须是最多 256 个字符串的数组');
      }
      result.args = [...raw.args] as string[];
    }
    if (raw.env !== undefined) result.env = stringMap(raw.env, 'env');
    if (raw.cwd !== undefined) {
      result.cwd = text(raw.cwd, 'cwd', 4096);
      if (!path.isAbsolute(result.cwd)) throw new Error('cwd 必须是绝对路径');
    }
  } else {
    if (['command', 'args', 'env', 'cwd'].some(key => raw[key] !== undefined)) {
      throw new Error('远程 MCP 不支持 command、args、env 或 cwd');
    }
    result.url = remoteUrl(raw.url, 'url');
    if (raw.headers !== undefined) result.headers = stringMap(raw.headers, 'headers');
    if (raw.oauth !== undefined) result.oauth = oauthConfig(raw.oauth);
  }
  return result;
}

/** Parse a pasted Claude-style mcpServers object, a named map, or one named source.
 * Values such as ${TOKEN} remain literal: configuration never evaluates shell/env expressions.
 * Errors intentionally omit input values because MCP URLs and headers can contain credentials.
 */
export function parseMcpSourceConfig(input: unknown, name?: string): McpSourceConfig[] {
  let value = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > MAX_MCP_CONFIG_BYTES) throw new Error('MCP 配置不能超过 256 KiB');
    try { value = JSON.parse(input); } catch { throw new Error('MCP 配置必须是有效 JSON'); }
    rejectDuplicateKeys(input);
  } else {
    try {
      if (Buffer.byteLength(JSON.stringify(input) ?? '', 'utf8') > MAX_MCP_CONFIG_BYTES) {
        throw new Error('MCP 配置不能超过 256 KiB');
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'MCP 配置不能超过 256 KiB') throw error;
      throw new Error('MCP 配置必须是可序列化的 JSON 对象');
    }
  }
  const raw = object(value, 'MCP 配置');
  let sources: Record<string, unknown>;
  if (Object.hasOwn(raw, 'mcpServers')) {
    if (Object.keys(raw).length !== 1 || name !== undefined) {
      throw new Error('mcpServers 配置不能包含其他顶层字段或同时指定 --name');
    }
    sources = object(raw.mcpServers, 'mcpServers');
  } else if (Object.entries(raw).some(([key, item]) => SOURCE_FIELDS.has(key)
    && (item === null || typeof item !== 'object' || Array.isArray(item)))) {
    if (!name) throw new Error('单个 MCP 配置需要通过 --name 指定名称');
    sources = { [name]: raw };
  } else {
    if (name !== undefined) throw new Error('命名 MCP 配置不能同时指定 --name');
    sources = raw;
  }
  const entries = Object.entries(sources);
  if (entries.length < 1 || entries.length > MAX_SOURCES) throw new Error('MCP 配置必须包含 1–64 个数据源');
  const ids = new Set<string>();
  return entries.map(([sourceName, config]) => {
    const source = parseSource(sourceName, config);
    if (ids.has(source.id)) throw new Error('MCP 配置中的数据源名称重复');
    ids.add(source.id);
    return source;
  });
}

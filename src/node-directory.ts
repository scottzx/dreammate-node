import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { DEFAULT_PORTS } from '@1agents/dreammate-network';

/** Portable addresses only: no Tailscale credentials, local identity or live status. */
export interface DirectoryNode {
  node_id: string;
  name: string;
  type: string;
  agent_url: string;
  ipv4?: string;
  dnsName?: string;
}

export interface NodeDirectory {
  format: 'dreammate.nodes';
  version: 1;
  exported_at: string;
  imported_at?: string;
  default_node: string;
  nodes: DirectoryNode[];
}

const MAX_BYTES = 2 * 1024 * 1024;
const normalized = (value: string): string => value.toLowerCase().replace(/\.$/, '');

export function gatewayUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('网关地址必须是无凭据、查询串和片段的 HTTP(S) URL');
  }
  return url.toString().replace(/\/+$/, '');
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('节点地址簿必须是 JSON 对象');
  return value as Record<string, unknown>;
}

function label(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\s\x00-\x1f]/.test(value) || value.length > 255) {
    throw new Error(`无效字段: ${field}`);
  }
  return value;
}

function date(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`无效时间: ${field}`);
  }
  return value;
}

export function findDirectoryNode(directory: NodeDirectory, alias: string): DirectoryNode | undefined {
  const wanted = normalized(alias);
  return directory.nodes.find(n => [n.node_id, n.name, n.dnsName, n.ipv4]
    .some(v => v !== undefined && normalized(v) === wanted));
}

/** Avoid MagicDNS only for the node's own HTTP address; preserve HTTPS SNI and proxies. */
export function directoryNodeUrl(node: DirectoryNode): string {
  const url = new URL(node.agent_url);
  if (url.protocol === 'http:' && node.ipv4 && !isIP(url.hostname)
    && [node.name, node.dnsName].some(alias => alias && normalized(alias) === normalized(url.hostname))) {
    url.hostname = node.ipv4;
  }
  return gatewayUrl(url.toString());
}

export function validateDirectory(value: unknown): NodeDirectory {
  const raw = object(value);
  if (raw.format !== 'dreammate.nodes' || raw.version !== 1) throw new Error('不支持的节点地址簿格式/版本；请用 cli nodes export 导出');
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0 || raw.nodes.length > 1000) {
    throw new Error('nodes 必须包含 1–1000 个节点');
  }
  const aliases = new Map<string, number>();
  const nodes = raw.nodes.map((item: unknown, index: number): DirectoryNode => {
    const n = object(item);
    const node: DirectoryNode = {
      node_id: label(n.node_id, 'node_id'), name: label(n.name, 'name'),
      type: label(n.type, 'type'), agent_url: gatewayUrl(label(n.agent_url, 'agent_url')),
    };
    if (n.ipv4 !== undefined) {
      node.ipv4 = label(n.ipv4, 'ipv4');
      if (isIP(node.ipv4) !== 4) throw new Error(`无效 IPv4: ${node.ipv4}`);
    }
    if (n.dnsName !== undefined) node.dnsName = label(n.dnsName, 'dnsName');
    for (const alias of [node.node_id, node.name, node.dnsName, node.ipv4]) {
      if (!alias) continue;
      const key = normalized(alias);
      if (['all', 'localhost', '127.0.0.1'].includes(key)) throw new Error(`节点别名是保留字: ${alias}`);
      if (aliases.has(key) && aliases.get(key) !== index) throw new Error(`节点别名重复: ${alias}`);
      aliases.set(key, index);
    }
    return node;
  });
  const directory: NodeDirectory = {
    format: 'dreammate.nodes', version: 1, exported_at: date(raw.exported_at, 'exported_at'),
    ...(raw.imported_at !== undefined ? { imported_at: date(raw.imported_at, 'imported_at') } : {}),
    default_node: label(raw.default_node, 'default_node'), nodes,
  };
  const selected = findDirectoryNode(directory, directory.default_node);
  if (!selected) throw new Error(`默认节点不在地址簿内: ${directory.default_node}`);
  directory.default_node = selected.node_id;
  return directory;
}

export function parseDirectory(text: string): NodeDirectory {
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('节点地址簿超过 2 MiB');
  return validateDirectory(JSON.parse(text));
}

export function directoryPath(override?: string): string {
  const value = override ?? process.env.DREAMMATE_NODES_FILE;
  if (!value) return path.join(os.homedir(), '.1agents', 'nodes.json');
  return path.resolve(value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value);
}

export function loadDirectory(override?: string): NodeDirectory | undefined {
  const file = directoryPath(override);
  try {
    if (fs.statSync(file).size > MAX_BYTES) throw new Error('节点地址簿超过 2 MiB');
    return parseDirectory(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !override && !process.env.DREAMMATE_NODES_FILE) return undefined;
    throw new Error(`无法读取地址簿 ${file}: ${error instanceof Error ? error.message : String(error)}；可重新导入或用 --live 忽略缓存`);
  }
}

/** Validate before touching the previous cache; replace atomically, never merge stale entries. */
export function saveDirectory(directory: NodeDirectory, file: string): void {
  const checked = validateDirectory(directory);
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(temp, `${JSON.stringify(checked, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/** Export all known nodes, including offline nodes; status is deliberately not persisted. */
export async function exportDirectory(agent: string, defaultNode?: string): Promise<NodeDirectory> {
  const sourceUrl = gatewayUrl(agent);
  const res = await fetch(`${sourceUrl}/nodes`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) { await res.body?.cancel(); throw new Error(`导出节点清单失败: HTTP ${res.status}`); }
  const raw = object(await res.json());
  if (!Array.isArray(raw.nodes)) throw new Error('网关未返回有效 nodes 清单');
  const sourceNodes = raw.nodes.map(object);
  const nodes = sourceNodes.map(n => {
    const host = label(n.ipv4 ?? n.dnsName ?? n.name, '节点地址');
    if (/[\/@?#:]/.test(host) || host === 'localhost' || host.startsWith('127.')) {
      throw new Error(`节点缺少可导出的网络地址: ${String(n.name)}`);
    }
    let agentUrl = `http://${host}:${DEFAULT_PORTS['node-agent']}`;
    if (n.is_self === true) {
      const selfUrl = new URL(sourceUrl);
      if (selfUrl.hostname === 'localhost' || selfUrl.hostname.startsWith('127.') || selfUrl.hostname === '[::1]') {
        selfUrl.hostname = host;
      }
      agentUrl = gatewayUrl(selfUrl.toString());
    }
    return { node_id: n.node_id, name: n.name, type: n.type, ipv4: n.ipv4, dnsName: n.dnsName, agent_url: agentUrl };
  });
  const self = sourceNodes.find(n => n.is_self === true);
  return validateDirectory({ format: 'dreammate.nodes', version: 1, exported_at: new Date().toISOString(),
    default_node: defaultNode ?? self?.node_id, nodes });
}

import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_MCP_CONFIG_BYTES } from './mcp-source-config.js';
import { McpSourceManager } from './mcp-sources.js';
import { ServiceRegistry, type MethodDescriptor, type RegisteredService } from './registry.js';

/** Connections belong to one CLI/Stdio client process, never to the shared node. */
export interface PrivateMcpSources {
  list(): RegisteredService[];
  get(id: string): RegisteredService | undefined;
  describe(id: string, method: string): Promise<{ method: string; details: MethodDescriptor & { schema_loaded?: boolean } }>;
  invoke(id: string, payload: { method?: string; capability?: string; params?: unknown }): Promise<{ status: number; data: unknown }>;
  stop(): Promise<void>;
}

async function readPrivateConfig(file: string, optional: boolean): Promise<string | undefined> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try { metadata = await lstat(file); }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('无法读取客户端私有 MCP 配置文件');
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('客户端私有 MCP 配置必须是普通文件，不能是符号链接');
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // Verify the opened descriptor as well as the path so a replaced symlink
    // cannot redirect the read after permission checks.
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== metadata.dev || stat.ino !== metadata.ino) {
      throw new Error('客户端私有 MCP 配置文件在读取前发生变化');
    }
    if ((stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw new Error('客户端私有 MCP 配置必须属于当前用户且仅所有者可访问（chmod 600）');
    }
    if (stat.size > MAX_MCP_CONFIG_BYTES) throw new Error('客户端私有 MCP 配置不能超过 256 KiB');
    // Bound the read too: the owner may change a file between fstat and read.
    const bytes = Buffer.alloc(MAX_MCP_CONFIG_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, null);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    if (size > MAX_MCP_CONFIG_BYTES) throw new Error('客户端私有 MCP 配置不能超过 256 KiB');
    return bytes.subarray(0, size).toString('utf8');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('客户端私有 MCP 配置')) throw error;
    throw new Error('无法读取客户端私有 MCP 配置文件');
  } finally { await handle?.close(); }
}

/** Explicit path > environment > owner-only default. Only an absent default is optional. */
export async function loadPrivateMcpSources(explicit?: string, onCreated?: (sources: PrivateMcpSources) => void): Promise<PrivateMcpSources | undefined> {
  const configured = explicit ?? (process.env.DREAMMATE_MCP_CONFIG?.trim() || undefined);
  if (configured?.trim() === 'none') return undefined;
  if (configured !== undefined && (!configured.trim() || configured.includes('\0'))) {
    throw new Error('客户端私有 MCP 配置路径无效；使用 none 可显式禁用');
  }
  const file = configured === undefined ? path.join(os.homedir(), '.1agents', 'mcp-client.json') : path.resolve(configured);
  const text = await readPrivateConfig(file, configured === undefined);
  if (text === undefined) return undefined;
  const registry = new ServiceRegistry({ storagePath: false });
  const manager = new McpSourceManager(registry, { storagePath: false });
  const sources: PrivateMcpSources = {
    list: () => registry.list(),
    get: id => registry.get(id),
    describe: (id, method) => manager.describe(id, method),
    invoke: (id, payload) => manager.invoke(id, payload),
    stop: () => manager.stop(),
  };
  try {
    onCreated?.(sources);
    const result = await manager.import(text);
    if (result.sources.length === 0 || result.sources.some(source => source.status !== 'connected')) {
      throw new Error('unavailable');
    }
    return sources;
  } catch {
    await manager.stop();
    // Parser, transport, and subprocess diagnostics can contain credentials.
    throw new Error('客户端私有 MCP 配置无效或数据源连接失败；未加载任何私有工具');
  }
}

/** Strictly validated configuration for provider advertisement priority and sharing. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_CONFIG_BYTES = 16 * 1024;

export function defaultConfigPath(home = os.homedir()) {
  return path.join(home, '.1agents', 'embedding-config.json');
}

export function validatePriorityConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['version', 'priority', 'sharing'].includes(key))
    || value.version !== 1 || typeof value.priority !== 'number'
    || !Number.isSafeInteger(value.priority) || value.priority < -1000 || value.priority > 1000) {
    throw new Error('Embedding priority config requires version: 1 and an integer priority from -1000 to 1000; only optional sharing is supported');
  }
  if (Object.hasOwn(value, 'sharing') && !['local', 'network'].includes(value.sharing)) {
    throw new Error('Embedding config sharing must be local or network');
  }
  return { version: 1, priority: value.priority, ...(Object.hasOwn(value, 'sharing') ? { sharing: value.sharing } : {}) };
}

/** Open without following symlinks or blocking on special files, then read a bounded snapshot. */
export async function readPriorityConfig(file) {
  let handle;
  try {
    try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('expected a regular file');
    if (stat.size > MAX_CONFIG_BYTES) throw new Error(`file exceeds ${MAX_CONFIG_BYTES} bytes`);
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_CONFIG_BYTES) throw new Error(`file exceeds ${MAX_CONFIG_BYTES} bytes`);
    let value;
    try { value = JSON.parse(buffer.subarray(0, size).toString('utf8')); }
    catch { throw new Error('expected valid JSON'); }
    return validatePriorityConfig(value);
  } catch (error) {
    throw new Error(`Invalid embedding priority config ${file}: ${error.message}`, { cause: error });
  } finally { await handle?.close(); }
}

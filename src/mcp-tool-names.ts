import { createHash } from 'node:crypto';

export interface ToolIdentity<T> {
  kind: 'native' | 'action';
  name: string;
  group?: string;
  adapter?: string;
  value: T;
}

export interface NamedTool<T> extends ToolIdentity<T> {
  method: string;
  aliases: string[];
}

export class ToolNameError extends Error {
  constructor(readonly status: number, message: string, readonly candidates: string[] = []) { super(message); }
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
const RESERVED_SUFFIX = /__dm_[a-f0-9]{16}$/;

function segment(raw: string, budget: number, identity = raw, forceHash = false): string {
  const safe = raw.normalize('NFKC').replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_') || 'tool';
  if (!forceHash && /^[A-Za-z0-9_-]+$/.test(raw) && raw.length <= budget && !RESERVED_SUFFIX.test(raw)) return raw;
  const suffix = `__dm_${digest(identity)}`;
  return `${safe.slice(0, Math.max(1, budget - suffix.length))}${suffix}`;
}

/** Stable canonical names never depend on list order or on which other tools are installed. */
export class ToolNameIndex<T> {
  readonly records: NamedTool<T>[];
  readonly #canonical = new Map<string, NamedTool<T>>();
  readonly #aliases = new Map<string, Set<string>>();

  constructor(source: string, identities: readonly ToolIdentity<T>[]) {
    this.records = identities.map(item => {
      let method: string;
      const aliases = [item.name];
      if (item.kind === 'native') {
        method = `${source}.${segment(item.name, 128 - source.length - 1)}`;
        aliases.push(`${source}.${item.name}`);
      } else {
        const prefix = `${source}.actions.`;
        const groupBudget = Math.min(24, Math.floor((128 - prefix.length - 1 - 22) / 2));
        const group = segment(item.group!, groupBudget);
        const identity = JSON.stringify([item.adapter, item.group, item.name]);
        method = `${prefix}${group}.${segment(item.name, 128 - prefix.length - group.length - 1, identity, true)}`;
        aliases.push(`${item.group}.${item.name}`, `${source}.${item.group}.${item.name}`);
      }
      if (method.length > 128 || !/^[A-Za-z0-9_.-]+$/.test(method)) throw new Error('Invalid generated MCP tool name');
      return { ...item, method, aliases: [...new Set(aliases.filter(alias => alias !== method))] };
    });
    for (const item of this.records) {
      if (this.#canonical.has(item.method)) throw new Error('Duplicate MCP tool identity');
      this.#canonical.set(item.method, item);
      for (const alias of [item.method, ...item.aliases]) {
        for (const key of new Set([alias, alias.toLowerCase()])) {
          const matches = this.#aliases.get(key) ?? new Set<string>();
          matches.add(item.method);
          this.#aliases.set(key, matches);
        }
      }
    }
  }

  resolve(name: string): NamedTool<T> {
    const canonical = this.#canonical.get(name);
    if (canonical) return canonical;
    const matches = this.#aliases.get(name) ?? this.#aliases.get(name.toLowerCase());
    if (!matches?.size) throw new ToolNameError(404, 'MCP tool not found');
    if (matches.size !== 1) throw new ToolNameError(409, 'Ambiguous MCP tool name; use a canonical method', [...matches].sort().slice(0, 20));
    return this.#canonical.get(matches.values().next().value!)!;
  }
}

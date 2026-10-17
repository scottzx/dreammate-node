import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { discoverSkillDirectories, PROJECT_SKILL_ROOTS, type SkillDiscoveryOptions, type SkillDirectoryDiscovery } from './discovery.js';

export class SkillSourceError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'SkillSourceError';
  }
}

export interface SkillSourceManagerOptions {
  storagePath?: string | false;
  autoDiscover?: boolean;
  discovery?: SkillDiscoveryOptions;
  discoveryIntervalMs?: number;
}

export type SkillSourceOrigin = 'manual' | 'shared' | 'session-reader';
export type SkillSourceScope = 'user' | 'system' | 'project';

export interface SkillDiscoveryResult {
  added: number;
  existing: number;
  excluded: number;
  removed: number;
  source_count: number;
  directory_count: number;
  workspace_count: number;
  project_status: SkillDirectoryDiscovery['project_status'];
  diagnostics: SkillCatalog['diagnostics'];
}

export interface SkillSummary {
  id: string;
  source_id: string;
  name: string;
  description: string;
  revision: string;
  compatibility?: string;
  scope?: SkillSourceScope;
}

export interface SkillSourceStatus {
  id: string;
  name: string;
  type: 'dir' | 'project';
  dir?: string;
  project?: string;
  status: 'ready' | 'error';
  skill_count: number;
  last_checked_at: string;
  error?: string;
  origin: SkillSourceOrigin;
  scope?: SkillSourceScope;
}

export interface SkillCatalog {
  skills: SkillSummary[];
  diagnostics: { source_id: string; error: string }[];
}

export interface SkillReadResult {
  id: string;
  name: string;
  source_id: string;
  revision: string;
  resource: string;
  content: string;
  encoding: 'utf8' | 'base64';
  resources: { path: string; bytes: number }[];
  compatibility?: string;
  scope?: SkillSourceScope;
}

interface SourceConfig {
  id: string;
  name: string;
  dir?: string;
  project?: string;
  origin: SkillSourceOrigin;
  scope?: SkillSourceScope;
}
interface FileEntry { path: string; absolute: string; bytes: number; digest?: string }
interface LocatedSkill { summary: SkillSummary; directory: string; entry: string; files: FileEntry[] }
interface ScanResult { skills: LocatedSkill[]; error?: string }

const ENTRY_FILES = ['SKILL.remote.md', 'skill.remote.md', 'SKILL.md', 'skill.md'];
const MAX_SOURCES = 2048;
const MAX_EXCLUSIONS = 4096;
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_ENTRIES = 10_000;
const MAX_SKILLS = 256;
const MAX_DISCOVERY_DEPTH = 4;
const MAX_PACKAGE_DEPTH = 12;
const MAX_PACKAGE_FILES = 2_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_FRONTMATTER_BYTES = 256 * 1024;

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function failure(message: string, status = 400): never { throw new SkillSourceError(status, message); }

function expandedDirectory(value: string): string {
  return path.resolve(value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value);
}

function configOf(input: unknown, stored = false): SourceConfig {
  if (!object(input)) failure('Skill source must be an object');
  if (typeof input.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.name)) {
    failure('Skill source name must contain 1–64 letters, digits, underscores or hyphens');
  }
  const fields = ['id', 'name', 'dir', 'project', ...(stored ? ['origin', 'scope'] : [])];
  if (Object.keys(input).some(key => !fields.includes(key))) failure('Unknown skill source field');
  const hasDir = input.dir !== undefined;
  const hasProject = input.project !== undefined;
  if (hasDir === hasProject) failure('Provide exactly one of dir or project');
  const value = hasDir ? input.dir : input.project;
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > 4096) {
    failure('Skill source directory must be a non-empty path');
  }
  const id = `skills-${input.name}`;
  if (input.id !== undefined && input.id !== id) failure('Invalid stored skill source ID');
  const origin = input.origin ?? 'manual';
  if (!['manual', 'shared', 'session-reader'].includes(String(origin))) failure('Invalid stored skill source origin');
  if (input.scope !== undefined && !['user', 'system', 'project'].includes(String(input.scope))) failure('Invalid stored skill source scope');
  if (origin !== 'manual' && (input.scope === undefined || !hasDir)) failure('Automatic skill sources require a directory and scope');
  return { id, name: input.name, ...(hasDir ? { dir: expandedDirectory(value) } : { project: expandedDirectory(value) }),
    origin: origin as SkillSourceOrigin, ...(input.scope ? { scope: input.scope as SkillSourceScope } : {}) };
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Revision ordering must stay identical across machines regardless of their locale. */
function comparePaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function realDirectory(directory: string): string {
  try { return fs.realpathSync(directory); } catch { return path.resolve(directory); }
}

function uniqueDiagnostics(diagnostics: SkillCatalog['diagnostics']): SkillCatalog['diagnostics'] {
  return [...new Map(diagnostics.map(diagnostic => [`${diagnostic.source_id}\0${diagnostic.error}`, diagnostic])).values()];
}

function blockedSegment(segment: string): boolean {
  return segment.startsWith('.') || ['node_modules', '__pycache__', 'credentials', 'secrets'].includes(segment.toLowerCase())
    || /^(?:credentials?|secrets?)\.(?:json|ya?ml|toml|ini|txt)$/i.test(segment)
    || /\.(?:pem|key|p12|pfx)$/i.test(segment);
}

function validResource(resource: string): boolean {
  return Boolean(resource) && !path.isAbsolute(resource) && !/^[A-Za-z]:/.test(resource)
    && !resource.includes('\\') && !resource.includes('\0')
    && resource.split('/').every(segment => Boolean(segment) && segment !== '..' && !blockedSegment(segment));
}

function safeError(error: unknown): string {
  if (error instanceof SkillSourceError) return error.message;
  if (object(error) && error.code === 'ENOENT') return 'Skill source or resource is missing';
  if (object(error) && ['EACCES', 'EPERM'].includes(String(error.code))) return 'Skill source or resource cannot be read';
  return 'Skill source could not be scanned';
}

/** Only these top-level scalar fields are needed; nested metadata is deliberately ignored. */
function frontmatter(raw: string): Record<string, string> {
  const match = raw.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/);
  if (!match) return {};
  if (Buffer.byteLength(match[1]!, 'utf8') > MAX_FRONTMATTER_BYTES) failure('Skill frontmatter exceeds the size limit');
  const lines = match[1]!.split(/\r?\n/);
  const result: Record<string, string> = {};
  for (let index = 0; index < lines.length; index++) {
    const field = lines[index]!.match(/^(name|description|compatibility):(?:\s+(.*))?$/);
    if (!field) continue;
    const key = field[1]!;
    const value = (field[2] ?? '').trim();
    if (/^[>|][+-]?[1-9]?(?:\s+#.*)?$/.test(value) || value === '') {
      const block: string[] = [];
      while (index + 1 < lines.length && (/^\s/.test(lines[index + 1]!) || lines[index + 1] === '')) block.push(lines[++index]!);
      const indents = block.filter(line => line.trim()).map(line => line.match(/^\s*/)?.[0].length ?? 0);
      const indent = indents.length ? Math.min(...indents) : 0;
      const content = block.map(line => line.slice(indent));
      result[key] = value.startsWith('|') ? content.join('\n').trim() : content.join(' ').replace(/\s+/g, ' ').trim();
    } else if (value.startsWith('"')) {
      let quoted = value;
      while (!/"\s*(?:#.*)?$/.test(quoted.slice(1)) && index + 1 < lines.length && /^\s/.test(lines[index + 1]!)) {
        quoted += ` ${lines[++index]!.trim()}`;
      }
      // A # inside the quoted value is ordinary text; trim only after its closing quote.
      const closing = quoted.match(/^"(?:[^"\\]|\\.)*"/);
      try { result[key] = JSON.parse(closing?.[0] ?? quoted) as string; }
      catch { failure(`Invalid quoted ${key} in skill frontmatter`); }
    } else if (value.startsWith("'")) {
      let quoted = value;
      while (!/'\s*(?:#.*)?$/.test(quoted.slice(1)) && index + 1 < lines.length && /^\s/.test(lines[index + 1]!)) {
        quoted += ` ${lines[++index]!.trim()}`;
      }
      const scalar = quoted.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/);
      if (!scalar) failure(`Invalid quoted ${key} in skill frontmatter`);
      result[key] = scalar[1]!.replace(/''/g, "'");
    } else {
      const continuation: string[] = [value.replace(/\s+#.*$/, '')];
      while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1]!)) continuation.push(lines[++index]!.trim());
      result[key] = continuation.join(' ').trim();
    }
  }
  return result;
}

function readBounded(file: string): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) failure('Skill resource is not a regular file');
    if (stat.size > MAX_FILE_BYTES) failure('Skill resource exceeds the file size limit');
    const buffer = fs.readFileSync(fd);
    if (buffer.length > MAX_FILE_BYTES) failure('Skill resource exceeds the file size limit');
    return buffer;
  } finally { fs.closeSync(fd); }
}

function packageAt(directory: string, source: SourceConfig, identity: string, budget?: { bytes: number; entries: number }): LocatedSkill | undefined {
  const root = fs.realpathSync(directory);
  const files: FileEntry[] = [];
  let bytes = 0;
  let entries = 0;
  const walk = (current: string, relative: string, depth: number): void => {
    if (depth > MAX_PACKAGE_DEPTH) failure('Skill package exceeds the directory depth limit');
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => comparePaths(a.name, b.name))) {
      if (++entries > MAX_SOURCE_ENTRIES) failure('Skill package exceeds the entry count limit');
      if (budget && ++budget.entries > MAX_SOURCE_ENTRIES) failure('Skill source exceeds the entry count limit');
      if (blockedSegment(entry.name)) continue;
      const resource = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        // Links are excluded even when they currently point inward: they can be retargeted between reads.
        continue;
      }
      if (entry.isDirectory()) { walk(absolute, resource, depth + 1); continue; }
      if (!entry.isFile()) continue;
      const real = fs.realpathSync(absolute);
      if (!inside(root, real)) failure('Skill resource leaves its package directory');
      const stat = fs.statSync(real);
      if (stat.size > MAX_FILE_BYTES) failure('Skill resource exceeds the file size limit');
      bytes += stat.size;
      if (bytes > MAX_PACKAGE_BYTES || files.length >= MAX_PACKAGE_FILES) failure('Skill package exceeds the total size or file count limit');
      if (budget) {
        budget.bytes += stat.size;
        if (budget.bytes > MAX_SOURCE_BYTES) failure('Skill source exceeds the total published size limit');
      }
      files.push({ path: resource, absolute: real, bytes: stat.size });
    }
  };
  walk(root, '', 0);
  const entry = ENTRY_FILES.find(candidate => files.some(file => file.path === candidate));
  if (!entry) return undefined;
  const hash = createHash('sha256');
  let raw = '';
  for (const file of files.sort((a, b) => comparePaths(a.path, b.path))) {
    const buffer = readBounded(file.absolute);
    if (buffer.length !== file.bytes) failure('Skill package changed while reading; retry', 409);
    file.digest = createHash('sha256').update(buffer).digest('hex');
    hash.update(`${file.path}\0${buffer.length}\0`).update(buffer);
    if (file.path === entry) raw = buffer.toString('utf8');
  }
  const data = frontmatter(raw);
  const name = (data.name || path.basename(root)).trim();
  const description = (data.description ?? '').trim();
  const compatibility = data.compatibility?.trim();
  if (!name || name.length > 128) failure('Skill name must contain 1–128 characters');
  if (!description || description.length > 4096) failure('Skill description must contain 1–4096 characters');
  if (compatibility && compatibility.length > 1024) failure('Skill compatibility exceeds the 1024-character limit');
  const id = `${source.id}:${createHash('sha256').update(identity).digest('hex').slice(0, 20)}`;
  return {
    summary: { id, source_id: source.id, name, description, revision: hash.digest('hex'),
      ...(compatibility ? { compatibility } : {}), ...(source.scope ? { scope: source.scope } : {}) },
    directory: root, entry, files,
  };
}

function scanSource(source: SourceConfig): ScanResult {
  const skills: LocatedSkill[] = [];
  const errors = new Set<string>();
  try {
    const configured = source.dir ?? source.project!;
    const anchor = fs.realpathSync(configured);
    if (!fs.statSync(anchor).isDirectory()) failure('Skill source is not a directory');
    const roots: { root: string; identity: string }[] = [];
    const visited = new Set<string>();
    if (source.dir) roots.push({ root: anchor, identity: '' });
    else {
      for (const conventional of PROJECT_SKILL_ROOTS) {
        const candidate = path.join(anchor, conventional);
        if (!fs.existsSync(candidate)) continue;
        const real = fs.realpathSync(candidate);
        if (!inside(anchor, real)) { errors.add('Project skill directory leaves its project'); continue; }
        if (!visited.has(real)) { visited.add(real); roots.push({ root: real, identity: conventional }); }
      }
    }
    visited.clear();
    const budget = { bytes: 0, entries: 0 };
    const walk = (directory: string, identity: string, depth: number): void => {
      const real = fs.realpathSync(directory);
      if (!inside(anchor, real)) failure('Skill directory leaves its source');
      if (visited.has(real)) return;
      visited.add(real);
      if (!fs.statSync(real).isDirectory()) return;
      const children = fs.readdirSync(real, { withFileTypes: true });
      budget.entries += children.length;
      if (budget.entries > MAX_SOURCE_ENTRIES) failure('Skill source exceeds the entry count limit');
      const hasEntry = ENTRY_FILES.some(candidate => children.some(entry => entry.name === candidate && entry.isFile()));
      if (hasEntry) {
        if (skills.length >= MAX_SKILLS) failure('Skill source exceeds the skill count limit');
        try { const skill = packageAt(real, source, identity || '.', budget); if (skill) skills.push(skill); }
        catch (error) { errors.add(safeError(error)); }
        return;
      }
      if (depth >= MAX_DISCOVERY_DEPTH) return;
      for (const child of children.sort((a, b) => comparePaths(a.name, b.name))) {
        if (!child.isDirectory() || blockedSegment(child.name)) continue;
        walk(path.join(real, child.name), identity ? `${identity}/${child.name}` : child.name, depth + 1);
      }
    };
    for (const { root, identity } of roots) walk(root, identity, 0);
  } catch (error) { errors.add(safeError(error)); }
  return { skills, ...(errors.size ? { error: [...errors].join('; ') } : {}) };
}

/** Stores source locations only. Every catalog/read derives content from the current source files. */
export class SkillSourceManager {
  readonly #sources = new Map<string, SourceConfig>();
  readonly #excludedDirectories = new Set<string>();
  readonly #storagePath: string | false;
  readonly #autoDiscover: boolean;
  readonly #discoveryOptions: SkillDiscoveryOptions;
  readonly #discoveryIntervalMs: number;
  #loadError?: string;
  #storageFingerprint?: string;
  #discoveryDiagnostics: SkillCatalog['diagnostics'] = [];
  #discoveryJob?: Promise<SkillDiscoveryResult>;
  #discoveryController?: AbortController;
  #startJob?: Promise<void>;
  #timer?: NodeJS.Timeout;
  #started = false;
  #stopped = false;
  #generation = 0;
  #projectPending = false;

  constructor(options: SkillSourceManagerOptions = {}) {
    const isTest = process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT) || process.execArgv.includes('--test');
    this.#storagePath = options.storagePath ?? (isTest ? false : path.join(os.homedir(), '.1agents', 'skill-sources.json'));
    this.#autoDiscover = options.autoDiscover ?? !isTest;
    this.#discoveryOptions = options.discovery ?? {};
    this.#discoveryIntervalMs = Math.max(10, options.discoveryIntervalMs ?? 5 * 60 * 1000);
    this.#reloadIfChanged();
  }

  #fingerprint(): string {
    if (!this.#storagePath) return 'disabled';
    try {
      const stat = fs.statSync(this.#storagePath);
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch (error) {
      return object(error) && error.code === 'ENOENT' ? 'missing' : 'unreadable';
    }
  }

  #reloadIfChanged(): void {
    if (!this.#storagePath) return;
    const fingerprint = this.#fingerprint();
    if (fingerprint === this.#storageFingerprint) return;
    try {
      if (fingerprint === 'missing') {
        this.#sources.clear();
        this.#excludedDirectories.clear();
        this.#loadError = undefined;
        this.#storageFingerprint = fingerprint;
        return;
      }
      if (fs.statSync(this.#storagePath).size > MAX_CONFIG_BYTES) failure('Stored skill configuration exceeds the size limit');
      const parsed: unknown = JSON.parse(fs.readFileSync(this.#storagePath, 'utf8'));
      if (!object(parsed) || parsed.version !== 1 || !Array.isArray(parsed.sources) || parsed.sources.length > MAX_SOURCES) {
        failure('Invalid stored skill configuration');
      }
      const exclusions: unknown = parsed.excluded_dirs ?? [];
      if (!Array.isArray(exclusions) || exclusions.length > MAX_EXCLUSIONS || exclusions.some(value => typeof value !== 'string'
        || !path.isAbsolute(value) || value.length > 4096 || value.includes('\0'))) failure('Invalid stored skill exclusions');
      const loaded = new Map<string, SourceConfig>();
      for (const value of parsed.sources) {
        const config = configOf(value, true);
        if (loaded.has(config.id)) failure('Duplicate stored skill source');
        loaded.set(config.id, config);
      }
      if (this.#fingerprint() !== fingerprint) failure('Skill configuration changed while reading; retry', 409);
      this.#sources.clear();
      for (const [id, config] of loaded) this.#sources.set(id, config);
      this.#excludedDirectories.clear();
      for (const directory of exclusions as string[]) this.#excludedDirectories.add(path.resolve(directory));
      this.#loadError = undefined;
    } catch {
      // Keep the last usable configuration so a damaged external edit cannot erase registered sources.
      this.#loadError = 'Stored skill configuration could not be read; repair or remove it before changing sources';
    }
    this.#storageFingerprint = fingerprint;
  }

  #persist(): void {
    if (this.#loadError) failure(this.#loadError, 500);
    if (!this.#storagePath) return;
    let temporary: string | undefined;
    const lockPath = `${this.#storagePath}.lock`;
    let lock: number | undefined;
    try {
      fs.mkdirSync(path.dirname(this.#storagePath), { recursive: true, mode: 0o700 });
      try { lock = fs.openSync(lockPath, 'wx', 0o600); }
      catch (error) {
        if (object(error) && error.code === 'EEXIST') failure('Skill configuration is busy; another writer holds its lock. Retry after it finishes', 409);
        throw error;
      }
      // Keep readable ownership information for safely diagnosing a lock left by a crashed writer.
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }), 'utf8');
      const serialized = JSON.stringify({ version: 1, sources: [...this.#sources.values()],
        ...(this.#excludedDirectories.size ? { excluded_dirs: [...this.#excludedDirectories].sort(comparePaths) } : {}) }, null, 2);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_CONFIG_BYTES) failure('Stored skill configuration exceeds the size limit');
      temporary = `${this.#storagePath}.${randomUUID()}.tmp`;
      fs.writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      if (this.#fingerprint() !== this.#storageFingerprint) failure('Skill configuration changed in another process; retry', 409);
      fs.renameSync(temporary, this.#storagePath);
      this.#storageFingerprint = this.#fingerprint();
    } catch (error) {
      if (temporary) { try { fs.unlinkSync(temporary); } catch { /* No partial configuration. */ } }
      if (error instanceof SkillSourceError) throw error;
      failure('Skill configuration could not be saved', 500);
    } finally {
      if (lock !== undefined) {
        try {
          const owned = fs.fstatSync(lock);
          const current = fs.statSync(lockPath);
          if (owned.dev === current.dev && owned.ino === current.ino) fs.unlinkSync(lockPath);
        } catch { /* Never remove a replacement lock owned by a different writer. */ }
        fs.closeSync(lock);
      }
    }
  }

  #status(source: SourceConfig, scan: ScanResult): SkillSourceStatus {
    return { ...source, type: source.dir ? 'dir' : 'project', status: scan.error ? 'error' : 'ready',
      skill_count: scan.skills.length, last_checked_at: new Date().toISOString(), ...(scan.error ? { error: scan.error } : {}) };
  }

  async add(input: unknown): Promise<SkillSourceStatus> {
    this.#reloadIfChanged();
    if (this.#loadError) failure(this.#loadError, 500);
    const config = configOf(input);
    if (this.#sources.has(config.id)) failure('Skill source already exists; remove it before adding a replacement', 409);
    if (this.#sources.size >= MAX_SOURCES) failure('Skill source limit reached');
    const removed: SourceConfig[] = [];
    const directory = realDirectory(config.dir ?? config.project!);
    for (const source of this.#sources.values()) {
      if (source.origin !== 'manual' && realDirectory(source.dir!) === directory) {
        removed.push(source);
        this.#sources.delete(source.id);
      }
    }
    this.#sources.set(config.id, config);
    try { this.#persist(); }
    catch (error) {
      this.#sources.delete(config.id);
      for (const source of removed) this.#sources.set(source.id, source);
      throw error;
    }
    return this.#status(config, scanSource(config));
  }

  async list(): Promise<SkillSourceStatus[]> {
    this.#reloadIfChanged();
    if (this.#loadError) failure(this.#loadError, 500);
    return [...this.#sources.values()].map(source => this.#status(source, scanSource(source)));
  }

  async remove(id: string): Promise<{ removed: string }> {
    this.#reloadIfChanged();
    if (this.#loadError) failure(this.#loadError, 500);
    const source = this.#sources.get(id);
    if (!source) failure('Skill source was not found', 404);
    const excluded = source.origin !== 'manual' ? realDirectory(source.dir!) : undefined;
    if (excluded && !this.#excludedDirectories.has(excluded) && this.#excludedDirectories.size >= MAX_EXCLUSIONS) failure('Skill exclusion limit reached');
    const wasExcluded = excluded !== undefined && this.#excludedDirectories.has(excluded);
    if (excluded) this.#excludedDirectories.add(excluded);
    this.#sources.delete(id);
    try { this.#persist(); }
    catch (error) {
      this.#sources.set(id, source);
      if (excluded && !wasExcluded) this.#excludedDirectories.delete(excluded);
      throw error;
    }
    return { removed: id };
  }

  async refresh(id?: string): Promise<SkillCatalog> {
    this.#reloadIfChanged();
    if (id && !this.#sources.has(id)) failure('Skill source was not found', 404);
    return this.#catalog(id);
  }

  /** Explicit discovery, also used by the optional lifecycle scheduler. Query methods never invoke a provider. */
  async discover(options: SkillDiscoveryOptions = {}): Promise<SkillDiscoveryResult> {
    this.#reloadIfChanged();
    if (this.#loadError) failure(this.#loadError, 500);
    if (this.#stopped) failure('Skill source manager is stopped', 503);
    if (this.#discoveryJob) return this.#discoveryJob;
    const controller = new AbortController();
    const merged = { ...this.#discoveryOptions, ...options };
    const signals = [controller.signal, this.#discoveryOptions.signal, options.signal].filter((signal): signal is AbortSignal => signal !== undefined);
    const signal = AbortSignal.any(signals);
    const generation = this.#generation;
    this.#discoveryController = controller;
    if (merged.projects !== false) this.#projectPending = true;
    const job = this.#discover({ ...merged, signal }, generation).catch((error: unknown) => {
      if (!signal.aborted && generation === this.#generation) {
        this.#discoveryDiagnostics = uniqueDiagnostics([...this.#discoveryDiagnostics, { source_id: 'discovery', error: safeError(error) }]);
      }
      throw error;
    }).finally(() => {
      if (this.#discoveryJob === job) {
        this.#discoveryJob = undefined;
        this.#discoveryController = undefined;
        this.#projectPending = false;
      }
    });
    this.#discoveryJob = job;
    return job;
  }

  async #discover(options: SkillDiscoveryOptions, generation: number): Promise<SkillDiscoveryResult> {
    const discovered = await discoverSkillDirectories(options);
    if (options.signal?.aborted || generation !== this.#generation || this.#stopped) failure('Skill discovery was cancelled', 503);
    // The standalone CLI may have changed the shared configuration while the project provider was running.
    this.#reloadIfChanged();
    if (this.#loadError) failure(this.#loadError, 500);
    const previous = new Map(this.#sources);
    const directories = new Map(discovered.directories.map(directory => [realDirectory(directory.dir), directory]));
    const diagnostics = discovered.project_status === 'skipped'
      ? uniqueDiagnostics([...this.#discoveryDiagnostics.filter(diagnostic => diagnostic.source_id === 'session-reader'), ...discovered.diagnostics])
      : [...discovered.diagnostics];
    const manualDirectories = new Set([...this.#sources.values()].filter(source => source.origin === 'manual')
      .map(source => realDirectory(source.dir ?? source.project!)));
    let added = 0;
    let existing = 0;
    let excluded = 0;
    let removed = 0;
    for (const source of this.#sources.values()) {
      if (source.origin === 'manual') continue;
      const directory = realDirectory(source.dir!);
      const canRemove = discovered.diagnostics.length === 0 && (source.origin === 'shared' || discovered.project_status === 'ok');
      if (manualDirectories.has(directory) || this.#excludedDirectories.has(directory) || (canRemove && !directories.has(directory))) {
        this.#sources.delete(source.id);
        removed++;
      }
    }
    const registered = new Map([...this.#sources.values()].filter(source => source.origin !== 'manual')
      .map(source => [realDirectory(source.dir!), source]));
    for (const [directory, candidate] of directories) {
      if (this.#excludedDirectories.has(directory)) { excluded++; continue; }
      if (manualDirectories.has(directory) || registered.has(directory)) { existing++; continue; }
      if (this.#sources.size >= MAX_SOURCES) {
        diagnostics.push({ source_id: 'discovery', error: 'Skill source limit reached; some discovered directories were skipped' });
        continue;
      }
      const name = `auto-${candidate.scope}-${createHash('sha256').update(directory).digest('hex').slice(0, 20)}`;
      const config: SourceConfig = { id: `skills-${name}`, name, dir: directory, origin: candidate.origin, scope: candidate.scope };
      if (this.#sources.has(config.id)) {
        diagnostics.push({ source_id: 'discovery', error: 'An automatic skill source ID conflicts with an existing source; the existing source was preserved' });
        continue;
      }
      this.#sources.set(config.id, config);
      registered.set(directory, config);
      added++;
    }
    if (added || removed) {
      try { this.#persist(); }
      catch (error) {
        this.#sources.clear();
        for (const [id, source] of previous) this.#sources.set(id, source);
        throw error;
      }
    }
    this.#discoveryDiagnostics = uniqueDiagnostics(diagnostics);
    return { added, existing, excluded, removed, source_count: this.#sources.size, directory_count: directories.size,
      workspace_count: discovered.workspace_count, project_status: discovered.project_status, diagnostics: [...this.#discoveryDiagnostics] };
  }

  async start(): Promise<void> {
    if (this.#startJob) return this.#startJob;
    if (this.#started) return;
    this.#started = true;
    this.#stopped = false;
    if (!this.#autoDiscover) return;
    const generation = this.#generation;
    const job = (async () => {
      try { await this.discover({ projects: false }); }
      catch { /* Diagnostics are available through catalog without preventing the host from starting. */ }
      if (this.#stopped || generation !== this.#generation) return;
      if (this.#discoveryOptions.projects !== false) void this.discover({ projects: true }).catch(() => undefined);
      this.#timer = setInterval(() => { void this.discover().catch(() => undefined); }, this.#discoveryIntervalMs);
      this.#timer.unref();
    })();
    this.#startJob = job;
    try { await job; }
    finally { if (this.#startJob === job) this.#startJob = undefined; }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#started = false;
    this.#generation++;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#discoveryController?.abort();
    await this.#discoveryJob?.catch(() => undefined);
    await this.#startJob?.catch(() => undefined);
    this.#projectPending = false;
  }

  #catalog(id?: string): SkillCatalog {
    this.#reloadIfChanged();
    const result: SkillCatalog = { skills: [], diagnostics: [...this.#discoveryDiagnostics] };
    if (this.#loadError) result.diagnostics.push({ source_id: 'configuration', error: this.#loadError });
    if (this.#projectPending) result.diagnostics.push({ source_id: 'session-reader', error: 'Project skill discovery is pending' });
    const publishedDirectories = new Set<string>();
    const ordered = [...this.#sources.values()].sort((left, right) => Number(left.origin !== 'manual') - Number(right.origin !== 'manual'));
    for (const source of ordered) {
      const scan = scanSource(source);
      for (const skill of scan.skills) {
        if (source.origin !== 'manual' && publishedDirectories.has(skill.directory)) continue;
        publishedDirectories.add(skill.directory);
        if (!id || source.id === id) result.skills.push(skill.summary);
      }
      if (scan.error && (!id || source.id === id)) result.diagnostics.push({ source_id: source.id, error: scan.error });
    }
    result.diagnostics = uniqueDiagnostics(result.diagnostics);
    return result;
  }

  async catalog(): Promise<SkillCatalog> { return this.#catalog(); }

  async read(id: string, revision: string, resource?: string): Promise<SkillReadResult> {
    this.#reloadIfChanged();
    if (this.#loadError) failure(this.#loadError, 500);
    if (typeof revision !== 'string' || !revision) failure('A skill revision is required');
    if (resource !== undefined && (typeof resource !== 'string' || !validResource(resource))) failure('Invalid or excluded skill resource path');
    const source = [...this.#sources.values()].find(item => id.startsWith(`${item.id}:`));
    if (!source) failure('Skill was not found', 404);
    const scan = scanSource(source);
    const skill = scan.skills.find(item => item.summary.id === id);
    if (!skill) failure('Skill was not found', 404);
    if (skill.summary.revision !== revision) failure('Skill revision changed; search or refresh the catalog before reading', 409);
    const selected = resource ?? skill.entry;
    const file = skill.files.find(item => item.path === selected);
    if (!file) failure('Skill resource was not found', 404);
    try {
      const real = fs.realpathSync(file.absolute);
      if (!inside(skill.directory, real) || fs.lstatSync(file.absolute).isSymbolicLink()) failure('Skill resource leaves its package directory');
      const buffer = readBounded(real);
      if (createHash('sha256').update(buffer).digest('hex') !== file.digest) failure('Skill resource changed while reading; refresh the catalog', 409);
      const after = packageAt(skill.directory, source, '.');
      if (!after || after.summary.revision !== revision) failure('Skill revision changed while reading; refresh the catalog', 409);
      let encoding: SkillReadResult['encoding'] = 'utf8';
      let content: string;
      try {
        if (buffer.includes(0)) throw new Error('binary');
        content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      } catch { encoding = 'base64'; content = buffer.toString('base64'); }
      const { description: _description, ...summary } = skill.summary;
      return { ...summary, resource: selected, content, encoding,
        resources: skill.files.map(item => ({ path: item.path, bytes: item.bytes })) };
    } catch (error) {
      if (error instanceof SkillSourceError) throw error;
      failure(safeError(error), 503);
    }
  }
}

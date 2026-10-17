import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

export interface SkillDiscoveryOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  projects?: boolean;
  signal?: AbortSignal;
  sessionCommand?: string;
  timeoutMs?: number;
}

export interface DiscoveredSkillDirectory {
  dir: string;
  scope: 'user' | 'system' | 'project';
  origin: 'shared' | 'session-reader';
  project?: string;
}

export interface SkillDirectoryDiscovery {
  directories: DiscoveredSkillDirectory[];
  diagnostics: { source_id: string; error: string }[];
  project_status: 'ok' | 'unavailable' | 'skipped';
  /** Unique observed workspaces which currently exist as local directories. */
  workspace_count: number;
}

const ENTRY_FILES = ['SKILL.md', 'SKILL.remote.md', 'skill.md', 'skill.remote.md'];
export const PROJECT_SKILL_ROOTS: readonly string[] = [
  '.agents/skills', '.claude/skills', '.codex/skills', '.gemini/skills', '.dsh/skills', '.grok/skills',
  '.agent/skills', '_agents/skills', '_agent/skills', 'skills',
];
const PAGE_SIZE = 1000;
const MAX_PAGES = 20;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_WORKSPACES = 20_000;
const MAX_LINK_ENTRIES = 10_000;

function checkAbort(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function environmentPath(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  return env[key]?.trim() || fallback;
}

function sharedRoots(home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): DiscoveredSkillDirectory[] {
  const codex = environmentPath(env, 'CODEX_HOME', path.join(home, '.codex'));
  const grok = environmentPath(env, 'GROK_HOME', path.join(home, '.grok'));
  const antigravity = path.join(home, '.gemini', 'antigravity');
  const user = [
    path.join(home, '.agents', 'skills'),
    path.join(environmentPath(env, 'CLAUDE_CONFIG_DIR', path.join(home, '.claude')), 'skills'),
    path.join(codex, 'skills'),
    path.join(environmentPath(env, 'GEMINI_CLI_HOME', home), '.gemini', 'skills'),
    path.join(home, '.gemini', 'config', 'skills'),
    path.join(antigravity, 'skills'),
    path.join(grok, 'skills'),
    path.join(environmentPath(env, 'DSH_HOME', path.join(home, '.dsh')), 'skills'),
    path.join(environmentPath(env, 'DSH_AGENTS_HOME', path.join(home, '.agents')), 'skills'),
    path.join(home, '.1agents', 'skill-manager', 'shared'),
    path.join(home, '.cc-switch', 'skills'),
  ];
  const system = [
    path.join(codex, 'skills', '.system'),
    path.join(grok, 'bundled', 'skills'),
    path.join(antigravity, 'builtin', 'skills'),
    path.join(home, '.gemini', 'antigravity-cli', 'builtin', 'skills'),
    ...(env.DSH_BUNDLED_SKILL_DIR?.trim() ? [env.DSH_BUNDLED_SKILL_DIR.trim()] : []),
    ...(platform === 'win32'
      ? [
        ...(env.PROGRAMDATA?.trim() ? [path.join(env.PROGRAMDATA.trim(), '1agents', 'skills')] : []),
        ...(env.ProgramFiles?.trim() ? [path.join(env.ProgramFiles.trim(), 'ClaudeCode', '.claude', 'skills')] : []),
      ]
      : ['/etc/codex/skills', '/etc/1agents/skills', '/usr/local/share/1agents/skills']),
    ...(platform === 'darwin' ? ['/Library/Application Support/1agents/skills', '/Library/Application Support/ClaudeCode/.claude/skills'] : []),
    ...(platform === 'linux' ? ['/etc/claude-code/.claude/skills'] : []),
  ];
  return [
    ...user.map(dir => ({ dir, scope: 'user' as const, origin: 'shared' as const })),
    ...system.map(dir => ({ dir, scope: 'system' as const, origin: 'shared' as const })),
  ];
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function missing(error: unknown): boolean {
  return object(error) && ['ENOENT', 'ENOTDIR'].includes(String(error.code));
}

async function realDirectory(directory: string, unreadable?: () => void): Promise<string | undefined> {
  try {
    const real = await fs.realpath(directory);
    return (await fs.stat(real)).isDirectory() ? real : undefined;
  } catch (error) {
    if (!missing(error)) unreadable?.();
    return undefined;
  }
}

async function hasEntry(directory: string): Promise<boolean> {
  for (const entry of ENTRY_FILES) {
    try { if ((await fs.lstat(path.join(directory, entry))).isFile()) return true; }
    catch { /* Missing entries are ordinary directories, not skill packages. */ }
  }
  return false;
}

/** Invoke the installed executable directly; history text is never interpreted as code. */
function projectPage(command: string, page: number, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, ['projects', '--global', '--json', '--limit', String(PAGE_SIZE), '--page', String(page)],
      { encoding: 'utf8', env, signal, maxBuffer: MAX_PAGE_BYTES, killSignal: 'SIGKILL', windowsHide: true },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

async function sessionWorkspaces(options: SkillDiscoveryOptions, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string[]> {
  const workspaces = new Set<string>();
  let bytes = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    checkAbort(signal);
    const stdout = await projectPage(options.sessionCommand ?? '1session', page, env, signal);
    bytes += Buffer.byteLength(stdout, 'utf8');
    if (bytes > MAX_OUTPUT_BYTES) throw new Error('Project discovery output limit reached');
    const data: unknown = JSON.parse(stdout);
    if (!object(data) || !Array.isArray(data.projects) || data.projects.length > PAGE_SIZE || typeof data.hasMore !== 'boolean'
      || (data.page !== undefined && data.page !== page)
      || (data.limit !== undefined && data.limit !== PAGE_SIZE)
      || (data.total !== undefined && (!Number.isSafeInteger(data.total) || Number(data.total) < 0))) {
      throw new Error('Invalid project discovery response');
    }
    for (const project of data.projects) {
      if (!object(project) || (project.workspaces !== undefined && (!Array.isArray(project.workspaces)
        || project.workspaces.some(value => typeof value !== 'string')))
        || (project.workspace !== undefined && typeof project.workspace !== 'string')) throw new Error('Invalid project workspace');
      const observed = [...(Array.isArray(project.workspaces) ? project.workspaces : []), project.workspace];
      for (const candidate of observed) {
        if (typeof candidate !== 'string' || !candidate || candidate.includes('\0') || !path.isAbsolute(candidate)) continue;
        workspaces.add(path.normalize(candidate));
        if (workspaces.size > MAX_WORKSPACES) throw new Error('Project workspace limit reached');
      }
    }
    if (!data.hasMore) return [...workspaces];
    if (data.nextPage !== page + 1) throw new Error('Invalid project discovery cursor');
  }
  throw new Error('Project discovery page limit reached');
}

async function nearestRepository(workspace: string, signal?: AbortSignal): Promise<string | undefined> {
  let directory = workspace;
  for (let depth = 0; depth < 64; depth++) {
    checkAbort(signal);
    try {
      const marker = await fs.stat(path.join(directory, '.git'));
      if (marker.isFile() || marker.isDirectory()) return directory;
    } catch (error) {
      if (!missing(error)) throw error;
      // Non-repository parents are checked without listing their contents.
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  return undefined;
}

/** Discover locations only: never copy, install, execute or persist skill contents. */
export async function discoverSkillDirectories(options: SkillDiscoveryOptions = {}): Promise<SkillDirectoryDiscovery> {
  checkAbort(options.signal);
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const result: SkillDirectoryDiscovery = { directories: [], diagnostics: [], project_status: 'skipped', workspace_count: 0 };
  const seen = new Set<string>();
  const inspectedLinks = new Set<string>();
  let linkEntries = 0;
  let linkLimitReported = false;
  let activeSignal = options.signal;
  const unreadableOrigins = new Set<string>();
  const unreadable = (origin: DiscoveredSkillDirectory['origin']) => {
    const source = origin === 'session-reader' ? 'session-reader' : 'shared';
    if (!unreadableOrigins.has(source)) {
      unreadableOrigins.add(source);
      result.diagnostics.push({ source_id: source, error: 'A skill or project directory could not be inspected; discovery may be incomplete' });
    }
  };

  const add = async (candidate: DiscoveredSkillDirectory): Promise<string | undefined> => {
    checkAbort(activeSignal);
    const real = await realDirectory(candidate.dir, () => unreadable(candidate.origin));
    if (!real) return undefined;
    if (!seen.has(real)) {
      seen.add(real);
      result.directories.push({ ...candidate, dir: real });
    }
    return real;
  };

  const topLevelLinks = async (candidate: DiscoveredSkillDirectory, depth = 0): Promise<void> => {
    checkAbort(activeSignal);
    const real = await realDirectory(candidate.dir, () => unreadable(candidate.origin));
    if (!real || inspectedLinks.has(real) || await hasEntry(real)) return;
    inspectedLinks.add(real);
    try {
      const directory = await fs.opendir(real);
      for await (const entry of directory) {
        checkAbort(activeSignal);
        if (++linkEntries > MAX_LINK_ENTRIES) {
          if (!linkLimitReported) {
            result.diagnostics.push({ source_id: 'discovery', error: 'Skill directory link discovery reached its entry limit' });
            linkLimitReported = true;
          }
          break;
        }
        if (entry.name.startsWith('.') || ['node_modules', '__pycache__'].includes(entry.name)) continue;
        const child = path.join(real, entry.name);
        if (entry.isSymbolicLink()) {
          const target = await realDirectory(child, () => unreadable(candidate.origin));
          if (target && await hasEntry(target)) await add({ ...candidate, dir: target });
        } else if (entry.isDirectory() && depth < 1) {
          await topLevelLinks({ ...candidate, dir: child }, depth + 1);
        }
      }
    } catch (error) {
      checkAbort(activeSignal);
      if (!missing(error)) unreadable(candidate.origin);
    }
  };

  for (const candidate of sharedRoots(home, env, options.platform ?? process.platform)) {
    if (await add(candidate)) await topLevelLinks(candidate);
  }
  if (options.projects === false) {
    checkAbort(options.signal);
    return result;
  }

  const sharedCount = result.directories.length;
  try {
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Invalid project discovery timeout');
    const timeout = AbortSignal.timeout(timeoutMs);
    activeSignal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const observed = await sessionWorkspaces(options, env, activeSignal);
    const projects = new Set<string>();
    const localWorkspaces = new Set<string>();
    for (const workspace of observed) {
      checkAbort(activeSignal);
      const real = await realDirectory(workspace, () => unreadable('session-reader'));
      if (!real || localWorkspaces.has(real)) continue;
      localWorkspaces.add(real);
      result.workspace_count++;
      projects.add(real);
      const repository = await nearestRepository(real, activeSignal);
      if (repository) {
        let ancestor = real;
        for (let depth = 0; depth < 64; depth++) {
          checkAbort(activeSignal);
          projects.add(ancestor);
          if (ancestor === repository) break;
          ancestor = path.dirname(ancestor);
        }
      }
    }
    for (const project of projects) {
      for (const conventional of PROJECT_SKILL_ROOTS) {
        checkAbort(activeSignal);
        const candidate: DiscoveredSkillDirectory = { dir: path.join(project, conventional), scope: 'project', origin: 'session-reader', project };
        if (await add(candidate)) await topLevelLinks(candidate);
      }
    }
    checkAbort(activeSignal);
    result.project_status = 'ok';
  } catch {
    checkAbort(options.signal);
    result.directories.splice(sharedCount);
    result.workspace_count = 0;
    result.project_status = 'unavailable';
    result.diagnostics.push({ source_id: 'session-reader', error: 'Project discovery is unavailable; check the installed 1session command, its output and timeout' });
  }
  return result;
}

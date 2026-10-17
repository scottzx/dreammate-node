#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defaultConfigPath, validatePriorityConfig, readPriorityConfig } from './priority-config.mjs';

export const SERVICE_LABEL = 'work.dreammate.embedding';
export const SERVICE_ID = 'dreammate-embedding-on-demand';
const ownershipMarker = '<!-- dreammate-embedding-managed:v1 -->';
const defaultScript = fileURLToPath(new URL('./on-demand.mjs', import.meta.url));
const execute = promisify(execFile);
const configReloadIntervalMs = 15000;
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const unxml = value => value.replaceAll('&apos;', "'").replaceAll('&quot;', '"').replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');

function context(overrides = {}) {
  const ctx = {
    home: os.homedir(), platform: process.platform, uid: process.getuid?.() ?? 0,
    nodeBin: process.execPath, script: defaultScript, env: process.env,
    run: (command, args, options) => execute(command, args, { timeout: 5000, ...options }), fetch: globalThis.fetch,
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    ...overrides,
  };
  if (ctx.platform !== 'darwin') throw new Error(`当前平台 ${ctx.platform} 不支持此安装器；请直接运行 node scripts/local-embeddings/on-demand.mjs`);
  return ctx;
}

function validInteger(value, name, minimum, maximum) {
  const parsed = typeof value === 'number' ? value : /^-?\d+$/.test(String(value)) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} 必须是 ${minimum}–${maximum} 之间的整数`);
  return parsed;
}

function validSharing(value) {
  if (!['local', 'network'].includes(value)) throw new Error('--sharing 必须是 local 或 network');
  return value;
}

function safeText(value, name) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) throw new Error(`${name} 必须非空且不能包含换行或空字符`);
  return value;
}

function absoluteFile(value, name, executable = false) {
  safeText(value, name);
  if (!path.isAbsolute(value)) throw new Error(`${name} 必须是绝对路径`);
  if (!fs.statSync(value, { throwIfNoEntry: false })?.isFile()) throw new Error(`${name} 文件不存在：${value}`);
  if (executable) fs.accessSync(value, fs.constants.X_OK);
  return value;
}

function localAgent(value) {
  const agent = new URL(value ?? 'http://127.0.0.1:36908');
  if (!['http:', 'https:'].includes(agent.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(agent.hostname)
      || agent.username || agent.password || agent.pathname !== '/' || agent.search || agent.hash) {
    throw new Error('--agent 必须是无凭据和额外路径的本机 loopback URL');
  }
  return agent.origin;
}

function configFile(value, ctx) {
  const file = safeText(value ?? defaultConfigPath(ctx.home), '--config');
  if (!path.isAbsolute(file)) throw new Error('--config 必须是绝对路径');
  return file;
}

function installedArguments(ctx) {
  const content = existingFile(fileFor(ctx));
  return content === undefined ? [] : parseArguments(content);
}

async function configurationFor(options, ctx, args = []) {
  const priorityIndex = args.indexOf('--priority');
  const sharingIndex = args.indexOf('--sharing');
  const configIndex = args.indexOf('--config');
  const fallbackPriority = validInteger(options.fallbackPriority ?? (priorityIndex < 0 ? 100 : args[priorityIndex + 1]), '--priority', -1000, 1000);
  const fallbackSharing = validSharing(options.fallbackSharing ?? (sharingIndex < 0 ? 'network' : args[sharingIndex + 1]));
  const file = configFile(options.config ?? (configIndex < 0 ? undefined : args[configIndex + 1]), ctx);
  const config = await readPriorityConfig(file);
  return {
    file, priority: config?.priority ?? fallbackPriority, fallbackPriority,
    sharing: config?.sharing ?? fallbackSharing, fallbackSharing,
    source: config === undefined ? 'startup' : 'file', reloadIntervalMs: configReloadIntervalMs,
    ...(config === undefined ? {} : { config }),
  };
}

function argumentsFor(options, ctx) {
  if ((options.model ?? 'qwen3') !== 'qwen3') throw new Error('--model 目前只支持 qwen3');
  const args = [absoluteFile(ctx.nodeBin, 'Node', true), absoluteFile(ctx.script, '入口脚本'),
    '--port', String(validInteger(options.port ?? 8766, '--port', 1, 65535)),
    '--agent', localAgent(options.agent),
    '--python', absoluteFile(options.python, '--python', true),
    '--manifest', absoluteFile(options.manifest, '--manifest'),
    '--model', safeText(options.model ?? 'qwen3', '--model'),
    '--device', options.device ?? 'auto',
    '--idle-timeout-ms', String(validInteger(options.idleTimeoutMs ?? 300000, '--idle-timeout-ms', 1, 86400000)),
    '--priority', String(validInteger(options.priority ?? 100, '--priority', -1000, 1000)),
    '--sharing', validSharing(options.sharing === undefined ? 'network' : options.sharing),
    '--config', configFile(options.config, ctx),
    '--batch-size', String(validInteger(options.batchSize ?? 8, '--batch-size', 1, 64))];
  if (!['auto', 'cpu', 'mps', 'cuda'].includes(options.device ?? 'auto')) throw new Error('--device 必须是 auto、cpu、mps 或 cuda');
  for (const [key, flag, min, max] of [
    ['maxLength', '--max-length', 64, 8192],
    ['startupTimeoutMs', '--startup-timeout-ms', 1, 600000],
    ['inferenceTimeoutMs', '--inference-timeout-ms', 1, 600000],
    ['maxPending', '--max-pending', 1, 256],
  ]) if (options[key] !== undefined) args.push(flag, String(validInteger(options[key], flag, min, max)));
  if (options.register === false) args.push('--no-register');
  return args;
}

function fileFor(ctx) { return path.join(ctx.home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`); }
function targetFor(ctx) { return `gui/${ctx.uid}/${SERVICE_LABEL}`; }
function parseArguments(content) {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(content)?.[1];
  return array ? [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map(match => unxml(match[1])) : [];
}
function assertOwned(content, file) {
  const args = parseArguments(content);
  if (!content.includes(ownershipMarker) || !content.includes(`<key>Label</key><string>${SERVICE_LABEL}</string>`)
      || path.basename(args[1] ?? '') !== 'on-demand.mjs') throw new Error(`拒绝修改非本安装器管理的服务文件：${file}`);
}
function existingFile(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`服务配置必须是普通文件：${file}`);
  const content = fs.readFileSync(file, 'utf8');
  assertOwned(content, file);
  return content;
}
async function loadedJob(ctx, file, runOptions) {
  try {
    const result = await ctx.run('launchctl', ['print', targetFor(ctx)], runOptions);
    const loadedPath = /^\s*path = (.+)$/m.exec(result.stdout ?? '')?.[1]?.trim();
    if (loadedPath !== file) throw new Error(`同名 launchd 服务不是由当前配置加载，拒绝替换：${targetFor(ctx)}`);
    return result.stdout;
  } catch (error) {
    if (/Could not find (?:specified )?service|No such process/i.test(error.stderr ?? '')) return undefined;
    throw error;
  }
}

async function bootstrap(ctx, file, expectedContent) {
  // launchd can briefly reject a replacement while the old job is retiring.
  // Keep retries specific to that error, bounded to three seconds in total.
  const deadline = Date.now() + 3000;
  const delays = [200, 500, 1000];
  for (let attempt = 0; ; attempt++) {
    if (existingFile(file) !== expectedContent) throw new Error(`服务配置已变化，拒绝加载：${file}`);
    try {
      await ctx.run('launchctl', ['bootstrap', `gui/${ctx.uid}`, file], { timeout: Math.max(1, deadline - Date.now()) });
      return;
    } catch (error) {
      if (!/^Bootstrap failed: 5: Input\/output error\s*$/m.test(error.stderr ?? '')) throw error;
      if (Date.now() >= deadline) throw error;
      const loaded = await loadedJob(ctx, file, { timeout: Math.max(1, deadline - Date.now()) });
      if (loaded) {
        // The transient error may race with successful activation. Its managed
        // path and unchanged configuration must both match before accepting it.
        if (existingFile(file) !== expectedContent) throw new Error(`已加载服务的配置已变化，拒绝接管：${file}`);
        return;
      }
      const delay = delays[attempt];
      if (delay === undefined || Date.now() + delay >= deadline) throw error;
      await ctx.sleep(delay);
    }
  }
}
function atomicWrite(file, content) {
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

/** Only the lightweight HTTP supervisor starts at login; the model stays unloaded. */
export function renderServicePlist(options, overrides = {}) {
  const ctx = context(overrides);
  const args = argumentsFor(options, ctx);
  const runtimePath = safeText(ctx.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', 'PATH');
  const logs = path.join(ctx.home, '.1agents', 'logs');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
${ownershipMarker}
<plist version="1.0"><dict>
<key>Label</key><string>${SERVICE_LABEL}</string>
<key>ProgramArguments</key><array>${args.map(value => `<string>${xml(value)}</string>`).join('')}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(runtimePath)}</string></dict>
<key>StandardOutPath</key><string>${xml(path.join(logs, 'dreammate-embedding.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(logs, 'dreammate-embedding.err.log'))}</string>
<key>ProcessType</key><string>Interactive</string>
</dict></plist>
`;
}

export async function installService(options = {}, overrides = {}) {
  const ctx = context(overrides);
  const content = renderServicePlist(options, ctx);
  // Validate before stopping a running supervisor. A file override deliberately
  // wins over the startup fallback, and installing never rewrites that file.
  const configuration = await configurationFor({ config: options.config, fallbackPriority: options.priority ?? 100, fallbackSharing: options.sharing ?? 'network' }, ctx);
  const file = fileFor(ctx);
  const previous = existingFile(file);
  const loaded = await loadedJob(ctx, file);
  if (loaded && previous === undefined) throw new Error(`同名 launchd 服务缺少本安装器管理的配置，拒绝替换：${targetFor(ctx)}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.join(ctx.home, '.1agents', 'logs'), { recursive: true });
  let stoppedPrevious = false;
  let wrote = false;
  try {
    if (loaded) {
      await ctx.run('launchctl', ['bootout', targetFor(ctx)]);
      stoppedPrevious = true;
    }
    atomicWrite(file, content);
    wrote = true;
    await bootstrap(ctx, file, content);
  } catch (error) {
    const failures = [];
    const restore = async args => {
      try { await ctx.run('launchctl', args); } catch (failure) { failures.push(String(failure)); }
    };
    // A timed-out bootstrap can still have loaded the job. Retire only the job
    // whose path is the managed configuration before restoring previous state.
    if (wrote) {
      try { if (await loadedJob(ctx, file)) await restore(['bootout', targetFor(ctx)]); }
      catch (failure) { failures.push(String(failure)); }
    }
    if (wrote) {
      try {
        if (previous !== undefined) atomicWrite(file, previous);
        else fs.rmSync(file, { force: true });
      } catch (failure) { failures.push(String(failure)); }
    }
    if (stoppedPrevious && previous !== undefined) {
      try { await bootstrap(ctx, file, previous); }
      catch (failure) { failures.push(String(failure)); }
    }
    if (failures.length) throw new Error(`${String(error)}; 服务回滚未完成：${failures.join('; ')}`);
    throw error;
  }
  return {
    installed: true, platform: 'launchd', file,
    port: validInteger(options.port ?? 8766, '--port', 1, 65535),
    idleTimeoutMs: validInteger(options.idleTimeoutMs ?? 300000, '--idle-timeout-ms', 1, 86400000),
    effectivePriority: configuration.priority, fallbackPriority: configuration.fallbackPriority,
    sharing: configuration.sharing, fallbackSharing: configuration.fallbackSharing, configuration,
  };
}

/** Reads or changes advertisement settings without restarting the supervisor or its model. */
export async function configurePriority(options = {}, overrides = {}) {
  const ctx = context(overrides);
  const args = installedArguments(ctx);
  const previous = await configurationFor(options, ctx, args);
  if (options.priority === undefined && options.sharing === undefined) return { ...previous, updated: false };
  const config = validatePriorityConfig({ version: 1,
    priority: options.priority === undefined ? previous.priority : validInteger(options.priority, '--priority', -1000, 1000),
    ...(options.sharing === undefined
      ? (previous.config?.sharing === undefined ? {} : { sharing: previous.config.sharing })
      : { sharing: validSharing(options.sharing) }),
  });
  fs.mkdirSync(path.dirname(previous.file), { recursive: true, mode: 0o700 });
  // Refuse to replace an invalid or non-regular file even if it appeared since
  // the first read. Atomic replacement also resets existing broad permissions.
  await readPriorityConfig(previous.file);
  atomicWrite(previous.file, `${JSON.stringify(config, null, 2)}\n`);
  return { ...await configurationFor(options, ctx, args), updated: true };
}

export async function uninstallService(overrides = {}) {
  const ctx = context(overrides);
  const file = fileFor(ctx);
  const previous = existingFile(file);
  const loaded = await loadedJob(ctx, file);
  if (loaded && previous === undefined) throw new Error(`同名 launchd 服务缺少本安装器管理的配置，拒绝停止：${targetFor(ctx)}`);
  if (loaded) await ctx.run('launchctl', ['bootout', targetFor(ctx)]);
  if (previous !== undefined) fs.rmSync(file);
  return { platform: 'launchd', file, removed: previous !== undefined };
}

export async function serviceStatus(options = {}, overrides = {}) {
  const ctx = context(overrides);
  const file = fileFor(ctx);
  const previous = existingFile(file);
  const args = previous === undefined ? [] : parseArguments(previous);
  const configuredPort = args.indexOf('--port');
  const port = validInteger(options.port ?? (configuredPort < 0 ? 8766 : args[configuredPort + 1]), '--port', 1, 65535);
  let configuration;
  try { configuration = await configurationFor(options, ctx, args); }
  catch (error) {
    const configIndex = args.indexOf('--config');
    configuration = { file: configFile(options.config ?? (configIndex < 0 ? undefined : args[configIndex + 1]), ctx), error: error.message, reloadIntervalMs: configReloadIntervalMs };
  }
  let managerSays = 'not-loaded';
  try {
    const loaded = await loadedJob(ctx, file);
    if (loaded) managerSays = /state = (\w+)/.exec(loaded)?.[1] ?? 'loaded';
  } catch (error) { managerSays = `unknown: ${error.message}`; }
  let health;
  try {
    const response = await ctx.fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    if (response.ok) {
      const body = await response.json();
      if (body.service === SERVICE_ID) health = body;
    }
  } catch { /* An absent/unresponsive supervisor is represented in the status result. */ }
  return { platform: 'launchd', installed: previous !== undefined, file, managerSays, responding: health !== undefined, port, configuration, ...(health ? { health } : {}) };
}

const help = `Usage: node scripts/local-embeddings/manage.mjs <install|config|status|uninstall> [options]

install requires --python ABSOLUTE_PATH --manifest ABSOLUTE_PATH.
  --port 8766 --agent http://127.0.0.1:36908 --model qwen3
  --device auto|cpu|mps|cuda --idle-timeout-ms 300000 --priority 100 --sharing network --batch-size 8
  --max-length N --startup-timeout-ms N --inference-timeout-ms N --max-pending N
  --config ABSOLUTE_PATH --no-register
config [--priority N] [--sharing local|network] [--config ABSOLUTE_PATH] reads or updates without restarting.
  Default file: ~/.1agents/embedding-config.json. Each configured field overrides its startup argument.
  --sharing local restricts access to this Node; network allows peer access (default).
  Changes reload within 15 seconds. Without --priority or --sharing, config performs a read only.
  config --config selects the file to read/write; install --config sets the service's watched file.
status accepts --port PORT and --config ABSOLUTE_PATH; otherwise it uses the installed configuration.
uninstall accepts no options. This installer supports macOS launchd only.
Installing starts a lightweight supervisor; model loading happens on the first embedding request.
`;

export function parseArgs(argv) {
  const command = argv[0];
  if (!command || ['--help', '-h', 'help'].includes(command)) return { command: 'help', options: {} };
  if (!['install', 'config', 'status', 'uninstall'].includes(command)) throw new Error(`未知命令：${command}`);
  const options = {};
  const keys = {
    '--port': 'port', '--agent': 'agent', '--python': 'python', '--manifest': 'manifest', '--model': 'model', '--device': 'device',
    '--idle-timeout-ms': 'idleTimeoutMs', '--priority': 'priority', '--batch-size': 'batchSize', '--max-length': 'maxLength',
    '--startup-timeout-ms': 'startupTimeoutMs', '--inference-timeout-ms': 'inferenceTimeoutMs', '--max-pending': 'maxPending',
    '--config': 'config', '--sharing': 'sharing',
  };
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { command: 'help', options: {} };
    if (flag === '--no-register' && command === 'install') { options.register = false; continue; }
    if (!(flag in keys) || command === 'uninstall'
        || (command === 'status' && !['--port', '--config'].includes(flag))
        || (command === 'config' && !['--priority', '--sharing', '--config'].includes(flag))) throw new Error(`${command} 不支持参数：${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} 缺少值`);
    options[keys[flag]] = value;
  }
  return { command, options };
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (command === 'help') { process.stdout.write(help); return; }
  const result = command === 'install' ? await installService(options) : command === 'uninstall' ? await uninstallService()
    : command === 'config' ? await configurePriority(options) : await serviceStatus(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (command === 'status' && result.installed && !result.responding) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

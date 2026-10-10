#!/usr/bin/env node
// Runs before a source checkout is compiled: intentionally only Node built-ins.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const owner = '@1agents/dreammate-node';
const markerName = '.dreammate-node-install.json';
const hash = text => createHash('sha256').update(text).digest('hex');

export function detectProfile({ platform = process.platform, release = os.release(),
  exists = fs.existsSync } = {}) {
  // iSH reports Linux/i686. Alpine, architecture and hostname alone are not evidence.
  return platform === 'linux' && (/(?:^|[^a-z])ish(?:[^a-z]|$)/i.test(release) || exists('/proc/ish'))
    ? 'ish' : 'terminal';
}

function absoluteDir(value, home) {
  const expanded = value === '~' ? home : value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
  if (!path.isAbsolute(expanded)) throw new Error('技能目录必须是绝对路径或 ~/ 开头的路径');
  return path.resolve(expanded);
}

export function skillRoots({ home = os.homedir(), env = process.env, dir } = {}) {
  const custom = dir ?? env.DREAMMATE_SKILLS_DIR;
  if (custom) return [absoluteDir(custom, home)];
  const candidates = [path.join(home, '.agents', 'skills')];
  const optional = [
    path.join(home, '.claude', 'skills'),
    path.join(env.CODEX_HOME ? absoluteDir(env.CODEX_HOME, home) : path.join(home, '.codex'), 'skills'),
    path.join(home, '.gemini', 'skills'),
    path.join(home, '.gemini', 'config', 'skills'),
  ];
  for (const dir of optional) {
    try { if (fs.statSync(dir).isDirectory()) candidates.push(dir); } catch { /* Not installed. */ }
  }
  const seen = new Set();
  return candidates.filter(dir => {
    let key = dir;
    try { key = fs.realpathSync(dir); } catch { /* New canonical root. */ }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stat(file) {
  try { return fs.lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function atomicWrite(file, content) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, content, { flag: 'wx', mode: 0o644 });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/** Only replace an unchanged file previously installed by this package. */
export function installSkill(root, profile, { sourceRoot = packageRoot } = {}) {
  if (!['ish', 'terminal'].includes(profile)) throw new Error(`未知 profile: ${profile}`);
  const content = fs.readFileSync(path.join(sourceRoot, 'skills', profile, 'dreammate-node', 'SKILL.md'), 'utf8');
  const version = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')).version;
  const destination = path.join(root, 'dreammate-node');
  const skillFile = path.join(destination, 'SKILL.md');
  const markerFile = path.join(destination, markerName);
  const directory = stat(destination);
  if (directory && (!directory.isDirectory() || directory.isSymbolicLink())) {
    throw new Error(`保留已有非普通目录: ${destination}`);
  }
  const existing = stat(skillFile);
  const markerStat = stat(markerFile);
  if (markerStat && (!markerStat.isFile() || markerStat.isSymbolicLink())) {
    throw new Error(`保留已有非普通安装记录: ${markerFile}`);
  }
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error(`保留已有非普通文件: ${skillFile}`);
    let marker;
    try { marker = JSON.parse(fs.readFileSync(markerFile, 'utf8')); } catch { /* Unmanaged file. */ }
    if (marker?.owner !== owner || marker.sha256 !== hash(fs.readFileSync(skillFile, 'utf8'))) {
      throw new Error(`保留用户自建或修改过的 skill: ${skillFile}；请备份移走后再补装`);
    }
  }
  fs.mkdirSync(destination, { recursive: true });
  if (!existing || fs.readFileSync(skillFile, 'utf8') !== content) atomicWrite(skillFile, content);
  atomicWrite(markerFile, `${JSON.stringify({ owner, profile, version, sha256: hash(content) }, null, 2)}\n`);
  return skillFile;
}

const usage = `dreammate-node skills install [--profile auto|ish|terminal] [--dir /absolute/skills]

默认自动识别 iSH，安装至 ~/.agents/skills/dreammate-node；同时同步已存在的
Claude、Codex、Gemini skills 目录。--dir 指定时仅安装到该目录。
环境变量：DREAMMATE_SKILL_PROFILE、DREAMMATE_SKILLS_DIR（分别被显式参数覆盖）。
DREAMMATE_SKIP_SKILLS=1 仅跳过 npm 自动安装；手动命令仍可补装。
只复制本包自带 skill，不联网、不启动服务、不改 MCP 配置。
用户修改过的 skill 会保留，并提示处理路径。`;

export function runInstaller(argv = [], env = process.env) {
  const postinstall = argv.includes('--postinstall');
  try {
    const { values } = parseArgs({ args: argv, options: {
      profile: { type: 'string' }, dir: { type: 'string' },
      postinstall: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    } });
    if (values.help) { console.log(usage); return 0; }
    if (postinstall && env.DREAMMATE_SKIP_SKILLS === '1') {
      console.error('dreammate-node: 已按 DREAMMATE_SKIP_SKILLS=1 跳过 skill 安装');
      return 0;
    }
    const requested = values.profile ?? (env.DREAMMATE_SKILL_PROFILE?.trim() || 'auto');
    if (!['auto', 'ish', 'terminal'].includes(requested)) throw new Error('profile 必须是 auto、ish 或 terminal');
    const profile = requested === 'auto' ? detectProfile() : requested;
    let failures = 0;
    for (const root of skillRoots({ env, dir: values.dir })) {
      try {
        const file = installSkill(root, profile);
        console.error(`dreammate-node: 已安装 ${profile} skill → ${file}`);
      } catch (error) {
        failures++;
        console.error(`dreammate-node: skill 安装未完成: ${error.message}`);
      }
    }
    if (failures) console.error('dreammate-node: 可运行 dreammate-node skills install 补装；npm 包仍可使用');
    return failures && !postinstall ? 1 : 0;
  } catch (error) {
    console.error(`dreammate-node: skill 安装未完成: ${error.message}；可运行 dreammate-node skills install 补装`);
    return postinstall ? 0 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runInstaller(process.argv.slice(2));
}

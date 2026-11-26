#!/usr/bin/env node
/**
 * 编排 @1agents/dreammate-node 在运行中的 DSH profile 里的升级。
 *
 * set_bundle / remove_bundle / install_bundle 是 plugin_manager 的 Remote 方法，
 * 只能在 Agent 会话里调用，普通 Node 进程调不到。因此脚本分两阶段：
 *   prepare  检查目标版本已发布、备份 bundle 顺序、打印给 Agent 的调用序列
 *   finalize 恢复 bundle 顺序、验证版本与浏览器 bundle、输出热重载 URL
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const PACKAGE = '@1agents/dreammate-node';
const REGISTRY = 'https://registry.npmjs.org';
const DEFAULT_PROFILE = 'desktop';

export function profileDir(name = DEFAULT_PROFILE, env = process.env) {
  if (name === DEFAULT_PROFILE && env.DSH_PROFILE_DIR) return env.DSH_PROFILE_DIR;
  return path.join(homedir(), '.dsh', 'profiles', name);
}

export function readManifest(dir) {
  const file = path.join(dir, 'package.json');
  assert.ok(existsSync(file), `profile manifest not found: ${file}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function bundleSelection(manifest) {
  return manifest?.dsh?.profile?.bundles ?? [];
}

export function withBundleOrder(manifest, bundles) {
  return {
    ...manifest,
    dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } },
  };
}

/** 安装会把目标包追加到数组末尾；恢复到备份里的原位置。 */
export function restoreBundleOrder(current, original, name = PACKAGE) {
  const before = [...original];
  const index = before.indexOf(name);
  const after = current.filter(item => item !== name);
  if (index === -1) return [...after, name];
  return [...after.slice(0, index), name, ...after.slice(index)];
}

export function installedVersion(dir) {
  const file = path.join(dir, 'node_modules', PACKAGE, 'package.json');
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')).version;
}

export function declaredVersion(manifest) {
  return manifest?.dependencies?.[PACKAGE];
}

/** 浏览器 bundle 顶层声明检查：0.22.2 的回归点。 */
export function hasTopLevelDeclaration(source) {
  return /^(?:const|let|var|class|function|async function)\s/m.test(source);
}

export function clientBundlePath(dir) {
  return path.join(dir, 'node_modules', PACKAGE, 'vendor/dsh/client.js');
}

/** 询问 registry 上该版本是否可见（传播延迟用），不可见返回 undefined。 */
export function registryVersion(version, registry = REGISTRY) {
  try {
    return execFileSync('npm', ['view', `${PACKAGE}@${version}`, 'version', '--registry', registry], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000,
    }).trim();
  } catch {
    return undefined;
  }
}

function writeManifest(dir, manifest, dryRun) {
  if (dryRun) return;
  const file = path.join(dir, 'package.json');
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`);
  chmodSync(temp, statSync(file).mode);
  renameSync(temp, file);
}

export function prepare({ dir, version, dryRun = false, registry = REGISTRY, checkRegistry = true }) {
  const manifest = readManifest(dir);
  const bundles = bundleSelection(manifest);
  if (checkRegistry) {
    const published = registryVersion(version, registry);
    assert.equal(published, version,
      `${PACKAGE}@${version} 在 ${registry} 尚不可见；等 npm 传播完再升级`);
  }

  const backup = {
    version, package: PACKAGE,
    declaredVersion: declaredVersion(manifest),
    installedVersion: installedVersion(dir),
    bundles,
    createdAt: new Date().toISOString(),
  };
  const backupFile = path.join(dir, '.plugin-manager', `upgrade-backup-${version}.json`);
  if (!dryRun) {
    mkdirSync(path.dirname(backupFile), { recursive: true });
    writeFileSync(backupFile, `${JSON.stringify(backup, null, 2)}\n`);
  }

  return {
    phase: 'prepare', dir, version, backupFile, dryRun,
    currentVersion: backup.installedVersion,
    bundleIndex: bundles.indexOf(PACKAGE),
    agentCalls: [
      `set_bundle({ target: '${PACKAGE}', enabled: false })`,
      `remove_bundle({ target: '${PACKAGE}' })`,
      `install_bundle({ target: '${PACKAGE}@${version}', registry: '${registry}' })`,
    ],
  };
}

export function finalize({ dir, version, dryRun = false }) {
  const manifest = readManifest(dir);
  const backupFile = path.join(dir, '.plugin-manager', `upgrade-backup-${version}.json`);
  assert.ok(existsSync(backupFile), `prepare 阶段的备份不存在: ${backupFile}`);
  const backup = JSON.parse(readFileSync(backupFile, 'utf8'));

  const actual = installedVersion(dir);
  assert.equal(actual, version, `已安装版本 ${actual ?? '(none)'} 与目标 ${version} 不一致`);
  assert.equal(declaredVersion(manifest), version, `profile 声明的版本不是 ${version}`);

  const client = clientBundlePath(dir);
  assert.ok(existsSync(client), `浏览器 bundle 不存在: ${client}`);
  assert.ok(!hasTopLevelDeclaration(readFileSync(client, 'utf8')),
    '浏览器 bundle 存在顶层声明，HMR 重载会失败（见 test/dsh-embed.test.mjs）');

  const restored = restoreBundleOrder(bundleSelection(manifest), backup.bundles);
  const changed = JSON.stringify(bundleSelection(manifest)) !== JSON.stringify(restored);
  writeManifest(dir, withBundleOrder(manifest, restored), dryRun);

  return {
    phase: 'finalize', version, actual, changed, bundleIndex: restored.indexOf(PACKAGE),
    bundles: restored, reloadUrl: 'http://127.0.0.1:62579/plugins/events',
  };
}

function main() {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      version: { type: 'string' },
      profile: { type: 'string', default: DEFAULT_PROFILE },
      registry: { type: 'string', default: REGISTRY },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });
  if (values.help || !positionals.length) {
    console.log('用法: profile-upgrade <prepare|finalize> --version X.Y.Z [--profile NAME] [--registry URL] [--dry-run]');
    process.exitCode = values.help ? 0 : 1;
    return;
  }
  const phase = positionals[0];
  assert.ok(['prepare', 'finalize'].includes(phase), `未知阶段: ${phase}`);
  assert.ok(values.version, '必须提供 --version');
  const dir = profileDir(values.profile);
  const result = phase === 'prepare'
    ? prepare({ dir, version: values.version, dryRun: values['dry-run'], registry: values.registry })
    : finalize({ dir, version: values.version, dryRun: values['dry-run'] });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

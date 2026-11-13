#!/usr/bin/env node
/**
 * dreammate-node 和 dsh-dreammate-node 的版本号各自走。
 * 对齐的是插件依赖的大、小版本：`^0.18.0` 接得住 0.18.x，接不住 0.19.0。
 * 0.x 的补丁不用另发插件；小版本变了，必须在同一个提交里抬高插件依赖和插件自己的版本。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export function acceptsCaret(range, version) {
  const rangeMatch = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  const versionMatch = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!rangeMatch) throw new Error(`插件依赖必须是 ^主.次.补 范围，现在是 ${range}`);
  if (!versionMatch) throw new Error(`版本不是主.次.补：${version}`);
  const [rangeMajor, rangeMinor, rangePatch] = rangeMatch.slice(1).map(Number);
  const [major, minor, patch] = versionMatch.slice(1).map(Number);
  if (major !== rangeMajor) return false;
  // ^0.y.z 只浮动补丁，不跨小版本。^1.y.z 才允许小版本上涨。
  if (major === 0) return minor === rangeMinor && patch >= rangePatch;
  if (minor < rangeMinor) return false;
  if (minor > rangeMinor) return true;
  return patch >= rangePatch;
}

export function planRelease({ nodeVersion, pluginDependency, pluginPublished, publishedDependency }) {
  if (!acceptsCaret(pluginDependency, nodeVersion)) {
    const [major, minor] = nodeVersion.split('.');
    throw new Error(
      `插件依赖 ${pluginDependency} 接不住 dreammate-node ${nodeVersion}。` +
      `在同一个提交里把依赖改成 ^${major}.${minor}.0，并把 @1agents/dsh-dreammate-node 的小版本加一档。` +
      `补丁不用发插件，两个包的版本号也不用对齐。`,
    );
  }
  if (!pluginPublished) return 'publish-plugin';
  const published = publishedDependency || pluginDependency;
  if (!acceptsCaret(published, nodeVersion)) {
    throw new Error(
      `npm 上已有的插件版本依赖 ${published}，接不住 ${nodeVersion}。` +
      `先把插件版本加一档并改依赖，再发这次 Node。`,
    );
  }
  return 'skip-plugin';
}

function flag(values, name) {
  const value = values[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  const { values } = parseArgs({
    options: {
      node: { type: 'string' },
      'plugin-dependency': { type: 'string' },
      'plugin-published': { type: 'string' },
      'published-dependency': { type: 'string' },
    },
  });
  const nodePackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const pluginPackage = JSON.parse(readFileSync(new URL('../packages/dsh-plugin/package.json', import.meta.url), 'utf8'));
  const nodeVersion = flag(values, 'node') ?? nodePackage.version;
  const pluginDependency = flag(values, 'plugin-dependency') ?? pluginPackage.dependencies['@1agents/dreammate-node'];
  const publishedFlag = flag(values, 'plugin-published');
  if (publishedFlag !== undefined && publishedFlag !== 'true' && publishedFlag !== 'false') {
    throw new Error('--plugin-published 只能是 true 或 false');
  }
  const action = planRelease({
    nodeVersion,
    pluginDependency,
    pluginPublished: publishedFlag === 'true',
    publishedDependency: flag(values, 'published-dependency'),
  });
  process.stdout.write(`${action}\n`);
}

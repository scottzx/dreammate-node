#!/usr/bin/env node
// Test actual release artifacts outside the workspace, then exercise their HTTP boundary.
// Callers build both packages first; packing here deliberately skips all lifecycle scripts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const managerManifest = JSON.parse(fs.readFileSync(path.join(root, 'packages/skill-manager/package.json')));
const gatewayManifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
assert.equal(gatewayManifest.dependencies?.[managerManifest.name], undefined,
  'Node must not depend on Skill Manager at runtime');
assert.equal(managerManifest.dependencies?.[gatewayManifest.name], undefined,
  'Skill Manager must not depend on Node at runtime');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dreammate-package-boundary-'));
const artifacts = path.join(temp, 'artifacts');
fs.mkdirSync(artifacts);
const env = { ...process.env, NODE_PATH: '', DREAMMATE_SKIP_SKILLS: '1' };
const npm = (args, cwd = root) => execFileSync('npm', args, {
  cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 120_000,
});
function createConsumer(name) {
  const directory = path.join(temp, name);
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  return directory;
}
function run(consumer, args) {
  return execFileSync(process.execPath, args, {
    cwd: consumer, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 45_000,
  });
}
function install(consumer, ...tarballs) {
  npm(['install', '--ignore-scripts', '--package-lock=false', '--no-audit', '--no-fund', ...tarballs], consumer);
}
function check(consumer, filename, source) {
  fs.writeFileSync(path.join(consumer, filename), source);
  process.stdout.write(run(consumer, [filename]));
}

try {
  const [gateway] = JSON.parse(npm(['pack', '--json', '--ignore-scripts',
    '--workspaces=false', '--pack-destination', artifacts]));
  const [manager] = JSON.parse(npm(['pack', '--json', '--ignore-scripts',
    '--workspace=@1agents/skill-manager', '--pack-destination', artifacts]));
  assert.ok(!gateway.files.some(file => file.path.startsWith('dist/packages/')),
    'Node must not embed Skill Manager implementation');
  const gatewayTarball = path.join(artifacts, gateway.filename);
  const managerTarball = path.join(artifacts, manager.filename);

  const gatewayConsumer = createConsumer('node-only');
  install(gatewayConsumer, gatewayTarball);
  check(gatewayConsumer, 'node-check.mjs', String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as gateway from '@1agents/dreammate-node';
const pkg = JSON.parse(fs.readFileSync('node_modules/@1agents/dreammate-node/package.json'));
assert.equal(pkg.version, ${JSON.stringify(gatewayManifest.version)});
assert.equal(pkg.dependencies?.['@1agents/skill-manager'], undefined);
assert.equal(fs.existsSync('node_modules/@1agents/skill-manager'), false);
assert.equal(fs.existsSync('node_modules/@1agents/dreammate-node/node_modules/@1agents/skill-manager'), false);
assert.throws(() => import.meta.resolve('@1agents/skill-manager'), { code: 'ERR_MODULE_NOT_FOUND' });
assert.equal(gateway.SkillSourceManager, undefined);
assert.equal(typeof gateway.createAgent, 'function');
assert.ok(import.meta.resolve('@1agents/dreammate-node').startsWith(new URL('./node_modules/', import.meta.url).href));
const agent = gateway.createAgent({ registry: new gateway.ServiceRegistry({ storagePath: false }), mcpSources: { storagePath: false } });
await new Promise(resolve => agent.server.listen(0, '127.0.0.1', resolve));
try {
  const base = 'http://127.0.0.1:' + agent.server.address().port;
  assert.equal((await fetch(base + '/skills')).status, 503, 'Absent provider must be explicit');
} finally {
  await agent.mcpSources.stop();
  agent.server.closeAllConnections();
  await new Promise(resolve => agent.server.close(resolve));
}
console.log('Node-only install, public import and absent-provider response passed');
`);
  assert.match(run(gatewayConsumer, ['node_modules/@1agents/dreammate-node/dist/bin/dreammate-node.js', '--help']), /dreammate-node/);

  const managerConsumer = createConsumer('manager-only');
  install(managerConsumer, managerTarball);
  check(managerConsumer, 'manager-check.mjs', String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SkillSourceManager, loadSkillsFromDir, archiveSkill, serveSkillService } from '@1agents/skill-manager';
const pkg = JSON.parse(fs.readFileSync('node_modules/@1agents/skill-manager/package.json'));
assert.equal(pkg.version, ${JSON.stringify(managerManifest.version)});
assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
assert.equal(fs.existsSync('node_modules/@1agents/dreammate-node'), false);
assert.throws(() => import.meta.resolve('@1agents/dreammate-node'), { code: 'ERR_MODULE_NOT_FOUND' });
assert.ok(import.meta.resolve('@1agents/skill-manager').startsWith(new URL('./node_modules/', import.meta.url).href));
assert.equal(typeof archiveSkill, 'function');
assert.equal(typeof serveSkillService, 'function');
const dir = path.resolve('sample-skill');
fs.mkdirSync(dir);
fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: package-check\ndescription: Independent consumer check\n---\nPackage body\n');
const source = new SkillSourceManager({ storagePath: path.resolve('skill-sources.json'), autoDiscover: false });
await source.add({ name: 'package-check', dir });
const { skills } = await source.catalog();
assert.equal(skills.length, 1);
assert.match((await source.read(skills[0].id, skills[0].revision)).content, /Package body/);
assert.equal(loadSkillsFromDir(dir)['package-check'].sop, 'Package body');
console.log('Manager-only install, public import and versioned guide read passed');
`);
  assert.match(run(managerConsumer, ['node_modules/@1agents/skill-manager/dist/cli.js', '--help']), /dreammate-skills/);
  assert.match(run(managerConsumer, ['node_modules/@1agents/skill-manager/dist/cli.js', 'list', '--config', 'skill-sources.json']), /package-check/);

  const integrationConsumer = createConsumer('integration');
  install(integrationConsumer, gatewayTarball, managerTarball);
  check(integrationConsumer, 'integration-check.mjs', String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createAgent, ServiceRegistry } from '@1agents/dreammate-node';
import { SkillSourceManager } from '@1agents/skill-manager';
const skill = path.resolve('fixture');
fs.mkdirSync(path.join(skill, 'references'), { recursive: true });
fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: integration-guide\ndescription: Verify an independently registered provider\n---\nRemote provider guide.\n');
fs.writeFileSync(path.join(skill, 'references', 'detail.md'), 'Original reference.\n');
const config = path.resolve('skill-sources.json');
const manager = new SkillSourceManager({ storagePath: config, autoDiscover: false });
await manager.add({ name: 'fixture', dir: skill });
const agent = createAgent({ registry: new ServiceRegistry({ storagePath: false }), mcpSources: { storagePath: false } });
await new Promise(resolve => agent.server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + agent.server.address().port;
let child;
let logs = '';
try {
  assert.equal((await fetch(base + '/skills')).status, 503);
  child = spawn(process.execPath, ['node_modules/@1agents/skill-manager/dist/cli.js', 'serve', '--port', '0', '--agent', base, '--config', config, '--no-projects'], {
    env: { ...process.env, NODE_PATH: '', HOME: path.resolve('isolated-home'), CODEX_HOME: path.resolve('isolated-home/.codex'), CLAUDE_CONFIG_DIR: path.resolve('isolated-home/.claude') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', data => { logs = (logs + data).slice(-16000); });
  child.stderr.on('data', data => { logs = (logs + data).slice(-16000); });
  let card;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Manager exited before registration: ' + logs);
    const response = await fetch(base + '/skills?limit=200');
    if (response.ok) {
      const body = await response.json();
      card = body.skills?.find(item => item.name === 'integration-guide');
      if (card) break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(card, 'Real provider must register and serve its catalog: ' + logs);
  const services = agent.registry.list();
  assert.ok(services.some(service => service.metadata?.skill_provider?.protocol === 'dreammate.skills.v1'));
  const route = base + '/skills/' + encodeURIComponent(card.id) + '?revision=' + card.revision;
  const guideResponse = await fetch(route);
  assert.equal(guideResponse.status, 200);
  assert.match((await guideResponse.json()).content, /Remote provider guide/);
  const resourceResponse = await fetch(route + '&resource=references%2Fdetail.md');
  assert.equal(resourceResponse.status, 200);
  assert.equal((await resourceResponse.json()).content, 'Original reference.\n');
  console.log('Separate Node and Manager processes, HTTP registration, guide and resource reads passed');
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await once(child, 'exit');
    clearTimeout(timer);
  }
  await agent.mcpSources.stop();
  agent.server.closeAllConnections();
  await new Promise(resolve => agent.server.close(resolve));
}
`);
  console.log('All isolated package and runtime integration checks passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

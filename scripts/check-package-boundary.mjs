#!/usr/bin/env node
// Test actual release artifacts outside the workspace, then exercise their HTTP boundary.
// Callers build the compiled packages first; packing skips all lifecycle scripts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const managerManifest = JSON.parse(fs.readFileSync(path.join(root, 'packages/skill-manager/package.json')));
const artifactManifest = JSON.parse(fs.readFileSync(path.join(root, 'packages/artifact-index/package.json')));
const gatewayManifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
assert.equal(gatewayManifest.dependencies?.[managerManifest.name], undefined,
  'Node must not depend on Skill Manager at runtime');
assert.equal(managerManifest.dependencies?.[gatewayManifest.name], undefined,
  'Skill Manager must not depend on Node at runtime');
assert.equal(gatewayManifest.dependencies?.[artifactManifest.name], undefined,
  'Node must not depend on Artifact Index at runtime');
assert.equal(Object.keys(artifactManifest.dependencies ?? {}).length, 0,
  'Artifact Index must have no runtime npm dependencies');
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
  const [artifact] = JSON.parse(npm(['pack', '--json', '--ignore-scripts',
    '--workspace=@1agents/artifact-index', '--pack-destination', artifacts]));
  assert.ok(!gateway.files.some(file => /^(?:dist\/)?packages\//.test(file.path)),
    'Node must not embed independent workspace implementations');
  assert.ok(artifact.files.some(file => file.path === 'python/requirements.txt'),
    'Artifact Index must include its parser dependency manifest');
  const artifactAllow = /^(?:src\/[^/]+\.(?:mjs|d\.ts)|bin\/artifact-index\.mjs|python\/(?:extract\.py|requirements\.txt)|(?:package\.json|README\.md|CHANGELOG\.md|LICENSE))$/;
  assert.ok(artifact.files.every(file => artifactAllow.test(file.path)),
    'Artifact Index must only ship implementation, declarations, parser manifest and documentation');
  assert.ok(!artifact.files.some(file => /(?:^|\/)(?:\.local|node_modules|__pycache__|test|tests|fixtures|models?)(?:\/|$)|\.(?:safetensors|gguf|sqlite|f32|pdf|pptx?|xlsx?|mp4|png|pyc|tgz)$/i.test(file.path)),
    'Artifact Index must not contain source artifacts, model weights, generated indexes, caches or tests');
  const gatewayTarball = path.join(artifacts, gateway.filename);
  const managerTarball = path.join(artifacts, manager.filename);
  const artifactTarball = path.join(artifacts, artifact.filename);
  if (process.env.DREAMMATE_PACKAGE_CHECK_ARTIFACTS) {
    const destination = path.resolve(process.env.DREAMMATE_PACKAGE_CHECK_ARTIFACTS);
    fs.mkdirSync(destination, { recursive: true });
    for (const filename of [gateway.filename, manager.filename, artifact.filename]) fs.copyFileSync(path.join(artifacts, filename), path.join(destination, filename));
    fs.writeFileSync(path.join(destination, 'package-manifests.json'), JSON.stringify({ gateway, manager, artifact }, null, 2));
  }

  const gatewayConsumer = createConsumer('node-only');
  install(gatewayConsumer, gatewayTarball);
  check(gatewayConsumer, 'node-check.mjs', String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as gateway from '@1agents/dreammate-node';
const pkg = JSON.parse(fs.readFileSync('node_modules/@1agents/dreammate-node/package.json'));
assert.equal(pkg.version, ${JSON.stringify(gatewayManifest.version)});
assert.equal(pkg.dependencies?.['@1agents/skill-manager'], undefined);
assert.equal(pkg.dependencies?.['@1agents/artifact-index'], undefined);
assert.equal(fs.existsSync('node_modules/@1agents/skill-manager'), false);
assert.equal(fs.existsSync('node_modules/@1agents/dreammate-node/node_modules/@1agents/skill-manager'), false);
assert.throws(() => import.meta.resolve('@1agents/skill-manager'), { code: 'ERR_MODULE_NOT_FOUND' });
assert.throws(() => import.meta.resolve('@1agents/artifact-index'), { code: 'ERR_MODULE_NOT_FOUND' });
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

  const artifactConsumer = createConsumer('artifact-only');
  install(artifactConsumer, artifactTarball);
  check(artifactConsumer, 'artifact-check.mjs', String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ArtifactIndex } from '@1agents/artifact-index';
import { createEmbeddingClient } from '@1agents/artifact-index/embeddings';
import { extractArtifact, doctor } from '@1agents/artifact-index/extract';
import { serveArtifactIndex } from '@1agents/artifact-index/service';
const pkg = JSON.parse(fs.readFileSync('node_modules/@1agents/artifact-index/package.json'));
assert.equal(pkg.version, ${JSON.stringify(artifactManifest.version)});
assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
for (const sibling of ['@1agents/dreammate-node', '@1agents/skill-manager']) {
  assert.throws(() => import.meta.resolve(sibling), { code: 'ERR_MODULE_NOT_FOUND' });
}
assert.ok(import.meta.resolve('@1agents/artifact-index').startsWith(new URL('./node_modules/', import.meta.url).href));
assert.equal(typeof createEmbeddingClient, 'function');
assert.equal(typeof extractArtifact, 'function');
assert.equal(typeof doctor, 'function');
assert.equal(typeof serveArtifactIndex, 'function');
const source = path.resolve('fixture.pdf');
fs.writeFileSync(source, 'Opaque fixture for injected local extractor');
const index = new ArtifactIndex({ dbPath: path.resolve('artifacts.sqlite'), cacheDir: path.resolve('derived'), sourceNode: 'standalone',
  extractor: async () => ({ kind: 'pdf', title: '独立包', mime: 'application/pdf', parser_version: 'boundary-fixture-v1',
    units: [{ kind: 'page', locator: { page: 4 }, text: '眼镜 independent package boundary', representations: [] }], warnings: [] }) });
try {
  const result = await index.index([source], { semantic: false });
  assert.equal(result.diagnostics.indexed, 1);
  assert.equal(index.stats().vectors, 0);
  const search = await index.search('眼镜', { mode: 'lexical' });
  assert.equal(search.results.length, 1);
  assert.deepEqual(search.results[0].locator, { page: 4 });
  assert.match(index.read(search.results[0].unit_id).text, /independent package/);
} finally { index.close(); }
console.log('Artifact-only tarball import, local persistence, locators and lexical search passed without gateway or models');
`);
  // Exercise npm's installed executable symlink, not only its physical target.
  const artifactBin = path.join(artifactConsumer, 'node_modules/.bin/artifact-index');
  assert.match(execFileSync(artifactBin, ['--help'], { cwd: artifactConsumer, env, encoding: 'utf8', timeout: 45_000 }), /artifact-index/);
  assert.equal(execFileSync(artifactBin, ['--version'], { cwd: artifactConsumer, env, encoding: 'utf8', timeout: 45_000 }).trim(), artifactManifest.version);
  const artifactStats = JSON.parse(execFileSync(artifactBin, ['stats', '--db', path.join(artifactConsumer, 'artifacts.sqlite')], { cwd: artifactConsumer, env, encoding: 'utf8', timeout: 45_000 }));
  assert.equal(artifactStats.resources, 1);
  assert.equal(artifactStats.vectors, 0);
  fs.writeFileSync(path.join(artifactConsumer, 'artifact-types.mts'), `
import { ArtifactIndex, type SearchResponse } from '@1agents/artifact-index';
import { createEmbeddingClient } from '@1agents/artifact-index/embeddings';
import { extractArtifact, doctor } from '@1agents/artifact-index/extract';
import { serveArtifactIndex } from '@1agents/artifact-index/service';
const index = new ArtifactIndex({ embeddings: createEmbeddingClient(), extractor: (file, options) => extractArtifact(file, options) });
const results: SearchResponse = await index.search('glasses', { modalities: ['image', 'video'] });
const status = await doctor();
const service = await serveArtifactIndex({ index, register: false, port: 0 });
console.log(results.semantic_status, status.offline_isolation, service.descriptor().metadata.artifact_index_provider.protocol);
index.close();
`);
  run(artifactConsumer, [path.join(root, 'node_modules/typescript/lib/tsc.js'), '--strict', '--noEmit',
    '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2022', '--types', 'node',
    '--typeRoots', path.join(root, 'node_modules/@types'), path.join(artifactConsumer, 'artifact-types.mts')]);
  console.log('Artifact-only public declarations passed strict NodeNext consumer compilation');

  const integrationConsumer = createConsumer('integration');
  install(integrationConsumer, gatewayTarball, managerTarball, artifactTarball);
  check(integrationConsumer, 'integration-check.mjs', String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createAgent, ServiceRegistry } from '@1agents/dreammate-node';
import { SkillSourceManager } from '@1agents/skill-manager';
import { ArtifactIndex } from '@1agents/artifact-index';
import { serveArtifactIndex } from '@1agents/artifact-index/service';
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
let artifactService, artifactIndex;
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
  fs.writeFileSync('fixture.pdf', 'Controlled package-boundary fixture');
  artifactIndex = new ArtifactIndex({ dbPath: path.resolve('artifacts.sqlite'), cacheDir: path.resolve('derived'),
    extractor: async () => ({ kind: 'pdf', title: 'Integrated artifact', parser_version: 'boundary-fixture-v1', units: [{ kind: 'page', locator: { page: 7 }, text: '眼镜 across separate packages' }] }) });
  await artifactIndex.index([path.resolve('fixture.pdf')], { semantic: false });
  artifactService = await serveArtifactIndex({ index: artifactIndex, agent: base, port: 0, sharing: 'local' });
  assert.ok(agent.registry.list().some(service => service.metadata?.artifact_index_provider?.protocol === 'dreammate.artifacts.v1'));
  const artifactResponse = await fetch(base + '/services/artifact-index/invoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'artifacts.search', params: { query: '眼镜', mode: 'lexical' } }) });
  assert.equal(artifactResponse.status, 200);
  const artifactResult = await artifactResponse.json();
  assert.equal(artifactResult.results.length, 1);
  assert.deepEqual(artifactResult.results[0].locator, { page: 7 });
  console.log('Separate Node and Manager processes, HTTP registration, guide and resource reads passed');
  console.log('Independent Artifact Index service registration and gateway search with original PDF locator passed');
} finally {
  await artifactService?.stop();
  artifactIndex?.close();
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

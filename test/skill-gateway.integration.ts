import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAgent } from '../src/server.js';
import { ServiceRegistry } from '../src/registry.js';
import { callDreammateTool } from '../src/mcp.js';
import type { NodeDirectory } from '../src/node-directory.js';
import { serveSkillService } from '@1agents/skill-manager';

const fixtureDescription = 'Create a Three.js scene from CAD drawings and verify the result';
const bodyMarker = 'PRIVATE_BODY_ONLY: read every prerequisite before building the scene.';
const markdown = (name: string, body = bodyMarker) => `---\nname: ${name}\ndescription: ${fixtureDescription}\ncompatibility: Python 3 and the existing Three.js project\n---\n\n# Scene workflow\n\n${body}\n\nRead [the reference](references/guide.md).\n`;
const options = (base: string) => ({ agentUrl: base, embeddingUrl: '' });
const dataOf = (result: Awaited<ReturnType<typeof callDreammateTool>>): Record<string, any> =>
  (result.structuredContent ?? JSON.parse((result.content[0] as { text: string }).text)) as Record<string, any>;

async function listen(server: Server, host = '127.0.0.1'): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => { server.off('error', reject); resolve(); });
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

function post(base: string, route: string, data: unknown): Promise<Response> {
  return fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
}

async function writeSkill(project: string, name: string, body = bodyMarker): Promise<string> {
  const directory = path.join(project, '.agents', 'skills', name);
  await fs.mkdir(path.join(directory, 'references'), { recursive: true });
  await fs.mkdir(path.join(directory, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(directory, 'SKILL.md'), markdown(name, body));
  await fs.writeFile(path.join(directory, 'references', 'guide.md'), '# Detailed guide\nKeep CAD dimensions and source evidence.\n');
  await fs.writeFile(path.join(directory, 'scripts', 'check.py'), 'print("original fixture script")\n');
  return directory;
}

async function fixture(t: TestContext, host = '127.0.0.1') {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'dreammate-skill-gateway-'));
  const skillDirectory = await writeSkill(project, 'cad-scene');
  const registry = new ServiceRegistry({ storagePath: false });
  const provider = await serveSkillService({ port: 0, register: false, managerOptions: { storagePath: false, autoDiscover: false } });
  registry.register(provider.descriptor);
  const agent = createAgent({ registry, mcpSources: { storagePath: false } });
  const base = await listen(agent.server, host);
  t.after(async () => {
    await agent.mcpSources.stop();
    await close(agent.server);
    await provider.close();
    await fs.rm(project, { recursive: true, force: true });
  });
  const published = await post(base, '/skills/sources', { name: 'project', project });
  assert.equal(published.status, 201);
  assert.equal((await published.json() as { skill_count: number }).skill_count, 1);
  return { project, skillDirectory, base, registry, agent };
}

async function search(base: string, args: Record<string, unknown> = {}) {
  const response = await callDreammateTool('dreammate_search_skills', { query: 'CAD drawings', node: base, ...args }, options(base));
  assert.equal(response.isError, undefined, JSON.stringify(dataOf(response)));
  return dataOf(response);
}

test('project skills: a registered provider supplies summaries and the complete workflow and reference', { timeout: 20000 }, async t => {
  const { base, project, registry } = await fixture(t);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.list()[0]!.metadata?.skill_provider && (registry.list()[0]!.metadata!.skill_provider as { protocol: string }).protocol, 'dreammate.skills.v1');
  const found = await search(base);
  assert.equal(found.returned, 1);
  assert.equal(found.partial, false);
  const card = found.results[0];
  assert.equal(card.name, 'cad-scene');
  assert.equal(card.source_id, 'skills-project');
  assert.equal(card.node, base, 'an explicit gateway URL must remain routable in the result');
  assert.match(card.revision, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(found).includes(project), false);
  assert.doesNotMatch(JSON.stringify(found), /PRIVATE_BODY_ONLY|"content"|"resources"/);
  const read = dataOf(await callDreammateTool('dreammate_read_skill', {
    node: card.node, skill_id: card.id, revision: card.revision,
  }, options(base)));
  assert.equal(read.content, markdown('cad-scene'));
  assert.equal(read.resource, 'SKILL.md');
  assert.equal(read.encoding, 'utf8');
  assert.equal(read.execution.performed, false);
  assert.ok(read.resources.some((resource: { path: string }) => resource.path === 'references/guide.md'));
  const reference = dataOf(await callDreammateTool('dreammate_read_skill', {
    node: card.node, skill_id: card.id, revision: card.revision, resource: 'references/guide.md',
  }, options(base)));
  assert.equal(reference.content, '# Detailed guide\nKeep CAD dimensions and source evidence.\n');
  assert.equal(JSON.stringify(reference).includes(project), false);
});

test('project skills: both guide and script changes invalidate old revisions before resources can be mixed', { timeout: 20000 }, async t => {
  const { base, skillDirectory } = await fixture(t);
  let card = (await search(base)).results[0];
  for (const [relative, content] of [
    ['SKILL.md', markdown('cad-scene', 'Updated workflow with another prerequisite.')],
    ['scripts/check.py', 'print("updated fixture script")\n'],
  ]) {
    await fs.writeFile(path.join(skillDirectory, relative!), content!);
    const stale = await callDreammateTool('dreammate_read_skill', {
      node: card.node, skill_id: card.id, revision: card.revision, resource: 'scripts/check.py',
    }, options(base));
    assert.equal(stale.isError, true);
    assert.equal(dataOf(stale).http_status, 409);
    assert.equal(dataOf(stale).code, 'SKILL_REVISION_CHANGED');
    const fresh = (await search(base)).results[0];
    assert.equal(fresh.id, card.id);
    assert.notEqual(fresh.revision, card.revision);
    const loaded = await callDreammateTool('dreammate_read_skill', {
      node: fresh.node, skill_id: fresh.id, revision: fresh.revision, resource: relative,
    }, options(base));
    assert.equal(loaded.isError, undefined);
    assert.equal(dataOf(loaded).content, content);
    card = fresh;
  }
});

test('project skills: additions, deletions, source filters and catalog pages reflect the current files', { timeout: 20000 }, async t => {
  const { base, project, skillDirectory } = await fixture(t);
  await writeSkill(project, 'visual-review');
  const current = await search(base, { source_id: 'skills-project' });
  assert.deepEqual(new Set(current.results.map((card: any) => card.name)), new Set(['cad-scene', 'visual-review']));
  const first = await (await fetch(`${base}/skills?limit=1&offset=0`)).json() as Record<string, any>;
  assert.equal(first.skills.length, 1);
  assert.equal(first.total, 2);
  assert.equal(first.has_more, true);
  const second = await (await fetch(`${base}/skills?limit=1&offset=${first.next_offset}`)).json() as Record<string, any>;
  assert.equal(second.skills.length, 1);
  assert.notEqual(second.skills[0].id, first.skills[0].id);
  assert.equal(second.has_more, false);
  assert.equal((await search(base, { source_id: 'skills-missing' })).returned, 0);
  const deleted = current.results.find((card: any) => card.name === 'cad-scene');
  await fs.rm(skillDirectory, { recursive: true });
  assert.deepEqual((await search(base)).results.map((card: any) => card.name), ['visual-review']);
  const removed = await callDreammateTool('dreammate_read_skill', {
    node: deleted.node, skill_id: deleted.id, revision: deleted.revision,
  }, options(base));
  assert.equal(removed.isError, true);
  assert.equal(dataOf(removed).http_status, 404);
});

test('project skills: two gateways with identical skill IDs retain imported aliases and read their own package', { timeout: 20000 }, async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  await fs.writeFile(path.join(second.skillDirectory, 'SKILL.md'), markdown('cad-scene', 'Second gateway workflow.'));
  const nodeDirectory: NodeDirectory = {
    format: 'dreammate.nodes', version: 1, exported_at: '2026-10-17T00:00:00Z', default_node: 'first-alias',
    nodes: [
      { node_id: 'first-id', name: 'first-alias', type: 'linux', agent_url: first.base },
      { node_id: 'second-id', name: 'second-alias', type: 'linux', agent_url: second.base },
    ],
  };
  const mcpOptions = { ...options(first.base), nodeDirectory };
  const found = dataOf(await callDreammateTool('dreammate_search_skills', { query: 'CAD drawings' }, mcpOptions));
  assert.equal(found.returned, 2, JSON.stringify(found));
  assert.deepEqual(new Set(found.results.map((card: any) => card.node)), new Set(['first-alias', 'second-alias']));
  assert.equal(found.results[0].id, found.results[1].id, 'package identity is scoped to its source node');
  for (const card of found.results) {
    const loaded = await callDreammateTool('dreammate_read_skill', {
      node: card.node, skill_id: card.id, revision: card.revision,
    }, mcpOptions);
    assert.equal(loaded.isError, undefined, JSON.stringify(dataOf(loaded)));
    assert.equal(dataOf(loaded).content, markdown('cad-scene', card.node === 'first-alias' ? bodyMarker : 'Second gateway workflow.'));
  }
});

test('project skills: unsupported and failed gateways preserve partial evidence alongside working results', { timeout: 20000 }, async t => {
  const active = await fixture(t);
  const extra = [];
  for (const status of [404, 503]) {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/services') res.end(JSON.stringify({ services: [] }));
      else res.writeHead(status).end(JSON.stringify({ error: 'Fixture gateway unavailable' }));
    });
    const base = await listen(server);
    t.after(() => close(server));
    extra.push({ node_id: `status-${status}`, name: `status-${status}`, type: 'linux', agent_url: base });
  }
  const nodeDirectory: NodeDirectory = { format: 'dreammate.nodes', version: 1, exported_at: '2026-10-17T00:00:00Z', default_node: 'working', nodes: [
    { node_id: 'working', name: 'working', type: 'linux', agent_url: active.base }, ...extra,
  ] };
  const result = await callDreammateTool('dreammate_search_skills', { query: 'CAD drawings' }, { ...options(active.base), nodeDirectory });
  assert.equal(result.isError, undefined);
  const found = dataOf(result);
  assert.equal(found.returned, 1);
  assert.equal(found.partial, true);
  assert.deepEqual(found.scans.map((scan: any) => scan.status), ['ok', 'unsupported', 'http_error']);
  assert.equal(found.scan_status_counts.unsupported, 1);
  assert.equal(found.scan_status_counts.http_error, 1);
});

test('project skills: malformed package diagnostics mark otherwise successful discovery partial', { timeout: 20000 }, async t => {
  const { base, project } = await fixture(t);
  const bad = path.join(project, '.agents', 'skills', 'bad-frontmatter');
  await fs.mkdir(bad);
  await fs.writeFile(path.join(bad, 'SKILL.md'), '---\nname: bad-frontmatter\n---\nMissing required description.\n');
  const found = await search(base);
  assert.equal(found.returned, 1);
  assert.equal(found.results[0].name, 'cad-scene');
  assert.equal(found.partial, true);
  assert.equal(found.scans[0].diagnostics_count, 1);
  assert.equal(JSON.stringify(found).includes(project), false);
});

test('project skills: invalid MCP inputs fail before any network request and invalid HTTP catalog pages return 400', { timeout: 20000 }, async t => {
  const { base } = await fixture(t);
  for (const query of ['limit=0', 'limit=201', 'offset=-1', 'offset=1.5', 'offset=1000001']) {
    const response = await fetch(`${base}/skills?${query}`);
    assert.equal(response.status, 400, query);
    await response.json();
  }
  const requests = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network request'); });
  for (const args of [
    {}, { query: '' }, { query: ' ' }, { query: 3 }, { query: 'x'.repeat(2001) },
    { query: 'CAD', limit: 21 }, { query: 'CAD', offset: -1 }, { query: 'CAD', max_chars: 999 },
    { query: 'CAD', source_id: '../../project' }, { query: 'CAD', node: [] },
  ]) {
    const result = await callDreammateTool('dreammate_search_skills', args, options(base));
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  const valid = { skill_id: 'skills-project:fixture', revision: 'a'.repeat(64) };
  for (const args of [
    {}, { ...valid, revision: 'old' }, { ...valid, revision: 'A'.repeat(64) },
    { ...valid, node: 'all' }, { ...valid, resource: '../outside.md' },
    { ...valid, resource: '/tmp/outside.md' }, { ...valid, resource: 'C:/outside.md' },
  ]) {
    const result = await callDreammateTool('dreammate_read_skill', args, options(base));
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(requests.mock.callCount(), 0);
});

test('project skills: non-loopback clients can read published catalogs but cannot manage local source paths', { timeout: 20000 }, async t => {
  const address = Object.values(os.networkInterfaces()).flat().find(entry => entry && !entry.internal && entry.family === 'IPv4')?.address;
  if (!address) { t.skip('No non-loopback IPv4 interface is available'); return; }
  const { base, project } = await fixture(t, '0.0.0.0');
  const remote = base.replace('127.0.0.1', address);
  for (const [route, method] of [
    ['/skills/sources', 'GET'], ['/skills/sources', 'POST'],
    ['/skills/sources/skills-project', 'DELETE'], ['/skills/sources/skills-project/refresh', 'POST'],
    ['/skills/sources/refresh', 'POST'],
    ['/skills/sources/discover', 'POST'],
  ]) {
    const response = await fetch(`${remote}${route}`, { method, ...(method === 'POST' ? { body: '{}' } : {}) });
    assert.equal(response.status, 403, `${method} ${route}`);
    assert.equal(JSON.stringify(await response.json()).includes(project), false);
  }
  const response = await fetch(`${remote}/skills`);
  assert.equal(response.status, 200);
  const catalog = await response.json() as Record<string, any>;
  assert.equal(catalog.skills.length, 1);
  assert.equal(JSON.stringify(catalog).includes(project), false);
  const card = catalog.skills[0];
  const loaded = await fetch(`${remote}/skills/${encodeURIComponent(card.id)}?revision=${card.revision}`);
  assert.equal(loaded.status, 200);
  assert.equal((await loaded.json() as { content: string }).content, markdown('cad-scene'));
  for (const method of ['sources', 'add_source', 'remove_source', 'refresh_sources', 'discover_sources']) {
    for (const [route, payload] of [
      ['/services/dreammate-skill-manager/invoke', { method, params: {} }],
      [`/capabilities/${method}/invoke`, { params: {} }],
      ['/capabilities/catalog/invoke', { method, params: {} }],
      ['/services/dreammate-skill-manager/invoke', { method: 'catalog', capability: method, params: {} }],
    ] as const) {
      const bypass = await post(remote, route, payload);
      assert.equal(bypass.status, 403, `${route} ${JSON.stringify(payload)}`);
      assert.equal(JSON.stringify(await bypass.json()).includes(project), false);
    }
  }
  assert.equal((await post(remote, '/services/dreammate-skill-manager/invoke', { method: 'catalog', params: {} })).status, 200);
});

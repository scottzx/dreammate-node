import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { SkillSourceManager, type SkillReadResult, type SkillSourceStatus, type SkillSummary } from '../src/manager.js';
import { createSkillService, serveSkillService, SKILL_SERVICE_METHODS, type SkillServiceRegistration } from '../src/service.js';

async function listen(server: Server, port = 0): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
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

async function until(predicate: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) assert.fail('Timed out waiting for service state');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function fixture(t: TestContext): { root: string; manager: SkillSourceManager; source: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-service-'));
  const source = path.join(root, 'skills');
  for (const name of ['cad', 'visual']) {
    const directory = path.join(source, name);
    fs.mkdirSync(path.join(directory, 'references'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Create and verify a Tesla project scene\n---\n# Complete ${name} guide\n`);
    fs.writeFileSync(path.join(directory, 'references/guide.md'), 'Read the complete source evidence.\n');
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, source, manager: new SkillSourceManager({ storagePath: false, autoDiscover: false }) };
}

function invoke(base: string, method: string, params: unknown = {}): Promise<Response> {
  return fetch(`${base}/invoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) });
}

async function data<T>(response: Promise<Response>): Promise<T> { return (await response).json() as Promise<T>; }
type CatalogPage = { total: number; skills: SkillSummary[]; has_more: boolean; next_offset: number | null };

function fakeNode(withEtag = true) {
  let current: SkillServiceRegistration | undefined;
  let registrations = 0;
  let deletions = 0;
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'POST' && req.url === '/services') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        current = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        registrations++;
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify(current));
      } else if (req.method === 'GET' && req.url?.startsWith('/services/')) {
        res.writeHead(current ? 200 : 404, { 'content-type': 'application/json',
          ...(withEtag ? { etag: '"' + createHash('sha256').update(JSON.stringify(current ?? {})).digest('hex') + '"' } : {}) });
        res.end(JSON.stringify(current ?? { error: 'missing' }));
      } else if (req.method === 'DELETE' && req.url?.startsWith('/services/')) {
        if (req.headers['if-match'] !== '"' + createHash('sha256').update(JSON.stringify(current ?? {})).digest('hex') + '"') {
          res.writeHead(412); res.end('{}'); return;
        }
        deletions++;
        current = undefined;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      } else { res.writeHead(404); res.end(); }
    })().catch(error => { res.writeHead(500); res.end(String(error)); });
  });
  return { server, get current() { return current; }, set current(value) { current = value; },
    get registrations() { return registrations; }, get deletions() { return deletions; } };
}

test('independent provider exposes versioned catalog/read and strict source management contracts', async t => {
  const f = fixture(t);
  const service = await serveSkillService({ manager: f.manager, port: 0, register: false });
  t.after(() => service.close());
  const base = `http://127.0.0.1:${service.descriptor.port}`;
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await data<{ service: string }>(fetch(`${base}/health`))).service, 'dreammate-skill-manager');
  assert.equal((await fetch(`${base}/invoke`)).status, 404);
  assert.equal((await invoke(base, 'add_source', { name: 'tesla', dir: f.source })).status, 200);
  const sources = await data<{ sources: SkillSourceStatus[] }>(invoke(base, 'sources'));
  assert.equal(sources.sources[0].skill_count, 2);
  const page = await data<CatalogPage>(invoke(base, 'catalog', { limit: 1, offset: 0 }));
  assert.equal(page.total, 2);
  assert.equal(page.skills.length, 1);
  assert.equal(page.has_more, true);
  assert.equal(page.next_offset, 1);
  assert.equal(JSON.stringify(page).includes(f.root), false);
  const second = await data<CatalogPage>(invoke(base, 'catalog', { limit: 1, offset: 1 }));
  assert.equal(second.has_more, false);
  assert.equal(second.next_offset, null);
  const skill = page.skills[0];
  const read = await data<SkillReadResult>(invoke(base, 'read', { skill_id: skill.id, revision: skill.revision }));
  assert.match(read.content, /Complete .* guide/);
  const resource = await data<SkillReadResult>(invoke(base, 'read', { skill_id: skill.id, revision: skill.revision, resource: 'references/guide.md' }));
  assert.equal(resource.content, 'Read the complete source evidence.\n');
  fs.appendFileSync(path.join(f.source, skill.name, 'SKILL.md'), 'Changed guide.\n');
  assert.equal((await invoke(base, 'read', { skill_id: skill.id, revision: skill.revision })).status, 409);
  assert.equal((await invoke(base, 'refresh_sources', { id: 'skills-tesla' })).status, 200);
  assert.equal((await invoke(base, 'remove_source', { id: 'skills-tesla' })).status, 200);
  assert.deepEqual((await data<{ sources: SkillSourceStatus[] }>(invoke(base, 'sources'))).sources, []);
  assert.equal(fs.existsSync(path.join(f.source, skill.name, 'SKILL.md')), true);
  assert.deepEqual(service.descriptor.metadata.local_only_methods, ['sources', 'add_source', 'remove_source', 'refresh_sources', 'discover_sources']);
  assert.equal(service.descriptor.metadata.skill_provider.protocol, 'dreammate.skills.v1');
  for (const descriptor of Object.values(SKILL_SERVICE_METHODS)) {
    assert.equal(descriptor.parameters.type, 'object');
    assert.equal(descriptor.parameters.additionalProperties, false);
  }
});

test('provider rejects unknown fields, wrong parameter types, invalid versions and traversal before executing methods', async t => {
  const f = fixture(t);
  const service = await serveSkillService({ manager: f.manager, port: 0, register: false });
  t.after(() => service.close());
  const base = `http://127.0.0.1:${service.descriptor.port}`;
  const invalid: [string, unknown][] = [
    ['catalog', { limit: 0 }], ['catalog', { limit: 201 }], ['catalog', { offset: -1 }], ['catalog', { offset: 1.5 }],
    ['catalog', { limit: '1' }], ['catalog', { command: 'anything' }], ['catalog', null], ['sources', []], ['sources', { dir: '/' }],
    ['add_source', { name: 'valid', dir: f.source, project: f.root }], ['add_source', { name: 'valid', dir: f.source, id: 'skills-valid' }],
    ['remove_source', { id: 'invalid' }], ['refresh_sources', { id: 1 }], ['discover_sources', { projects: 'yes' }],
    ['discover_sources', { sessionCommand: '/bin/sh' }], ['read', { skill_id: 'valid', revision: 'old' }],
    ['read', { skill_id: 'valid', revision: 'a'.repeat(64), resource: '../private' }],
    ['read', { skill_id: 'valid', revision: 'a'.repeat(64), resource: '/private' }],
  ];
  for (const [method, params] of invalid) assert.equal((await invoke(base, method, params)).status, 400, `${method}: ${JSON.stringify(params)}`);
  assert.equal((await invoke(base, 'unknown')).status, 404);
  assert.equal((await fetch(`${base}/invoke`, { method: 'POST', body: '{' })).status, 400);
  assert.equal((await fetch(`${base}/invoke`, { method: 'POST', body: JSON.stringify({ method: 'sources', params: {}, command: 'sh' }) })).status, 400);
  assert.equal((await fetch(`${base}/invoke`, { method: 'POST', body: JSON.stringify({ method: 'sources', capability: 'sources', params: {} }) })).status, 200);
  assert.equal((await fetch(`${base}/invoke`, { method: 'POST', body: JSON.stringify({ method: 'sources', params: {}, padding: 'x'.repeat(70_000) }) })).status, 413);
  assert.deepEqual(await f.manager.list(), []);
});

test('provider works while Node is absent and retries registration when the local Node starts later', async t => {
  const f = fixture(t);
  const node = fakeNode();
  const reservation = createServer();
  const base = await listen(reservation);
  const port = (reservation.address() as AddressInfo).port;
  await close(reservation);
  const service = await serveSkillService({ manager: f.manager, port: 0, agentUrl: base,
    registrationIntervalMs: 30, registrationTimeoutMs: 100 });
  t.after(async () => { await service.close(); await close(node.server); });
  await service.report();
  assert.equal(service.registration.registered, false);
  assert.ok(service.registration.lastError);
  assert.equal((await fetch(`http://127.0.0.1:${service.descriptor.port}/health`)).status, 200);
  await listen(node.server, port);
  await until(() => service.registration.registered && node.registrations > 0);
  assert.equal(node.current?.port, service.descriptor.port);
  assert.equal(node.current?.reachability, 'localhost');
  assert.equal(node.current?.execution, 'http');
  assert.equal(service.registration.lastError, undefined);
  await service.close();
  await service.close();
  assert.equal(node.deletions, 1);
  const count = node.registrations;
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(node.registrations, count, 'no heartbeat survives close');
  assert.equal(service.server.listening, false);
});

test('provider shutdown preserves a newer service registration even when IDs are reused', async t => {
  const f = fixture(t);
  const node = fakeNode();
  const base = await listen(node.server);
  const service = await serveSkillService({ manager: f.manager, port: 0, agentUrl: base, registrationIntervalMs: 60_000 });
  t.after(async () => { await service.close(); await close(node.server); });
  await service.report();
  assert.ok(node.current);
  node.current = { ...node.current!, port: service.descriptor.port + 1,
    metadata: { ...node.current!.metadata, skill_provider: { protocol: 'dreammate.skills.v1', instance_id: 'new-process' } } };
  await service.close();
  assert.equal(node.deletions, 0);
  assert.equal(node.current?.metadata.skill_provider.instance_id, 'new-process');
});

test('provider keeps an old Node registration when conditional withdrawal is unavailable', async t => {
  const f = fixture(t);
  const node = fakeNode(false);
  const base = await listen(node.server);
  const service = await serveSkillService({ manager: f.manager, port: 0, agentUrl: base });
  t.after(async () => { await service.close(); await close(node.server); });
  await service.report();
  await service.close();
  assert.equal(node.deletions, 0);
  assert.ok(node.current, 'old Node health probes can later expire this registration safely');
});

test('provider close aborts an in-flight registration and calls manager lifecycle exactly once', async t => {
  let starts = 0;
  let stops = 0;
  class Manager extends SkillSourceManager {
    override async start() { starts++; }
    override async stop() { stops++; }
  }
  let requests = 0;
  let aborted = false;
  const node = createServer((req, res) => {
    if (req.method === 'POST') { requests++; res.once('close', () => { aborted = true; }); }
    else { res.writeHead(404); res.end(); }
  });
  const base = await listen(node);
  const service = await serveSkillService({ manager: new Manager({ storagePath: false }), port: 0, agentUrl: base,
    registrationTimeoutMs: 10_000, registrationIntervalMs: 10 });
  t.after(async () => { await service.close(); await close(node); });
  await until(() => requests === 1);
  const extra = service.report();
  const start = Date.now();
  await service.close();
  await extra;
  await until(() => aborted);
  assert.ok(Date.now() - start < 2000, 'close must abort pending requests instead of waiting for their timeout');
  assert.equal(requests, 1, 'heartbeats and explicit reports share one in-flight request');
  assert.equal(starts, 1);
  assert.equal(stops, 1);
});

test('constructing a provider performs no discovery, registration, or listening and rejects remote endpoints', async () => {
  const manager = new SkillSourceManager({ storagePath: false, autoDiscover: false });
  const service = createSkillService({ manager, port: 0, register: false });
  assert.equal(service.server.listening, false);
  assert.equal(service.registration.lastAttemptAt, undefined);
  await service.close();
  assert.throws(() => createSkillService({ host: '0.0.0.0' }), /127.0.0.1/);
  assert.throws(() => createSkillService({ host: '::1' }), /127.0.0.1/);
  assert.throws(() => createSkillService({ agentUrl: 'http://example.com:36908' }), /loopback/);
  assert.throws(() => createSkillService({ agentUrl: 'http://127.0.0.1:36908/private' }), /loopback/);
  assert.throws(() => createSkillService({ port: -1 }), /port/);
});

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { scanSkillCatalog } from '../src/skill-catalog.js';
import { callDreammateTool } from '../src/mcp.js';

const skill = (name: string) => ({ id: `skills-fixture:${name}`, source_id: 'skills-fixture', name,
  description: `Find ${name} instructions`, revision: 'a'.repeat(64) });
const send = (res: ServerResponse, data: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });res.end(JSON.stringify(data));
};
async function fixture(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve());server.closeAllConnections(); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('catalog pages have independent deadlines instead of sharing one page budget', async t => {
  const base = await fixture(t, (req, res) => {
    const offset = Number(new URL(req.url!, 'http://local').searchParams.get('offset'));
    send(res, { skills: [skill(offset ? 'second' : 'first')], has_more: offset === 0, next_offset: 1 });
  });
  const originalFetch = globalThis.fetch;
  const signals: (AbortSignal | null | undefined)[] = [];
  globalThis.fetch = (input, init) => {
    if (String(input).startsWith(base)) signals.push(init?.signal);
    return originalFetch(input, init);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const result = await scanSkillCatalog(base, 'fixture');
  assert.equal(result.scan.status, 'ok');
  assert.deepEqual(result.skills.map(s => s.name), ['first', 'second']);
  assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal instanceof AbortSignal));
  assert.notEqual(signals[0], signals[1], 'later pages must receive a fresh deadline controller');
});

test('a timed out later page preserves earlier validated skills and remains bounded', async t => {
  const base = await fixture(t, (req, res) => {
    if (new URL(req.url!, 'http://local').searchParams.get('offset') === '0') {
      send(res, { skills: [skill('first')], has_more: true, next_offset: 1 });
    }
  });
  const result = await scanSkillCatalog(base, 'fixture', { pageTimeoutMs: 150, totalTimeoutMs: 700 });
  assert.equal(result.scan.status, 'timeout');
  assert.deepEqual(result.skills.map(s => s.name), ['first']);
});

test('transient catalog errors retry only the failed read page', async t => {
  const offsets: number[] = [];
  const base = await fixture(t, (req, res) => {
    const offset = Number(new URL(req.url!, 'http://local').searchParams.get('offset'));offsets.push(offset);
    if (offset === 1 && offsets.length === 2) return send(res, {}, 503);
    send(res, { skills: [skill(offset ? 'second' : 'first')], has_more: offset === 0, next_offset: 1 });
  });
  const result = await scanSkillCatalog(base, 'fixture');
  assert.equal(result.scan.status, 'ok');
  assert.deepEqual(offsets, [0, 1, 1]);
  assert.deepEqual(result.skills.map(s => s.name), ['first', 'second']);
});

test('aggregate catalog deadline bounds a stalled page even with a longer page budget', async t => {
  const base = await fixture(t, (req, res) => {
    if (new URL(req.url!, 'http://local').searchParams.get('offset') === '0') {
      send(res, { skills: [skill('first')], has_more: true, next_offset: 1 });
    }
  });
  const result = await scanSkillCatalog(base, 'fixture', { pageTimeoutMs: 1000, totalTimeoutMs: 150 });
  assert.equal(result.scan.status, 'timeout');
  assert.equal(result.skills.length, 1);
});

test('an invalid later page never leaks malformed entries into the retained catalog', async t => {
  const base = await fixture(t, (req, res) => {
    const offset = Number(new URL(req.url!, 'http://local').searchParams.get('offset'));
    send(res, { skills: offset ? [skill('valid'), { ...skill('invalid'), revision: 'wrong' }] : [skill('first')],
      has_more: offset === 0, next_offset: 1 });
  });
  const result = await scanSkillCatalog(base, 'fixture');
  assert.equal(result.scan.status, 'invalid_response');
  assert.deepEqual(result.skills.map(s => s.name), ['first']);
});

test('the MCP handler retrieves every page when a full traversal takes over three seconds', { timeout: 12000 }, async t => {
  const base = await fixture(t, (req, res) => {
    if (req.url === '/services') return send(res, { services: [] });
    const offset = Number(new URL(req.url!, 'http://local').searchParams.get('offset'));
    setTimeout(() => send(res, { skills: [skill(offset ? 'last-page' : 'first')], has_more: offset === 0, next_offset: 1 }), 1700);
  });
  const result = await callDreammateTool('dreammate_search_skills', { query: 'last-page', node: 'localhost' },
    { agentUrl: base, embeddingUrl: '' });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent!.total_candidates, 2);
  assert.equal((result.structuredContent!.results as { name: string }[])[0]!.name, 'last-page');
  assert.equal(result.structuredContent!.partial, false);
});

test('partial catalog results stay usable when the later page is unavailable', async t => {
  const base = await fixture(t, (req, res) => {
    if (req.url === '/services') return send(res, { services: [] });
    if (new URL(req.url!, 'http://local').searchParams.get('offset') === '0') {
      return send(res, { skills: [skill('first')], has_more: true, next_offset: 1 });
    }
    send(res, {}, 503);
  });
  const result = await callDreammateTool('dreammate_search_skills', { query: 'first', node: 'localhost' },
    { agentUrl: base, embeddingUrl: '' });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent!.partial, true);
  assert.equal(result.structuredContent!.total_candidates, 1);
  assert.equal((result.structuredContent!.results as { name: string }[])[0]!.name, 'first');
});

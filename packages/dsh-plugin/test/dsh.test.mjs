import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import * as plugin from '../src/index.js';
import { unused, health, endpoint } from './helpers.mjs';

const checkout = process.env.DSH_CHECKOUT;
async function runtime() {
  const fromTools = createRequire(resolve(checkout, 'packages/core/tools/package.json'));
  const { Context } = await import(pathToFileURL(fromTools.resolve('@deepseek-ai/cordis')));
  const { default: ToolRuntime } = await import(pathToFileURL(resolve(checkout, 'packages/core/tools/lib/index.js')));
  const { default: SystemPrompt } = await import(pathToFileURL(resolve(checkout, 'packages/core/system-prompt/lib/index.js')));
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  return ctx;
}

test('real DSH native tool execution, schema, business failure and Cordis disposal', { skip: !checkout, timeout: 20000 }, async t => {
  const ctx = await runtime();
  t.after(() => ctx.fiber.dispose());
  const url = await unused(t);
  const fiber = ctx.plugin(plugin, { serviceUrl: url, serviceHost: '127.0.0.1' });
  await fiber.await();
  assert.equal(ctx.tools.schemas().filter(t => t.name.startsWith('dreammate_')).length, 7);
  const success = await ctx.tools.execute({ name: 'dreammate_list_services', arguments: {}, callId: 'test-list', signal: new AbortController().signal });
  assert.equal(success.isError, false, JSON.stringify(success));
  assert.ok(Array.isArray(success.value.content));
  const failure = await ctx.tools.execute({ name: 'dreammate_inspect', arguments: { service_id: 'missing-service' }, callId: 'test-error', signal: new AbortController().signal });
  assert.equal(failure.isError, true);
  assert.match(failure.content.map(c => c.text).join(''), /isError/);
  await fiber.dispose();
  assert.equal(ctx.tools.get('dreammate_list_services'), undefined);
  await assert.rejects(health(url));
});

test('real Cordis activation failure cleans up the newly started node', { skip: !checkout, timeout: 20000 }, async t => {
  const ctx = await runtime();
  t.after(() => ctx.fiber.dispose());
  ctx.tools.register({ name: 'dreammate_list_nodes', description: 'duplicate fixture', parameters: { type: 'object' },
    output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) });
  const url = await unused(t);
  const fiber = ctx.plugin(plugin, { serviceUrl: url, serviceHost: '127.0.0.1' });
  await assert.rejects(fiber.await());
  await fiber.dispose();
  await assert.rejects(health(url));
});

test('real DSH preserves structured data and content in remote MCP results', { skip: !checkout, timeout: 20000 }, async t => {
  const envelope = { content: [{ type: 'text', text: 'ok' }, { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }],
    structuredContent: { answer: 42 }, _meta: { test: true } };
  const gateway = await endpoint(t, (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.includes('/invoke')) res.end(JSON.stringify(envelope));
    else if (req.url === '/services') res.end(JSON.stringify({ services: [{ id: 'fixture', methods: { echo: { description: 'test' } } }] }));
    else res.end('{}');
  });
  const ctx = await runtime();
  t.after(() => ctx.fiber.dispose());
  const fiber = ctx.plugin(plugin, { serviceUrl: gateway.url, serviceMode: 'external' });
  await fiber.await();
  const result = await ctx.tools.execute({ name: 'dreammate_invoke', arguments: { service_id: 'fixture', method: 'echo', params: {} }, callId: 'invoke', signal: new AbortController().signal });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.deepEqual(result.value, envelope);
});

test('HTTP 200 with an MCP business error is a real DSH failure, never retried', { skip: !checkout }, async t => {
  let calls = 0;
  const envelope = { isError: true, content: [{ type: 'text', text: 'Business rejected' }], structuredContent: { code: 'denied' } };
  const gateway = await endpoint(t, (_req, res) => { calls++; res.end(JSON.stringify(envelope)); });
  const ctx = await runtime();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(plugin, { serviceUrl: gateway.url, serviceMode: 'external' });
  const result = await ctx.tools.execute({ name: 'dreammate_invoke', arguments: { service_id: 'fixture', method: 'echo' }, callId: 'invoke-error', signal: new AbortController().signal });
  assert.equal(result.isError, true);
  assert.match(result.content.map(c => c.text).join(''), /Business rejected/);
  assert.equal(calls, 1);
});

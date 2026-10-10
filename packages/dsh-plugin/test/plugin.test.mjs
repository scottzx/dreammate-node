import test from 'node:test';
import assert from 'node:assert/strict';
import { MCP_TOOLS } from '@1agents/dreammate-node';
import * as plugin from '../src/index.js';
import { context, endpoint, unused, health } from './helpers.mjs';

test('registers native DSH tools using published schemas, invokes gateway, and releases tools', async t => {
  const gateway = await endpoint(t, (req, res) => {
    if (req.url === '/health') res.end(JSON.stringify({ service: 'node-agent', status: 'ok' }));
    else res.end(JSON.stringify({ node: 'fixture', services: [] }));
  });
  const ctx = context();
  t.after(() => ctx.dispose());
  await plugin.apply(ctx, { serviceUrl: gateway.url });
  assert.equal(ctx.definitions.size, 7);
  for (const tool of MCP_TOOLS) assert.deepEqual(ctx.definitions.get(tool.name).parameters, tool.inputSchema);
  const tool = ctx.definitions.get('dreammate_list_services');
  const result = await tool.execute({});
  assert.ok(Array.isArray(result.content));
  assert.deepEqual(JSON.parse(tool.output.render({}, result)[0].text), result);
  assert.notEqual(result.isError, true);
  await ctx.dispose();
  assert.equal(ctx.definitions.size, 0);
  assert.equal((await health(gateway.url)).status, 200);
});

test('business errors fail the DSH tool and retain the MCP error envelope', async t => {
  const ctx = context();
  t.after(() => ctx.dispose());
  await plugin.apply(ctx, { serviceMode: 'external', serviceUrl: await unused(t) });
  await assert.rejects(ctx.definitions.get('dreammate_list_services').execute({}), error => {
    assert.equal(JSON.parse(error.message).isError, true);
    return true;
  });
});

test('pre-cancelled calls never reach the gateway', async t => {
  let calls = 0;
  const gateway = await endpoint(t, (_req, res) => { calls++; res.end('{}'); });
  const ctx = context();
  t.after(() => ctx.dispose());
  await plugin.apply(ctx, { serviceMode: 'external', serviceUrl: gateway.url });
  await assert.rejects(ctx.definitions.get('dreammate_list_services').execute({}, { signal: AbortSignal.abort() }));
  assert.equal(calls, 0);
});

test('published package entry starts the dependency when the node is missing', { timeout: 20000 }, async t => {
  const url = await unused(t);
  const ctx = context();
  t.after(() => ctx.dispose());
  await plugin.apply(ctx, { serviceUrl: url, serviceHost: '127.0.0.1' });
  const result = await ctx.definitions.get('dreammate_list_services').execute({});
  assert.notEqual(result.isError, true);
  await ctx.dispose();
  await assert.rejects(health(url));
});

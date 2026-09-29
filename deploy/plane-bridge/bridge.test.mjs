import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from './bridge.mjs';

test('discovery, exact forwarding, upstream failure and secret redaction', async () => {
  const calls = [];
  const secret = 'test-secret-never-publish';
  const tools = [{ name: 'project', description: 'Plane project resource', inputSchema: { type: 'object', properties: { action: { enum: ['list', 'create'] } }, required: ['action'] }, annotations: { readOnlyHint: false } }];
  const client = { async callTool(input) {
    calls.push(input);
    if (input.arguments.action === 'create') return { isError: true, content: [{ type: 'text', text: `denied ${secret}` }] };
    return { content: [{ type: 'text', text: '[]' }], structuredContent: { results: [] } };
  } };
  const server = createBridge(client, tools, { secret, workspace: 'demo', appUrl: 'http://plane.test', health: async () => ({ online: true }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const invoke = (method, params) => fetch(`${base}/invoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) });
  try {
    const manifest = await (await fetch(`${base}/manifest`)).json();
    assert.deepEqual(manifest.services[0].methods['plane.project'].parameters, tools[0].inputSchema);
    assert.equal(manifest.services[0].methods['plane.project'].annotations.readOnlyHint, false);
    assert.ok(!JSON.stringify(manifest).includes(secret));
    const success = await invoke('plane.project', { action: 'list', per_page: 2 });
    assert.equal(success.status, 200);
    assert.deepEqual((await success.json()).structuredContent, { results: [] });
    assert.deepEqual(calls, [{ name: 'project', arguments: { action: 'list', per_page: 2 } }]);
    assert.equal((await invoke('unknown', {})).status, 404);
    assert.equal((await invoke('plane.project', [])).status, 400);
    assert.equal(calls.length, 1);
    const failure = await invoke('plane.project', { action: 'create' });
    assert.equal(failure.status, 200);
    const result = await failure.json();
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, 'denied [REDACTED]');
    assert.equal(calls.length, 2, 'upstream failures must not retry writes');
    assert.equal((await (await invoke('plane-pm.status', {})).json()).online, true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('DMN-4/6: preserve business errors and scope availability to observed action/resources', async () => {
  let fail = true;
  const client = { async callTool() {
    return fail ? { isError: true, content: [{ type: 'text', text: "Error calling tool 'page': HTTP 404: Not Found: Page not found." }] }
      : { content: [{ type: 'text', text: '[]' }], structuredContent: { results: [] } };
  } };
  const server = createBridge(client, [{ name: 'page', inputSchema: { type: 'object' } }], { workspace: 'w', health: async () => ({ online: true }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const catalog = async () => (await (await fetch(`${base}/manifest`)).json()).services[0].metadata.method_availability['plane.page'];
  const invoke = params => fetch(`${base}/invoke`, { method: 'POST', body: JSON.stringify({ method: 'plane.page', params }) });
  try {
    assert.equal((await catalog()).state, 'unknown');
    let response = await invoke({ action: 'list', project_id: 'p1' });
    assert.equal(response.status, 200);
    let result = await response.json(); assert.equal(result.isError, true);
    assert.equal(result._meta.dreammate_upstream.kind, 'business');
    assert.equal(result._meta.dreammate_upstream.upstream_status, 404);
    let availability = await catalog();
    assert.equal(availability.state, 'unknown');
    assert.equal(availability.observations[0].outcome, 'failed');
    assert.equal(availability.observations[0].scope.project_id, 'p1');
    assert.equal(availability.observations[0].availability, 'unknown');
    fail = false; await (await invoke({ action: 'list', project_id: 'p2' })).text();
    availability = await catalog();
    assert.equal(availability.observations.length, 2);
    assert.equal(availability.observations[1].availability, 'available');
    assert.equal(availability.state, 'unknown', 'success on one scope must not imply all actions work');
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.service_health.scope, 'api_credentials');
    assert.equal(health.methods_verified, false);
    assert.ok(health.checked_at);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('DMN-4/5: timeout and transport failures differ; offline status is not success', async () => {
  let mode = 'timeout'; let calls = 0;
  const client = { async callTool() { calls++; const error = new Error(mode); if (mode === 'timeout') error.code = -32001; throw error; } };
  const server = createBridge(client, [{ name: 'project', inputSchema: { type: 'object' } }], { workspace: 'w', health: async () => ({ online: false }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const invoke = method => fetch(`${base}/invoke`, { method: 'POST', body: JSON.stringify({ method, params: {} }) });
  try {
    let response = await invoke('plane.project'); assert.equal(response.status, 504);
    assert.equal((await response.json())._meta.dreammate_upstream.kind, 'timeout');
    mode = 'transport'; response = await invoke('plane.project'); assert.equal(response.status, 502);
    assert.equal((await response.json())._meta.dreammate_upstream.kind, 'transport');
    assert.equal(calls, 2, 'each call executes only once');
    response = await invoke('plane-pm.status'); assert.equal(response.status, 503);
    assert.equal((await response.json()).service_health.status, 'down');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('DMN-6: only explicit deployment evidence marks a tool unsupported', async () => {
  let calls = 0;
  const client = { async callTool() { calls++; return { content: [] }; } };
  const tools = [{ name: 'page', inputSchema: { type: 'object' } }];
  assert.throws(() => createBridge(client, tools, { methodSupport: { 'plane.page': { state: 'unsupported' } } }), /Invalid explicit/);
  const support = { state: 'unsupported', reason: 'Verified deployment has no public Pages routes', checked_at: '2026-09-29T00:00:00Z', fallback: 'workitem description_html' };
  const server = createBridge(client, tools, { workspace: 'w', methodSupport: { 'plane.page': support }, health: async () => ({ online: true }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const manifest = await (await fetch(`${base}/manifest`)).json();
    assert.ok(manifest.services[0].methods['plane.page']);
    assert.equal(manifest.services[0].metadata.method_availability['plane.page'].state, 'unsupported');
    const r = await (await fetch(`${base}/invoke`, { method: 'POST', body: JSON.stringify({ method: 'plane.page', params: { action: 'create' } }) })).json();
    assert.equal(r.isError, true); assert.equal(r._meta.dreammate_upstream.kind, 'unsupported');
    assert.match(r.content[0].text, /workitem description_html/); assert.equal(calls, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('DMN-6: observations are bounded, canonicalized and recoverable without storing payloads', async () => {
  const secret = 'do-not-leak'; let fail = false;
  const client = { async callTool() { return fail ? { isError: true, content: [{ type: 'text', text: `denied ${secret}` }] } : { content: [] }; } };
  const server = createBridge(client, [{ name: 'page', inputSchema: { type: 'object' } }], { workspace: 'w', secret, health: async () => ({ online: true }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const invoke = params => fetch(`${base}/invoke`, { method: 'POST', body: JSON.stringify({ method: 'plane.page', params }) }).then(r => r.json());
  const catalog = async () => (await (await fetch(`${base}/manifest`)).json()).services[0].metadata.method_availability['plane.page'];
  try {
    await invoke({ action: 'retrieve', project_id: 'p', page_id: 'x', description_html: secret });
    fail = true; await invoke({ page_id: 'x', project_id: 'p', action: 'retrieve' });
    let d = await catalog(); assert.equal(d.observations.length, 1); assert.equal(d.observations[0].outcome, 'failed');
    assert.equal(d.observations[0].error.upstream_status, null); assert.ok(!JSON.stringify(d).includes(secret));
    fail = false; await invoke({ action: 'retrieve', project_id: 'p', page_id: 'x' });
    assert.equal((await catalog()).observations[0].outcome, 'succeeded');
    for (let i = 0; i < 22; i++) await invoke({ action: 'list', project_id: String(i) });
    assert.equal((await catalog()).observations.length, 20);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('bridge preserves UTF-8 characters split across request chunks', async () => {
  const { request } = await import('node:http');
  let received;
  const client = { async callTool(input) { received = input.arguments.name; return { content: [] }; } };
  const server = createBridge(client, [{ name: 'project', inputSchema: { type: 'object' } }], { health: async () => ({ online: true }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const payload = Buffer.from(JSON.stringify({ method: 'plane.project', params: { action: 'create', name: '商务' } }));
    const split = payload.indexOf(Buffer.from('商')) + 1;
    await new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: server.address().port, path: '/invoke', method: 'POST' }, res => {
        res.resume(); res.on('end', resolve); res.on('error', reject);
      });
      req.on('error', reject); req.write(payload.subarray(0, split));
      setTimeout(() => req.end(payload.subarray(split)), 20);
    });
    assert.equal(received, '商务');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

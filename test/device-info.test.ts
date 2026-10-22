import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { DEVICE_INFO_PROTOCOL, localInterfaces, type DeviceInfo } from '../src/device-info.js';
import { createAgent } from '../src/server.js';
import { ServiceRegistry } from '../src/registry.js';
import { callDreammateTool } from '../src/mcp.js';

test('local interface collection only keeps non-loopback addresses and their basic fields', () => {
  const entry = { family: 'IPv4' as const, address: '192.168.1.10', netmask: '255.255.255.0', mac: '02:00:00:00:00:01', internal: false, cidr: '192.168.1.10/24' };
  assert.deepEqual(localInterfaces({ en0: [entry], lo0: [{ ...entry, internal: true }] }), [
    { name: 'en0', mac: entry.mac, addresses: [{ family: 'IPv4', address: entry.address, netmask: entry.netmask }] },
  ]);
});

test('gateway exposes basic device data and has no peer-probing endpoints or advertisements', async t => {
  const { server, mcpSources } = createAgent({ registry: new ServiceRegistry({ storagePath: false }), mcpSources: { storagePath: false } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await mcpSources.stop(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const info = await (await fetch(`${base}/device`)).json() as DeviceInfo;
  assert.equal(info.protocol, DEVICE_INFO_PROTOCOL); assert.ok(info.node_id); assert.ok(info.system.name); assert.ok(info.system.arch);
  assert.ok(info.model === null || typeof info.model === 'string');
  assert.deepEqual(Object.keys(info).sort(), ['protocol', 'node_id', 'collected_at', 'hostname', 'model', 'system', 'interfaces'].sort());
  const manifest = await (await fetch(`${base}/manifest`)).json() as { node_id: string; metadata: { device: DeviceInfo; network_observations?: string } };
  assert.equal(manifest.metadata.device.node_id, manifest.node_id);
  assert.equal(manifest.metadata.network_observations, undefined);
  const health = await (await fetch(`${base}/health`)).json() as { network_observations?: string };
  assert.equal(health.network_observations, undefined);
  for (const route of ['/network/probe?challenge=fixture-challenge', '/network/observations']) assert.equal((await fetch(base + route)).status, 404);
});

test('MCP adds only device information to the existing health checks', async t => {
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const pathname = new URL(String(input)).pathname; requests.push(pathname);
    const body = pathname === '/nodes' ? { node: 'a', nodes: [{ node_id: 'b', name: 'b', type: 'linux', online: true, is_self: false, ipv4: '100.64.0.2' }] }
      : pathname === '/health' ? { service: 'node-agent', status: 'ok', node_id: 'b', device_info: DEVICE_INFO_PROTOCOL }
      : pathname === '/device' ? { protocol: DEVICE_INFO_PROTOCOL, node_id: 'b', collected_at: new Date().toISOString(), hostname: 'host-b', model: 'Fixture model', system: { name: 'Linux', version: '6.8', arch: 'arm64' }, interfaces: [] }
      : undefined;
    assert.ok(body, `Unexpected request: ${pathname}`);
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  });
  const result = await callDreammateTool('dreammate_list_nodes', {}, { agentUrl: 'http://127.0.0.1:36908' });
  const content = result.content[0]; assert.equal(content.type, 'text');
  const node = JSON.parse(content.text).nodes[0];
  assert.equal(node.device.model, 'Fixture model');
  assert.equal(node.network_observations, undefined);
  assert.deepEqual(requests, ['/nodes', '/health', '/device']);
});

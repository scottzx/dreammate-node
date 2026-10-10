/** Offline provider lifecycle check against an isolated in-memory gateway.
 * Requires prepared Qwen weights and a prior sanitized tool directory.
 * Never changes the running gateway or invokes business methods.
 * npm run build && node scripts/test-embedding-discovery.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgent, ServiceRegistry, callDreammateTool } from '../dist/src/index.js';
import { launchProvider, parseOptions, requestJson } from './local-embeddings/serve.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, '.local/tool-search');
const report = { created_at: new Date().toISOString(),
  evidence: 'One real offline Qwen worker and an isolated gateway on this machine. The failed primary is simulated. No business methods invoked; existing gateway untouched.',
  runs: [] };
const registry = new ServiceRegistry({ storagePath: false });
const { server } = createAgent({ registry, rediscover: false });
let worker;

async function unusedPort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function search(name, agentUrl, args = {}, extra = {}) {
  const started = performance.now();
  const result = await callDreammateTool('dreammate_search_tools', {
    query: '打开知识图谱中指定的实体及其关联关系', node: 'localhost', ...args,
  }, { agentUrl, ...extra }); // No embedding URL or model override: exercise discovery.
  const data = result.structuredContent ?? JSON.parse(result.content[0].text);
  assert.equal(result.isError, undefined);
  assert.ok(data.returned <= 15);
  assert.equal(data.limit, 15);
  assert.equal(data.max_chars, 12000);
  assert.ok(JSON.stringify(data, null, 2).length <= 12000);
  assert.ok(data.results.every(card => !('parameters' in card) && !('gateway_url' in card)));
  const run = { name, elapsed_ms: Math.round(performance.now() - started),
    scope: data.scope, partial: data.partial, returned: data.returned, total_candidates: data.total_candidates,
    search: { ...data.search,
      ...(data.search.provider ? { provider: { ...data.search.provider, node: 'local-test' } } : {}),
      ...(data.search.provider_attempts ? { provider_attempts: data.search.provider_attempts.map(attempt => ({ ...attempt, node: 'local-test' })) } : {}) },
    top3: data.results.slice(0, 3).map(({ service_id, method }) => ({ service_id, method })) };
  report.runs.push(run);
  console.log(JSON.stringify(run));
  return data;
}

try {
  if (process.env.DREAMMATE_EMBEDDING_URL !== undefined || process.env.DREAMMATE_EMBEDDING_MODEL !== undefined) {
    throw new Error('Unset embedding URL/model overrides to test automatic discovery');
  }
  const services = JSON.parse(await fs.readFile(path.join(artifacts, 'current-services-live.json'), 'utf8'));
  for (const service of services) {
    registry.register({ id: service.id, name: service.name, kind: service.kind,
      methods: service.methods, capabilities: service.capabilities, metadata: { enabled: service.metadata?.enabled !== false } });
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const agentUrl = `http://127.0.0.1:${server.address().port}`;
  const before = await search('no_ready_provider', agentUrl);
  assert.equal(before.search.semantic_status, 'no_provider');
  assert.equal(before.search.mode, 'lexical');

  const port = await unusedPort();
  worker = launchProvider(parseOptions(['--agent', agentUrl, '--model', 'qwen3', '--port', String(port)]));
  await worker.ready;
  const id = `dreammate-embedding-${port}`;
  const registered = registry.get(id);
  assert.ok(registered, 'wrapper must register itself');
  assert.equal(registered.methods, undefined, 'model service must not become a business tool');
  report.advertisement = registered.metadata.embedding_provider;
  const ready = await search('discovered_real_qwen_cold_catalog', agentUrl, {}, { embeddingTimeoutMs: 60000 });
  assert.equal(ready.search.semantic_status, 'ok');
  assert.equal(ready.search.provider.source, 'discovered');
  assert.equal(ready.search.provider.service_id, id);
  assert.equal(ready.search.model, `qwen3@${report.advertisement.revision}`);
  assert.ok(ready.results.slice(0, 5).some(card => card.method === 'memory.open_nodes'), 'expected memory tool in top 5');

  const warm = await search('discovered_real_qwen_default_budget', agentUrl);
  assert.equal(warm.search.semantic_status, 'ok');
  // An imported directory exercises the default cross-node entry without probing
  // unrelated live peers. This remains a one-machine lifecycle test.
  const directory = { format: 'dreammate.nodes', version: 1, exported_at: new Date().toISOString(),
    nodes: [{ node_id: 'test', name: 'local-test', type: 'macos', agent_url: agentUrl }] };
  const global = await search('default_all_imported_directory', agentUrl, { node: undefined }, { nodeDirectory: directory });
  assert.equal(global.scope, 'all');
  assert.equal(global.search.semantic_status, 'ok');
  const filtered = await search('business_filter_preserves_provider', agentUrl, { service_id: 'memory' });
  assert.equal(filtered.search.semantic_status, 'ok');
  assert.ok(filtered.results.every(card => card.service_id === 'memory'));

  const deadPort = await unusedPort();
  registry.register({ id: 'simulated-failed-primary', port: deadPort, execution: 'http', reachability: 'localhost',
    metadata: { embedding_provider: { ...report.advertisement, priority: 100 } } });
  const failover = await search('failed_primary_real_backup', agentUrl);
  assert.equal(failover.search.semantic_status, 'ok');
  assert.equal(failover.search.provider_candidates, 2);
  assert.deepEqual(failover.search.provider_attempts.map(attempt => attempt.status), ['failed', 'ok']);
  assert.equal(failover.search.provider.service_id, id);
  registry.deregister('simulated-failed-primary');

  const proxyResponse = await requestJson(`${agentUrl}/services/${id}/embed`, {
    method: 'POST', body: { texts: ['tool discovery'], input_type: 'query' },
  });
  assert.equal(proxyResponse.model, ready.search.model);
  assert.equal(proxyResponse.embeddings[0].length, report.advertisement.dimensions);
  report.proxy_dimensions = proxyResponse.embeddings[0].length;

  await worker.stop();
  assert.equal(registry.get(id), undefined, 'wrapper must unregister on shutdown');
  const after = await search('provider_stopped', agentUrl);
  assert.equal(after.search.semantic_status, 'no_provider');
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await worker?.stop();
  registry.stop();
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(path.join(artifacts, 'provider-discovery-live.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ stage: 'provider_discovery_verification', passed: report.passed, runs: report.runs.length,
    ...(report.error ? { error: report.error } : {}) }));
}

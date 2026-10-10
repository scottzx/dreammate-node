/** Read-only live cross-node discovery and bounded Qwen tool-search checks.
 * node scripts/test-network-tool-search.mjs [--collect-only]
 * Uses existing gateways and adapter; never starts, stops or invokes services.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_PORTS } from '@1agents/dreammate-network';
import { callDreammateTool } from '../dist/src/mcp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = path.join(root, '.local/tool-search');
const { values } = parseArgs({ options: { 'collect-only': { type: 'boolean' } } });
const agentUrl = 'http://127.0.0.1:36908';
const embeddingUrl = 'http://127.0.0.1:8766';
const deadlineMs = 3000;
const timestamp = () => new Date().toISOString();
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 12);
const pseudonyms = new Map();
const labelFor = value => pseudonyms.get(value) ?? `node-${hash(String(value))}`;

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(deadlineMs), redirect: 'error' });
  if (!response.ok) {
    await response.body?.cancel();
    const error = new Error('HTTP error');
    error.httpStatus = response.status;
    throw error;
  }
  return response.json();
}

const methodCount = service => new Set([...Object.keys(service.methods ?? {}), ...(service.capabilities ?? [])]).size;
function sanitizeService(service, node) {
  const methods = Object.fromEntries(Object.entries(service.methods ?? {}).map(([method, definition]) => {
    const properties = definition?.parameters?.properties;
    return [method, {
      ...(typeof definition?.description === 'string' ? { description: definition.description } : {}),
      parameters: { type: 'object', properties: Object.fromEntries(Object.keys(properties && typeof properties === 'object'
        && !Array.isArray(properties) ? properties : {}).map(name => [name, {}])) },
    }];
  }));
  return { id: service.id, node,
    ...(typeof service.name === 'string' ? { name: service.name } : {}),
    ...(typeof service.kind === 'string' ? { kind: service.kind } : {}),
    methods, capabilities: (service.capabilities ?? []).filter(value => typeof value === 'string'),
    metadata: { enabled: service.metadata?.enabled !== false },
  };
}

await fs.mkdir(home, { recursive: true });
const health = await getJson(`${agentUrl}/health`);
if (health.service !== 'node-agent' || health.status !== 'ok') throw new Error('Local node-agent is not healthy');
const topology = await getJson(`${agentUrl}/nodes`);
if (!Array.isArray(topology.nodes) || !topology.nodes.length) throw new Error('Invalid or empty live node topology');

// Mirror src/mcp.ts nodeBaseUrl: self uses the configured gateway; peers use
// ipv4, then dnsName/name with the protocol's advertised default agent port.
const targets = topology.nodes.filter(node => node.online || node.is_self).map(node => {
  const token = `node-${hash(String(node.node_id ?? node.name))}`;
  for (const alias of [node.node_id, node.name, node.dnsName, node.ipv4]) {
    if (typeof alias === 'string') pseudonyms.set(alias, token);
  }
  return { node, token, url: node.is_self ? agentUrl
    : `http://${node.ipv4 || node.dnsName || node.name}:${DEFAULT_PORTS['node-agent']}` };
});
const started = performance.now();
const discovered = await Promise.all(targets.map(async target => {
  const begin = performance.now();
  const scan = { node: target.token, type: target.node.type, is_self: target.node.is_self === true,
    network_online: target.node.network_online ?? target.node.online ?? null, status: 'ok',
    service_count: 0, method_count: 0, elapsed_ms: 0 };
  let services = [];
  try {
    const catalog = await getJson(`${target.url}/services`);
    if (!Array.isArray(catalog.services) || catalog.services.some(service => !service || typeof service.id !== 'string')) {
      scan.status = 'invalid_response';
    } else {
      if (typeof catalog.node === 'string') pseudonyms.set(catalog.node, target.token);
      services = catalog.services.map(service => sanitizeService(service, target.token));
      scan.service_count = services.length;
      scan.method_count = services.reduce((sum, service) => sum + methodCount(service), 0);
    }
  } catch (error) {
    scan.status = error.httpStatus ? 'http_error' : ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout'
      : error instanceof SyntaxError ? 'invalid_response' : 'unreachable';
    if (error.httpStatus) scan.http_status = error.httpStatus;
    if (typeof error.cause?.code === 'string') scan.error_code = error.cause.code;
  }
  scan.elapsed_ms = Math.round(performance.now() - begin);
  return { scan, services };
}));
const services = discovered.flatMap(result => result.services);
const scans = discovered.map(result => result.scan);
const discovery = { created_at: timestamp(), evidence: 'Read-only live network registry; no business methods invoked. Node identities and addresses omitted.',
  source_health: { service: health.service, status: health.status }, scope: 'online_or_self',
  topology_count: topology.nodes.length, eligible_count: targets.length,
  skipped_offline_count: topology.nodes.length - targets.length,
  reachable_count: scans.filter(scan => scan.status === 'ok').length,
  failed_count: scans.filter(scan => scan.status !== 'ok').length,
  service_count: services.length, method_count: services.reduce((sum, service) => sum + methodCount(service), 0),
  elapsed_ms: Math.round(performance.now() - started), deadline_ms: deadlineMs, scans };
await fs.writeFile(path.join(home, 'network-discovery.json'), JSON.stringify(discovery, null, 2) + '\n', { mode: 0o600 });
await fs.writeFile(path.join(home, 'network-services-live.json'), JSON.stringify(services, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ stage: 'network_discovery', ...Object.fromEntries(Object.entries(discovery).filter(([key]) => !['scans', 'evidence'].includes(key))) }));
if (!services.length) throw new Error('No reachable service directory; cannot verify network tool search');
if (values['collect-only']) process.exit(0);

const manifest = JSON.parse(await fs.readFile(path.join(home, 'manifest.json'), 'utf8'));
const revision = manifest.models?.qwen3?.revision;
if (typeof revision !== 'string' || !revision) throw new Error('Qwen model is not prepared');
const expectedModel = `qwen3@${revision}`;
const options = { agentUrl, embeddingUrl, embeddingModel: 'qwen3', embeddingTimeoutMs: 60000 };
const cases = [
  { name: 'files_git_memory', query: '读取项目里的文本文件，查看 Git 未提交的改动，并检索之前保存的记忆' },
  { name: 'devices_time_voice', query: '查看设备和系统信息，查询当前时间，并了解离线语音转写状态' },
  { name: 'voice_files_memory', query: '把会议录音转成文字，保存到文件，并查询相关的历史记忆与项目 Git 状态' },
];
const decode = result => result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
const counts = (rows, key) => rows.reduce((totals, row) => {
  const value = key === 'node' ? labelFor(row[key]) : row[key];
  totals[value] = (totals[value] ?? 0) + 1;
  return totals;
}, {});
const runs = [];
const checks = [];
async function check(name, args, expectedScope) {
  const began = performance.now();
  // Deliberately omit node and limit for default-scope/default-budget checks.
  const result = await callDreammateTool('dreammate_search_tools', args, options);
  const body = decode(result);
  const rows = body.results ?? [];
  const chars = JSON.stringify(body, null, 2).length;
  const run = { name, query: args.query, scope: body.scope ?? null, partial: body.partial ?? null,
    returned: body.returned ?? rows.length, limit: body.limit ?? null, max_chars: body.max_chars ?? null,
    response_chars: chars, total_candidates: body.total_candidates ?? null, total_matched: body.total_matched ?? null,
    by_service: counts(rows, 'service_id'), by_node: counts(rows, 'node'),
    top3: rows.slice(0, 3).map(row => ({ node: labelFor(row.node), service_id: row.service_id, method: row.method })),
    actual_model: body.search?.model ?? null, semantic_status: body.search?.semantic_status ?? null,
    elapsed_ms: Math.round(performance.now() - began), error: Boolean(result.isError || body.error),
    diversity: body.search?.diversity ?? null };
  runs.push(run);
  checks.push({ name, passed: !run.error && run.scope === expectedScope && run.limit === 15 && run.max_chars === 12000
    && run.returned <= 15 && chars <= run.max_chars && run.actual_model === expectedModel && run.semantic_status === 'ok'
    && (!args.service_id || rows.every(row => row.service_id === args.service_id)) });
  await fs.writeFile(path.join(home, 'network-search-live.json'), JSON.stringify({ created_at: timestamp(),
    evidence: 'Manually authored cross-domain tasks against live registry; retrieval only, no inspect or invoke.',
    expected_model: expectedModel, discovery_summary: { reachable_count: discovery.reachable_count, failed_count: discovery.failed_count,
      service_count: discovery.service_count, method_count: discovery.method_count }, runs, checks }, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ stage: 'network_search', ...run }));
}
for (const item of cases) await check(item.name, { query: item.query }, 'all');
await check('explicit_localhost', { query: cases[0].query, node: 'localhost' }, 'localhost');
const serviceId = services.some(service => service.id === 'git') ? 'git' : services[0].id;
await check('explicit_service_id', { query: cases[0].query, service_id: serviceId }, 'all');
console.log(JSON.stringify({ stage: 'network_verification', passed: checks.filter(check => check.passed).length, total: checks.length }));
if (checks.some(check => !check.passed)) process.exitCode = 1;

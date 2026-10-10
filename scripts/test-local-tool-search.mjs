/** Read-only live routing checks and identical-corpus local model comparison.
 * node scripts/test-local-tool-search.mjs --phase preflight|models
 * Models phase starts/stops only its own loopback adapter process.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { callDreammateTool } from '../dist/src/mcp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = path.join(root, '.local/tool-search');
const { values } = parseArgs({ options: { phase: { type: 'string', default: 'preflight' }, models: { type: 'string', default: 'qwen3' }, 'cold-only': { type: 'boolean' } } });
if (!['preflight', 'models'].includes(values.phase)) throw new Error('--phase must be preflight or models');
if (values['cold-only'] && values.phase !== 'models') throw new Error('--cold-only requires --phase models');
const selectedModels = [...new Set(values.models.split(','))];
if (!selectedModels.length || selectedModels.some(model => model !== 'qwen3')) throw new Error('--models must contain qwen3');
const agentUrl = 'http://127.0.0.1:36908';
const embeddingUrl = 'http://127.0.0.1:8766';
const cases = [
  { query: '查询上海现在的时间', service_id: 'time', method: 'time.get_current_time', params: { timezone: 'Asia/Shanghai' }, kind: 'time' },
  { query: '查看终端平台、默认工作目录与执行器版本', service_id: 'bash', method: 'bash.info', params: {}, kind: 'platform' },
  { query: '查看离线语音引擎当前状态和硬件加速情况', service_id: 'transcribe', method: 'asr.info', params: {}, kind: 'engine' },
  { query: '这个文件服务允许访问哪些目录', service_id: 'filesystem', method: 'filesystem.list_allowed_directories', params: {}, kind: 'directories' },
  { query: '读取文件服务项目 package.json 的前三行', service_id: 'filesystem', method: 'filesystem.read_text_file', params: { path: '', head: 3 }, kind: 'public_file' },
  { query: '查看文件服务项目 Git 工作区有哪些未提交改动', service_id: 'git', method: 'git.git_status', params: { repo_path: '' }, kind: 'git' },
];
const decode = result => {
  if (result.structuredContent) return result.structuredContent;
  const texts = result.content?.filter(c => c.type === 'text').map(c => c.text) ?? [];
  if (texts.length === 1) { try { return JSON.parse(texts[0]); } catch { /* Plain text is valid business output. */ } }
  return { text: texts.join('\n') };
};
const hasError = (result, body) => Boolean(result.isError || body?.error || body?.ok === false || body?.success === false
  || (typeof body?.exit_code === 'number' && body.exit_code !== 0));
const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object'
  ? Object.values(value).flatMap(strings) : [];
const objects = value => {
  if (typeof value === 'string' && /^[\s]*[\[{]/.test(value)) {
    try { return objects(JSON.parse(value)); } catch { return []; }
  }
  return value && typeof value === 'object' ? [value, ...Object.values(value).flatMap(objects)] : [];
};
const json = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
};
const run = (command, args, logfile) => new Promise(async (resolve, reject) => {
  const output = await fs.open(logfile, 'w');
  const child = spawn(command, args, { cwd: root, stdio: ['ignore', output.fd, output.fd] });
  child.on('error', async error => { await output.close(); reject(error); });
  child.on('exit', async code => {
    await output.close();
    if (code !== 0) reject(new Error(`${command} exited ${code}; see ${logfile}`));
    else resolve();
  });
});
const checkFreshCli = model => new Promise((resolve, reject) => {
  const started = performance.now();
  const env = { ...process.env, DREAMMATE_EMBEDDING_URL: embeddingUrl, DREAMMATE_EMBEDDING_MODEL: model };
  delete env.DREAMMATE_EMBEDDING_TIMEOUT_MS;
  const child = spawn(process.execPath, ['dist/bin/dreammate-node.js', 'cli', 'search', '--query', cases[0].query,
    '--agent', agentUrl, '--node', 'localhost', '--limit', '5'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', reject);
  child.on('exit', code => {
    try {
      if (code !== 0) throw new Error(`Fresh CLI failed: ${stderr.slice(0, 240)}`);
      const response = decode(JSON.parse(stdout));
      resolve({ model, elapsed_ms: Math.round(performance.now() - started), search: response.search,
        selected: response.results?.[0] ? `${response.results[0].service_id}/${response.results[0].method}` : null,
        returned: response.returned, response_chars: JSON.stringify(response).length });
    } catch (error) { reject(error); }
  });
});
await fs.mkdir(home, { recursive: true });
const health = await json(`${agentUrl}/health`);
if (health.service !== 'node-agent' || health.status !== 'ok') throw new Error('Expected the local DreamMate node-agent');
const catalog = await json(`${agentUrl}/services`);
if (!Array.isArray(catalog.services)) throw new Error('Invalid live service directory');
await fs.writeFile(path.join(home, 'current-services-live.json'), JSON.stringify(catalog.services.map(s => ({
  id: s.id, name: s.name, kind: s.kind, node: catalog.node ?? 'local', methods: s.methods,
  metadata: { enabled: s.metadata?.enabled !== false }, registeredAt: s.registeredAt,
  liveness: s.liveness, failures: s.failures,
})), null, 2), { mode: 0o600 });
console.log(JSON.stringify({ stage: 'live_directory', service_count: catalog.services.length,
  method_count: catalog.services.reduce((n, s) => n + Object.keys(s.methods ?? {}).length, 0),
  services: catalog.services.map(s => ({ id: s.id, health: s.liveness, execution: s.execution })) }));

let adapter;
let adapterLog;
let modelTags = {};
try {
  if (values.phase === 'models') {
    const manifest = JSON.parse(await fs.readFile(path.join(home, 'manifest.json'), 'utf8'));
    modelTags = Object.fromEntries(selectedModels.map(alias => {
      if (!manifest.models?.[alias]?.revision) throw new Error(`Missing prepared model: ${alias}`);
      return [alias, `${alias}@${manifest.models[alias].revision}`];
    }));
    const python = path.join(home, 'venv/bin/python');
    if (!values['cold-only']) await run(python, ['scripts/local-embeddings/server.py', '--self-test'], path.join(home, 'self-test.log'));
    let existing;
    try { existing = await json(`${embeddingUrl}/health`); } catch { /* Start below. */ }
    if (existing && existing.outbound_network !== 'blocked') throw new Error('Port 8766 is occupied by another service');
    if (existing && values['cold-only']) throw new Error('Cold document-index test requires its own fresh adapter');
    if (!existing) {
      adapterLog = await fs.open(path.join(home, 'adapter.log'), 'w');
      adapter = spawn(python, ['scripts/local-embeddings/server.py', '--warmup', selectedModels[0]],
        { cwd: root, stdio: ['ignore', adapterLog.fd, adapterLog.fd] });
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        if (adapter.exitCode !== null) throw new Error('Adapter exited; see adapter.log');
        try { existing = await json(`${embeddingUrl}/health`); break; } catch { await new Promise(r => setTimeout(r, 500)); }
      }
      if (!existing) throw new Error('Adapter readiness timed out; see adapter.log');
    }
    if (!values['cold-only']) await run(process.execPath, ['--import', 'tsx', 'scripts/benchmark-tool-search.ts',
      '--services', '.local/tool-search/current-services-live.json', '--out', '.local/tool-search/gateway-benchmark-live.json',
      '--embedding-url', embeddingUrl, '--models', selectedModels.join(','), '--manifest', '.local/tool-search/manifest.json'], path.join(home, 'benchmark.log'));
  }
  const configurations = values.phase === 'models' ? selectedModels : ['lexical'];
  const runs = [];
  for (const model of configurations) {
    if (values['cold-only']) {
      // Warm only the selected model, leaving its document vector cache empty.
      const response = await fetch(`${embeddingUrl}/embed`, { method: 'POST', signal: AbortSignal.timeout(60000),
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, texts: ['Find a tool'], input_type: 'query' }) });
      if (!response.ok || (await response.json()).model !== modelTags[model]) throw new Error(`Cold test warmup failed: ${model}`);
    }
    const declaredRoots = catalog.services.find(s => s.id === 'filesystem')?.metadata?.allowed_directories;
    let allowedDirectories = (Array.isArray(declaredRoots) ? declaredRoots : []).filter(directory => typeof directory === 'string' && path.isAbsolute(directory));
    const checks = [];
    for (const c of values['cold-only'] ? [] : cases) {
      const options = { agentUrl, embeddingUrl: model === 'lexical' ? '' : embeddingUrl,
        embeddingModel: model === 'lexical' ? undefined : model, embeddingTimeoutMs: 60000 };
      const started = performance.now();
      const search = await callDreammateTool('dreammate_search_tools', { query: c.query, node: 'localhost', limit: 5 }, options);
      const found = decode(search);
      if (model !== 'lexical' && found.search?.semantic_status !== 'ok') throw new Error(`${model} silently fell back: ${JSON.stringify(found.search)}`);
      if (model !== 'lexical' && found.search?.model !== modelTags[model]) throw new Error(`Expected ${modelTags[model]}, received ${found.search?.model}`);
      const results = found.results ?? [];
      const expectedRank = results.findIndex(r => r.service_id === c.service_id && r.method === c.method);
      const row = { query: c.query, expected: `${c.service_id}/${c.method}`, expected_rank: expectedRank < 0 ? null : expectedRank + 1,
        actual_model: found.search?.model ?? null,
        selected: results[0] ? `${results[0].service_id}/${results[0].method}` : null,
        search_chars: JSON.stringify(found).length, search_ms: Math.round(performance.now() - started),
        inspect_ok: false, invoked: false, invocation_ok: false, output_verified: false };
      // Preflight checks backend readiness separately from lexical recall. The
      // model test invokes only when the top-ranked result is the expected safe method.
      if (model !== 'lexical' && expectedRank !== 0) {
        row.skip_reason = 'Top result did not match the read-only labelled tool';
        checks.push(row); continue;
      }
      const inspect = await callDreammateTool('dreammate_inspect', { service_id: c.service_id, method: c.method, node: 'localhost' }, options);
      const contract = decode(inspect);
      row.inspect_ok = !inspect.isError && contract.method === c.method && contract.defined === true;
      if (!row.inspect_ok) { row.skip_reason = 'Missing exact method contract'; checks.push(row); continue; }
      let params = c.params;
      let expectedPackage;
      if (c.kind === 'public_file') {
        let packageFile;
        for (const directory of allowedDirectories) {
          const candidate = path.join(directory, 'package.json');
          if (await fs.stat(candidate).then(s => s.isFile(), () => false)) { packageFile = candidate; break; }
        }
        if (!packageFile) {
          row.skip_reason = 'No public package.json in the explicitly allowed roots'; checks.push(row); continue;
        }
        params = { ...params, path: packageFile };
        expectedPackage = JSON.parse(await fs.readFile(packageFile, 'utf8')).name;
      }
      if (c.kind === 'git') {
        const roots = catalog.services.find(s => s.id === 'git')?.metadata?.allowed_directories;
        let repository;
        for (const directory of Array.isArray(roots) ? roots : []) {
          if (typeof directory === 'string' && await fs.stat(path.join(directory, '.git')).then(() => true, () => false)) {
            repository = directory; break;
          }
        }
        if (!repository) { row.skip_reason = 'No repository in the declared allowed Git roots'; checks.push(row); continue; }
        params = { repo_path: repository };
      }
      const invokedAt = performance.now();
      const invocation = await callDreammateTool('dreammate_invoke', { service_id: c.service_id, method: c.method, params, node: 'localhost' }, options);
      const body = decode(invocation);
      const text = JSON.stringify(body);
      const plain = strings(body).join('\n');
      const parsedObjects = objects(body);
      row.invoked = true;
      row.invoke_ms = Math.round(performance.now() - invokedAt);
      row.invocation_ok = !hasError(invocation, body);
      if (!row.invocation_ok) row.error = text.slice(0, 240);
      else if (c.kind === 'time') row.output_verified = /\d{4}-\d\d-\d\d/.test(text) && /Asia\/Shanghai|\+08:00/.test(text);
      else if (c.kind === 'platform') row.output_verified = parsedObjects.some(p => typeof p.platform === 'string'
        && /darwin|linux|win32|macos|windows/i.test(p.platform) && typeof p.version === 'string' && /^\d+\./.test(p.version));
      else if (c.kind === 'engine') row.output_verified = parsedObjects.some(p => p.service === 'transcribe'
        && typeof p.version === 'string' && typeof p.status === 'string' && p.status !== 'error' && Object.hasOwn(p, 'model'));
      else if (c.kind === 'directories') {
        const array = parsedObjects.flatMap(p => Array.isArray(p.directories) ? p.directories : Array.isArray(p.allowed_directories) ? p.allowed_directories : []);
        const listing = strings(body).find(s => /^Allowed directories:\s*\n/i.test(s));
        allowedDirectories = [...array, ...(listing?.split('\n').slice(1) ?? [])].filter(s => typeof s === 'string')
          .map(line => line.trim()).filter(line => line.startsWith('/') && !line.includes('\0'));
        row.output_verified = allowedDirectories.length > 0;
      }
      else if (c.kind === 'public_file') row.output_verified = typeof expectedPackage === 'string'
        && plain.includes(`"name": "${expectedPackage}"`);
      else if (c.kind === 'git') row.output_verified = /branch|working tree|modified|untracked|分支|改动/i.test(text);
      checks.push(row);
      console.log(JSON.stringify({ stage: 'live_call', model, ...row }));
    }
    const freshCli = [];
    if (model !== 'lexical') for (let attempt = 0; attempt < 3; attempt++) {
      const check = await checkFreshCli(model);
      if (check.search?.semantic_status === 'ok' && check.search.model !== modelTags[model]) throw new Error(`Fresh CLI used wrong model: ${check.search.model}`);
      freshCli.push(check);
    }
    const runResult = { model, actual_model: modelTags[model] ?? null, fresh_cli_default_5s: freshCli, top1_correct: checks.filter(c => c.expected_rank === 1).length,
      recall_at_5: checks.length ? checks.filter(c => c.expected_rank !== null).length / checks.length : null,
      attempted_calls: checks.filter(c => c.invoked).length,
      verified_calls: checks.filter(c => c.invocation_ok && c.output_verified).length, checks };
    runs.push(runResult);
    console.log(JSON.stringify({ stage: 'live_summary', model, ...Object.fromEntries(Object.entries(runResult).filter(([key]) => key !== 'checks')) }));
    await fs.writeFile(path.join(home, values['cold-only'] ? 'default-cold-cli.json' : `routing-${values.phase}.json`), JSON.stringify({
      created_at: new Date().toISOString(), evidence: values['cold-only']
        ? 'Fresh offline adapter; selected model preloaded, its document cache initially empty. Three new CLI processes per model, true default 5000ms semantic budget. No business methods invoked.'
        : 'Real local gateway. Six manually labelled read-only tasks; no business writes. Preflight invokes labelled targets independently of lexical ranking; model conditions invoke only correct top-1 selections.',
      runs }, null, 2) + '\n');
  }
} finally {
  if (adapter) {
    adapter.kill('SIGTERM');
    await new Promise(resolve => adapter.exitCode !== null ? resolve() : adapter.once('exit', resolve));
  }
  await adapterLog?.close();
}

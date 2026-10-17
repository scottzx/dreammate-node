#!/usr/bin/env node
/** Lightweight loopback provider. Python/model memory exists only while needed. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { defaultConfigPath, readPriorityConfig, validatePriorityConfig } from './priority-config.mjs';
import { localAgentUrl, REPO_ROOT } from './serve.mjs';

const WORKER_PATH = fileURLToPath(new URL('./worker.py', import.meta.url));
const PROTOCOL = 'dreammate.embedding.v1';
const SHARING_PROTOCOL = 'dreammate.service-sharing.v1';
const BODY_LIMIT = 262144, RESPONSE_LIMIT = 16 * 1024 * 1024;

function integer(value, label, min, max) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return Number(value);
}

export function parseOptions(argv, cwd = process.cwd()) {
  const { values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
    model: { type: 'string', default: 'qwen3' }, port: { type: 'string', default: '8766' },
    agent: { type: 'string', default: 'http://127.0.0.1:36908' }, priority: { type: 'string', default: '100' },
    sharing: { type: 'string', default: 'network' },
    config: { type: 'string' },
    python: { type: 'string' }, manifest: { type: 'string' }, device: { type: 'string', default: 'auto' },
    'batch-size': { type: 'string' }, 'max-length': { type: 'string', default: '512' },
    'idle-timeout-ms': { type: 'string', default: '300000' }, 'startup-timeout-ms': { type: 'string', default: '180000' },
    'inference-timeout-ms': { type: 'string', default: '120000' }, 'max-pending': { type: 'string', default: '32' },
    'no-register': { type: 'boolean', default: false },
  } });
  if (values.model !== 'qwen3') throw new Error('--model must be qwen3');
  if (!['local', 'network'].includes(values.sharing)) throw new Error('--sharing must be local or network');
  if (!['auto', 'cpu', 'mps', 'cuda'].includes(values.device)) throw new Error('--device must be auto, cpu, mps or cuda');
  if ((values.python !== undefined && !values.python.trim()) || (values.manifest !== undefined && !values.manifest.trim())) {
    throw new Error('--python and --manifest cannot be empty');
  }
  if (values.config !== undefined && !values.config.trim()) throw new Error('--config cannot be empty');
  const priority = Number(values.priority);
  if (!/^-?\d+$/.test(values.priority) || !Number.isSafeInteger(priority) || priority < -1000 || priority > 1000) {
    throw new Error('--priority must be an integer from -1000 to 1000');
  }
  return { model: values.model, port: integer(values.port, '--port', 1, 65535), agent: localAgentUrl(values.agent), priority, sharing: values.sharing,
    config: values.config === undefined ? defaultConfigPath() : path.resolve(cwd, values.config),
    python: values.python ?? path.join(REPO_ROOT, '.local/tool-search/venv/bin/python'),
    manifest: values.manifest ? path.resolve(cwd, values.manifest) : path.join(REPO_ROOT, '.local/tool-search/manifest.json'),
    device: values.device, maxLength: integer(values['max-length'], '--max-length', 64, 8192),
    idleTimeoutMs: integer(values['idle-timeout-ms'], '--idle-timeout-ms', 1, 86400000),
    startupTimeoutMs: integer(values['startup-timeout-ms'], '--startup-timeout-ms', 1, 600000),
    inferenceTimeoutMs: integer(values['inference-timeout-ms'], '--inference-timeout-ms', 1, 600000),
    maxPending: integer(values['max-pending'], '--max-pending', 1, 256), register: !values['no-register'],
    ...(values['batch-size'] === undefined ? {} : { batchSize: integer(values['batch-size'], '--batch-size', 1, 64) }) };
}

/** Fixed compatibility metadata is read without importing Torch or loading weights. */
export async function readModelMetadata(options) {
  const manifest = JSON.parse(await readFile(options.manifest, 'utf8'));
  const entry = manifest?.models?.[options.model];
  if (!entry || typeof entry.path !== 'string' || !entry.path.trim() || typeof entry.revision !== 'string'
    || !entry.revision.trim() || entry.revision !== entry.revision.trim() || entry.revision.length > 200) {
    throw new Error('Manifest must contain a prepared qwen3 path and exact revision');
  }
  const modelPath = path.resolve(REPO_ROOT, entry.path.replace(/^~(?=\/)/, process.env.HOME ?? '~'));
  const config = JSON.parse(await readFile(path.join(modelPath, 'config.json'), 'utf8'));
  const dimensions = integer(config.hidden_size, 'Model hidden_size', 1, 4096);
  return { protocol: PROTOCOL, model: options.model, revision: entry.revision, dimensions,
    encoding: `dreammate.tool-search.v1:fp32:max${options.maxLength}:dim${dimensions}`, ready: true };
}

/** Direct local registration transport, bounded and redirect-free; preserves ETag. */
export function requestAgent(url, { method = 'GET', body, headers = {}, timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const request = (new URL(url).protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method, agent: false, headers: { ...headers, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) },
    }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 1048576) response.destroy(new Error('Registration response too large'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) throw new Error(`HTTP ${response.statusCode}`);
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ body: text ? JSON.parse(text) : null, etag: response.headers.etag });
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('Registration request timed out')), timeoutMs);
    request.once('close', () => clearTimeout(timer));
    request.on('error', reject);
    request.end(data);
  });
}

function unavailable(message, status = 503) { return Object.assign(new Error(message), { status }); }
function sameProvider(actual, expected) {
  return actual && ['protocol', 'model', 'revision', 'dimensions', 'encoding', 'ready'].every(key => actual[key] === expected[key]);
}

export function validateEmbedRequest(value, model) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['model', 'texts', 'input_type'].includes(key))
    || (value.model !== undefined && value.model !== model) || !['query', 'document'].includes(value.input_type)
    || !Array.isArray(value.texts) || value.texts.length < 1 || value.texts.length > 64
    || value.texts.some(text => typeof text !== 'string' || !text.trim() || [...text].length > 8192)) {
    throw unavailable('Expected model qwen3, input_type query/document and 1..64 nonempty texts of at most 8192 characters', 400);
  }
  return { model, texts: value.texts, input_type: value.input_type };
}

function validateResult(result, request, provider) {
  if (!result || result.model !== `${provider.model}@${provider.revision}` || result.alias !== provider.model
    || result.revision !== provider.revision || result.dimensions !== provider.dimensions || result.encoding !== provider.encoding
    || !Array.isArray(result.embeddings) || result.embeddings.length !== request.texts.length) {
    throw unavailable('Encoder returned incompatible embedding metadata');
  }
  for (const row of result.embeddings) {
    if (!Array.isArray(row) || row.length !== provider.dimensions || row.some(value => typeof value !== 'number' || !Number.isFinite(value))
      || Math.abs(row.reduce((sum, value) => sum + value * value, 0) - 1) > 0.01) {
      throw unavailable('Encoder returned an invalid embedding');
    }
  }
  return result;
}

/** Injectable child/registration transport enables tests without model weights. */
export async function createOnDemandProvider(options = parseOptions([]), deps = {}) {
  options = { ...parseOptions([]), ...options };
  options.agent = localAgentUrl(options.agent);
  integer(options.port, 'port', 0, 65535);
  integer(options.idleTimeoutMs, 'idleTimeoutMs', 1, 86400000);
  integer(options.startupTimeoutMs, 'startupTimeoutMs', 1, 600000);
  integer(options.inferenceTimeoutMs, 'inferenceTimeoutMs', 1, 600000);
  integer(options.maxPending, 'maxPending', 1, 256);
  integer(options.maxLength, 'maxLength', 64, 8192);
  if (options.model !== 'qwen3' || !['auto', 'cpu', 'mps', 'cuda'].includes(options.device)
    || !['local', 'network'].includes(options.sharing)
    || !Number.isSafeInteger(options.priority) || options.priority < -1000 || options.priority > 1000
    || typeof options.python !== 'string' || !options.python.trim()
    || typeof options.config !== 'string' || !options.config.trim()
    || (options.batchSize !== undefined && (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 64))) {
    throw new Error('Invalid on-demand provider options');
  }
  options.config = path.resolve(options.config);
  const loadConfig = deps.readPriorityConfig ?? readPriorityConfig;
  const initialValue = await loadConfig(options.config);
  const initialConfig = initialValue === undefined ? undefined : validatePriorityConfig(initialValue);
  let priority = initialConfig?.priority ?? options.priority;
  let sharing = initialConfig?.sharing ?? options.sharing;
  let sharingSource = initialConfig?.sharing === undefined ? 'startup' : 'file';
  let configSource = initialConfig === undefined ? 'startup' : 'file', lastConfigError;
  const provider = await (deps.readModelMetadata ?? readModelMetadata)(options);
  if (!sameProvider(provider, { ...provider, protocol: PROTOCOL, model: options.model, ready: true })
    || !Number.isSafeInteger(provider.dimensions) || provider.dimensions < 1 || provider.dimensions > 4096) throw new Error('Invalid model metadata');
  const spawnChild = deps.spawn ?? spawn, send = deps.requestAgent ?? requestAgent;
  const log = deps.log ?? (message => process.stderr.write(`${message}\n`));
  const instanceId = randomUUID();
  let stopped = false, started = false, starting, stopping, idleTimer, registrationTimer, refreshing;
  let worker, retiring = Promise.resolve(), retirementFailure, active, pumping = false, lastUsed = null, registered = false, registeredSharing, localConfirmed = false, lastRegistrationError;
  const queue = [];
  let port = options.port;
  const descriptor = () => ({ id: `dreammate-embedding-${port}`, name: `Local embedding (${options.model}, on demand)`,
    kind: 'generic', port, sharing, reachability: 'localhost', health: '/health', execution: 'http',
    metadata: { embedding_provider: { ...provider, priority, lifecycle: 'on_demand', instance_id: instanceId },
      invoke_timeout_ms: Math.min(120000, options.startupTimeoutMs + options.inferenceTimeoutMs) } });
  const health = () => ({ status: 'ok', service: 'dreammate-embedding-on-demand', pid: process.pid,
    sharing, loaded: Boolean(worker?.ready), loading: Boolean(worker && !worker.ready), idle_timeout_ms: options.idleTimeoutMs,
    last_used: lastUsed === null ? null : new Date(lastUsed).toISOString(), pending_requests: queue.length + Number(Boolean(active)),
    worker_pid: worker?.child.pid ?? null, embedding_provider: { ...provider, priority, lifecycle: 'on_demand' },
    config: { file: options.config, source: configSource, priority_source: configSource, sharing_source: sharingSource,
      ...(lastConfigError ? { last_error: lastConfigError } : {}) },
    registration: { registered, local_confirmed: localConfirmed, ...(registeredSharing ? { sharing: registeredSharing } : {}),
      ...(lastRegistrationError ? { last_error: lastRegistrationError } : {}) } });

  function clearIdle() { clearTimeout(idleTimer); idleTimer = undefined; }
  function scheduleIdle() {
    clearIdle();
    if (!stopped && worker?.ready && !active && queue.length === 0) {
      idleTimer = setTimeout(() => { if (!active && queue.length === 0) void retireWorker(unavailable('Encoder idle timeout')); }, options.idleTimeoutMs);
      idleTimer.unref?.();
    }
  }
  function retireWorker(error) {
    clearIdle();
    const owned = worker;
    if (!owned) return retiring;
    worker = undefined;
    owned.fail(error);
    const previous = retiring;
    retiring = (async () => {
      await previous;
      if (owned.exited) return;
      await new Promise(resolve => {
        const timer = setTimeout(() => { owned.child.kill('SIGKILL'); }, deps.shutdownTimeoutMs ?? 3000);
        const fallback = setTimeout(() => {
          if (!owned.exited) retirementFailure = owned;
          resolve();
        }, (deps.shutdownTimeoutMs ?? 3000) + 1000);
        timer.unref?.(); fallback.unref?.();
        owned.child.once('exit', () => {
          if (retirementFailure === owned) retirementFailure = undefined;
          clearTimeout(timer); clearTimeout(fallback); resolve();
        });
        owned.child.kill('SIGTERM');
      });
    })();
    return retiring;
  }
  async function ensureWorker(signal) {
    await retiring;
    if (stopped || signal?.aborted) throw unavailable('Embedding request cancelled');
    if (retirementFailure) throw unavailable('Previous local encoder has not exited');
    if (worker) return worker.readyPromise;
    const child = spawnChild(options.python, [WORKER_PATH, '--manifest', options.manifest, '--model', options.model,
      '--device', options.device, '--max-length', String(options.maxLength),
      ...(options.batchSize === undefined ? [] : ['--batch-size', String(options.batchSize)])],
    { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'], shell: false, env: { ...process.env, PYTHONUNBUFFERED: '1' } });
    let resolveReady, rejectReady;
    const owned = { child, ready: false, exited: false, buffer: Buffer.alloc(0), response: undefined,
      readyPromise: new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }),
      fail(error) { clearTimeout(owned.startupTimer); rejectReady(error); owned.response?.reject(error); owned.response = undefined; } };
    worker = owned;
    const fail = error => { if (worker === owned) void retireWorker(error); else owned.fail(error); };
    owned.startupTimer = setTimeout(() => fail(unavailable('Local model startup timed out')), options.startupTimeoutMs);
    child.once('error', () => {
      // A failed spawn has no PID and emits close rather than exit. There is no
      // old process to retire in this case; errors after spawning still require
      // an observed exit before another worker may start.
      if (child.pid === undefined) owned.exited = true;
      fail(unavailable('Could not start the local encoder'));
    });
    child.once('exit', () => {
      owned.exited = true;
      if (worker === owned) { worker = undefined; clearIdle(); }
      owned.fail(unavailable('Local encoder exited'));
    });
    child.stdin.on('error', () => fail(unavailable('Local encoder input closed')));
    child.stderr.on('data', chunk => { if (deps.workerLog) deps.workerLog(chunk); else process.stderr.write(chunk); });
    child.stdout.on('data', chunk => {
      if (worker !== owned) return;
      if (owned.buffer.length + chunk.length > RESPONSE_LIMIT) return fail(unavailable('Encoder response exceeds limit'));
      owned.buffer = Buffer.concat([owned.buffer, chunk]);
      let newline;
      while ((newline = owned.buffer.indexOf(10)) !== -1) {
        const line = owned.buffer.subarray(0, newline).toString('utf8');
        owned.buffer = owned.buffer.subarray(newline + 1);
        try {
          const message = JSON.parse(line);
          if (!owned.ready) {
            if (message?.type !== 'ready' || !sameProvider(message.provider, provider)) throw new Error('Invalid readiness');
            owned.ready = true; clearTimeout(owned.startupTimer); resolveReady(owned); continue;
          }
          const response = owned.response;
          if (!response || message?.id !== response.id || !['result', 'error'].includes(message.type)) throw new Error('Invalid response id/type');
          if (message.type === 'error') throw new Error('Inference failed');
          const result = validateResult(message.result, response.request, provider);
          owned.response = undefined; response.resolve(result);
        } catch { return fail(unavailable('Local encoder returned an invalid response')); }
      }
    });
    return owned.readyPromise;
  }
  async function encode(request, signal) {
    const owned = await ensureWorker(signal);
    if (stopped || signal?.aborted || worker !== owned) throw unavailable('Local encoder unavailable');
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { void retireWorker(unavailable('Local model inference timed out')); }, options.inferenceTimeoutMs);
      owned.response = { id, request, resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } };
      try {
        owned.child.stdin.write(`${JSON.stringify({ id, ...request })}\n`, error => {
          if (error && worker === owned) void retireWorker(unavailable('Local encoder input failed'));
        });
      } catch { void retireWorker(unavailable('Local encoder input failed')); }
    });
  }
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (!stopped && queue.length) {
        const job = queue.shift(); active = job;
        try { job.resolve(await encode(job.request, job.signal)); } catch (error) { job.reject(error); }
        finally {
          clearTimeout(job.queueTimer); job.signal?.removeEventListener('abort', job.cancel);
          active = undefined; if (!job.signal?.aborted) lastUsed = Date.now();
        }
      }
    } finally { pumping = false; scheduleIdle(); }
  }
  function submit(request, signal) {
    if (stopped) return Promise.reject(unavailable('Embedding provider stopped'));
    if (signal?.aborted) return Promise.reject(unavailable('Embedding request cancelled'));
    if (queue.length + Number(Boolean(active)) >= options.maxPending) return Promise.reject(unavailable('Local encoder queue is full', 429));
    clearIdle();
    return new Promise((resolve, reject) => {
      const job = { request, resolve, reject, signal };
      job.cancel = () => {
        clearTimeout(job.queueTimer); signal.removeEventListener('abort', job.cancel);
        const index = queue.indexOf(job);
        if (index >= 0) queue.splice(index, 1);
        if (active === job) void retireWorker(unavailable('Embedding request cancelled'));
        reject(unavailable('Embedding request cancelled'));
      };
      signal?.addEventListener('abort', job.cancel, { once: true });
      // A stalled client cannot retain unbounded queue time, even behind slow jobs.
      job.queueTimer = setTimeout(() => {
        const index = queue.indexOf(job);
        if (index >= 0) {
          queue.splice(index, 1); signal?.removeEventListener('abort', job.cancel);
          reject(unavailable('Local encoder queue wait timed out', 504));
        }
      }, options.startupTimeoutMs + options.inferenceTimeoutMs);
      queue.push(job); void pump();
    });
  }
  async function readBody(request) {
    const contentLength = request.headers['content-length'];
    if (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) > BODY_LIMIT)) throw unavailable('Request body exceeds 262144 bytes', 413);
    const chunks = []; let size = 0;
    const timer = setTimeout(() => request.destroy(), deps.bodyTimeoutMs ?? 10000);
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > BODY_LIMIT) throw unavailable('Request body exceeds 262144 bytes', 413);
        chunks.push(chunk);
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw unavailable('Request body must be valid JSON', 400); }
    } finally { clearTimeout(timer); }
  }
  function json(response, status, body) {
    if (response.destroyed || response.writableEnded) return;
    const data = Buffer.from(JSON.stringify(body));
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length }); response.end(data);
  }
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/health') return json(response, 200, health());
      if (request.method !== 'POST' || request.url !== '/embed') return json(response, 404, { error: 'Not found' });
      const payload = validateEmbedRequest(await readBody(request), options.model);
      // A legacy gateway may retain an older network advertisement for this port.
      // Until local registration is confirmed, that stale route must not wake weights.
      if (sharing === 'local' && options.register && (!registered || registeredSharing !== 'local' || !localConfirmed)) {
        throw unavailable('Local service sharing has not been confirmed by the Node');
      }
      const controller = new AbortController();
      const cancel = () => { if (!response.writableEnded) controller.abort(); };
      response.once('close', cancel);
      if (response.destroyed || request.aborted) controller.abort();
      try { json(response, 200, await submit(payload, controller.signal)); }
      finally { response.off('close', cancel); }
    } catch (error) { json(response, error.status ?? 503, { error: error.status ? error.message : 'Local embedding provider unavailable' }); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;

  async function withdrawRegistration() {
    if (!registered) return;
    const url = `${options.agent}/services/${encodeURIComponent(descriptor().id)}`;
    const result = await send(url);
    const current = result.body?.service ?? result.body;
    if (current?.metadata?.embedding_provider?.instance_id === instanceId && current.port === port) {
      if (!result.etag) throw new Error('Cannot withdraw previous embedding advertisement without an ETag');
      await send(url, { method: 'DELETE', headers: { 'if-match': result.etag } });
    }
    // A replaced advertisement belongs to another process and must remain untouched.
    registered = false; registeredSharing = undefined; localConfirmed = false;
  }

  async function refresh() {
    if (stopped || !started) return false;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        try {
          const value = await loadConfig(options.config);
          const config = value === undefined ? undefined : validatePriorityConfig(value);
          priority = config?.priority ?? options.priority;
          const nextSharing = config?.sharing ?? options.sharing;
          if (sharing !== nextSharing) localConfirmed = false;
          sharing = nextSharing;
          configSource = config === undefined ? 'startup' : 'file';
          sharingSource = config?.sharing === undefined ? 'startup' : 'file';
          if (lastConfigError) log('On-demand embedding configuration restored');
          lastConfigError = undefined;
        } catch (error) {
          const message = error.message ?? String(error);
          if (lastConfigError !== message) log(`On-demand embedding configuration: ${message}`);
          lastConfigError = message;
        }
        if (stopped || !options.register) return false;
        if (sharing === 'local') {
          const result = await send(`${options.agent}/health`);
          if (result.body?.service_sharing !== SHARING_PROTOCOL) {
            throw new Error(`Node does not support local service sharing (${SHARING_PROTOCOL}); local embedding advertisement was not registered`);
          }
        }
        await send(`${options.agent}/services`, { method: 'POST', body: descriptor() });
        registered = true; registeredSharing = sharing; localConfirmed = sharing === 'local';
        if (lastRegistrationError) log('On-demand embedding registration restored');
        lastRegistrationError = undefined; return true;
      } catch (error) {
        let message = error.message ?? String(error);
        localConfirmed = false;
        if (sharing === 'local' && registered) {
          try { await withdrawRegistration(); }
          catch (withdrawError) { message += `; previous advertisement withdrawal pending: ${withdrawError.message ?? String(withdrawError)}`; }
        } else if (sharing !== 'local') { registered = false; registeredSharing = undefined; }
        if (lastRegistrationError !== message) log(`On-demand embedding registration: ${message}`);
        lastRegistrationError = message; return false;
      } finally { refreshing = undefined; }
    })();
    return refreshing;
  }
  function start() {
    return starting ??= (async () => {
      if (stopped) throw unavailable('Embedding provider stopped');
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      port = server.address().port; started = true;
      if (stopped) throw unavailable('Embedding provider stopped');
      await refresh();
      if (!stopped) {
        registrationTimer = setInterval(() => { void refresh(); }, deps.registrationIntervalMs ?? 15000);
        registrationTimer.unref?.();
      }
      return api;
    })();
  }
  function stop() {
    return stopping ??= (async () => {
      stopped = true; clearIdle(); clearInterval(registrationTimer);
      for (const job of queue.splice(0)) {
        clearTimeout(job.queueTimer); job.signal?.removeEventListener('abort', job.cancel);
        job.reject(unavailable('Embedding provider stopped'));
      }
      await retireWorker(unavailable('Embedding provider stopped'));
      await starting?.catch(() => {});
      await refreshing;
      if (registered) {
        try { await withdrawRegistration(); }
        catch { /* Replaced/old/offline Nodes expire the advertisement through health. */ }
      }
      registered = false; registeredSharing = undefined; localConfirmed = false;
      if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    })();
  }
  const api = { server, health, descriptor, start, refresh, stop };
  return api;
}

export async function startOnDemandProvider(options, deps) {
  const provider = await createOnDemandProvider(options, deps);
  try { return await provider.start(); } catch (error) { await provider.stop(); throw error; }
}

export async function main(argv = process.argv.slice(2)) {
  const provider = await startOnDemandProvider(parseOptions(argv));
  process.stderr.write(`On-demand local embeddings listening on 127.0.0.1:${provider.descriptor().port}; idle unload ${provider.health().idle_timeout_ms} ms\n`);
  const shutdown = () => { void provider.stop().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  return provider;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

#!/usr/bin/env node
/** Run an offline encoder child and report its ready provider to the local agent. */
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SERVER_PATH = fileURLToPath(new URL('./server.py', import.meta.url));
const MODELS = new Set(['qwen3']);

export function localAgentUrl(value) {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || url.pathname !== '/' || !(hostname === 'localhost' || hostname === '::1'
      || (isIP(hostname) === 4 && hostname.startsWith('127.')))) {
    throw new Error('--agent must be a loopback HTTP(S) root URL');
  }
  // Do not rely on local DNS or proxy environment variables for registration.
  if (hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.origin;
}

export function parseOptions(argv, cwd = process.cwd()) {
  const { values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
    model: { type: 'string', default: 'qwen3' }, port: { type: 'string', default: '8766' },
    agent: { type: 'string', default: 'http://127.0.0.1:36908' },
    priority: { type: 'string', default: '0' }, python: { type: 'string' }, manifest: { type: 'string' },
    'batch-size': { type: 'string' },
  } });
  if (!MODELS.has(values.model)) throw new Error('--model must be qwen3');
  const port = Number(values.port), priority = Number(values.priority);
  if (!/^\d+$/.test(values.port) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('--port must be an integer from 1 to 65535');
  }
  if (!/^-?\d+$/.test(values.priority) || !Number.isSafeInteger(priority) || priority < -1000 || priority > 1000) {
    throw new Error('--priority must be an integer from -1000 to 1000');
  }
  if (values.python !== undefined && !values.python.trim()) throw new Error('--python cannot be empty');
  if (values.manifest !== undefined && !values.manifest.trim()) throw new Error('--manifest cannot be empty');
  const batchSize = values['batch-size'] === undefined ? undefined : Number(values['batch-size']);
  if (batchSize !== undefined && (!/^\d+$/.test(values['batch-size']) || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 64)) {
    throw new Error('--batch-size must be an integer from 1 to 64');
  }
  return { model: values.model, port, priority, agent: localAgentUrl(values.agent),
    python: values.python ?? path.join(REPO_ROOT, '.local/tool-search/venv/bin/python'),
    manifest: values.manifest ? path.resolve(cwd, values.manifest) : path.join(REPO_ROOT, '.local/tool-search/manifest.json'),
    ...(batchSize === undefined ? {} : { batchSize }) };
}

/** Direct HTTP(S): ignores all proxy variables and never follows redirects. */
export function requestJson(url, { method = 'GET', body, timeoutMs = 2000, requestImpl } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const request = (requestImpl ?? (new URL(url).protocol === 'https:' ? httpsRequest : httpRequest))(url, {
      method, agent: false,
      headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
    }, response => {
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode ?? 'unknown'} (redirects are disabled)`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 1_048_576) response.destroy(new Error('Response exceeds 1 MiB'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve(text ? JSON.parse(text) : null);
        } catch { reject(new Error('Response is not valid JSON')); }
      });
    });
    // Deadline includes headers and the complete response body.
    const deadline = setTimeout(() => request.destroy(new Error('Request timed out')), timeoutMs);
    request.once('close', () => clearTimeout(deadline));
    request.on('error', reject);
    request.end(data);
  });
}

export function providerDescriptor(health, model, pid) {
  const provider = health?.embedding_provider;
  if (!Number.isSafeInteger(pid) || pid < 1 || health?.status !== 'ok' || health?.pid !== pid || provider?.protocol !== 'dreammate.embedding.v1'
    || provider.ready !== true || provider.model !== model || typeof provider.revision !== 'string'
    || !provider.revision.trim() || provider.revision !== provider.revision.trim()
    || provider.revision.length > 200 || !Number.isSafeInteger(provider.dimensions)
    || provider.dimensions < 1 || provider.dimensions > 4096 || typeof provider.encoding !== 'string'
    || !provider.encoding.trim() || provider.encoding !== provider.encoding.trim() || provider.encoding.length > 200) {
    throw new Error('Owned encoder is not ready with a valid provider descriptor');
  }
  return { protocol: provider.protocol, model, revision: provider.revision, dimensions: provider.dimensions,
    encoding: provider.encoding, ready: true };
}

export function registrationPayload(options, provider) {
  return { id: `dreammate-embedding-${options.port}`, name: `Local embedding (${options.model})`,
    kind: 'generic', port: options.port, reachability: 'localhost', health: '/health', execution: 'http',
    metadata: { embedding_provider: { ...provider, priority: options.priority } } };
}

/** Injected process/HTTP/timers keep contract tests independent of model weights. */
export function launchProvider(options, deps = {}) {
  const agent = localAgentUrl(options.agent);
  if (!MODELS.has(options.model) || !Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535
    || !Number.isSafeInteger(options.priority) || options.priority < -1000 || options.priority > 1000
    || (options.batchSize !== undefined && (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 64))) {
    throw new Error('Invalid provider options');
  }
  const spawnChild = deps.spawn ?? spawn, send = deps.requestJson ?? requestJson;
  const schedule = deps.setInterval ?? setInterval, cancel = deps.clearInterval ?? clearInterval;
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now, log = deps.log ?? (message => process.stderr.write(`${message}\n`));
  const child = spawnChild(options.python, [SERVER_PATH, '--manifest', options.manifest, '--host', '127.0.0.1',
    '--port', String(options.port), '--serve-model', options.model, '--warmup', options.model,
    ...(options.batchSize === undefined ? [] : ['--batch-size', String(options.batchSize)])],
  { cwd: REPO_ROOT, stdio: ['ignore', 'inherit', 'inherit'], shell: false });
  const healthUrl = `http://127.0.0.1:${options.port}/health`;
  let stopped = false, childExited = false, childFailure, registrationAttempted = false;
  let interval, refreshing, stopping, lastError;
  const diagnose = error => {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== lastError) log(`embedding provider registration: ${message}`);
    lastError = message;
  };
  const refresh = () => {
    if (stopped || childExited) return Promise.resolve(false);
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const health = await send(healthUrl);
        const provider = providerDescriptor(health, options.model, child.pid);
        if (stopped || childExited) return false;
        registrationAttempted = true;
        await send(`${agent}/services`, { method: 'POST', body: registrationPayload(options, provider) });
        if (lastError) log('embedding provider registration: restored');
        lastError = undefined;
        return true;
      } catch (error) { diagnose(error); return false; }
      finally { refreshing = undefined; }
    })();
    return refreshing;
  };
  const stop = () => stopping ??= (async () => {
    stopped = true;
    if (interval !== undefined) cancel(interval);
    await refreshing;
    // The child may have failed to bind: never delete a registration we did not submit.
    if (registrationAttempted) {
      try { await send(`${agent}/services/dreammate-embedding-${options.port}`, { method: 'DELETE' }); }
      catch (error) { diagnose(error); }
    }
    if (!childExited) {
      await new Promise(resolve => {
        const deadline = setTimeout(() => {
          if (!childExited) child.kill('SIGKILL');
          resolve();
        }, deps.shutdownTimeoutMs ?? 5000);
        deadline.unref?.();
        child.once('exit', () => { clearTimeout(deadline); resolve(); });
        child.kill('SIGTERM');
      });
    }
  })();
  child.once('error', error => { childFailure = error; childExited = true; void stop(); });
  child.once('exit', (code, signal) => {
    childExited = true;
    childFailure ??= new Error(`Encoder exited (${signal ?? code ?? 'unknown'})`);
    void stop();
  });
  const ready = (async () => {
    const deadline = now() + (deps.startupTimeoutMs ?? 180_000);
    while (!stopped && !childExited) {
      try {
        providerDescriptor(await send(healthUrl), options.model, child.pid);
        if (stopped || childExited) break;
        await refresh(); // Registration failure does not stop a ready encoder.
        if (stopped || childExited) break;
        interval = schedule(() => { void refresh(); }, 15_000);
        return;
      } catch { /* Model warmup may take time; advertise only after real encoding. */ }
      if (now() >= deadline) break;
      await sleep(deps.pollIntervalMs ?? 500);
    }
    await stop();
    throw childFailure ?? new Error(stopped ? 'Embedding provider stopped' : 'Encoder readiness timed out');
  })();
  return { child, ready, refresh, stop };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  const provider = launchProvider(options);
  let shuttingDown = false;
  const shutdown = () => { shuttingDown = true; void provider.stop(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  provider.child.once('exit', code => { if (!shuttingDown) process.exitCode = code || 1; });
  try { await provider.ready; }
  catch (error) { await provider.stop(); throw error; }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

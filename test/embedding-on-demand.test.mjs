import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { createOnDemandProvider, startOnDemandProvider, parseOptions, readModelMetadata,
  validateEmbedRequest, requestAgent } from '../scripts/local-embeddings/on-demand.mjs';
import { defaultConfigPath, readPriorityConfig } from '../scripts/local-embeddings/priority-config.mjs';

const metadata = { protocol: 'dreammate.embedding.v1', model: 'qwen3', revision: 'fixture-sha', dimensions: 2,
  encoding: 'dreammate.tool-search.v1:fp32:max512:dim2', ready: true };
const input = { model: 'qwen3', texts: ['Find relevant tools'], input_type: 'query' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= deadline) assert.fail('Condition timed out'); await sleep(5); }
}
function result(request) {
  return { model: 'qwen3@fixture-sha', alias: 'qwen3', revision: 'fixture-sha', dimensions: 2,
    encoding: metadata.encoding, embeddings: request.texts.map(() => [0.6, 0.8]) };
}
class FakeChild extends EventEmitter {
  pid = 1234;
  stdout = new PassThrough();
  stderr = new PassThrough();
  kills = [];
  requests = [];
  dead = false;
  constructor(behavior = {}) {
    super();
    this.stdin = new Writable({ write: (data, _encoding, done) => {
      const request = JSON.parse(data.toString()); this.requests.push(request); done();
      if (behavior.hang) return;
      setTimeout(() => {
        if (this.dead) return;
        const message = behavior.respond ? behavior.respond(request) : { type: 'result', id: request.id, result: result(request) };
        this.stdout.write(`${JSON.stringify(message)}\n`);
      }, behavior.inferenceMs ?? 0);
    } });
    if (!behavior.noReady) setTimeout(() => {
      if (!this.dead) this.stdout.write(`${JSON.stringify({ type: 'ready', provider: behavior.metadata ?? metadata })}\n`);
    }, behavior.startupMs ?? 0);
  }
  kill(signal) {
    this.kills.push(signal);
    if (!this.dead) { this.dead = true; queueMicrotask(() => this.emit('exit', 0, signal)); }
    return true;
  }
}
async function fixture(t, behaviors = [{}], options = {}, extras = {}) {
  const children = [], calls = [];
  const provider = await startOnDemandProvider({ port: 0, register: false, idleTimeoutMs: 100,
    startupTimeoutMs: 500, inferenceTimeoutMs: 500, ...options }, {
    readModelMetadata: async () => metadata,
    readPriorityConfig: async () => undefined,
    spawn(command, args, spawnOptions) {
      calls.push({ command, args, spawnOptions });
      const child = new FakeChild(behaviors[Math.min(children.length, behaviors.length - 1)]);
      children.push(child); return child;
    }, log() {}, ...extras,
  });
  t.after(() => provider.stop());
  const url = `http://127.0.0.1:${provider.descriptor().port}`;
  return { provider, children, calls, url, embed: async (payload = input) => {
    const response = await fetch(`${url}/embed`, { method: 'POST', body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json() };
  } };
}

test('on-demand CLI defaults and strict validation do not touch model processes', () => {
  const options = parseOptions([]);
  assert.equal(options.priority, 100); assert.equal(options.port, 8766);
  assert.equal(options.sharing, 'network');
  assert.equal(parseOptions(['--sharing', 'local']).sharing, 'local');
  assert.equal(options.device, 'auto'); assert.equal(options.idleTimeoutMs, 300000);
  assert.equal(options.config, defaultConfigPath());
  assert.equal(options.register, true);
  assert.equal(parseOptions(['--no-register', '--device', 'mps', '--batch-size', '8']).register, false);
  assert.equal(parseOptions(['--manifest', 'fixture.json'], '/tmp/project').manifest, '/tmp/project/fixture.json');
  assert.equal(parseOptions(['--config', 'priority.json'], '/tmp/project').config, '/tmp/project/priority.json');
  for (const flags of [['--port', '0'], ['--idle-timeout-ms', '0'], ['--startup-timeout-ms', '-1'],
    ['--inference-timeout-ms', 'NaN'], ['--max-pending', '257'], ['--device', 'metal'], ['--model', 'cloud'],
    ['--batch-size', '65'], ['--max-length', '1'], ['--priority', '1001'], ['--python', ' '], ['--config', ' '],
    ['--agent', 'https://example.com'], ['--host', '0.0.0.0'], ['--sharing', 'lcoal'], ['--sharing', 'LOCAL'], ['--sharing', '']]) assert.throws(() => parseOptions(flags), flags.join(' '));
});

test('priority config is loaded before listening and invalid startup config fails without a worker', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'embedding-priority-start-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'priority.json');
  await writeFile(config, '{"version":1,"priority":"100"}');
  let spawned = false, modelMetadataRead = false;
  await assert.rejects(createOnDemandProvider({ config, port: 0 }, {
    readModelMetadata: async () => { modelMetadataRead = true; return metadata; },
    spawn() { spawned = true; },
  }), /Invalid embedding priority config.*integer priority/);
  assert.equal(spawned, false);
  assert.equal(modelMetadataRead, false, 'invalid config should fail before reading model metadata');
});

test('priority file updates register live without restarting the worker; invalid config retains last valid value', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'embedding-priority-live-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'priority.json'), registrations = [];
  const save = priority => writeFile(config, JSON.stringify({ version: 1, priority }));
  await save(120);
  const f = await fixture(t, [{}], { config, priority: 100, register: true, idleTimeoutMs: 10000 }, {
    readPriorityConfig,
    registrationIntervalMs: 15,
    async requestAgent(_url, request = {}) {
      if (request.method === 'POST') registrations.push(request.body);
      return { body: {} };
    },
  });
  assert.equal(f.provider.health().embedding_provider.priority, 120);
  assert.deepEqual(f.provider.health().config, { file: config, source: 'file', priority_source: 'file', sharing_source: 'startup' });
  assert.equal(f.children.length, 0);
  await save(121);
  await until(() => registrations.at(-1)?.metadata.embedding_provider.priority === 121);
  assert.equal(f.children.length, 0, 'config reload must not load model weights');
  assert.equal((await f.embed()).status, 200);
  const lastUsed = f.provider.health().last_used, workerPid = f.provider.health().worker_pid;
  const originalEncoding = f.provider.descriptor().metadata.embedding_provider.encoding;
  await save(-2);
  await until(() => registrations.at(-1)?.metadata.embedding_provider.priority === -2);
  assert.equal(f.provider.health().loaded, true);
  assert.equal(f.provider.health().worker_pid, workerPid);
  assert.equal(f.provider.health().last_used, lastUsed);
  assert.equal(f.provider.descriptor().metadata.embedding_provider.encoding, originalEncoding);
  assert.equal(f.children.length, 1); assert.deepEqual(f.children[0].kills, []);

  await writeFile(config, '{"version":1,"priority":200,"unknown":true}');
  await until(() => Boolean(f.provider.health().config.last_error));
  assert.match(f.provider.health().config.last_error, /integer priority/);
  assert.equal(f.provider.health().embedding_provider.priority, -2);
  assert.equal(f.provider.health().config.source, 'file');
  assert.equal(registrations.at(-1).metadata.embedding_provider.priority, -2);
  assert.deepEqual(f.children[0].kills, []);
  await rm(config);
  await until(() => f.provider.health().embedding_provider.priority === 100);
  assert.deepEqual(f.provider.health().config, { file: config, source: 'startup', priority_source: 'startup', sharing_source: 'startup' });
  assert.equal(f.provider.health().last_used, lastUsed);
  assert.equal(f.children.length, 1);
});

test('sharing follows its own startup fallback and hot updates the Node advertisement without loading or restarting weights', async t => {
  let config = { version: 1, priority: 120 };
  const registrations = [], probes = [];
  const f = await fixture(t, [{}], { priority: 100, sharing: 'local', register: true, idleTimeoutMs: 10000 }, {
    readPriorityConfig: async () => config, registrationIntervalMs: 10,
    async requestAgent(url, request = {}) {
      if (url.endsWith('/health')) { probes.push(url); return { body: { service_sharing: 'dreammate.service-sharing.v1' } }; }
      if (request.method === 'POST') registrations.push(request.body);
      return { body: {} };
    },
  });
  assert.equal(f.provider.health().sharing, 'local');
  assert.equal(f.provider.health().config.sharing_source, 'startup');
  assert.equal(registrations.at(-1).sharing, 'local');
  assert.equal(probes.length, 1);
  assert.equal(f.children.length, 0);
  assert.equal(registrations.at(-1).metadata.mcp_sharing, undefined);
  config = { version: 1, priority: 121, sharing: 'network' };
  await until(() => registrations.at(-1)?.sharing === 'network');
  assert.equal(f.provider.health().config.sharing_source, 'file');
  assert.equal(f.children.length, 0, 'a sharing update must not load model weights');
  assert.equal((await f.embed()).status, 200);
  const lastUsed = f.provider.health().last_used, workerPid = f.provider.health().worker_pid;
  config = { version: 1, priority: -2, sharing: 'local' };
  await until(() => registrations.at(-1)?.sharing === 'local' && registrations.at(-1)?.metadata.embedding_provider.priority === -2);
  assert.equal(f.provider.health().worker_pid, workerPid);
  assert.equal(f.provider.health().last_used, lastUsed);
  assert.deepEqual(f.children[0].kills, []);
  config = { version: 1, priority: 800, sharing: 'lcoal' };
  await until(() => Boolean(f.provider.health().config.last_error));
  assert.equal(f.provider.health().sharing, 'local');
  assert.equal(f.provider.health().embedding_provider.priority, -2);
  assert.equal(registrations.at(-1).sharing, 'local');
  assert.equal(registrations.at(-1).metadata.embedding_provider.priority, -2);
  config = undefined;
  await until(() => f.provider.health().embedding_provider.priority === 100);
  assert.equal(f.provider.health().sharing, 'local');
  assert.equal(f.provider.health().config.sharing_source, 'startup');
  assert.equal(f.provider.health().config.last_error, undefined);
  assert.equal(f.provider.health().worker_pid, workerPid);
  assert.equal(f.provider.health().last_used, lastUsed);
  assert.equal(f.children.length, 1);
});

test('local sharing refuses legacy Nodes before registering and retries when the capability becomes available', async t => {
  let supported = false;
  const requests = [];
  const f = await fixture(t, [{}], { sharing: 'local', register: true }, {
    registrationIntervalMs: 10,
    async requestAgent(url, request = {}) {
      requests.push({ url, ...request });
      return { body: url.endsWith('/health') && supported ? { service_sharing: 'dreammate.service-sharing.v1' } : {} };
    },
  });
  assert.equal(f.provider.health().registration.registered, false);
  assert.match(f.provider.health().registration.last_error, /does not support local service sharing/);
  assert.ok(requests.every(request => request.url.endsWith('/health') && request.method === undefined));
  assert.equal((await f.embed()).status, 503, 'a retained network route must not wake a locally restricted encoder');
  assert.equal(f.children.length, 0);
  supported = true;
  await until(() => f.provider.health().registration.registered);
  assert.equal(requests.find(request => request.method === 'POST').body.sharing, 'local');
  assert.equal(f.provider.health().registration.sharing, 'local');
  assert.equal(f.children.length, 0);
  assert.equal((await f.embed()).status, 200, 'local requests are accepted once the Node confirms local registration');
  assert.equal(f.children.length, 1);
});

test('network to local on a legacy Node conditionally withdraws the previous network advertisement', async t => {
  let config, advertised;
  const posts = [], deletes = [];
  const f = await fixture(t, [{}], { register: true }, {
    readPriorityConfig: async () => config, registrationIntervalMs: 10,
    async requestAgent(url, request = {}) {
      if (url.endsWith('/health')) return { body: {} };
      if (request.method === 'POST') { advertised = request.body; posts.push(advertised); return { body: {} }; }
      if (request.method === 'DELETE') { deletes.push(request); advertised = undefined; return { body: {} }; }
      return { body: advertised, etag: '"owned-network"' };
    },
  });
  assert.equal(posts.length, 1); assert.equal(posts[0].sharing, 'network');
  config = { version: 1, priority: 100, sharing: 'local' };
  await until(() => deletes.length === 1);
  assert.equal(deletes[0].headers['if-match'], '"owned-network"');
  assert.equal(posts.length, 1, 'a legacy Node must never receive a local registration');
  assert.equal(f.provider.health().sharing, 'local');
  assert.equal(f.provider.health().registration.registered, false);
  assert.match(f.provider.health().registration.last_error, /does not support local service sharing/);
  assert.equal(f.children.length, 0);
});

test('loss of local sharing capability revokes confirmation even if an earlier local advertisement cannot be withdrawn', async t => {
  let supported = true, advertised;
  const f = await fixture(t, [{}], { sharing: 'local', register: true }, {
    registrationIntervalMs: 10,
    async requestAgent(url, request = {}) {
      if (url.endsWith('/health')) return { body: supported ? { service_sharing: 'dreammate.service-sharing.v1' } : {} };
      if (request.method === 'POST') { advertised = request.body; return { body: {} }; }
      throw new Error('Cannot reach previous advertisement');
    },
  });
  assert.equal(f.provider.health().registration.local_confirmed, true);
  assert.equal(advertised.sharing, 'local');
  supported = false;
  await until(() => /withdrawal pending/.test(f.provider.health().registration.last_error ?? ''));
  assert.equal(f.provider.health().registration.registered, true);
  assert.equal(f.provider.health().registration.local_confirmed, false);
  assert.equal((await f.embed()).status, 503);
  assert.equal(f.children.length, 0);
  supported = true;
  await until(() => f.provider.health().registration.local_confirmed);
  assert.equal((await f.embed()).status, 200);
  assert.equal(f.children.length, 1);
});

test('failed withdrawal retains the previous advertised sharing and retries without claiming local registration', async t => {
  let config, advertised, blocked = true;
  const deletes = [];
  const f = await fixture(t, [{}], { register: true }, {
    readPriorityConfig: async () => config, registrationIntervalMs: 10,
    async requestAgent(url, request = {}) {
      if (url.endsWith('/health')) return { body: {} };
      if (request.method === 'POST') { advertised = request.body; return { body: {} }; }
      if (request.method === 'DELETE') { deletes.push(request); return { body: {} }; }
      if (blocked) throw new Error('Node unavailable during withdrawal');
      return { body: advertised, etag: '"owned-network"' };
    },
  });
  config = { version: 1, priority: 100, sharing: 'local' };
  await until(() => /withdrawal pending/.test(f.provider.health().registration.last_error ?? ''));
  assert.equal(f.provider.health().registration.registered, true);
  assert.equal(f.provider.health().registration.sharing, 'network');
  assert.equal((await f.embed()).status, 503, 'the previous network route stays blocked while withdrawal is pending');
  assert.equal(deletes.length, 0);
  blocked = false;
  await until(() => !f.provider.health().registration.registered);
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].headers['if-match'], '"owned-network"');
  assert.equal(f.children.length, 0);
});

test('local transition cannot withdraw a replacement advertisement or an owned advertisement without ETag', async t => {
  let config, advertised, replaced = false, etag;
  const deletes = [];
  const f = await fixture(t, [{}], { register: true }, {
    readPriorityConfig: async () => config, registrationIntervalMs: 10,
    async requestAgent(url, request = {}) {
      if (url.endsWith('/health')) return { body: {} };
      if (request.method === 'POST') { advertised = request.body; return { body: {} }; }
      if (request.method === 'DELETE') { deletes.push(request); return { body: {} }; }
      return { body: replaced ? { ...advertised, metadata: {} } : advertised, etag };
    },
  });
  config = { version: 1, priority: 100, sharing: 'local' };
  await until(() => /without an ETag/.test(f.provider.health().registration.last_error ?? ''));
  assert.equal(f.provider.health().registration.registered, true);
  assert.equal(f.provider.health().registration.sharing, 'network');
  replaced = true; etag = '"replacement"';
  await until(() => !f.provider.health().registration.registered);
  assert.deepEqual(deletes, []);
  assert.equal(f.children.length, 0);
});

test('invalid sharing startup config and direct runtime options fail before reading metadata or starting a child', async t => {
  let metadataRead = false, childStarted = false;
  const deps = { readModelMetadata: async () => { metadataRead = true; return metadata; },
    readPriorityConfig: async () => undefined, spawn() { childStarted = true; } };
  for (const sharing of [null, '', 'lcoal', 'LOCAL', 1, true]) {
    await assert.rejects(createOnDemandProvider({ sharing }, deps), /Invalid on-demand provider options/);
    await assert.rejects(createOnDemandProvider({}, { ...deps,
      readPriorityConfig: async () => ({ version: 1, priority: 100, sharing }) }), /sharing must be local or network/);
  }
  assert.equal(metadataRead, false); assert.equal(childStarted, false);
});

test('unregistered provider reloads priority periodically without extending worker idle time', async t => {
  let config;
  const f = await fixture(t, [{}], { register: false, priority: 25, idleTimeoutMs: 80 }, {
    readPriorityConfig: async () => config,
    registrationIntervalMs: 10,
    requestAgent() { assert.fail('no-register must not advertise'); },
  });
  assert.equal(f.provider.health().config.source, 'startup');
  config = { version: 1, priority: 26 };
  await until(() => f.provider.health().embedding_provider.priority === 26);
  assert.equal(f.children.length, 0);
  assert.equal((await f.embed()).status, 200);
  const lastUsed = f.provider.health().last_used;
  for (let index = 0; index < 12; index++) {
    config = { version: 1, priority: 30 + index, sharing: index % 2 ? 'local' : 'network' };
    await sleep(10);
  }
  assert.equal(f.provider.health().loaded, false, 'priority refresh must not reset the idle timer');
  assert.equal(f.provider.health().last_used, lastUsed);
  assert.equal(f.children.length, 1);
  assert.deepEqual(f.children[0].kills, ['SIGTERM']);
  assert.ok(f.provider.health().embedding_provider.priority >= 30);
  assert.equal(f.provider.health().sharing, 'local');
});

test('prepared model metadata reads only manifest/config and preserves encoding compatibility', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'embedding-manifest-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'model'));
  await writeFile(path.join(dir, 'model/config.json'), JSON.stringify({ hidden_size: 2 }));
  const manifest = path.join(dir, 'manifest.json');
  await writeFile(manifest, JSON.stringify({ models: { qwen3: { path: path.join(dir, 'model'), revision: 'fixture-sha' } } }));
  assert.deepEqual(await readModelMetadata({ model: 'qwen3', manifest, maxLength: 512 }), metadata);
  await writeFile(path.join(dir, 'model/config.json'), JSON.stringify({ hidden_size: 4097 }));
  await assert.rejects(readModelMetadata({ model: 'qwen3', manifest, maxLength: 512 }), /hidden_size/);
  await writeFile(manifest, JSON.stringify({ models: { qwen3: { path: dir, revision: '' } } }));
  await assert.rejects(readModelMetadata({ model: 'qwen3', manifest, maxLength: 512 }), /exact revision/);
});

test('health/registration stay light; concurrent inference shares one child and unloads after last completion', async t => {
  const f = await fixture(t, [{ startupMs: 10, inferenceMs: 45 }], { idleTimeoutMs: 30 });
  assert.equal(f.children.length, 0);
  const health = await (await fetch(`${f.url}/health`)).json();
  assert.equal(health.service, 'dreammate-embedding-on-demand'); assert.equal(health.loaded, false);
  assert.equal(health.loading, false); assert.equal(health.last_used, null);
  assert.equal(health.embedding_provider.ready, true);
  assert.equal(health.embedding_provider.lifecycle, 'on_demand');
  const first = f.embed(), second = f.embed();
  await until(() => f.children.length === 1);
  await sleep(35);
  assert.equal(f.children[0].kills.length, 0, 'idle clock must not interrupt loading/inference/queue');
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.equal(f.children[0].requests.length, 2);
  assert.equal(f.calls[0].spawnOptions.shell, false);
  assert.equal(f.calls[0].args.includes('--device'), true);
  assert.equal(f.provider.health().loaded, true);
  await until(() => f.provider.health().loaded === false);
  assert.deepEqual(f.children[0].kills, ['SIGTERM']);
  assert.ok(f.provider.health().last_used);
  assert.equal((await f.embed()).status, 200);
  assert.equal(f.children.length, 2, 'next request must restart an unloaded worker');
});

test('health polling does not postpone an idle unload', async t => {
  const f = await fixture(t, [{}], { idleTimeoutMs: 35 });
  assert.equal((await f.embed()).status, 200);
  for (let index = 0; index < 8; index++) { await fetch(`${f.url}/health`); await sleep(10); }
  assert.equal(f.provider.health().loaded, false);
  assert.equal(f.children.length, 1);
});

test('bounded queue rejects overload without starting extra workers', async t => {
  const f = await fixture(t, [{ inferenceMs: 80 }], { maxPending: 2 });
  const first = f.embed(); await until(() => f.provider.health().pending_requests === 1);
  const second = f.embed(); await until(() => f.provider.health().pending_requests === 2);
  assert.equal((await f.embed()).status, 429);
  assert.equal((await first).status, 200); assert.equal((await second).status, 200);
  assert.equal(f.children.length, 1);
});

test('startup and inference timeouts retire the failed worker and later calls recover', async t => {
  for (const bad of [{ noReady: true }, { hang: true }]) {
    const f = await fixture(t, [bad, {}], { startupTimeoutMs: 35, inferenceTimeoutMs: 35 });
    const failed = await f.embed();
    assert.equal(failed.status, 503); assert.match(failed.body.error, /timed out/);
    assert.deepEqual(f.children[0].kills, ['SIGTERM']);
    assert.equal((await f.embed()).status, 200);
    assert.equal(f.children.length, 2);
    await f.provider.stop();
  }
});

test('a real spawn failure without a PID allows the next request to start a worker', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'embedding-failed-spawn-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let attempts = 0;
  const f = await fixture(t, [], {}, {
    spawn(_command, args, options) {
      attempts++;
      return attempts === 1 ? spawn(path.join(directory, 'missing-python'), args, options) : new FakeChild();
    },
    shutdownTimeoutMs: 1,
  });
  const failed = await f.embed();
  assert.equal(failed.status, 503);
  assert.equal(failed.body.error, 'Could not start the local encoder');
  assert.equal((await f.embed()).status, 200);
  assert.equal(attempts, 2, 'a child that was never created must not permanently block retries');
});

test('an existing worker without a confirmed exit still blocks replacement', async t => {
  let attempts = 0;
  const child = new FakeChild({ noReady: true });
  child.kill = signal => { child.kills.push(signal); return false; };
  const f = await fixture(t, [], { startupTimeoutMs: 10 }, {
    spawn() { attempts++; return child; },
    shutdownTimeoutMs: 1,
  });
  assert.equal((await f.embed()).status, 503);
  const retry = await f.embed();
  assert.equal(retry.status, 503);
  assert.equal(retry.body.error, 'Previous local encoder has not exited');
  assert.equal(attempts, 1);
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
});

test('strict worker response IDs, metadata and vectors fail closed then recover', async t => {
  const responses = [
    request => ({ type: 'result', id: 'wrong-id', result: result(request) }),
    request => ({ type: 'result', id: request.id, result: { ...result(request), model: 'different@revision' } }),
    request => ({ type: 'result', id: request.id, result: { ...result(request), embeddings: [[0, 0]] } }),
    request => ({ type: 'error', id: request.id, error: 'Do not trust or echo this' }),
  ];
  for (const respond of responses) {
    const f = await fixture(t, [{ respond }, {}]);
    const failed = await f.embed(); assert.equal(failed.status, 503);
    assert.equal(failed.body.error, 'Local encoder returned an invalid response');
    assert.equal((await f.embed()).status, 200);
    await f.provider.stop();
  }
});

test('invalid public requests are rejected before loading a model', async t => {
  const f = await fixture(t);
  for (const value of [null, [], {}, { ...input, extra: 1 }, { ...input, model: 'cloud' },
    { ...input, texts: [] }, { ...input, texts: [' '] }, { ...input, texts: ['a'.repeat(8193)] },
    { ...input, input_type: 'arbitrary' }]) assert.equal((await f.embed(value)).status, 400);
  assert.equal((await fetch(`${f.url}/embed`, { method: 'POST', body: 'not json' })).status, 400);
  assert.equal((await fetch(`${f.url}/embed`, { method: 'POST', body: ' '.repeat(262145) })).status, 413);
  assert.equal((await fetch(`${f.url}/missing`)).status, 404);
  assert.equal(f.children.length, 0);
  assert.equal(validateEmbedRequest({ ...input, model: undefined }, 'qwen3').model, 'qwen3');
});

test('advertisement retries after Node restart and conditional shutdown cannot delete a replacement', async t => {
  const requests = []; let offline = true, ownDescriptor, replaced = false;
  const f = await fixture(t, [{}], { register: true, idleTimeoutMs: 20 }, {
    registrationIntervalMs: 15,
    async requestAgent(url, request = {}) {
      requests.push({ url, ...request });
      if (request.method === 'POST') {
        if (offline) throw new Error('Node offline');
        ownDescriptor = request.body; return { body: { ok: true } };
      }
      if (!request.method) return { body: replaced ? { ...ownDescriptor, metadata: {} } : ownDescriptor, etag: '"fixture-etag"' };
      if (request.method === 'DELETE') {
        assert.equal(request.headers['if-match'], '"fixture-etag"'); return { body: {} };
      }
    },
  });
  assert.equal(f.children.length, 0); assert.equal(f.provider.health().registration.registered, false);
  offline = false; await until(() => f.provider.health().registration.registered);
  assert.equal(ownDescriptor.metadata.embedding_provider.priority, 100);
  assert.equal(ownDescriptor.metadata.embedding_provider.lifecycle, 'on_demand');
  assert.ok(ownDescriptor.metadata.embedding_provider.instance_id);
  assert.equal(f.children.length, 0, 'periodic registration must not load weights');
  offline = true; await until(() => !f.provider.health().registration.registered);
  offline = false; await until(() => f.provider.health().registration.registered);
  replaced = true; await f.provider.stop(); await f.provider.stop();
  assert.equal(requests.filter(request => request.method === 'DELETE').length, 0);
});

test('shutdown withdraws only owned ETag-protected registration', async t => {
  let descriptor; const deleted = [];
  const f = await fixture(t, [{}], { register: true }, {
    async requestAgent(_url, request = {}) {
      if (request.method === 'POST') { descriptor = request.body; return { body: {} }; }
      if (!request.method) return { body: descriptor, etag: '"owned"' };
      deleted.push(request); return { body: {} };
    },
  });
  await f.provider.stop(); assert.equal(deleted.length, 1);
  assert.equal(deleted[0].headers['if-match'], '"owned"');
});

test('shutdown rejects active/queued requests, terminates child and closes listener', async t => {
  const f = await fixture(t, [{ noReady: true }]);
  const first = f.embed(), second = f.embed();
  await until(() => f.provider.health().pending_requests === 2);
  await f.provider.stop();
  const outcomes = await Promise.allSettled([first, second]);
  for (const outcome of outcomes) if (outcome.status === 'fulfilled') assert.equal(outcome.value.status, 503);
  assert.equal(f.provider.server.listening, false);
  assert.deepEqual(f.children[0].kills, ['SIGTERM']);
});

test('client cancellation removes queued work and retires abandoned active inference', async t => {
  const f = await fixture(t, [{ hang: true }, {}], { idleTimeoutMs: 35 });
  const activeController = new AbortController(), queuedController = new AbortController();
  const send = signal => fetch(`${f.url}/embed`, { method: 'POST', body: JSON.stringify(input), signal }).catch(error => error);
  const first = send(activeController.signal);
  await until(() => f.children[0]?.requests.length === 1);
  const second = send(queuedController.signal);
  await until(() => f.provider.health().pending_requests === 2);
  queuedController.abort(); await second;
  await until(() => f.provider.health().pending_requests === 1);
  assert.equal(f.children[0].requests.length, 1, 'cancelled queued request must never reach Python');
  activeController.abort(); await first;
  await until(() => f.provider.health().pending_requests === 0);
  assert.equal(f.provider.health().loaded, false);
  assert.equal(f.provider.health().last_used, null, 'abandoned work must not reset the idle clock');
  assert.deepEqual(f.children[0].kills, ['SIGTERM']);
  assert.equal((await f.embed()).status, 200, 'a subsequent live request can start a fresh worker');
});

test('worker readiness mismatch never receives private texts', async t => {
  const f = await fixture(t, [{ metadata: { ...metadata, revision: 'wrong-sha' } }]);
  assert.equal((await f.embed()).status, 503);
  assert.equal(f.children[0].requests.length, 0);
});

test('registration transport keeps ETag and refuses redirects', async t => {
  const { createServer } = await import('node:http');
  const server = createServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { location: '/service' }); return response.end(); }
    response.writeHead(200, { etag: '"current"' }); response.end('{"port":8766}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await requestAgent(`${url}/service`), { body: { port: 8766 }, etag: '"current"' });
  await assert.rejects(requestAgent(`${url}/redirect`), /HTTP 302/);
});

test('private Python worker isolates library stdout and speaks bounded JSON-lines protocol', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'embedding-worker-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await copyFile(new URL('../scripts/local-embeddings/worker.py', import.meta.url), path.join(dir, 'worker.py'));
  await copyFile(new URL('../scripts/local-embeddings/vector_cache.py', import.meta.url), path.join(dir, 'vector_cache.py'));
  await writeFile(path.join(dir, 'server.py'), `
from collections import OrderedDict
from types import SimpleNamespace

class Encoder:
    def __init__(self, *args):
        print("library stdout belongs on stderr")
        self.encoder = SimpleNamespace(get_sentence_embedding_dimension=lambda: 2)
        self.dimensions = {}
        self.document_cache = OrderedDict()
        self.models = {"qwen3":{"revision":"fixture-sha"}}
    def load(self, alias):
        return "qwen3@fixture-sha"
    def encoding_profile(self, dimensions):
        return "fixture-encoding:dim2"
    def encode(self, alias, texts, input_type):
        print("encoding without leaking into protocol")
        return {"model":"fixture", "embeddings":[[1,0] for _ in texts]}
    def embedding_provider(self):
        return {"ready":True}
`);
  const child = spawn('python3', [path.join(dir, 'worker.py'), '--manifest', path.join(dir, 'manifest.json')], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  await until(() => output.includes('\n'));
  child.stdin.write(`${JSON.stringify({ id: 'one', model: 'qwen3', texts: ['hello'], input_type: 'query' })}\n`);
  await until(() => output.trim().split('\n').length === 2);
  child.stdin.end(); await once(child, 'exit');
  const lines = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines[0].type, 'ready'); assert.equal(lines[1].type, 'result'); assert.equal(lines[1].id, 'one');
  assert.match(errors, /library stdout belongs on stderr/);
  const startup = errors.split('\n').find(line => line.startsWith('{"event": "encoder_ready"'));
  assert.ok(startup, 'startup diagnostics must not enter stdout');
  const timing = JSON.parse(startup);
  assert.equal(timing.restored_document_vectors, 0);
  assert.ok(timing.startup_ms >= 0);
  assert.equal(errors.match(/encoding without leaking into protocol/g)?.length, 1,
    'startup must load model metadata without performing a discarded warmup query');
});

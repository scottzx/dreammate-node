import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { createRoutedProvider, parseOptions, routeInvocation } from '../scripts/local-embeddings/on-demand.mjs';

const QWEN = 'qwen3', GEMMA = 'embeddinggemma2';
const profile = model => ({ protocol: 'dreammate.embedding.v1', model,
  revision: `${model}-fixture-sha`, dimensions: model === QWEN ? 1024 : 768,
  encoding: model === QWEN ? 'dreammate.tool-search.v1:fp32:max512:dim1024'
    : 'dreammate.gemma2.v1:fp32:max2048:dim768', ready: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= deadline) assert.fail('Condition timed out'); await sleep(5); }
}
const text = (target = undefined) => ({ method: 'embedding.encode',
  params: { texts: ['眼镜'], input_type: 'query', ...(target ? { target } : {}) } });
const media = () => ({ method: 'embedding.encode_media', params: { items: [{ image: 'portrait.png' }] } });

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  requests = [];
  kills = [];
  dead = false;
  retiring = false;
  constructor(model, state, behavior = {}) {
    super();
    this.model = model;
    this.pid = 1000 + state.children.length;
    state.alive++;
    state.maxAlive = Math.max(state.maxAlive, state.alive);
    state.events.push({ type: 'spawn', model, pid: this.pid });
    this.stdin = new Writable({ write: (data, _encoding, done) => {
      const request = JSON.parse(data.toString());
      this.requests.push(request);
      state.events.push({ type: 'request', model, id: request.id });
      done();
      setTimeout(() => {
        if (this.dead || this.retiring) return;
        const provider = profile(model);
        const result = { model: `${model}@${provider.revision}`, alias: model,
          revision: provider.revision, dimensions: provider.dimensions, encoding: provider.encoding,
          ...(request.operation === 'compare' ? { scores: request.items.map(() => .8) }
            : { embeddings: (request.items ?? request.texts).map(() => [1, ...Array(provider.dimensions - 1).fill(0)]) }) };
        state.events.push({ type: 'response', model, id: request.id });
        this.stdout.write(`${JSON.stringify({ type: 'result', id: request.id,
          result: behavior.result ? behavior.result(result) : result })}\n`);
      }, behavior.inferenceMs ?? 1);
    } });
    setTimeout(() => {
      if (!this.dead && !this.retiring) this.stdout.write(`${JSON.stringify({ type: 'ready', provider: behavior.provider ?? profile(model) })}\n`);
    }, behavior.startupMs ?? 1);
    this.kill = signal => {
      this.kills.push(signal);
      state.events.push({ type: 'signal', model, signal, pid: this.pid });
      if (!this.dead && !this.retiring) {
        this.retiring = true;
        setTimeout(() => {
          this.dead = true; state.alive--;
          state.events.push({ type: 'exit', model, pid: this.pid });
          this.emit('exit', 0, signal);
        }, behavior.exitMs ?? 15);
      }
      return true;
    };
  }
}

async function fixture(t, options = {}, dependencies = {}, behavior = {}) {
  const state = { children: [], calls: [], events: [], alive: 0, maxAlive: 0 };
  const provider = await createRoutedProvider({ port: 0, gemmaPort: 0, register: false,
    python: '/fixture/qwen-python', gemmaPython: '/fixture/gemma-python',
    manifest: '/fixture/qwen-manifest.json', gemmaManifest: '/fixture/gemma-manifest.json',
    mediaRoot: '/fixture/media', gemmaModalities: 'vision', gemmaMaxLength: 2048, mpsLimitMb: 4096,
    idleTimeoutMs: 1000, startupTimeoutMs: 1000, inferenceTimeoutMs: 1000, ...options }, {
    readPriorityConfig: async () => undefined,
    readModelMetadata: async options => profile(options.model),
    spawn(command, args, spawnOptions) {
      const model = args[args.indexOf('--model') + 1];
      state.calls.push({ command, args, spawnOptions, model });
      const child = new FakeChild(model, state, typeof behavior === 'function' ? behavior(model, state) : behavior);
      state.children.push(child);
      return child;
    }, log() {}, workerLog() {}, ...dependencies,
  });
  t.after(() => provider.stop());
  await provider.start();
  const url = model => `http://127.0.0.1:${provider.backends.get(model).descriptor().port}`;
  const post = async (route, body, model = QWEN) => {
    const response = await fetch(`${url(model)}${route}`, { method: 'POST', body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { provider, state, url, post };
}

test('content routing separates pure text from text querying a multimodal index', () => {
  assert.equal(parseOptions([]).idleTimeoutMs, 60000);
  assert.deepEqual(routeInvocation(text()), { model: QWEN,
    request: { model: QWEN, texts: ['眼镜'], input_type: 'query' } });
  assert.deepEqual(routeInvocation({ ...text(), capability: 'embedding.encode' }), routeInvocation(text()), 'Node gateway includes the compatibility capability field');
  assert.deepEqual(routeInvocation({ capability: 'embedding.encode', params: text().params }), routeInvocation(text()));
  assert.throws(() => routeInvocation({ ...text(), capability: 'embedding.compare' }), error => error.status === 400);
  assert.deepEqual(routeInvocation(text('multimodal')), { model: GEMMA,
    request: { model: GEMMA, texts: ['眼镜'], input_type: 'query' } });
  assert.equal(routeInvocation(text('text'), GEMMA).model, QWEN);
  assert.equal(routeInvocation({ method: 'embedding.encode_text', params: { texts: ['hello'] } }, GEMMA).model, GEMMA,
    'fixed Gemma endpoint must never create Qwen vectors for a media index');
  assert.deepEqual(routeInvocation(media()), { model: GEMMA,
    request: { operation: 'media', items: [{ image: 'portrait.png' }] } });
  assert.equal(routeInvocation({ method: 'embedding.encode', params: { items: [{ text: 'hello' }] } }).model, QWEN);
  assert.equal(routeInvocation({ method: 'embedding.encode', params: { items: [{ text: 'hello', video: 'clip.mp4' }] } }).model, GEMMA);
  assert.equal(routeInvocation({ method: 'embedding.compare', params: { query: '眼镜', items: [{ image: 'portrait.png' }] } }).model, GEMMA);
  for (const invocation of [text('unknown'), { method: 'embedding.encode', params: { target: 'text', items: [{ image: 'portrait.png' }] } },
    { method: 'embedding.encode', params: { texts: ['hello'], items: [{ image: 'portrait.png' }] } }]) {
    assert.throws(() => routeInvocation(invocation), error => error.status === 400);
  }
});

test('dual listeners stay lightweight and expose fixed profiles through actual HTTP requests', async t => {
  const f = await fixture(t);
  assert.equal(f.provider.backends.size, 2);
  assert.notEqual(f.url(QWEN), f.url(GEMMA));
  for (const model of [QWEN, GEMMA]) {
    const health = await (await fetch(`${f.url(model)}/health`)).json();
    assert.equal(health.loaded, false);
    assert.equal(health.exclusive, true);
    assert.equal(health.active_model, null);
    assert.equal(health.embedding_provider.model, model);
    assert.equal(health.embedding_provider.encoding, profile(model).encoding);
  }
  assert.equal(f.state.children.length, 0);
  assert.equal((await f.post('/invoke', { ...text(), capability: 'embedding.encode' })).status, 200);
  const qwen = await f.post('/embed', { texts: ['Find tools'], input_type: 'query' });
  assert.equal(qwen.status, 200);
  assert.equal(qwen.body.encoding, profile(QWEN).encoding);
  const gemma = await f.post('/embed', { texts: ['眼镜'], input_type: 'query' }, GEMMA);
  assert.equal(gemma.status, 200);
  assert.equal(gemma.body.encoding, profile(GEMMA).encoding);
  assert.equal(gemma.body.dimensions, 768);
  assert.equal(f.state.maxAlive, 1);
  assert.equal((await f.post('/embed', { model: GEMMA, texts: ['x'], input_type: 'query' })).status, 400);
  assert.equal((await f.post('/embed', { model: QWEN, texts: ['x'], input_type: 'query' }, GEMMA)).status, 400);
});

test('Qwen → Gemma → Qwen waits for each old worker exit before spawning the next', async t => {
  const f = await fixture(t, {}, {}, { exitMs: 35 });
  const outputs = [await f.post('/invoke', text()), await f.post('/invoke', text('multimodal')),
    await f.post('/invoke', text())];
  assert.deepEqual(outputs.map(result => result.status), [200, 200, 200]);
  assert.deepEqual(outputs.map(result => result.body.alias), [QWEN, GEMMA, QWEN]);
  assert.deepEqual(f.state.children.map(child => child.model), [QWEN, GEMMA, QWEN]);
  assert.equal(f.state.maxAlive, 1);
  const lifecycle = f.state.events.filter(event => ['spawn', 'exit'].includes(event.type));
  assert.deepEqual(lifecycle.map(event => `${event.type}:${event.model}`),
    [`spawn:${QWEN}`, `exit:${QWEN}`, `spawn:${GEMMA}`, `exit:${GEMMA}`, `spawn:${QWEN}`]);
  assert.deepEqual(f.state.children.slice(0, 2).map(child => child.kills), [['SIGTERM'], ['SIGTERM']]);
  assert.equal(f.provider.health().active_model, QWEN);
  assert.equal(f.state.calls[1].args[0].endsWith('/gemma_worker.py'), true);
  assert.equal(f.state.calls[1].args.includes('--media-root'), true);
  assert.equal(f.state.calls[1].args.includes('--mps-limit-mb'), true);
  assert.equal(f.state.calls[1].spawnOptions.shell, false);
});

test('concurrent cross-model requests queue and do not interrupt in-flight inference', async t => {
  const f = await fixture(t, { idleTimeoutMs: 15 }, {}, { inferenceMs: 60, exitMs: 20 });
  const first = f.post('/invoke', text());
  await until(() => f.state.children[0]?.requests.length === 1);
  const second = f.post('/invoke', media());
  await sleep(20);
  const third = f.post('/invoke', text());
  await sleep(15);
  assert.deepEqual(f.state.children[0].kills, [], 'neither switching nor idle timeout may kill an active request');
  assert.equal(f.state.children.length, 1);
  const outputs = await Promise.all([first, second, third]);
  assert.deepEqual(outputs.map(result => result.status), [200, 200, 200]);
  assert.equal(f.state.maxAlive, 1);
  const firstResponse = f.state.events.findIndex(event => event.type === 'response' && event.model === QWEN);
  const firstSignal = f.state.events.findIndex(event => event.type === 'signal' && event.model === QWEN);
  assert.ok(firstSignal > firstResponse, 'switch must wait for the query result');
  assert.deepEqual(f.state.children.map(child => child.model), [QWEN, GEMMA, QWEN]);
});

test('global FIFO preserves A Qwen → B Qwen → C Gemma arrival order across backend queues', async t => {
  const f = await fixture(t, {}, {}, { inferenceMs: 35 });
  const first = f.provider.invoke({ method: 'embedding.encode', params: { texts: ['A'], input_type: 'query' } });
  await until(() => f.state.children[0]?.requests.length === 1);
  const second = f.provider.invoke({ method: 'embedding.encode', params: { texts: ['B'], input_type: 'query' } });
  const third = f.provider.invoke(media());
  const results = await Promise.all([first, second, third]);
  assert.deepEqual(results.map(result => result.alias), [QWEN, QWEN, GEMMA]);
  assert.deepEqual(f.state.events.filter(event => event.type === 'request').map(event => event.model), [QWEN, QWEN, GEMMA]);
  assert.deepEqual(f.state.children[0].requests.map(request => request.texts[0]), ['A', 'B']);
  const responses = f.state.events.filter(event => event.type === 'response').map(event => event.model);
  assert.deepEqual(responses, [QWEN, QWEN, GEMMA]);
  assert.deepEqual(f.state.children.map(child => child.model), [QWEN, GEMMA], 'same-model pending request should reuse its worker');
  assert.equal(f.state.maxAlive, 1);
});

test('cancelling a request waiting for the other model leaves active inference and its worker intact', async t => {
  const f = await fixture(t, {}, {}, { inferenceMs: 70 });
  const first = f.provider.invoke(text());
  await until(() => f.state.children[0]?.requests.length === 1);
  const controller = new AbortController();
  const cancelled = assert.rejects(f.provider.invoke(media(), controller.signal), /cancelled/);
  const third = f.provider.invoke(text());
  controller.abort();
  await cancelled;
  await Promise.all([first, third]);
  assert.deepEqual(f.state.children.map(child => child.model), [QWEN]);
  assert.deepEqual(f.state.children[0].kills, []);
  assert.equal(f.state.maxAlive, 1);
});

test('stopping a backend aborts its waiting requests without unloading the other backend', async t => {
  const f = await fixture(t, {}, {}, { inferenceMs: 70 });
  const first = f.provider.invoke(media());
  await until(() => f.state.children[0]?.requests.length === 1);
  const cancelled = assert.rejects(f.provider.invoke(text()), /stopped/);
  await f.provider.backends.get(QWEN).stop();
  await cancelled; await first; await sleep(10);
  assert.deepEqual(f.state.children.map(child => child.model), [GEMMA]);
  assert.deepEqual(f.state.children[0].kills, []);
});

test('idle config reload uses the last completion deadline and retains the fixed Gemma priority', async t => {
  let config = { version: 1, priority: 120, idle_timeout_ms: 2000 };
  const f = await fixture(t, {}, { readPriorityConfig: async () => config });
  await f.provider.invoke(media());
  const gemma = f.provider.backends.get(GEMMA), lastUsed = gemma.health().last_used;
  assert.equal(gemma.health().embedding_provider.priority, -10);
  await sleep(30);
  config = { version: 1, priority: 125, idle_timeout_ms: 10 };
  await f.provider.refresh();
  await until(() => f.state.alive === 0);
  assert.equal(gemma.health().last_used, lastUsed);
  assert.equal(gemma.health().idle_timeout_ms, 10);
  assert.equal(f.provider.health().embedding_provider.priority, 125);
  assert.equal(gemma.health().embedding_provider.priority, -10);
});

test('a worker refusing to exit blocks the other model and keeps its unloading PID visible', async t => {
  const f = await fixture(t, {}, { shutdownTimeoutMs: 1 });
  await f.provider.invoke(text());
  const child = f.state.children[0], kill = child.kill;
  child.kill = signal => { child.kills.push(signal); return true; };
  const failed = assert.rejects(f.provider.invoke(media()), /has not exited/);
  await until(() => f.provider.health().unloading);
  assert.equal(f.provider.health().worker_pid, child.pid);
  assert.equal(f.provider.health().active_model, QWEN);
  await failed;
  assert.equal(f.state.children.length, 1);
  assert.equal(f.state.maxAlive, 1);
  child.kill = kill; child.kill('SIGKILL');
  await until(() => child.dead);
  await f.provider.invoke(media());
  assert.deepEqual(f.state.children.map(child => child.model), [QWEN, GEMMA]);
  assert.equal(f.state.maxAlive, 1);
});

test('prewarm starts only one model without sending inference and health does not extend its idle deadline', async t => {
  const f = await fixture(t, { idleTimeoutMs: 60 });
  const warmed = await f.post('/invoke', { method: 'embedding.prewarm', params: { target: 'multimodal' } });
  assert.equal(warmed.status, 200);
  assert.equal(warmed.body.model, GEMMA);
  assert.equal(warmed.body.encoding, profile(GEMMA).encoding);
  assert.equal(warmed.body.warmed, true);
  assert.equal(f.state.children.length, 1);
  assert.equal(f.state.children[0].requests.length, 0);
  const gemma = f.provider.backends.get(GEMMA);
  const lastUsed = gemma.health().last_used;
  assert.ok(lastUsed);
  for (let index = 0; index < 9; index++) {
    const status = await f.post('/invoke', { method: 'embedding.status', params: {} });
    assert.equal(status.status, 200);
    await fetch(`${f.url(GEMMA)}/health`);
    await sleep(12);
  }
  await until(() => f.state.alive === 0);
  assert.equal(gemma.health().loaded, false);
  assert.equal(gemma.health().last_used, lastUsed);
  assert.deepEqual(f.state.children[0].kills, ['SIGTERM']);
  assert.equal(f.state.children[0].requests.length, 0);
  assert.equal(f.state.children.length, 1);
});

test('a later call renews idle time from its completion and an unloaded worker restarts on demand', async t => {
  const f = await fixture(t, { idleTimeoutMs: 70 }, {}, { inferenceMs: 15 });
  assert.equal((await f.post('/invoke', media())).status, 200);
  const firstUsed = f.provider.backends.get(GEMMA).health().last_used;
  await sleep(40);
  assert.equal((await f.post('/invoke', media())).status, 200);
  const lastUsed = f.provider.backends.get(GEMMA).health().last_used;
  assert.notEqual(lastUsed, firstUsed);
  await sleep(35);
  assert.equal(f.state.children.length, 1);
  assert.equal(f.state.children[0].kills.length, 0);
  await until(() => f.state.alive === 0);
  assert.equal((await f.post('/invoke', media())).status, 200);
  assert.equal(f.state.children.length, 2);
  assert.equal(f.state.maxAlive, 1);
});

test('vision mode rejects audio and invalid routing before loading or disrupting a healthy model', async t => {
  const f = await fixture(t);
  const cases = [
    { method: 'embedding.encode_media', params: { items: [{ audio: 'voice.wav' }] } },
    { method: 'embedding.compare', params: { query: 'voice', items: [{ audio: 'voice.wav' }] } },
    text('bogus'),
    { method: 'embedding.encode', params: { target: 'text', items: [{ video: 'clip.mp4' }] } },
  ];
  for (const invocation of cases) assert.equal((await f.post('/invoke', invocation)).status, 400);
  assert.equal(f.state.children.length, 0);
  assert.equal((await f.post('/invoke', text())).status, 200);
  const child = f.state.children[0];
  for (const invocation of cases) assert.equal((await f.post('/invoke', invocation)).status, 400);
  assert.equal(f.state.children.length, 1);
  assert.deepEqual(child.kills, []);
  assert.equal(f.provider.health().active_model, QWEN);
});

test('missing Gemma metadata leaves Qwen operational and returns 503 rather than mixing vector spaces', async t => {
  const f = await fixture(t, {}, { readModelMetadata: async options => {
    if (options.model === GEMMA) throw new Error('Gemma is not downloaded');
    return profile(options.model);
  } });
  assert.equal(f.provider.backends.size, 1);
  assert.match(f.provider.health().multimodal_unavailable, /Gemma/);
  assert.equal((await f.post('/invoke', text())).status, 200);
  for (const invocation of [media(), text('multimodal'), { method: 'embedding.prewarm', params: { target: 'multimodal' } }]) {
    const response = await f.post('/invoke', invocation);
    assert.equal(response.status, 503);
    assert.match(response.body.error, /embeddinggemma2.*unavailable/);
  }
  assert.equal(f.state.children.length, 1);
  assert.equal(f.state.children[0].model, QWEN);
  assert.deepEqual(f.state.children[0].kills, []);
  assert.equal((await f.post('/invoke', text())).status, 200);
});

test('compare uses Gemma and incompatible readiness or result profiles fail closed', async t => {
  const f = await fixture(t);
  const compared = await f.post('/invoke', { method: 'embedding.compare',
    params: { query: '戴眼镜的人', items: [{ image: 'portrait.png' }, { video: 'clip.mp4' }] } });
  assert.equal(compared.status, 200);
  assert.equal(compared.body.alias, GEMMA);
  assert.deepEqual(compared.body.scores, [.8, .8]);
  for (const behavior of [{ provider: { ...profile(GEMMA), encoding: 'other-space' } },
    { result: result => ({ ...result, encoding: profile(QWEN).encoding }) }]) {
    const bad = await fixture(t, {}, {}, behavior);
    const response = await bad.post('/invoke', media());
    assert.equal(response.status, 503);
    assert.equal(bad.state.children.length, 1);
    assert.equal(bad.state.children[0].model, GEMMA);
    if (behavior.provider) assert.equal(bad.state.children[0].requests.length, 0);
    await bad.provider.stop();
  }
});

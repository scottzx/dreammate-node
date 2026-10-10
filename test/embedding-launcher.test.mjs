import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import { launchProvider, localAgentUrl, parseOptions, providerDescriptor, registrationPayload,
  REPO_ROOT, requestJson } from '../scripts/local-embeddings/serve.mjs';

const descriptor = { protocol: 'dreammate.embedding.v1', model: 'qwen3', revision: 'fixture-sha',
  dimensions: 1024, encoding: 'dreammate.tool-search.v1:fp32:max512:dim1024', ready: true };
const health = { status: 'ok', pid: 1234, embedding_provider: descriptor };

class FakeChild extends EventEmitter {
  pid = 1234;
  kills = [];
  kill(signal) {
    this.kills.push(signal);
    queueMicrotask(() => this.emit('exit', 0, signal));
    return true;
  }
}

test('launcher import is inert and defaults resolve repository paths across working directories', () => {
  const options = parseOptions([], '/private/tmp/another-project');
  assert.equal(options.model, 'qwen3');
  assert.equal(options.port, 8766);
  assert.equal(options.priority, 0);
  assert.equal(options.python, path.join(REPO_ROOT, '.local/tool-search/venv/bin/python'));
  assert.equal(options.manifest, path.join(REPO_ROOT, '.local/tool-search/manifest.json'));
  assert.equal(parseOptions(['--manifest', 'fixture.json'], '/private/tmp').manifest, '/private/tmp/fixture.json');
  assert.equal(parseOptions(['--python', '/custom/python', '--priority=-2']).python, '/custom/python');
});

test('launcher rejects nonloopback agents and invalid flags before creating a child', () => {
  for (const value of ['http://100.100.10.20:36908', 'https://example.com', 'http://127.0.0.1.example.com',
    'http://127.0.0.1:36908/path', 'http://user@127.0.0.1', 'http://127.0.0.1/?x=1',
    'http://127.0.0.1/#x', 'file:///tmp', 'http://[::ffff:127.0.0.1]']) {
    assert.throws(() => localAgentUrl(value), value);
  }
  assert.equal(localAgentUrl('http://localhost:36908'), 'http://127.0.0.1:36908');
  assert.equal(localAgentUrl('http://[::1]:36908'), 'http://[::1]:36908');
  for (const args of [['--model', 'cloud'], ['--model', 'embeddinggemma2'], ['--port', '0'], ['--port', '65536'], ['--port', '1e3'],
    ['--priority', '1.2'], ['--batch-size', '0'], ['--batch-size', '65'], ['--batch-size', '1.5'],
    ['--python', ' '], ['--manifest', ''], ['--unknown']]) assert.throws(() => parseOptions(args));
});

test('ready descriptor must come from the owned child and retain encoding compatibility fields', () => {
  assert.deepEqual(providerDescriptor(health, 'qwen3', 1234), descriptor);
  for (const bad of [{ ...health, pid: 55 }, { ...health, status: 'loading' },
    ...[{ ready: false }, { model: 'embeddinggemma2' }, { revision: '' }, { dimensions: 0 },
      { dimensions: 4097 }, { encoding: '' }, { protocol: 'unknown' }]
      .map(change => ({ ...health, embedding_provider: { ...descriptor, ...change } }))]) {
    assert.throws(() => providerDescriptor(bad, 'qwen3', 1234));
  }
  const entry = registrationPayload(parseOptions(['--priority', '3']), descriptor);
  assert.deepEqual(entry, { id: 'dreammate-embedding-8766', name: 'Local embedding (qwen3)',
    kind: 'generic', port: 8766, reachability: 'localhost', health: '/health', execution: 'http',
    metadata: { embedding_provider: { ...descriptor, priority: 3 } } });
  assert.ok(!('methods' in entry) && !('capabilities' in entry), 'encoding provider must not pollute tool search');
});

test('priority and descriptor boundaries remain discoverable without silently changing metadata', () => {
  for (const priority of [-1000, 1000]) {
    assert.equal(parseOptions([`--priority=${priority}`]).priority, priority);
  }
  for (const priority of [-1001, 1001, 1.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => parseOptions([`--priority=${priority}`]), /priority/);
    assert.throws(() => launchProvider({ ...parseOptions([]), priority }, {
      spawn() { assert.fail('Invalid priority must not start an encoder'); },
    }), /Invalid provider options/);
  }
  const maximum = { ...health, embedding_provider: { ...descriptor, revision: 'r'.repeat(200), encoding: 'e'.repeat(200) } };
  assert.equal(providerDescriptor(maximum, 'qwen3', 1234).encoding.length, 200);
  assert.equal(providerDescriptor(maximum, 'qwen3', 1234).revision.length, 200);
  for (const change of [{ encoding: 'e'.repeat(201) }, { revision: 'r'.repeat(201) },
    { encoding: ` ${descriptor.encoding}` }, { encoding: `${descriptor.encoding}\n` },
    { revision: ' fixture-sha' }, { revision: 'fixture-sha ' }]) {
    assert.throws(() => providerDescriptor({ ...health, embedding_provider: { ...descriptor, ...change } }, 'qwen3', 1234));
  }
});

test('launcher warms one offline child, advertises only readiness, refreshes and withdraws once', async () => {
  const child = new FakeChild(), requests = [], logs = [], scheduled = [], canceled = [];
  let warmed = false, agentOffline = true;
  const options = parseOptions(['--model', 'qwen3', '--port', '8777', '--priority', '2', '--batch-size', '1']);
  const provider = launchProvider(options, {
    spawn(command, args, spawnOptions) {
      assert.equal(command, options.python);
      assert.deepEqual(args.slice(1), ['--manifest', options.manifest, '--host', '127.0.0.1',
        '--port', '8777', '--serve-model', 'qwen3', '--warmup', 'qwen3', '--batch-size', '1']);
      assert.equal(spawnOptions.shell, false);
      assert.equal(spawnOptions.cwd, REPO_ROOT);
      return child;
    },
    async requestJson(url, request = {}) {
      requests.push({ url, ...request });
      if (url.endsWith('/health')) return warmed ? health : { ...health, embedding_provider: { ready: false } };
      if (request.method === 'POST') {
        assert.ok(warmed, 'must not register before model encoding readiness');
        if (agentOffline) throw new Error('agent offline');
      }
      return { ok: true };
    },
    async sleep() { warmed = true; },
    setInterval(callback, ms) { scheduled.push({ callback, ms }); return 42; },
    clearInterval(id) { canceled.push(id); }, log(message) { logs.push(message); },
  });
  await provider.ready;
  assert.deepEqual(child.kills, [], 'agent registration failure must keep the encoder running');
  assert.equal(scheduled[0].ms, 15_000);
  agentOffline = false;
  assert.equal(await provider.refresh(), true);
  const posts = requests.filter(request => request.method === 'POST');
  assert.equal(posts.length, 2);
  assert.equal(posts[1].url, 'http://127.0.0.1:36908/services');
  assert.equal(posts[1].body.metadata.embedding_provider.priority, 2);
  assert.ok(logs.some(message => message.includes('restored')));
  await provider.stop();
  await provider.stop();
  assert.deepEqual(child.kills, ['SIGTERM']);
  assert.deepEqual(canceled, [42]);
  assert.equal(requests.filter(request => request.method === 'DELETE').length, 1);
  assert.equal(requests.find(request => request.method === 'DELETE').url,
    'http://127.0.0.1:36908/services/dreammate-embedding-8777');
  assert.equal(await provider.refresh(), false);
});

test('failed child cannot advertise or delete another process registration', async () => {
  const child = new FakeChild(), requests = [];
  const provider = launchProvider(parseOptions([]), {
    spawn() { queueMicrotask(() => child.emit('exit', 1, null)); return child; },
    async requestJson(url, request = {}) { requests.push(request); return { ...health, pid: 999 }; },
    sleep: async () => {}, log: () => {},
  });
  await assert.rejects(provider.ready, /Encoder exited/);
  await provider.stop();
  assert.ok(requests.every(request => !request.method), 'no registration changes without owned readiness');
  assert.deepEqual(child.kills, []);
});

test('registration HTTP helper rejects redirects and uses direct transport options', async () => {
  let calls = 0;
  const requestImpl = (_url, options, receive) => {
    calls++;
    assert.deepEqual(options.headers, { 'content-type': 'application/json', 'content-length': 11 });
    assert.equal(options.agent, false, 'must not inherit a global proxy agent');
    assert.ok(!('proxy' in options));
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = 302;
      response.resume = () => {};
      receive(response);
      request.emit('close');
    });
    return request;
  };
  await assert.rejects(requestJson('http://127.0.0.1:36908/services',
    { method: 'POST', body: { ready: 1 }, requestImpl }), /redirects are disabled/);
  assert.equal(calls, 1);
});

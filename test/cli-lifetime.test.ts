import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';

const entry = fileURLToPath(new URL('../bin/dreammate-node.ts', import.meta.url));

async function run(t: TestContext, preload: string, args: string[]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dreammate-lifetime-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hook = path.join(home, 'hook.mjs');
  fs.writeFileSync(hook, preload);
  return new Promise<{ code: number; stdout: string; stderr: string; killed: boolean }>(resolve => {
    execFile(process.execPath, ['--import', pathToFileURL(hook).href, '--import', 'tsx', entry, 'cli', ...args], {
      env: { ...process.env, HOME: home, DREAMMATE_AGENT_URL: '', DREAMMATE_NODES_FILE: '', TSX_DISABLE_CACHE: '1' },
      timeout: 6500, maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => resolve({ code: typeof error?.code === 'number' ? error.code : error ? -1 : 0,
      stdout, stderr, killed: !!error?.killed }));
  });
}

test('CLI exits after a DNS timeout even while the resolver keeps a handle alive', async t => {
  const result = await run(t, `
    import dns from 'node:dns';
    const original = dns.lookup;
    dns.lookup = function(host, options, callback) {
      if (host !== 'slow.example.test') return original.apply(this, arguments);
      setTimeout(() => callback(Object.assign(new Error('DNS delayed'), { code: 'EAI_AGAIN' })), 20000);
    };
  `, ['services', '--agent', 'http://slow.example.test:36908']);
  assert.ok(result.stdout, result.stderr);
  assert.equal(JSON.parse(result.stdout).structuredContent.scans[0].status, 'timeout');
  assert.equal(result.killed, false, 'HTTP timeout must also allow the one-shot process to finish');
  assert.equal(result.code, 1);
});

test('CLI keeps an otherwise idle request alive until its timeout can produce JSON', async t => {
  const result = await run(t, `
    globalThis.fetch = (_url, {signal}) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {once:true});
    });
  `, ['services', '--agent', 'http://idle.example.test:36908']);
  assert.equal(result.killed, false);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).structuredContent.scans[0].status, 'timeout');
});

test('per-node timeout still reports diagnostics if fetch ignores abort entirely', async t => {
  const result = await run(t, 'globalThis.fetch = () => new Promise(() => {});',
    ['services', '--agent', 'http://stuck.example.test:36908']);
  assert.equal(result.killed, false);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).structuredContent.scans[0].status, 'timeout');
});

test('all-node scan preserves successful peers when another response body never ends', async t => {
  const result = await run(t, `
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    const dir = path.join(os.homedir(), '.1agents');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'nodes.json'), JSON.stringify({
      format:'dreammate.nodes', version:1, exported_at:'2026-09-29T00:00:00Z', default_node:'fast',
      nodes: ['fast','slow'].map(name => ({node_id:name,name,type:'linux',agent_url:'http://'+name+'.example.test:36908'}))
    }));
    globalThis.fetch = async url => url.includes('fast.')
      ? new Response('{"services":[{"id":"notes"}]}')
      : new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));}}));
  `, ['services', '--node', 'all']);
  assert.equal(result.killed, false);
  assert.equal(result.code, 0, result.stdout);
  const data = JSON.parse(result.stdout).structuredContent;
  assert.equal(data.partial, true);
  assert.equal(data.services[0].service_id, 'notes');
  assert.deepEqual(data.scans.map((scan: { status: string }) => scan.status), ['ok', 'timeout']);
});

test('command deadline bounds invocation and returns a visible error without retry', async t => {
  const result = await run(t, `
    let calls = 0;
    globalThis.fetch = () => { if (++calls > 1) throw new Error('RETRIED'); return new Promise(() => {}); };
  `, ['invoke', '--agent', 'http://stuck.example.test:36908', '--service', 's', '--method', 'm', '--timeout-ms', '1000']);
  assert.equal(result.killed, false);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).structuredContent.code, 'COMMAND_TIMEOUT');
  assert.match(JSON.parse(result.stderr).error, /不要自动重试/);
});

test('CLI flushes large pipe output before terminating residual runtime handles', async t => {
  const result = await run(t, `
    setInterval(() => {}, 20000);
    globalThis.fetch = async () => new Response(JSON.stringify({payload:'x'.repeat(300000)}));
  `, ['invoke', '--agent', 'http://example.test:36908', '--service', 's', '--method', 'm']);
  assert.equal(result.killed, false);
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).structuredContent.payload.length, 300000);
});

test('CLI subcommand help and explicit target work without a default agent', async t => {
  const help = await run(t, '', ['nodes', 'export', '--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--default-node：/);
  assert.doesNotMatch(help.stdout, /inspect --service/);
  const direct = await run(t, `globalThis.fetch = async url => {
    if (url !== 'http://100.64.0.8:36908/services') throw new Error('Unexpected URL '+url);
    return new Response(JSON.stringify({services:[]}));
  };`, ['services', '--node', '100.64.0.8']);
  assert.equal(direct.code, 0, direct.stdout);
  for (const value of ['0', '-1', 'nan', '1.5', '3600001']) {
    const invalid = await run(t, '', ['services', '--timeout-ms', value]);
    assert.equal(invalid.code, 2);
    assert.equal(JSON.parse(invalid.stdout).isError, true);
  }
});

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runTunnelCli, tunnelTarget, type QuickTunnel } from '../src/tunnel-cli.js';

const entry = fileURLToPath(new URL('../bin/dreammate-node.ts', import.meta.url));

function capture<T>(body: () => Promise<T>): Promise<{ result: T; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => { stdout.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(' ')); };
  return body().finally(() => {
    console.log = log;
    console.error = error;
  }).then(result => ({ result, stdout: stdout.join('\n'), stderr: stderr.join('\n') }));
}

function fakeTunnel(): QuickTunnel & {
  emitUrl(url: string): void;
  emitError(error: Error): void;
  emitExit(code: number | null, signal: NodeJS.Signals | null): void;
  stopped: boolean;
} {
  const listeners = new Map<string, Set<(...args: never[]) => void>>();
  const on = (event: string, listener: (...args: never[]) => void) => {
    const bucket = listeners.get(event) ?? new Set();
    bucket.add(listener);
    listeners.set(event, bucket);
  };
  const emit = (event: string, ...args: never[]) => {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  };
  const tunnel = {
    stopped: false,
    stop() { tunnel.stopped = true; },
    on(event: 'url' | 'error' | 'exit', listener: (...args: never[]) => void) { on(event, listener); },
    emitUrl(url: string) { emit('url', url as never); },
    emitError(error: Error) { emit('error', error as never); },
    emitExit(code: number | null, signal: NodeJS.Signals | null) { emit('exit', code as never, signal as never); },
  };
  return tunnel;
}

test('tunnel 只接受回环源地址', () => {
  assert.deepEqual(tunnelTarget('http://127.0.0.1:8787'), {
    origin: 'http://127.0.0.1:8787', hostHeader: '127.0.0.1:8787',
  });
  assert.deepEqual(tunnelTarget('http://localhost:8787/'), {
    origin: 'http://localhost:8787', hostHeader: 'localhost:8787',
  });
  assert.equal(tunnelTarget('http://[::1]:9000').hostHeader, '[::1]:9000');
  for (const value of [
    'http://example.com:8787',
    'http://192.168.1.8:8787',
    'http://0.0.0.0:8787',
    'http://127.0.0.1:8787/mcp',
    'http://user:secret@127.0.0.1:8787',
    'http://127.0.0.1:8787?x=1',
    'http://127.0.0.1:0',
    'not a url',
  ]) {
    assert.throws(() => tunnelTarget(value), /回环|端口/, value);
  }
});

test('tunnel 帮助、拒绝公网地址，并在注入的隧道上改写 Host', async () => {
  const help = await capture(() => runTunnelCli(['--help']));
  assert.equal(help.result, 0);
  assert.match(help.stdout, /127\.0\.0\.1:8787/);
  assert.match(help.stdout, /可选依赖/);

  const rejected = await capture(() => runTunnelCli(['--url', 'http://example.com']));
  assert.equal(rejected.result, 2);
  assert.equal(rejected.stdout, '');

  const tunnel = fakeTunnel();
  const seen: { origin?: string; hostHeader?: string } = {};
  const pending = capture(() => runTunnelCli(['--url', 'http://127.1.2.3:8787'], {
    start(origin, hostHeader) {
      seen.origin = origin;
      seen.hostHeader = hostHeader;
      return tunnel;
    },
  }));
  tunnel.emitUrl('https://example.trycloudflare.com/');
  process.emit('SIGINT');
  tunnel.emitExit(null, 'SIGINT');
  const started = await pending;
  assert.equal(started.result, 0);
  assert.equal(seen.origin, 'http://127.1.2.3:8787');
  assert.equal(seen.hostHeader, '127.1.2.3:8787');
  assert.equal(started.stdout, 'https://example.trycloudflare.com');
  assert.match(started.stderr, /\/mcp/);
  assert.equal(tunnel.stopped, true);
});

test('隧道进程失败时返回非零，且不打印非 https 地址', async () => {
  const tunnel = fakeTunnel();
  const pending = capture(() => runTunnelCli([], {
    start() { return tunnel; },
  }));
  tunnel.emitUrl('http://not-public.example');
  tunnel.emitExit(2, null);
  const failed = await pending;
  assert.equal(failed.result, 2);
  assert.equal(failed.stdout, '');
  assert.match(failed.stderr, /127\.0\.0\.1:8787/);
});

test('可选依赖在时，缺少二进制会失败且不打印公网地址', async () => {
  const previous = process.env.CLOUDFLARED_BIN;
  process.env.CLOUDFLARED_BIN = '/no/such/cloudflared';
  try {
    const result = await capture(() => runTunnelCli([]));
    assert.equal(result.result, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /二进制不存在/);
  } finally {
    if (previous === undefined) delete process.env.CLOUDFLARED_BIN;
    else process.env.CLOUDFLARED_BIN = previous;
  }
});

test('命令行帮助提到隧道，非法地址在连出前被拒绝', async () => {
  const help = await new Promise<{ code: number; stdout: string }>((resolve, reject) => {
    execFile(process.execPath, ['--import', 'tsx', entry, 'tunnel', '--help'], {
      env: { ...process.env, TSX_DISABLE_CACHE: '1' },
      timeout: 15_000,
    }, (error, stdout) => {
      if (error && typeof error.code !== 'number') return reject(error);
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout });
    });
  });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /cloudflared/);

  const top = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, ['--import', 'tsx', entry, '--help'], {
      env: { ...process.env, TSX_DISABLE_CACHE: '1' },
      timeout: 15_000,
    }, (error, stdout) => {
      if (error) return reject(error);
      resolve(stdout);
    });
  });
  assert.match(top, /dreammate-node tunnel/);

  const rejected = await new Promise<{ code: number; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, ['--import', 'tsx', entry, 'tunnel', '--url', 'http://example.com:8787'], {
      env: { ...process.env, TSX_DISABLE_CACHE: '1' },
      timeout: 15_000,
    }, (error, _stdout, stderr) => {
      if (error && typeof error.code !== 'number') return reject(error);
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, stderr });
    });
  });
  assert.equal(rejected.code, 2);
  assert.match(rejected.stderr, /回环/);
});

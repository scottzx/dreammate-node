import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../bin/dreammate-node.ts', import.meta.url));
const cwd = fileURLToPath(new URL('..', import.meta.url));
const sdkServer = new URL('../node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js', import.meta.url).href;
const sdkTransport = new URL('../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js', import.meta.url).href;
const sdkTypes = new URL('../node_modules/@modelcontextprotocol/sdk/dist/esm/types.js', import.meta.url).href;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

async function until(predicate: () => boolean, diagnostic: () => string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${diagnostic()}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function fixture(t: TestContext, mode: 'ready' | 'initialize-hang') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dreammate-private-exit-'));
  const pidFile = path.join(dir, 'private.pid');
  const callsFile = path.join(dir, 'calls.jsonl');
  const script = path.join(dir, 'private-fixture.mjs');
  fs.writeFileSync(script, `
import fs from 'node:fs';
import { Server } from ${JSON.stringify(sdkServer)};
import { StdioServerTransport } from ${JSON.stringify(sdkTransport)};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(sdkTypes)};
fs.writeFileSync(process.env.PID_FILE, String(process.pid));
// Keep running after stdin EOF: the owning DreamMate process must close or kill
// this upstream, rather than relying on a fixture exiting by itself.
setInterval(() => {}, 1000);
let pending = '';
process.stdin.on('data', chunk => {
  pending += chunk;
  let boundary;
  while ((boundary = pending.indexOf('\\n')) !== -1) {
    const line = pending.slice(0, boundary); pending = pending.slice(boundary + 1);
    try {
      const message = JSON.parse(line);
      fs.appendFileSync(process.env.CALLS_FILE, JSON.stringify({ method: message.method, name: message.params?.name }) + '\\n');
    } catch {}
  }
});
if (process.env.FIXTURE_MODE !== 'initialize-hang') {
  const server = new Server({ name: 'exit-fixture', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: 'hang', description: 'Hang until the owner closes the source', inputSchema: { type: 'object' } },
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async () => new Promise(() => {}));
  await server.connect(new StdioServerTransport());
}
`, { mode: 0o600 });
  const config = path.join(dir, 'mcp-client.json');
  fs.writeFileSync(config, JSON.stringify({ mcpServers: { exit: {
    command: process.execPath, args: [script],
    env: { PID_FILE: pidFile, CALLS_FILE: callsFile, FIXTURE_MODE: mode },
  } } }), { mode: 0o600 });
  let child: ChildProcessWithoutNullStreams | undefined;
  let stdout = '';
  let stderr = '';
  let closed = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  const privatePid = () => fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : undefined;
  const diagnostics = () => JSON.stringify({ stdout, stderr, closed, exitCode, exitSignal, privatePid: privatePid() });
  t.after(async () => {
    if (child && !closed) {
      child.kill('SIGTERM');
      try { await until(() => closed, diagnostics, 3000); }
      catch { child.kill('SIGKILL'); await until(() => closed, diagnostics, 3000); }
    }
    const pid = privatePid();
    if (pid && alive(pid)) {
      process.kill(pid, 'SIGKILL');
      await until(() => !alive(pid), diagnostics, 3000);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    config, privatePid, diagnostics,
    calls: () => fs.existsSync(callsFile)
      ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { method: string; name?: string }) : [],
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    get closed() { return closed; },
    get exitCode() { return exitCode; },
    get exitSignal() { return exitSignal; },
    start(args: string[]) {
      child = spawn(process.execPath, ['--import', 'tsx', entry, ...args], {
        cwd, stdio: 'pipe',
        env: { ...process.env, HOME: dir, DREAMMATE_AGENT_URL: '', DREAMMATE_MCP_CONFIG: config,
          DREAMMATE_NODES_FILE: path.join(dir, 'absent-nodes.json'), DREAMMATE_EMBEDDING_URL: '' },
      });
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', error => { stderr += String(error); });
      child.on('close', (code, signal) => { closed = true; exitCode = code; exitSignal = signal; });
      return child;
    },
  };
}

test('private MCP stdin EOF closes DreamMate and its upstream subprocess', { timeout: 25_000 }, async t => {
  const f = fixture(t, 'ready');
  const child = f.start(['mcp', '--mcp-config', f.config]);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'private-exit-test', version: '1' },
  } }) + '\n');
  await until(() => f.stdout.split('\n').some(line => {
    try { const response = JSON.parse(line); return response.id === 1 && response.result?.serverInfo; }
    catch { return false; }
  }), f.diagnostics);
  const pid = f.privatePid();
  assert.ok(pid && alive(pid), f.diagnostics());
  child.stdin.end();
  await until(() => f.closed, f.diagnostics);
  await until(() => !alive(pid), f.diagnostics, 3000);
  assert.equal(f.exitCode, 0, f.diagnostics());
  assert.equal(f.exitSignal, null, f.diagnostics());
  assert.equal(f.calls().filter(call => call.method === 'tools/call').length, 0);
});

test('private MCP startup preserves fragmented client initialization input', { timeout: 25_000 }, async t => {
  const f = fixture(t, 'ready');
  const child = f.start(['mcp', '--mcp-config', f.config]);
  const initialize = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize', params: {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'buffered-input-test', version: '1' },
  } }) + '\n';
  child.stdin.write(initialize.slice(0, 32));
  await until(() => Boolean(f.privatePid()), f.diagnostics);
  child.stdin.write(initialize.slice(32));
  await until(() => f.stdout.split('\n').some(line => {
    try { const response = JSON.parse(line); return response.id === 7 && response.result?.serverInfo; }
    catch { return false; }
  }), f.diagnostics);
  assert.equal(f.stdout.trim().split('\n').filter(line => JSON.parse(line).id === 7).length, 1);
  child.stdin.end();
  await until(() => f.closed, f.diagnostics);
  assert.equal(f.exitCode, 0, f.diagnostics());
});

test('private MCP stdin EOF during initialization closes both processes without waiting for the upstream timeout', { timeout: 15_000 }, async t => {
  const f = fixture(t, 'initialize-hang');
  const child = f.start(['mcp', '--mcp-config', f.config]);
  await until(() => f.calls().some(call => call.method === 'initialize'), f.diagnostics);
  const pid = f.privatePid();
  assert.ok(pid && alive(pid), f.diagnostics());
  child.stdin.end();
  await until(() => f.closed, f.diagnostics, 6000);
  await until(() => !alive(pid), f.diagnostics, 3000);
  assert.equal(f.exitCode, 0, f.diagnostics());
  assert.equal(f.exitSignal, null, f.diagnostics());
  assert.equal(f.calls().filter(call => call.method === 'initialize').length, 1);
  assert.equal(f.calls().filter(call => call.method === 'tools/call').length, 0);
});

test('private CLI invocation deadline reports COMMAND_TIMEOUT, never retries, and closes the child', { timeout: 25_000 }, async t => {
  const f = fixture(t, 'ready');
  f.start(['cli', 'invoke', '--live', '--node', '@client', '--service', 'mcp-exit', '--method', 'hang',
    '--params', '{}', '--mcp-config', f.config, '--timeout-ms', '1800']);
  await until(() => f.calls().some(call => call.method === 'tools/call'), f.diagnostics);
  const pid = f.privatePid();
  assert.ok(pid && alive(pid), f.diagnostics());
  await until(() => f.closed, f.diagnostics);
  await until(() => !alive(pid), f.diagnostics, 3000);
  assert.equal(f.exitCode, 1, f.diagnostics());
  assert.equal(f.exitSignal, null, f.diagnostics());
  assert.match(f.stdout, /COMMAND_TIMEOUT/);
  assert.equal(f.stdout.trim().split('\n').length, 1, f.diagnostics());
  assert.equal(f.calls().filter(call => call.method === 'tools/call').length, 1);
  assert.equal(f.calls().filter(call => call.method === 'initialize').length, 1);
});

test('private CLI deadline also closes a child that hangs during initialization', { timeout: 25_000 }, async t => {
  const f = fixture(t, 'initialize-hang');
  f.start(['cli', 'invoke', '--live', '--node', '@client', '--service', 'mcp-exit', '--method', 'hang',
    '--mcp-config', f.config, '--timeout-ms', '1800']);
  await until(() => f.calls().some(call => call.method === 'initialize'), f.diagnostics);
  const pid = f.privatePid();
  assert.ok(pid && alive(pid), f.diagnostics());
  await until(() => f.closed, f.diagnostics);
  await until(() => !alive(pid), f.diagnostics, 3000);
  assert.equal(f.exitCode, 1, f.diagnostics());
  assert.equal(f.exitSignal, null, f.diagnostics());
  assert.match(f.stdout, /COMMAND_TIMEOUT/);
  assert.equal(f.stdout.trim().split('\n').length, 1, f.diagnostics());
  assert.equal(f.calls().filter(call => call.method === 'initialize').length, 1);
  assert.equal(f.calls().filter(call => call.method === 'tools/call').length, 0);
});

test('private MCP signal during initialization closes both processes', { timeout: 25_000 }, async t => {
  const f = fixture(t, 'initialize-hang');
  const child = f.start(['mcp', '--mcp-config', f.config]);
  await until(() => f.calls().some(call => call.method === 'initialize'), f.diagnostics);
  const pid = f.privatePid();
  assert.ok(pid && alive(pid), f.diagnostics());
  child.kill('SIGTERM');
  await until(() => f.closed, f.diagnostics);
  await until(() => !alive(pid), f.diagnostics, 3000);
  assert.equal(f.exitCode, 0, f.diagnostics());
  assert.equal(f.exitSignal, null, f.diagnostics());
  assert.equal(f.calls().filter(call => call.method === 'initialize').length, 1);
  assert.equal(f.calls().filter(call => call.method === 'tools/call').length, 0);
});

test('private CLI cancellation reports COMMAND_INTERRUPTED and closes the upstream subprocess', { timeout: 25_000 }, async t => {
  const f = fixture(t, 'ready');
  const child = f.start(['cli', 'invoke', '--live', '--node', '@client', '--service', 'mcp-exit', '--method', 'hang',
    '--mcp-config', f.config, '--timeout-ms', '10000']);
  await until(() => f.calls().some(call => call.method === 'tools/call'), f.diagnostics);
  const pid = f.privatePid();
  assert.ok(pid && alive(pid), f.diagnostics());
  child.kill('SIGTERM');
  await until(() => f.closed, f.diagnostics);
  await until(() => !alive(pid), f.diagnostics, 3000);
  assert.equal(f.exitCode, 143, f.diagnostics());
  assert.equal(f.exitSignal, null, f.diagnostics());
  assert.match(f.stdout, /COMMAND_INTERRUPTED/);
  assert.equal(f.stdout.trim().split('\n').length, 1, f.diagnostics());
  assert.equal(f.calls().filter(call => call.method === 'tools/call').length, 1);
});

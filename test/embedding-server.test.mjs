import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { get } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const adapter = fileURLToPath(new URL('../scripts/local-embeddings/server.py', import.meta.url));

function startAdapter(port, manifest) {
  const child = spawn('python3', [adapter, '--host', '127.0.0.1', '--port', String(port), '--manifest', manifest]);
  let stderr = '', stdout = '';
  child.stderr.on('data', data => { stderr += data; });
  const closed = new Promise(resolve => child.once('exit', resolve));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`adapter readiness timed out: ${stderr}`)), 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`adapter exited (${code}): ${stderr}`)); });
    child.stdout.on('data', data => {
      stdout += data;
      if (stdout.includes('"listening"')) { clearTimeout(timer); resolve(); }
    });
  });
  return { ready, stop: async () => { if (child.exitCode === null) child.kill('SIGTERM'); await closed; } };
}

function healthAndClose(port) {
  return new Promise((resolve, reject) => {
    let body = '', ended = false, closed = false;
    const done = () => { if (ended && closed) resolve(JSON.parse(body)); };
    const request = get(`http://127.0.0.1:${port}/health`, { agent: false, headers: { connection: 'close' } }, response => {
      response.on('data', chunk => { body += chunk; });
      response.once('end', () => { ended = true; done(); });
      response.once('error', reject);
    });
    request.once('socket', socket => socket.once('close', () => { closed = true; done(); }));
    request.once('error', reject);
  });
}

test('offline adapter immediately restarts on the same port after serving HTTP', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dreammate-adapter-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = path.join(directory, 'manifest.json');
  await writeFile(manifest, JSON.stringify({ models: { qwen3: { revision: 'fixture', path: directory } } }));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  for (let round = 0; round < 2; round++) {
    const server = startAdapter(port, manifest);
    t.after(server.stop);
    await server.ready;
    const health = await healthAndClose(port);
    assert.equal(health.status, 'ok');
    assert.equal(health.outbound_network, 'blocked');
    await server.stop();
  }
});

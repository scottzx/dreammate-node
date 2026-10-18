import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SERVICE_LABEL, SERVICE_ID, renderServicePlist, installService, uninstallService, configurePriority, serviceStatus, parseArgs,
} from '../scripts/local-embeddings/manage.mjs';

function absent() { return Object.assign(new Error('not found'), { stderr: 'Could not find service in domain for gui' }); }
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dreammate-embedding-management-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const directory = path.join(home, 'local-embeddings & <media> "models" $value');
  fs.mkdirSync(directory);
  const python = path.join(directory, 'python');
  const script = path.join(directory, 'on-demand.mjs');
  const manifest = path.join(directory, 'manifest.json');
  fs.writeFileSync(python, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  fs.writeFileSync(script, '// fixture');
  fs.writeFileSync(manifest, '{}');
  const file = path.join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
  const calls = [];
  const state = {
    loaded: false, printFailure: undefined, bootoutFailure: undefined, failBootstrap: 0,
    transientBootstrap: 0, partialBootstrap: false, loadedPath: file, sleeps: [],
  };
  const ctx = {
    home, platform: 'darwin', uid: 1234, script, env: { PATH: '/usr/bin:/path with spaces & <angle>', SECRET_TOKEN: 'must-not-persist' },
    run: async (command, args) => {
      calls.push([command, ...args]);
      assert.equal(command, 'launchctl');
      if (args[0] === 'print') {
        state.onPrint?.();
        if (state.printFailure) throw state.printFailure;
        if (!state.loaded) throw absent();
        return { stdout: `path = ${state.loadedPath}\nstate = running\n` };
      }
      if (args[0] === 'bootout') {
        if (state.bootoutFailure) throw state.bootoutFailure;
        state.loaded = false;
        state.onBootout?.();
        return { stdout: '' };
      }
      if (args[0] === 'bootstrap') {
        if (state.failBootstrap > 0) {
          state.failBootstrap--;
          if (state.partialBootstrap) state.loaded = true;
          throw new Error('bootstrap failed');
        }
        if (state.transientBootstrap > 0) {
          state.transientBootstrap--;
          if (state.partialBootstrap) state.loaded = true;
          throw Object.assign(new Error('bootstrap transient failure'), { stderr: 'Bootstrap failed: 5: Input/output error\nTry running the command as root for richer errors.\n' });
        }
        state.loaded = true;
        state.onBootstrap?.();
        return { stdout: '' };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    },
    fetch: async () => { throw new Error('fixture: no HTTP service'); },
    sleep: async milliseconds => { state.sleeps.push(milliseconds); state.onSleep?.(milliseconds); },
  };
  return { home, file, python, script, manifest, options: { python, manifest }, ctx, calls, state };
}

test('renders direct absolute launchd arguments, escapes paths, preserves only PATH and leaves model loading to supervisor', t => {
  const f = fixture(t);
  const content = renderServicePlist(f.options, f.ctx);
  assert.match(content, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(content, /<key>KeepAlive<\/key><true\/>/);
  assert.match(content, /<key>ProcessType<\/key><string>Interactive<\/string>/);
  assert.match(content, /--idle-timeout-ms<\/string><string>60000/);
  assert.match(content, /--priority<\/string><string>100/);
  assert.match(content, /--sharing<\/string><string>network/);
  assert.ok(content.includes(`<string>${path.join(f.home, '.1agents', 'embedding-config.json')}</string>`));
  assert.match(content, /--device<\/string><string>auto/);
  assert.match(content, /&amp; &lt;media&gt; &quot;models&quot; \$value/);
  assert.ok(content.includes(`<string>${process.execPath}</string>`));
  assert.ok(!content.includes('SECRET_TOKEN'));
  assert.ok(!content.includes('must-not-persist'));
  assert.ok(!content.includes('<string>sh</string>'));
  assert.equal(f.calls.length, 0);
});

test('validates all install inputs before touching process manager or service files', async t => {
  const f = fixture(t);
  for (const options of [
    { ...f.options, python: 'python3' }, { ...f.options, manifest: 'manifest.json' },
    { ...f.options, device: 'metal' }, { ...f.options, port: 0 },
    { ...f.options, idleTimeoutMs: 0 }, { ...f.options, agent: 'https://remote.example.com' },
    { ...f.options, agent: 'http://secret@localhost:36908' }, { ...f.options, batchSize: 65 },
    { ...f.options, model: 'qwen3\nanything' }, { ...f.options, priority: 1001 },
    { ...f.options, startupTimeoutMs: 600001 }, { ...f.options, maxPending: 257 },
    { ...f.options, config: 'relative.json' },
    { ...f.options, sharing: 'lcoal' }, { ...f.options, sharing: '' }, { ...f.options, sharing: true },
  ]) await assert.rejects(installService(options, f.ctx));
  await assert.rejects(installService(f.options, { ...f.ctx, env: { PATH: 'bad\npath' } }));
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(f.file), false);
  assert.throws(() => renderServicePlist(f.options, { ...f.ctx, platform: 'linux' }), /不支持/);
});

test('dual-model installation writes validated direct arguments and accepts prepared manifests without running Python', t => {
  const f = fixture(t);
  const gemmaManifest = path.join(f.home, 'prepared gemma & vision.json');
  fs.writeFileSync(gemmaManifest, '{"format":1,"models":{"embeddinggemma2":{"path":"/prepared/model","revision":"offline"}}}');
  const options = { ...f.options, gemmaPython: f.python, gemmaManifest, mediaRoot: f.home };
  const content = renderServicePlist(options, f.ctx);
  for (const [flag, value] of [
    ['gemma-port', 8767], ['gemma-modalities', 'vision'], ['gemma-max-length', 2048], ['mps-limit-mb', 4096],
  ]) assert.ok(content.includes(`<string>--${flag}</string><string>${value}</string>`));
  assert.match(content, /--gemma-python<\/string><string>/);
  assert.match(content, /prepared gemma &amp; vision\.json/);
  assert.ok(content.includes(`<string>--media-root</string><string>${f.home}</string>`));
  const custom = renderServicePlist({ ...options, gemmaPort: 8799, gemmaModalities: 'all', gemmaMaxLength: 4096, mpsLimitMb: 8192 }, f.ctx);
  for (const [flag, value] of [
    ['gemma-port', 8799], ['gemma-modalities', 'all'], ['gemma-max-length', 4096], ['mps-limit-mb', 8192],
  ]) assert.ok(custom.includes(`<string>--${flag}</string><string>${value}</string>`));
  assert.ok(!renderServicePlist(f.options, f.ctx).includes('--gemma-'));
  assert.deepEqual(f.calls, []);
});

test('Gemma validation rejects incomplete paths, unsafe paths, conflicting ports and invalid limits before launchd', async t => {
  const f = fixture(t);
  const gemma = { gemmaPython: f.python, gemmaManifest: f.manifest, mediaRoot: f.home };
  for (const invalid of [
    { gemmaPython: f.python }, { gemmaManifest: f.manifest }, { mediaRoot: f.home }, { gemmaPort: 8767 },
    { ...gemma, gemmaPython: 'python3' }, { ...gemma, gemmaManifest: 'manifest.json' }, { ...gemma, mediaRoot: '.' },
    { ...gemma, gemmaPython: path.join(f.home, 'absent') }, { ...gemma, gemmaManifest: f.home },
    { ...gemma, mediaRoot: f.manifest }, { ...gemma, mediaRoot: path.join(f.home, 'absent') },
    { ...gemma, gemmaPort: 8766 }, { ...gemma, gemmaPort: 0 }, { ...gemma, gemmaPort: 65536 },
    { ...gemma, gemmaModalities: 'image' }, { ...gemma, gemmaModalities: 'vision\nextra' },
    { ...gemma, gemmaMaxLength: 1023 }, { ...gemma, gemmaMaxLength: 8193 },
    { ...gemma, mpsLimitMb: 1023 }, { ...gemma, mpsLimitMb: 16385 },
  ]) await assert.rejects(installService({ ...f.options, ...invalid }, f.ctx));
  const nonExecutable = path.join(f.home, 'not-executable');
  fs.writeFileSync(nonExecutable, 'not executable', { mode: 0o600 });
  await assert.rejects(installService({ ...f.options, ...gemma, gemmaPython: nonExecutable }, f.ctx));
  assert.equal(fs.existsSync(f.file), false);
  assert.deepEqual(f.calls, []);
});

test('install starts only supervisor and writes private plist, then replaces its own job', async t => {
  const f = fixture(t);
  const installed = await installService(f.options, f.ctx);
  assert.equal(installed.installed, true);
  assert.equal(installed.idleTimeoutMs, 60000);
  assert.equal(installed.effectiveIdleTimeoutMs, 60000);
  assert.equal(installed.fallbackIdleTimeoutMs, 60000);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.equal(f.state.loaded, true);
  assert.deepEqual(f.calls.map(call => call[1]), ['print', 'bootstrap', 'print', 'print']);
  f.calls.length = 0;
  await installService({ ...f.options, port: 8767 }, f.ctx);
  assert.deepEqual(f.calls.map(call => call[1]), ['print', 'bootout', 'print', 'bootstrap', 'print', 'print']);
  assert.match(fs.readFileSync(f.file, 'utf8'), /--port<\/string><string>8767/);
});

test('failed update restores old plist and old running job', async t => {
  const f = fixture(t);
  await installService(f.options, f.ctx);
  const previous = fs.readFileSync(f.file, 'utf8');
  f.calls.length = 0;
  f.state.failBootstrap = 1;
  await assert.rejects(installService({ ...f.options, port: 8767 }, f.ctx), /bootstrap failed/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), previous);
  assert.equal(f.state.loaded, true);
  assert.deepEqual(f.calls.map(call => call[1]), ['print', 'bootout', 'print', 'bootstrap', 'print', 'bootstrap', 'print', 'print']);
});

test('failed first install removes new plist; incomplete rollback is explicit', async t => {
  const f = fixture(t);
  f.state.failBootstrap = 1;
  await assert.rejects(installService(f.options, f.ctx), /bootstrap failed/);
  assert.equal(fs.existsSync(f.file), false);
  await installService(f.options, f.ctx);
  const previous = fs.readFileSync(f.file, 'utf8');
  f.state.failBootstrap = 2;
  await assert.rejects(installService({ ...f.options, port: 8767 }, f.ctx), /回滚未完成/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), previous);
});

test('a bootstrap that loads a job before failing is safely retired before rollback', async t => {
  const f = fixture(t);
  f.state.failBootstrap = 1;
  f.state.partialBootstrap = true;
  await assert.rejects(installService(f.options, f.ctx), /bootstrap failed/);
  assert.equal(f.state.loaded, false);
  assert.equal(fs.existsSync(f.file), false);
  assert.deepEqual(f.calls.map(call => call[1]), ['print', 'bootstrap', 'print', 'bootout', 'print']);
});

test('transient launchd retirement errors retry only while the managed job is absent', async t => {
  const f = fixture(t);
  f.state.transientBootstrap = 3;
  await installService(f.options, f.ctx);
  assert.deepEqual(f.state.sleeps, [200, 500, 1000, 150]);
  assert.equal(f.state.loaded, true);
  assert.deepEqual(f.calls.map(call => call[1]), ['print', 'bootstrap', 'print', 'bootstrap', 'print', 'bootstrap', 'print', 'bootstrap', 'print', 'print']);
});

test('rollback uses the same bounded retirement retries without hiding the original error', async t => {
  const f = fixture(t);
  await installService(f.options, f.ctx);
  const previous = fs.readFileSync(f.file, 'utf8');
  f.state.failBootstrap = 1;
  f.state.transientBootstrap = 2;
  await assert.rejects(installService({ ...f.options, port: 8767 }, f.ctx), error => {
    assert.equal(error.message, 'bootstrap failed');
    return true;
  });
  assert.deepEqual(f.state.sleeps, [150, 200, 500, 150]);
  assert.equal(f.state.loaded, true);
  assert.equal(fs.readFileSync(f.file, 'utf8'), previous);
});

test('transient failure is accepted only when the expected managed job actually became loaded', async t => {
  const f = fixture(t);
  f.state.transientBootstrap = 1;
  f.state.partialBootstrap = true;
  await installService(f.options, f.ctx);
  assert.equal(f.state.loaded, true);
  assert.deepEqual(f.state.sleeps, [150]);
  assert.deepEqual(f.calls.map(call => call[1]), ['print', 'bootstrap', 'print', 'print']);
});

test('bootstrap exit zero does not count as installed until the owned job remains loaded', async t => {
  const f = fixture(t);
  let starts = 0;
  f.state.onBootstrap = () => { if (++starts === 1) f.state.loaded = false; };
  await installService(f.options, f.ctx);
  assert.equal(starts, 2);
  assert.equal(f.state.loaded, true);
  assert.deepEqual(f.state.sleeps, [200, 150]);
  assert.deepEqual(f.calls.map(call => call[1]), ['print', 'bootstrap', 'print', 'bootstrap', 'print', 'print']);
});

test('a briefly present job that vanishes during confirmation is bootstrapped again', async t => {
  const f = fixture(t);
  let checks = 0;
  f.state.onSleep = milliseconds => { if (milliseconds === 150 && checks++ === 0) f.state.loaded = false; };
  await installService(f.options, f.ctx);
  assert.equal(f.state.loaded, true);
  assert.equal(f.calls.filter(call => call[1] === 'bootstrap').length, 2);
  assert.deepEqual(f.state.sleeps, [150, 200, 150]);
});

test('transient exit five and a briefly loaded job use the same stable confirmation as exit zero', async t => {
  const f = fixture(t);
  f.state.transientBootstrap = 1;
  f.state.partialBootstrap = true;
  let checks = 0;
  f.state.onSleep = milliseconds => { if (milliseconds === 150 && checks++ === 0) f.state.loaded = false; };
  await installService(f.options, f.ctx);
  assert.equal(f.state.loaded, true);
  assert.equal(f.calls.filter(call => call[1] === 'bootstrap').length, 2);
  assert.deepEqual(f.state.sleeps, [150, 200, 150]);
});

test('repeated successful bootstrap acknowledgements with no job fail within the retry budget and roll back', async t => {
  const f = fixture(t);
  await installService(f.options, f.ctx);
  const previous = fs.readFileSync(f.file, 'utf8');
  f.calls.length = 0;
  f.state.sleeps.length = 0;
  let starts = 0;
  f.state.onBootstrap = () => { if (++starts <= 4) f.state.loaded = false; };
  await assert.rejects(installService({ ...f.options, port: 8799 }, f.ctx), /加载后未保持运行/);
  assert.equal(starts, 5);
  assert.equal(fs.readFileSync(f.file, 'utf8'), previous);
  assert.equal(f.state.loaded, true);
  assert.deepEqual(f.state.sleeps, [200, 500, 1000, 150]);
});

test('replacement waits for asynchronous bootout retirement before writing and bootstrapping', async t => {
  const f = fixture(t);
  await installService(f.options, f.ctx);
  const previous = fs.readFileSync(f.file, 'utf8');
  f.calls.length = 0;
  f.state.sleeps.length = 0;
  let remaining = 0;
  f.state.onBootout = () => { remaining = 3; f.state.loaded = true; };
  f.state.onPrint = () => {
    if (remaining > 0) {
      assert.equal(fs.readFileSync(f.file, 'utf8'), previous);
      if (--remaining === 0) f.state.loaded = false;
    }
  };
  await installService({ ...f.options, port: 8799 }, f.ctx);
  assert.deepEqual(f.state.sleeps, [100, 100, 150]);
  assert.deepEqual(f.calls.map(call => call[1]), ['print', 'bootout', 'print', 'print', 'print', 'bootstrap', 'print', 'print']);
  assert.match(fs.readFileSync(f.file, 'utf8'), /--port<\/string><string>8799/);
});

test('bootout retirement timeout never overwrites the prior plist and retains the original failure', async t => {
  const f = fixture(t);
  await installService(f.options, f.ctx);
  const previous = fs.readFileSync(f.file, 'utf8');
  f.calls.length = 0;
  f.state.sleeps.length = 0;
  f.state.onBootout = () => { f.state.loaded = true; };
  await assert.rejects(installService({ ...f.options, port: 8799 }, f.ctx), /停止后仍未退出/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), previous);
  assert.equal(f.state.loaded, true);
  assert.equal(f.state.sleeps.filter(milliseconds => milliseconds === 100).length, 29);
});

test('changed plist or foreign loaded path during confirmation is never accepted as a successful activation', async t => {
  for (const change of ['plist', 'path']) {
    const f = fixture(t);
    f.state.onSleep = milliseconds => {
      if (milliseconds !== 150) return;
      if (change === 'plist') fs.appendFileSync(f.file, '\n<!-- concurrent change -->');
      else f.state.loadedPath = path.join(f.home, 'foreign.plist');
    };
    await assert.rejects(installService(f.options, f.ctx), change === 'plist' ? /服务配置已变化/ : /同名 launchd/);
    assert.equal(f.calls.filter(call => call[1] === 'bootstrap').length, 1);
    if (change === 'path') assert.equal(f.calls.filter(call => call[1] === 'bootout').length, 0);
  }
});

test('persistent transient errors exhaust the short retry budget and retain failure semantics', async t => {
  const f = fixture(t);
  f.state.transientBootstrap = 100;
  await assert.rejects(installService(f.options, f.ctx), /bootstrap transient failure/);
  assert.deepEqual(f.state.sleeps, [200, 500, 1000]);
  assert.equal(f.calls.filter(call => call[1] === 'bootstrap').length, 4);
  assert.equal(fs.existsSync(f.file), false);
});

test('foreign files or loaded jobs are never replaced or stopped; preflight errors propagate', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.file), { recursive: true });
  fs.writeFileSync(f.file, 'foreign plist');
  await assert.rejects(installService(f.options, f.ctx), /非本安装器/);
  await assert.rejects(uninstallService(f.ctx), /非本安装器/);
  assert.deepEqual(f.calls, []);
  fs.rmSync(f.file);
  f.state.loaded = true;
  f.state.loadedPath = path.join(f.home, 'another.plist');
  await assert.rejects(installService(f.options, f.ctx), /同名 launchd/);
  await assert.rejects(uninstallService(f.ctx), /同名 launchd/);
  assert.ok(f.calls.every(call => call[1] === 'print'));
  f.state.loadedPath = f.file;
  await assert.rejects(installService(f.options, f.ctx), /缺少本安装器/);
  f.state.loaded = false;
  f.state.printFailure = Object.assign(new Error('permission denied'), { stderr: 'Operation not permitted' });
  await assert.rejects(installService(f.options, f.ctx), /permission denied/);
});

test('uninstall preserves service file on actual bootout errors and is idempotent when absent', async t => {
  const f = fixture(t);
  await installService(f.options, f.ctx);
  const previous = fs.readFileSync(f.file, 'utf8');
  f.state.bootoutFailure = new Error('bootout failed: denied');
  await assert.rejects(uninstallService(f.ctx), /denied/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), previous);
  assert.equal(f.state.loaded, true);
  f.state.bootoutFailure = undefined;
  assert.equal((await uninstallService(f.ctx)).removed, true);
  assert.equal(f.state.loaded, false);
  assert.equal(fs.existsSync(f.file), false);
  assert.equal((await uninstallService(f.ctx)).removed, false);
});

test('status uses configured port, requests only health and rejects unrelated listeners', async t => {
  const f = fixture(t);
  await installService({ ...f.options, port: 8788 }, f.ctx);
  const requests = [];
  f.ctx.fetch = async (url, options) => {
    requests.push(url);
    assert.ok(options.signal);
    return { ok: true, json: async () => ({ service: SERVICE_ID, idle_timeout_ms: 300000, model_state: 'stopped' }) };
  };
  const status = await serviceStatus({}, f.ctx);
  assert.equal(status.port, 8788);
  assert.equal(status.installed, true);
  assert.equal(status.responding, true);
  assert.equal(status.managerSays, 'running');
  assert.equal(status.health.model_state, 'stopped');
  assert.deepEqual(requests, ['http://127.0.0.1:8788/health']);
  f.ctx.fetch = async () => ({ ok: true, json: async () => ({ service: 'other-service' }) });
  assert.equal((await serviceStatus({ port: 8789 }, f.ctx)).responding, false);
});

test('config is read only when priority is omitted and reports startup fallback without creating files', async t => {
  const f = fixture(t);
  const result = await configurePriority({}, f.ctx);
  assert.deepEqual(result, {
    file: path.join(f.home, '.1agents', 'embedding-config.json'), priority: 100, fallbackPriority: 100,
    sharing: 'network', fallbackSharing: 'network',
    idleTimeoutMs: 60000, fallbackIdleTimeoutMs: 60000,
    source: 'startup', reloadIntervalMs: 15000, updated: false,
  });
  assert.equal(fs.existsSync(path.join(f.home, '.1agents')), false);
  assert.deepEqual(f.calls, []);
});

test('config follows installed path and fallback while priority updates never restart a job', async t => {
  const f = fixture(t);
  const config = path.join(f.home, 'custom & priority.json');
  await installService({ ...f.options, priority: -5, config }, f.ctx);
  const plist = fs.readFileSync(f.file, 'utf8');
  f.calls.length = 0;
  const before = await configurePriority({}, f.ctx);
  assert.equal(before.file, config);
  assert.equal(before.priority, -5);
  assert.equal(before.source, 'startup');
  const updated = await configurePriority({ priority: '250' }, f.ctx);
  assert.equal(updated.updated, true);
  assert.equal(updated.priority, 250);
  assert.equal(updated.fallbackPriority, -5);
  assert.equal(updated.source, 'file');
  assert.deepEqual(updated.config, { version: 1, priority: 250 });
  assert.deepEqual(JSON.parse(fs.readFileSync(config, 'utf8')), { version: 1, priority: 250 });
  assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(f.file, 'utf8'), plist);
  assert.equal(f.state.loaded, true);
  assert.deepEqual(f.calls, []);
  assert.equal((await configurePriority({}, f.ctx)).updated, false);
});

test('explicit config path overrides installed path without changing the installed fallback or files', async t => {
  const f = fixture(t);
  const installed = path.join(f.home, 'installed.json');
  const custom = path.join(f.home, 'new', 'selected.json');
  await installService({ ...f.options, priority: 25, config: installed }, f.ctx);
  f.calls.length = 0;
  const result = await configurePriority({ config: custom, priority: 80 }, f.ctx);
  assert.equal(result.file, custom);
  assert.equal(result.priority, 80);
  assert.equal(result.fallbackPriority, 25);
  assert.equal(fs.existsSync(installed), false);
  assert.match(fs.readFileSync(f.file, 'utf8'), /installed\.json/);
  assert.deepEqual(f.calls, []);
});

test('install preserves a valid existing priority file and clearly reports override of startup priority', async t => {
  const f = fixture(t);
  const config = path.join(f.home, 'priority.json');
  const original = '{"version":1,"priority":-30}\n';
  fs.writeFileSync(config, original);
  const result = await installService({ ...f.options, config, priority: 700 }, f.ctx);
  assert.equal(result.effectivePriority, -30);
  assert.equal(result.fallbackPriority, 700);
  assert.equal(result.configuration.source, 'file');
  assert.equal(fs.readFileSync(config, 'utf8'), original);
  assert.match(fs.readFileSync(f.file, 'utf8'), /--priority<\/string><string>700/);
});

test('sharing updates preserve effective priority and priority-only updates preserve explicit sharing', async t => {
  const f = fixture(t);
  await installService({ ...f.options, priority: 55, sharing: 'local' }, f.ctx);
  const plist = fs.readFileSync(f.file, 'utf8');
  f.calls.length = 0;
  const initial = await configurePriority({}, f.ctx);
  assert.equal(initial.sharing, 'local'); assert.equal(initial.fallbackSharing, 'local');
  const local = await configurePriority({ sharing: 'local' }, f.ctx);
  assert.equal(local.priority, 55); assert.equal(local.sharing, 'local');
  assert.deepEqual(local.config, { version: 1, priority: 55, sharing: 'local' });
  const priority = await configurePriority({ priority: -10 }, f.ctx);
  assert.deepEqual(priority.config, { version: 1, priority: -10, sharing: 'local' });
  const network = await configurePriority({ sharing: 'network' }, f.ctx);
  assert.deepEqual(network.config, { version: 1, priority: -10, sharing: 'network' });
  assert.equal(network.fallbackSharing, 'local');
  const status = await serviceStatus({}, f.ctx);
  assert.equal(status.configuration.sharing, 'network');
  assert.equal(status.configuration.fallbackSharing, 'local');
  assert.equal(fs.readFileSync(f.file, 'utf8'), plist);
  assert.ok(f.calls.every(call => call[1] === 'print'));
});

test('idle timeout configuration preserves priority and sharing, reports effective and fallback values without restarting', async t => {
  const f = fixture(t);
  const config = path.join(f.home, 'idle-config.json');
  fs.writeFileSync(config, '{"version":1,"priority":-10,"sharing":"local","idle_timeout_ms":45000}');
  const installed = await installService({ ...f.options, config, idleTimeoutMs: 120000, priority: 100, sharing: 'network' }, f.ctx);
  assert.equal(installed.idleTimeoutMs, 120000);
  assert.equal(installed.effectiveIdleTimeoutMs, 45000);
  assert.equal(installed.fallbackIdleTimeoutMs, 120000);
  const plist = fs.readFileSync(f.file, 'utf8');
  f.calls.length = 0;
  const updated = await configurePriority({ idleTimeoutMs: '60000' }, f.ctx);
  assert.deepEqual(updated.config, { version: 1, priority: -10, sharing: 'local', idle_timeout_ms: 60000 });
  assert.equal(updated.idleTimeoutMs, 60000);
  assert.equal(updated.fallbackIdleTimeoutMs, 120000);
  assert.equal(updated.updated, true);
  assert.deepEqual((await configurePriority({ priority: 25 }, f.ctx)).config,
    { version: 1, priority: 25, sharing: 'local', idle_timeout_ms: 60000 });
  assert.deepEqual((await configurePriority({ sharing: 'network' }, f.ctx)).config,
    { version: 1, priority: 25, sharing: 'network', idle_timeout_ms: 60000 });
  assert.deepEqual(f.calls, []);
  const status = await serviceStatus({}, f.ctx);
  assert.equal(status.configuration.idleTimeoutMs, 60000);
  assert.equal(status.configuration.fallbackIdleTimeoutMs, 120000);
  assert.equal(fs.readFileSync(f.file, 'utf8'), plist);
  assert.equal(f.state.loaded, true);
  assert.ok(f.calls.every(call => call[1] === 'print'));
});

test('legacy config retains installed idle fallback and invalid idle changes preserve files and permissions', async t => {
  const f = fixture(t);
  const config = path.join(f.home, 'idle-config.json');
  fs.writeFileSync(config, '{"version":1,"priority":20,"sharing":"local"}');
  await installService({ ...f.options, config, idleTimeoutMs: 300000 }, f.ctx);
  assert.equal((await configurePriority({}, f.ctx)).idleTimeoutMs, 300000);
  assert.deepEqual((await configurePriority({ priority: 30 }, f.ctx)).config,
    { version: 1, priority: 30, sharing: 'local' });
  const original = fs.readFileSync(config, 'utf8');
  f.calls.length = 0;
  for (const idleTimeoutMs of [0, -1, 86400001, '0.5', '', true, null]) {
    await assert.rejects(configurePriority({ idleTimeoutMs }, f.ctx), /整数/);
    assert.equal(fs.readFileSync(config, 'utf8'), original);
  }
  const missing = path.join(f.home, 'not-created', 'config.json');
  await assert.rejects(configurePriority({ config: missing, idleTimeoutMs: 0 }, f.ctx), /整数/);
  assert.equal(fs.existsSync(path.dirname(missing)), false);
  assert.deepEqual(f.calls, []);
});

test('old config and plist retain sharing fallback and only present JSON fields override startup arguments', async t => {
  const f = fixture(t);
  const config = path.join(f.home, 'priority.json');
  fs.writeFileSync(config, '{"version":1,"priority":20}');
  const installed = await installService({ ...f.options, config, sharing: 'local' }, f.ctx);
  assert.equal(installed.sharing, 'local'); assert.equal(installed.fallbackSharing, 'local');
  const priority = await configurePriority({ priority: 25 }, f.ctx);
  assert.equal(priority.sharing, 'local');
  assert.deepEqual(priority.config, { version: 1, priority: 25 });
  fs.writeFileSync(f.file, fs.readFileSync(f.file, 'utf8').replace('<string>--sharing</string><string>local</string>', ''));
  const legacy = await configurePriority({}, f.ctx);
  assert.equal(legacy.sharing, 'network'); assert.equal(legacy.fallbackSharing, 'network');
  assert.equal(legacy.priority, 25);
  assert.deepEqual((await configurePriority({ sharing: 'local' }, f.ctx)).config, { version: 1, priority: 25, sharing: 'local' });
});

test('invalid sharing never changes a configuration or installs a supervisor', async t => {
  const f = fixture(t);
  const config = path.join(f.home, 'new', 'config.json');
  for (const sharing of ['', 'lcoal', 'LOCAL', true, 1, null]) {
    await assert.rejects(configurePriority({ config, sharing }, f.ctx), /sharing/);
    assert.equal(fs.existsSync(path.dirname(config)), false);
  }
  fs.mkdirSync(path.dirname(config));
  const original = '{"version":1,"priority":17,"sharing":"invalid"}';
  fs.writeFileSync(config, original);
  await assert.rejects(configurePriority({ config, sharing: 'local' }, f.ctx), /sharing/);
  await assert.rejects(installService({ ...f.options, config }, f.ctx), /sharing/);
  assert.equal(fs.readFileSync(config, 'utf8'), original);
  assert.deepEqual(f.calls, []);
});

test('config refuses invalid, linked and non-regular files without modifying them or running launchctl', async t => {
  const f = fixture(t);
  const config = path.join(f.home, 'priority.json');
  for (const content of ['garbage', '{"version":2,"priority":100}', '{"version":1,"priority":1.5}', '{"version":1,"priority":3,"other":true}']) {
    fs.writeFileSync(config, content);
    await assert.rejects(configurePriority({ config, priority: 200 }, f.ctx));
    await assert.rejects(installService({ ...f.options, config }, f.ctx));
    assert.equal(fs.readFileSync(config, 'utf8'), content);
    assert.deepEqual(f.calls, []);
  }
  fs.rmSync(config);
  const target = path.join(f.home, 'target.json');
  fs.writeFileSync(target, '{"version":1,"priority":20}');
  fs.symlinkSync(target, config);
  await assert.rejects(configurePriority({ config, priority: 200 }, f.ctx));
  await assert.rejects(installService({ ...f.options, config }, f.ctx));
  assert.equal(fs.lstatSync(config).isSymbolicLink(), true);
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).priority, 20);
  fs.rmSync(config);
  fs.mkdirSync(config);
  await assert.rejects(configurePriority({ config, priority: 200 }, f.ctx));
  await assert.rejects(installService({ ...f.options, config }, f.ctx));
  assert.equal(fs.statSync(config).isDirectory(), true);
  assert.deepEqual(f.calls, []);
});

test('invalid priority update does not create directories and successful replacement restricts permissions', async t => {
  const f = fixture(t);
  const config = path.join(f.home, 'new', 'priority.json');
  for (const priority of ['1.5', 'NaN', 1001, -1001, '']) {
    await assert.rejects(configurePriority({ config, priority }, f.ctx), /整数/);
    assert.equal(fs.existsSync(path.dirname(config)), false);
  }
  await assert.rejects(configurePriority({ config: 'relative.json', priority: 10 }, f.ctx), /绝对路径/);
  fs.mkdirSync(path.dirname(config));
  fs.writeFileSync(config, '{"version":1,"priority":0}', { mode: 0o644 });
  await configurePriority({ config, priority: -1000 }, f.ctx);
  assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).priority, -1000);
  assert.deepEqual(f.calls, []);
});

test('status displays selected configuration or validation error without changing priority or touching the model', async t => {
  const f = fixture(t);
  const config = path.join(f.home, 'priority.json');
  fs.writeFileSync(config, '{"version":1,"priority":71}');
  await installService({ ...f.options, config, priority: 30 }, f.ctx);
  f.calls.length = 0;
  let status = await serviceStatus({}, f.ctx);
  assert.equal(status.configuration.file, config);
  assert.equal(status.configuration.priority, 71);
  assert.equal(status.configuration.fallbackPriority, 30);
  assert.equal(status.configuration.source, 'file');
  fs.writeFileSync(config, 'invalid');
  status = await serviceStatus({}, f.ctx);
  assert.equal(status.configuration.file, config);
  assert.equal(typeof status.configuration.error, 'string');
  assert.equal(fs.readFileSync(config, 'utf8'), 'invalid');
  const custom = path.join(f.home, 'custom.json');
  status = await serviceStatus({ config: custom }, f.ctx);
  assert.equal(status.configuration.file, custom);
  assert.equal(status.configuration.priority, 30);
  assert.equal(fs.existsSync(custom), false);
  assert.ok(f.calls.every(call => call[1] === 'print'));
});

test('CLI parses separate arguments and rejects unsupported options and missing values', () => {
  const result = parseArgs(['install', '--python', '/space dir/python', '--manifest', '/manifest.json', '--device', 'mps', '--no-register']);
  assert.deepEqual(result, { command: 'install', options: { python: '/space dir/python', manifest: '/manifest.json', device: 'mps', register: false } });
  assert.equal(parseArgs(['status', '--port', '8767']).options.port, '8767');
  assert.deepEqual(parseArgs(['config', '--priority', '-30', '--config', '/selected.json']), { command: 'config', options: { priority: '-30', config: '/selected.json' } });
  assert.deepEqual(parseArgs(['config']), { command: 'config', options: {} });
  assert.deepEqual(parseArgs(['config', '--sharing', 'local']), { command: 'config', options: { sharing: 'local' } });
  assert.deepEqual(parseArgs(['config', '--idle-timeout-ms', '60000']), { command: 'config', options: { idleTimeoutMs: '60000' } });
  assert.deepEqual(parseArgs(['install', '--gemma-python', '/python', '--gemma-manifest', '/manifest', '--media-root', '/media',
    '--gemma-port', '8767', '--gemma-modalities', 'vision', '--gemma-max-length', '2048', '--mps-limit-mb', '4096']).options,
  { gemmaPython: '/python', gemmaManifest: '/manifest', mediaRoot: '/media', gemmaPort: '8767',
    gemmaModalities: 'vision', gemmaMaxLength: '2048', mpsLimitMb: '4096' });
  assert.deepEqual(parseArgs(['install', '--sharing', 'network']).options, { sharing: 'network' });
  assert.equal(parseArgs(['status', '--config', '/selected.json']).options.config, '/selected.json');
  assert.equal(parseArgs([]).command, 'help');
  assert.throws(() => parseArgs(['status', '--python', '/python']), /不支持参数/);
  assert.throws(() => parseArgs(['install', '--port']), /缺少值/);
  assert.throws(() => parseArgs(['uninstall', '--no-register']), /不支持参数/);
  assert.throws(() => parseArgs(['config', '--port', '8767']), /不支持参数/);
  assert.throws(() => parseArgs(['config', '--priority']), /缺少值/);
  assert.throws(() => parseArgs(['status', '--priority', '5']), /不支持参数/);
  assert.throws(() => parseArgs(['status', '--sharing', 'local']), /不支持参数/);
  assert.throws(() => parseArgs(['config', '--sharing']), /缺少值/);
  assert.throws(() => parseArgs(['config', '--idle-timeout-ms']), /缺少值/);
  assert.throws(() => parseArgs(['config', '--gemma-python', '/python']), /不支持参数/);
  assert.throws(() => parseArgs(['status', '--gemma-port', '8767']), /不支持参数/);
});

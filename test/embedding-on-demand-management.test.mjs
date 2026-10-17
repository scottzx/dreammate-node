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
        if (state.printFailure) throw state.printFailure;
        if (!state.loaded) throw absent();
        return { stdout: `path = ${state.loadedPath}\nstate = running\n` };
      }
      if (args[0] === 'bootout') {
        if (state.bootoutFailure) throw state.bootoutFailure;
        state.loaded = false;
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
        return { stdout: '' };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    },
    fetch: async () => { throw new Error('fixture: no HTTP service'); },
    sleep: async milliseconds => { state.sleeps.push(milliseconds); },
  };
  return { home, file, python, script, manifest, options: { python, manifest }, ctx, calls, state };
}

test('renders direct absolute launchd arguments, escapes paths, preserves only PATH and leaves model loading to supervisor', t => {
  const f = fixture(t);
  const content = renderServicePlist(f.options, f.ctx);
  assert.match(content, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(content, /<key>KeepAlive<\/key><true\/>/);
  assert.match(content, /<key>ProcessType<\/key><string>Interactive<\/string>/);
  assert.match(content, /--idle-timeout-ms<\/string><string>300000/);
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

test('install starts only supervisor and writes private plist, then replaces its own job', async t => {
  const f = fixture(t);
  const installed = await installService(f.options, f.ctx);
  assert.equal(installed.installed, true);
  assert.equal(installed.idleTimeoutMs, 300000);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.equal(f.state.loaded, true);
  assert.deepEqual(f.calls.map(call => call[1]), ['print', 'bootstrap']);
  f.calls.length = 0;
  await installService({ ...f.options, port: 8767 }, f.ctx);
  assert.deepEqual(f.calls.map(call => call[1]), ['print', 'bootout', 'bootstrap']);
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
  assert.deepEqual(f.calls.map(call => call[1]), ['print', 'bootout', 'bootstrap', 'print', 'bootstrap']);
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
  assert.deepEqual(f.calls.map(call => call[1]), ['print', 'bootstrap', 'print', 'bootout']);
});

test('transient launchd retirement errors retry only while the managed job is absent', async t => {
  const f = fixture(t);
  f.state.transientBootstrap = 3;
  await installService(f.options, f.ctx);
  assert.deepEqual(f.state.sleeps, [200, 500, 1000]);
  assert.equal(f.state.loaded, true);
  assert.deepEqual(f.calls.map(call => call[1]), ['print', 'bootstrap', 'print', 'bootstrap', 'print', 'bootstrap', 'print', 'bootstrap']);
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
  assert.deepEqual(f.state.sleeps, [200, 500]);
  assert.equal(f.state.loaded, true);
  assert.equal(fs.readFileSync(f.file, 'utf8'), previous);
});

test('transient failure is accepted only when the expected managed job actually became loaded', async t => {
  const f = fixture(t);
  f.state.transientBootstrap = 1;
  f.state.partialBootstrap = true;
  await installService(f.options, f.ctx);
  assert.equal(f.state.loaded, true);
  assert.deepEqual(f.state.sleeps, []);
  assert.deepEqual(f.calls.map(call => call[1]), ['print', 'bootstrap', 'print']);
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
});

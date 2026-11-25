import test from 'node:test';
import assert from 'node:assert/strict';
import { readRowConfig, saveRowConfig, validateRowConfig } from '../src/row-config.js';

test('validateRowConfig enforces constraints for all three rows', () => {
  assert.deepEqual(
    validateRowConfig('dreammate-node', { serviceMode: 'auto', serviceUrl: 'http://127.0.0.1:36908' }),
    { serviceMode: 'auto', serviceUrl: 'http://127.0.0.1:36908' },
  );
  assert.throws(() => validateRowConfig('dreammate-node', { serviceMode: 'invalid' }), /serviceMode/);
  assert.throws(() => validateRowConfig('dreammate-node', { serviceUrl: 'ftp://bad' }), /serviceUrl/);

  assert.deepEqual(
    validateRowConfig('yima-tailnet-trust', { authority: 'scott-mac.tailfb4720.ts.net:3080' }),
    { authority: 'scott-mac.tailfb4720.ts.net:3080' },
  );
  assert.throws(() => validateRowConfig('yima-tailnet-trust', { authority: 'https://bad.ts.net:3080' }), /Tailscale/);
  assert.throws(() => validateRowConfig('yima-tailnet-trust', { authority: 'example.com:3080' }), /Tailscale/);

  assert.deepEqual(
    validateRowConfig('yima-shared-loopback', {
      host: '127.0.0.1',
      port: 3466,
      websocketHeartbeatIntervalMs: 15000,
      compressionLevel: 6,
      slim: { enabled: true, maxMessages: 24, minMessages: 12, minTurns: 1, omitToolResults: true },
    }),
    {
      host: '127.0.0.1',
      port: 3466,
      websocketHeartbeatIntervalMs: 15000,
      compressionLevel: 6,
      slim: { enabled: true, maxMessages: 24, minMessages: 12, minTurns: 1, omitToolResults: true },
    },
  );
  assert.throws(() => validateRowConfig('yima-shared-loopback', { host: '0.0.0.0', port: 3466 }), /回环地址/);
  assert.throws(() => validateRowConfig('yima-shared-loopback', { host: '127.0.0.1', port: 0 }), /port/);
  assert.throws(() => validateRowConfig('unknown-row', {}), /unsupported rowId/);
});

test('readRowConfig and saveRowConfig integrate with ConfigEditor cleanly', async () => {
  const entry = {
    disabled: false,
    fiber: { state: 2 },
    options: { id: 'yima-shared-loopback', config: { host: '127.0.0.1', port: 3466 } },
  };
  let edited = null;
  const editor = {
    configuration: () => [{ entry, inherited: { host: '127.0.0.1', port: 0 }, override: entry.options.config }],
    async edit(target, fn) {
      assert.equal(target, entry);
      edited = fn(entry.options.config, { host: '127.0.0.1', port: 0 });
      entry.options.config = edited;
    },
  };

  const before = readRowConfig(editor, 'yima-shared-loopback');
  assert.equal(before.ok, true);
  assert.equal(before.writable, true);
  assert.equal(before.effective.port, 3466);

  const after = await saveRowConfig(editor, 'yima-shared-loopback', {
    host: '127.0.0.1',
    port: 3466,
    slim: false,
  });
  assert.equal(after.ok, true);
  assert.equal(after.effective.slim, false);
  assert.deepEqual(edited, { host: '127.0.0.1', port: 3466, slim: false });

  const missing = readRowConfig(editor, 'yima-tailnet-trust');
  assert.equal(missing.ok, true);
  assert.equal(missing.writable, false);
  assert.equal(missing.reason, 'inactive');

  const badSave = await saveRowConfig(editor, 'yima-shared-loopback', { host: '0.0.0.0', port: 3466 });
  assert.equal(badSave.ok, false);
  assert.equal(badSave.error.code, 'VALIDATION');
});

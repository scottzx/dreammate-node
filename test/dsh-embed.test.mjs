import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { embedDsh } from '../scripts/embed-dsh.mjs';
import { apply, inject, name, pluginEntry } from '../src/dsh.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the DSH plugin is embedded into the package root and stays unloaded until apply', () => {
  embedDsh(root);
  const patch = readFileSync(path.join(root, 'vendor/dsh/cordis.patch.yml'), 'utf8');
  assert.match(patch, /name: '@1agents\/dreammate-node'/);
  assert.doesNotMatch(patch, /dsh-dreammate-node/);
  assert.equal(name, 'dreammate-node');
  assert.deepEqual(inject, ['tools']);
  assert.equal(typeof apply, 'function');
  const sourceEntry = pluginEntry(pathToFileURL(path.join(root, 'src/dsh.ts')).href);
  const distEntry = pluginEntry(pathToFileURL(path.join(root, 'dist/src/dsh.js')).href);
  assert.equal(sourceEntry, distEntry);
  assert.match(sourceEntry, /\/vendor\/dsh\/index\.js$/);
  const pluginSource = readFileSync(path.join(root, 'src/dsh.ts'), 'utf8');
  assert.doesNotMatch(pluginSource, /^import .*(vendor\/dsh|packages\/dsh-plugin)/m);
});

test('the yima tailnet trust adapter ships via package subpath export', async () => {
  embedDsh(root);
  const patch = readFileSync(path.join(root, 'vendor/dsh/cordis.patch.yml'), 'utf8');
  assert.match(patch, /id: yima-tailnet-trust/);
  assert.match(patch, /name: '@1agents\/dreammate-node\/yima-tailnet-trust'/);
  assert.match(patch, /disabled: true/, 'the trust row must ship disabled until a profile supplies its authority');
  const adapter = await import(pathToFileURL(path.join(root, 'vendor/dsh/yima-tailnet-trust.mjs')).href);
  assert.equal(adapter.name, 'yima-tailnet-trust');
  assert.deepEqual(adapter.inject, ['connection']);
  assert.equal(typeof adapter.apply, 'function');
});

test('the yima shared loopback adapter and browser row-config client ship embedded', async () => {
  embedDsh(root);
  const patch = readFileSync(path.join(root, 'vendor/dsh/cordis.patch.yml'), 'utf8');
  assert.match(patch, /id: yima-shared-loopback/);
  assert.match(patch, /name: '@1agents\/dreammate-node\/yima-shared-loopback'/);
  assert.match(patch, /id: yima-shared-loopback[\s\S]*disabled: true/,
    'the loopback row must ship disabled until a profile supplies its loopback port');
  const adapter = await import(pathToFileURL(path.join(root, 'vendor/dsh/yima-shared-loopback.mjs')).href);
  assert.equal(adapter.name, 'yima-shared-loopback');
  assert.deepEqual(adapter.inject, ['connection', 'webServer', 'typertGateway']);
  assert.equal(typeof adapter.apply, 'function');
  const clientSource = readFileSync(path.join(root, 'vendor/dsh/client.js'), 'utf8');
  assert.match(clientSource, /plugins\.row\.config/);
  assert.match(clientSource, /yima-shared-loopback/);
  assert.match(clientSource, /yima-tailnet-trust/);
});

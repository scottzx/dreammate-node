import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { defaultConfigPath, readPriorityConfig, validatePriorityConfig } from '../scripts/local-embeddings/priority-config.mjs';

test('priority config accepts only its version and bounded numeric integer priority', () => {
  assert.equal(defaultConfigPath('/tmp/user'), '/tmp/user/.1agents/embedding-config.json');
  for (const priority of [-1000, -1, 0, 100, 1000]) {
    const input = { version: 1, priority };
    const result = validatePriorityConfig(input);
    assert.deepEqual(result, input);
    assert.notEqual(result, input);
  }
  for (const sharing of ['local', 'network']) {
    const input = { version: 1, priority: 100, sharing };
    assert.deepEqual(validatePriorityConfig(input), input);
  }
  for (const value of [null, [], {}, { priority: 100 }, { version: 2, priority: 100 },
    { version: 1, priority: '100' }, { version: 1, priority: null }, { version: 1, priority: NaN },
    { version: 1, priority: Infinity }, { version: 1, priority: 0.5 }, { version: 1, priority: -1001 },
    { version: 1, priority: 1001 }, { version: 1, priority: 100, timeout: 30 }]) {
    assert.throws(() => validatePriorityConfig(value), /integer priority/);
  }
  for (const sharing of [undefined, null, '', 'lcoal', 'LOCAL', true, [], 0]) {
    assert.throws(() => validatePriorityConfig({ version: 1, priority: 100, sharing }), /sharing must be local or network/);
  }
});

test('priority config reads bounded regular JSON files and distinguishes absence from invalid configuration', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'embedding-priority-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'priority.json');
  assert.equal(await readPriorityConfig(file), undefined);
  await writeFile(file, '{"version":1,"priority":120}\n');
  assert.deepEqual(await readPriorityConfig(file), { version: 1, priority: 120 });
  await writeFile(file, '{"version":1,"priority":120,"sharing":"local"}\n');
  assert.deepEqual(await readPriorityConfig(file), { version: 1, priority: 120, sharing: 'local' });
  for (const text of ['', 'not JSON', '{"version":1,"priority":100,"extra":true}', ' '.repeat(16385)]) {
    await writeFile(file, text);
    await assert.rejects(readPriorityConfig(file), /Invalid embedding priority config/);
  }
  await mkdir(path.join(dir, 'directory.json'));
  await assert.rejects(readPriorityConfig(path.join(dir, 'directory.json')), /regular file/);
});

test('priority config rejects symlinks, dangling symlinks and FIFOs without waiting for a writer', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'embedding-priority-special-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'target.json');
  await writeFile(target, '{"version":1,"priority":100}');
  const link = path.join(dir, 'link.json'), dangling = path.join(dir, 'dangling.json');
  await symlink(target, link); await symlink(path.join(dir, 'missing.json'), dangling);
  await assert.rejects(readPriorityConfig(link), /Invalid embedding priority config/);
  await assert.rejects(readPriorityConfig(dangling), /Invalid embedding priority config/);
  const fifo = path.join(dir, 'fifo.json');
  await promisify(execFile)('mkfifo', [fifo]);
  await assert.rejects(readPriorityConfig(fifo), /regular file/);
});

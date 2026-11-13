import assert from 'node:assert/strict';
import test from 'node:test';
import { needsTypeRestore, restoreTypedParams } from '../src/param-types.js';

const readSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    head: { type: 'number' },
    tail: { type: 'integer' },
    follow: { type: 'boolean' },
    ids: { type: 'string' },
    lines: { type: 'array', items: { type: 'integer' } },
    window: {
      type: 'object',
      properties: { limit: { type: 'number' }, label: { type: 'string' } },
    },
    optional: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    either: { anyOf: [{ type: 'string' }, { type: 'number' }] },
  },
};

test('按方法 Schema 还原被收成字符串的数值，字符串字段保持不动', () => {
  const params = {
    path: 'notes.txt',
    head: '6',
    tail: '2',
    follow: 'true',
    ids: '012',
    lines: ['3', '08'],
    window: { limit: '1.5', label: '6' },
    optional: '4',
    either: '9',
    extra: '7',
  };
  assert.equal(needsTypeRestore(params), true);
  assert.deepEqual(restoreTypedParams(params, readSchema), {
    path: 'notes.txt',
    head: 6,
    tail: 2,
    follow: true,
    ids: '012',
    lines: [3, '08'],
    window: { limit: 1.5, label: '6' },
    optional: 4,
    either: '9',
    extra: '7',
  });
});

test('已经是数字、没有 Schema、或字符串不像 JSON 数字时不改', () => {
  const ready = { head: 6, path: 'a' };
  assert.equal(needsTypeRestore(ready), false);
  assert.equal(restoreTypedParams(ready, readSchema), ready);
  assert.deepEqual(restoreTypedParams({ head: '6' }, undefined), { head: '6' });
  assert.deepEqual(restoreTypedParams({ head: '6 ', tail: '1.0', follow: 'TRUE' }, readSchema), {
    head: '6 ', tail: '1.0', follow: 'TRUE',
  });
});

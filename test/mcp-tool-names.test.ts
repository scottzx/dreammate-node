import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolNameError, ToolNameIndex } from '../src/mcp-tool-names.js';

test('tool names isolate sources/toolsets and reject ambiguous short aliases', () => {
  const entries = [
    { kind: 'native' as const, name: 'list', value: 'native' },
    { kind: 'action' as const, adapter: 'catalog', group: 'github', name: 'list', value: 'github' },
    { kind: 'action' as const, adapter: 'catalog', group: 'gitlab', name: 'list', value: 'gitlab' },
  ];
  const first = new ToolNameIndex('mcp-first', entries), second = new ToolNameIndex('mcp-second', entries);
  assert.equal(new Set([...first.records, ...second.records].map(r => r.method)).size, 6);
  assert.equal(first.resolve('mcp-first.list').value, 'native');
  assert.equal(first.resolve('github.list').value, 'github');
  assert.equal(first.resolve('mcp-first.gitlab.list').value, 'gitlab');
  assert.throws(() => first.resolve('list'), (e: unknown) => e instanceof ToolNameError && e.status === 409 && e.candidates.length === 3);
  assert.throws(() => first.resolve('mcp-second.list'), (e: unknown) => e instanceof ToolNameError && e.status === 404);
});

test('tool name conversion preserves special, unicode, reserved and long names without order-dependent collisions', () => {
  const names = ['echo', 'foo/bar', 'foo bar', 'foo_bar', 'echo__one', 'actions.github.list', '工具 名称', '__proto__', 'x'.repeat(2000), 'echo__dm_0123456789abcdef', 'Foo', 'foo'];
  const entries = names.map(name => ({ kind: 'native' as const, name, value: name }));
  const source = `mcp-${'s'.repeat(64)}`;
  const first = new ToolNameIndex(source, entries), reversed = new ToolNameIndex(source, [...entries].reverse());
  assert.equal(new Set(first.records.map(r => r.method)).size, names.length);
  for (const record of first.records) {
    assert.match(record.method, /^[A-Za-z0-9_.-]{1,128}$/);
    assert.equal(first.resolve(record.method).value, record.value);
    assert.equal(reversed.records.find(r => r.value === record.value)!.method, record.method);
    if (!['Foo', 'foo'].includes(record.value)) assert.equal(first.resolve(`${source}.${record.value}`).value, record.value);
  }
  assert.equal(first.resolve(`${source}.echo`).value, 'echo');
  assert.ok(first.records.some(r => r.method === `${source}.echo__one`));
  const actions = new ToolNameIndex(source, [
    { kind: 'action', adapter: 'one', group: '工具'.repeat(200), name: '列出'.repeat(200), value: 1 },
    { kind: 'action', adapter: 'two', group: '工具'.repeat(200), name: '列出'.repeat(200), value: 2 },
  ]);
  assert.notEqual(actions.records[0]!.method, actions.records[1]!.method);
  assert.ok(actions.records.every(r => r.method.length <= 128));
});

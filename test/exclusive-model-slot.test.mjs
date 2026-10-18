import assert from 'node:assert/strict';
import test from 'node:test';
import { createExclusiveModelSlot } from '../scripts/local-embeddings/exclusive-model-slot.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('one model slot executes concurrent submissions in FIFO order', async () => {
  const slot = createExclusiveModelSlot();
  slot.register('qwen3', () => assert.fail('same-model calls must reuse ownership'));
  const entered = deferred(), release = deferred();
  const events = [];
  const first = slot.run('qwen3', async () => {
    events.push('first-start');
    entered.resolve();
    await release.promise;
    events.push('first-end');
    return 1;
  });
  const second = slot.run('qwen3', () => { events.push('second'); return 2; });
  const third = slot.run('qwen3', () => { events.push('third'); return 3; });
  await entered.promise;
  assert.deepEqual(events, ['first-start']);
  assert.deepEqual(slot.health(), { exclusive: true, slot_owner: 'qwen3', queued_and_active: 3 });
  release.resolve();
  assert.deepEqual(await Promise.all([first, second, third]), [1, 2, 3]);
  assert.deepEqual(events, ['first-start', 'first-end', 'second', 'third']);
});

test('switching waits for confirmed unload before another model can own resources', async () => {
  const slot = createExclusiveModelSlot();
  const unloading = deferred(), releaseUnload = deferred();
  const loaded = new Set();
  const events = [];
  let maximumLoaded = 0;
  slot.register('qwen3', async () => {
    events.push('qwen-unload-start');
    unloading.resolve();
    await releaseUnload.promise;
    loaded.delete('qwen3');
    events.push('qwen-unload-end');
  });
  slot.register('embeddinggemma2', () => {
    loaded.delete('embeddinggemma2');
    events.push('gemma-unload');
  });
  const load = model => {
    assert.equal(loaded.size, 0, 'a different model must not start beside an owned worker');
    loaded.add(model);
    maximumLoaded = Math.max(maximumLoaded, loaded.size);
    events.push(`load-${model}`);
  };
  await slot.run('qwen3', () => load('qwen3'));
  const gemma = slot.run('embeddinggemma2', () => load('embeddinggemma2'));
  await unloading.promise;
  assert.deepEqual([...loaded], ['qwen3']);
  assert.equal(slot.health().slot_owner, 'qwen3', 'ownership must remain until unload confirms exit');
  assert.deepEqual(events, ['load-qwen3', 'qwen-unload-start']);
  const qwenAgain = slot.run('qwen3', () => load('qwen3'));
  releaseUnload.resolve();
  await Promise.all([gemma, qwenAgain]);
  assert.deepEqual(events, [
    'load-qwen3', 'qwen-unload-start', 'qwen-unload-end',
    'load-embeddinggemma2', 'gemma-unload', 'load-qwen3',
  ]);
  assert.equal(maximumLoaded, 1);
  assert.deepEqual([...loaded], ['qwen3']);
});

test('an aborted queued request is skipped without unloading the active model', async () => {
  const slot = createExclusiveModelSlot();
  let unloads = 0, cancelledOperationRan = false;
  slot.register('qwen3', () => { unloads++; });
  slot.register('embeddinggemma2', () => assert.fail('cancelled model was never loaded'));
  const entered = deferred(), release = deferred();
  const first = slot.run('qwen3', async () => { entered.resolve(); await release.promise; });
  const controller = new AbortController();
  const cancelled = slot.run('embeddinggemma2', () => { cancelledOperationRan = true; }, controller.signal);
  const rejected = assert.rejects(cancelled, error => error.status === 503 && /cancelled/.test(error.message));
  const following = slot.run('qwen3', () => 'continued');
  await entered.promise;
  controller.abort();
  assert.equal(cancelledOperationRan, false);
  release.resolve();
  await first;
  await rejected;
  assert.equal(await following, 'continued');
  assert.equal(cancelledOperationRan, false);
  assert.equal(unloads, 0);
  assert.equal(slot.health().slot_owner, 'qwen3');
});

test('an unload failure retains ownership and prevents a different model from starting', async () => {
  const slot = createExclusiveModelSlot();
  let permitUnload = false, otherStarts = 0, unloadAttempts = 0;
  slot.register('qwen3', async () => {
    unloadAttempts++;
    if (!permitUnload) throw new Error('old worker has not exited');
  });
  slot.register('embeddinggemma2', () => {});
  slot.register('third-model', () => {});
  await slot.run('qwen3', () => 'initial');
  const gemma = slot.run('embeddinggemma2', () => { otherStarts++; });
  const third = slot.run('third-model', () => { otherStarts++; });
  await Promise.all([
    assert.rejects(gemma, /old worker has not exited/),
    assert.rejects(third, /old worker has not exited/),
  ]);
  assert.equal(otherStarts, 0);
  assert.equal(unloadAttempts, 2);
  assert.equal(slot.health().slot_owner, 'qwen3');
  assert.equal(await slot.run('qwen3', () => 'original owner still usable'), 'original owner still usable');
  permitUnload = true;
  await slot.run('embeddinggemma2', () => { otherStarts++; });
  assert.equal(otherStarts, 1);
  assert.equal(slot.health().slot_owner, 'embeddinggemma2');
});

test('operation failures reject their caller without poisoning queued operations', async () => {
  const slot = createExclusiveModelSlot();
  const events = [];
  slot.register('qwen3', () => events.push('unload-qwen'));
  slot.register('embeddinggemma2', () => {});
  const failed = slot.run('qwen3', async () => { events.push('failed'); throw new Error('inference failed'); });
  const recovered = slot.run('qwen3', () => { events.push('same-model-recovered'); return 42; });
  const switched = slot.run('embeddinggemma2', () => { events.push('switched'); return 43; });
  await assert.rejects(failed, /inference failed/);
  assert.equal(await recovered, 42);
  assert.equal(await switched, 43);
  assert.deepEqual(events, ['failed', 'same-model-recovered', 'unload-qwen', 'switched']);
});

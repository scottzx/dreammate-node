/** One FIFO resource slot for all model workers owned by a supervisor. */
export function createExclusiveModelSlot() {
  const unloaders = new Map();
  let tail = Promise.resolve(), owner, pending = 0;
  const cancelled = () => Object.assign(new Error('Embedding request cancelled'), { status: 503 });
  return {
    register(model, unload) {
      if (unloaders.has(model)) throw new Error(`Model slot already registered: ${model}`);
      unloaders.set(model, unload);
    },
    run(model, operation, signal) {
      if (!unloaders.has(model)) return Promise.reject(new Error(`Unknown managed model: ${model}`));
      pending++;
      const result = tail.then(async () => {
        if (signal?.aborted) throw cancelled();
        if (owner !== undefined && owner !== model) {
          // unload() must confirm the old process exited. Keep ownership on
          // failure so no other backend can load beside an unretired worker.
          await unloaders.get(owner)();
          owner = undefined;
        }
        if (signal?.aborted) throw cancelled();
        owner = model;
        return operation();
      });
      tail = result.catch(() => {}).finally(() => { pending--; });
      return result;
    },
    health() { return { exclusive: true, slot_owner: owner ?? null, queued_and_active: pending }; },
  };
}

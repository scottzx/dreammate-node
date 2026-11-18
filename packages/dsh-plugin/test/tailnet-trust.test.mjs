import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, inject, name } from '../yima-tailnet-trust.mjs';

/** Minimal Connection-carrier stand-in: effects run immediately and collect disposers. */
function harness(connection = { trustedHosts: [] }) {
  const disposers = [];
  const ctx = {
    connection,
    effect(fn) {
      const dispose = fn();
      disposers.push(dispose);
      return dispose;
    },
  };
  return { ctx, disposers, connection };
}

test('ships the loader contract of the standalone profile adapter', () => {
  assert.equal(name, 'yima-tailnet-trust');
  assert.deepEqual(inject, ['connection']);
  assert.equal(typeof apply, 'function');
});

test('trusts the exact authority and withdraws it on dispose', () => {
  const { ctx, disposers, connection } = harness();
  apply(ctx, { authority: 'scott-mac.tailfb4720.ts.net:3080' });
  assert.deepEqual(connection.trustedHosts, ['scott-mac.tailfb4720.ts.net:3080']);
  disposers.forEach((dispose) => dispose());
  assert.deepEqual(connection.trustedHosts, []);
});

test('accepts the bare Tailnet host, exactly like the standalone extension', () => {
  const { ctx, disposers, connection } = harness();
  apply(ctx, { authority: 'scott-mac.tailfb4720.ts.net' });
  assert.deepEqual(connection.trustedHosts, ['scott-mac.tailfb4720.ts.net']);
  disposers.forEach((dispose) => dispose());
  assert.deepEqual(connection.trustedHosts, []);
});

test('never withdraws an authority that was already trusted', () => {
  const { ctx, disposers, connection } = harness({ trustedHosts: ['scott-mac.tailfb4720.ts.net:3080'] });
  apply(ctx, { authority: 'scott-mac.tailfb4720.ts.net:3080' });
  assert.deepEqual(connection.trustedHosts, ['scott-mac.tailfb4720.ts.net:3080']);
  disposers.forEach((dispose) => dispose());
  assert.deepEqual(connection.trustedHosts, ['scott-mac.tailfb4720.ts.net:3080']);
});

test('rejects anything but an exact Tailscale DNS host:port', () => {
  const fence = /an exact Tailscale DNS host:port is required/;
  for (const authority of [
    undefined,
    '',
    'scott-mac.tailfb4720.ts.net:443',
    'https://scott-mac.tailfb4720.ts.net:3080',
    'scott-mac.tailfb4720.ts.net:3080/admin',
    'scott-mac.tailfb4720.ts.net:3080?x=1',
    'scott-mac.tailfb4720.ts.net:3080#frag',
    'ScotT-Mac.tailfb4720.ts.net:3080',
    'user@scott-mac.tailfb4720.ts.net:3080',
    'example.com:3080',
    '100.88.227.56:3080',
  ]) {
    const { ctx } = harness();
    assert.throws(() => apply(ctx, { authority }), fence, `authority ${JSON.stringify(authority)} must be refused`);
  }
});

test('refuses a Connection contract that no longer carries trustedHosts', () => {
  const { ctx } = harness({});
  assert.throws(() => apply(ctx, { authority: 'scott-mac.tailfb4720.ts.net:3080' }),
    /installed Connection contract has changed/);
});

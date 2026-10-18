import test from 'node:test';
import assert from 'node:assert/strict';
import { ArtifactStore } from '../src/store.mjs';

const profile = { id: 'test-profile', model: 'test@revision1', alias: 'test', revision: 'revision1', dimensions: 2, encoding: 'fp32:normalized' };

test('SQLite refuses invalid, non-unit and incorrectly sized vectors without cache pollution', () => {
  const store = new ArtifactStore(':memory:');
  try {
    assert.throws(() => store.putVector(profile, 'hash', 'text', [1]), /dimension/);
    assert.throws(() => store.putVector(profile, 'hash', 'text', [0, 0]), /unit norm/);
    assert.throws(() => store.putVector(profile, 'hash', 'text', [0.9, 0.9]), /unit norm/);
    assert.throws(() => store.putVector(profile, 'hash', 'text', [NaN, 0]), /non-finite/);
    assert.throws(() => store.putVector(profile, 'hash', 'text', ['1', 0]), /non-numeric/);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM profiles').get().n, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM vectors').get().n, 0);
    const id = store.putVector(profile, 'hash', 'text', [0.6, 0.8]);
    assert.equal(store.putVector(profile, 'hash', 'text', [0.6, 0.8]), id);
    assert.equal(store.cachedVectors('hash', 'text').length, 1);
    assert.throws(() => store.putVector({ ...profile, encoding: 'other' }, 'hash2', 'text', [1, 0]), /collision/);
  } finally { store.close(); }
});

test('SQLite foreign keys prevent vectors referencing an absent embedding profile', () => {
  const store = new ArtifactStore(':memory:');
  try {
    assert.throws(() => store.db.prepare('INSERT INTO vectors VALUES (?, ?, ?, ?, ?)').run('bad', 'absent', 'hash', 'text', Buffer.alloc(8)), /FOREIGN KEY/);
  } finally { store.close(); }
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  bundleSelection, declaredVersion, finalize, hasTopLevelDeclaration, installedVersion,
  prepare, profileDir, readManifest, restoreBundleOrder, withBundleOrder,
} from '../scripts/profile-upgrade.mjs';

const PACKAGE = '@1agents/dreammate-node';

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dreammate-upgrade-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedProfile(dir, { version = '0.22.2', declared = '0.22.2', bundles = ['base', PACKAGE, 'web'], client = 'ok' } = {}) {
  fs.mkdirSync(path.join(dir, 'node_modules', PACKAGE, 'vendor/dsh'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'profile-test', dsh: { profile: { bundles } }, dependencies: { [PACKAGE]: declared },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'node_modules', PACKAGE, 'package.json'), JSON.stringify({ version }));
  fs.writeFileSync(path.join(dir, 'node_modules', PACKAGE, 'vendor/dsh/client.js'), client);
  return dir;
}

test('profileDir honours the desktop env override and otherwise resolves by name', () => {
  assert.equal(profileDir('desktop', { DSH_PROFILE_DIR: '/custom/profile' }), '/custom/profile');
  assert.equal(profileDir('work', { DSH_PROFILE_DIR: '/custom/profile' }),
    path.join(os.homedir(), '.dsh', 'profiles', 'work'));
});

test('bundle helpers keep the target at its original index', () => {
  const original = ['a', PACKAGE, 'b', 'c'];
  assert.deepEqual(restoreBundleOrder(['a', 'b', 'c', PACKAGE], original), original);
  assert.deepEqual(restoreBundleOrder([PACKAGE, 'a', 'b', 'c'], original), original);
  assert.deepEqual(restoreBundleOrder(['a', 'b', 'c'], original), ['a', PACKAGE, 'b', 'c']);
  assert.deepEqual(restoreBundleOrder(['a', 'b'], [], PACKAGE), ['a', 'b', PACKAGE]);
  const manifest = { dsh: { profile: { bundles: ['x'] }, other: 1 }, extra: 2 };
  assert.deepEqual(withBundleOrder(manifest, ['y']),
    { dsh: { profile: { bundles: ['y'] }, other: 1 }, extra: 2 });
});

test('top-level declaration detection matches the real regression', () => {
  assert.equal(hasTopLevelDeclaration('const STYLE = 1;\nwindow.x();'), true);
  assert.equal(hasTopLevelDeclaration('// const STYLE = 1;\nwindow.x();'), false);
  assert.equal(hasTopLevelDeclaration('window.load({ factory() { const STYLE = 1; } });'), false);
  assert.equal(hasTopLevelDeclaration('function leak() {}\nwindow.x();'), true);
});

test('prepare checks npm visibility, backs up state and prints the agent calls', t => {
  const dir = seedProfile(temporary(t));
  const result = prepare({ dir, version: '9.9.9', dryRun: false, checkRegistry: false });
  assert.equal(result.currentVersion, '0.22.2');
  assert.equal(result.bundleIndex, 1);
  assert.equal(result.agentCalls.length, 3);
  assert.match(result.agentCalls[0], /set_bundle.*enabled: false/);
  assert.match(result.agentCalls[1], /remove_bundle/);
  assert.match(result.agentCalls[2], /install_bundle.*9\.9\.9/);
  const backup = JSON.parse(fs.readFileSync(result.backupFile, 'utf8'));
  assert.deepEqual(backup.bundles, ['base', PACKAGE, 'web']);
  assert.equal(backup.declaredVersion, '0.22.2');
});

test('prepare dry-run leaves no backup on disk', t => {
  const dir = seedProfile(temporary(t));
  const result = prepare({ dir, version: '9.9.9', dryRun: true, checkRegistry: false });
  assert.equal(result.dryRun, true);
  assert.equal(fs.existsSync(result.backupFile), false);
});

test('finalize verifies install, restores bundle order and rejects a broken client bundle', t => {
  const dir = seedProfile(temporary(t), { bundles: ['base', PACKAGE, 'web'] });
  prepare({ dir, version: '9.9.9', checkRegistry: false });

  // Agent step: install moves the bundle to the end and bumps the version.
  const moved = readManifest(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(withBundleOrder(moved,
    [...moved.dsh.profile.bundles.filter(b => b !== PACKAGE), PACKAGE])));
  const manifest = readManifest(dir);
  manifest.dependencies[PACKAGE] = '9.9.9';
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'node_modules', PACKAGE, 'package.json'), JSON.stringify({ version: '9.9.9' }));

  const result = finalize({ dir, version: '9.9.9' });
  assert.equal(result.actual, '9.9.9');
  assert.equal(result.changed, true);
  assert.equal(result.bundleIndex, 1, 'bundle must be back at its original index');
  assert.deepEqual(bundleSelection(readManifest(dir)), ['base', PACKAGE, 'web']);
  assert.equal(declaredVersion(readManifest(dir)), '9.9.9');
  assert.equal(installedVersion(dir), '9.9.9');
});

test('finalize refuses a version mismatch or an un-reexecutable client bundle', t => {
  const dir = seedProfile(temporary(t), { client: 'const STYLE = 1;\n' });
  prepare({ dir, version: '9.9.9', checkRegistry: false });
  const manifest = readManifest(dir);
  manifest.dependencies[PACKAGE] = '9.9.9';
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'node_modules', PACKAGE, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  assert.throws(() => finalize({ dir, version: '9.9.9' }), /顶层声明/);

  const dir2 = seedProfile(temporary(t));
  prepare({ dir: dir2, version: '9.9.9', checkRegistry: false });
  assert.throws(() => finalize({ dir: dir2, version: '9.9.9' }), /安装版本/);
});

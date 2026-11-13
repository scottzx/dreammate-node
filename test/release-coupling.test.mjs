import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptsCaret, planRelease } from '../scripts/check-release-coupling.mjs';

test('0.x caret floats patches and stops at the next minor', () => {
  assert.equal(acceptsCaret('^0.17.0', '0.17.0'), true);
  assert.equal(acceptsCaret('^0.17.0', '0.17.1'), true);
  assert.equal(acceptsCaret('^0.17.0', '0.18.0'), false);
  assert.equal(acceptsCaret('^0.17.1', '0.17.0'), false);
  assert.equal(acceptsCaret('^1.2.0', '1.3.0'), true);
  assert.equal(acceptsCaret('^1.2.0', '2.0.0'), false);
});

test('a node patch reuses the published plugin', () => {
  assert.equal(planRelease({
    nodeVersion: '0.17.1',
    pluginDependency: '^0.17.0',
    pluginPublished: true,
    publishedDependency: '^0.17.0',
  }), 'skip-plugin');
});

test('an unpublished plugin version is published with the node', () => {
  assert.equal(planRelease({
    nodeVersion: '0.18.0',
    pluginDependency: '^0.18.0',
    pluginPublished: false,
  }), 'publish-plugin');
});

test('a minor node release cannot ship while the plugin still accepts only the previous minor', () => {
  assert.throws(() => planRelease({
    nodeVersion: '0.18.0',
    pluginDependency: '^0.17.0',
    pluginPublished: true,
    publishedDependency: '^0.17.0',
  }), /0\.18\.0/);
});

test('changing the git dependency without bumping the published plugin is rejected', () => {
  assert.throws(() => planRelease({
    nodeVersion: '0.18.0',
    pluginDependency: '^0.18.0',
    pluginPublished: true,
    publishedDependency: '^0.17.0',
  }), /已有的插件版本/);
});

/** Copy the private DSH plugin into this package. The published tarball is the only install target. */
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGIN_FILES = ['index.js', 'service-process.js', 'service-worker.js'];
// Loader modules whose patch rows use relative names; they must stay anchored
// beside cordis.patch.yml in both the source package and the embedded copy.
const PATCH_MODULES = ['yima-tailnet-trust.mjs'];
const DOC_FILES = ['cordis.patch.yml', 'README.md', 'LICENSE'];

export function embedDsh(root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))) {
  const pluginRoot = join(root, 'packages/dsh-plugin');
  const source = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));
  const target = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(source.private, true, 'DSH source package must not be published');
  assert.equal(source.name, '@1agents/dsh-dreammate-node');
  assert.equal(target.name, '@1agents/dreammate-node');
  assert.equal(target.dependencies?.['@1agents/dsh-dreammate-node'], undefined, 'DSH plugin must be embedded, not depended on');
  assert.equal(target.dsh?.bundle?.patch, './vendor/dsh/cordis.patch.yml');
  const patch = readFileSync(join(pluginRoot, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /name: '@1agents\/dreammate-node'/, 'DSH patch must load the package root');
  for (const name of PATCH_MODULES) {
    assert.match(patch, new RegExp(`name: '\\./${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`),
      `DSH patch must load ${name} beside its patch file`);
  }
  assert.doesNotMatch(patch, /dsh-dreammate-node/);
  const destination = join(root, 'vendor/dsh');
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const name of PLUGIN_FILES) cpSync(join(pluginRoot, 'src', name), join(destination, name));
  for (const name of PATCH_MODULES) cpSync(join(pluginRoot, name), join(destination, name));
  for (const name of DOC_FILES) cpSync(join(pluginRoot, name), join(destination, name));
  verifyEmbedded(root);
  return destination;
}

export function verifyEmbedded(root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))) {
  const target = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const destination = join(root, 'vendor/dsh');
  for (const name of [...PLUGIN_FILES, ...PATCH_MODULES, ...DOC_FILES]) {
    readFileSync(join(destination, name));
  }
  const patch = readFileSync(join(destination, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, new RegExp(`name: '${target.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  assert.equal(target.dsh.bundle.patch, './vendor/dsh/cordis.patch.yml');
  const listed = target.files ?? [];
  assert.ok(listed.includes('vendor/dsh'), 'package files must include the embedded plugin');
}

function main() {
  const destination = embedDsh();
  console.log(`Embedded DSH plugin in ${destination}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

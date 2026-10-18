import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { auditDependencies } from '../scripts/audit-dependencies.mjs';

function fixture(t, manifest={name:'audit-fixture',version:'1.0.0'}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'package-audit-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const put=(relative,value)=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2));};
  put('package.json',manifest);
  put('package-lock.json',{name:manifest.name,version:manifest.version,lockfileVersion:3,requires:true,packages:{'':manifest}});
  return {root,put};
}

test('clean empty npm project is valid and read-only, runtime remains unverified',t=>{
  const f=fixture(t),before=fs.readFileSync(path.join(f.root,'package-lock.json'));
  const result=auditDependencies(f.root);
  assert.equal(result.valid,true);assert.equal(result.runtime.verified,false);
  assert.deepEqual(fs.readFileSync(path.join(f.root,'package-lock.json')),before);
  assert.equal(fs.existsSync(path.join(f.root,'node_modules')),false);
});

test('manifest/lock disagreement is detected without rewriting either file',t=>{
  const f=fixture(t);f.put('package.json',{name:'audit-fixture',version:'1.0.0',dependencies:{'@1agents/fake':'^0.7.0'}});
  const result=auditDependencies(f.root);
  assert.equal(result.valid,false);assert.equal(result.lockManifestMismatches[0].field,'dependencies');
  assert.ok(result.npmProblems.length>0);
});

test('two compatible first-party versions are allowed, no deduplication or latest override',t=>{
  const manifest={name:'audit-fixture',version:'1.0.0',dependencies:{'@1agents/a':'1.0.0','@1agents/b':'1.0.0'}};
  const f=fixture(t,manifest);
  f.put('node_modules/@1agents/a/package.json',{name:'@1agents/a',version:'1.0.0',dependencies:{'@1agents/network':'^0.4.0'}});
  f.put('node_modules/@1agents/b/package.json',{name:'@1agents/b',version:'1.0.0',dependencies:{'@1agents/network':'^0.7.0'}});
  f.put('node_modules/@1agents/a/node_modules/@1agents/network/package.json',{name:'@1agents/network',version:'0.4.2'});
  f.put('node_modules/@1agents/b/node_modules/@1agents/network/package.json',{name:'@1agents/network',version:'0.7.3'});
  const result=auditDependencies(f.root);
  assert.equal(result.valid,true,JSON.stringify(result.npmProblems));
  assert.deepEqual(result.installed.filter(x=>x.name==='@1agents/network').map(x=>x.version).sort(),['0.4.2','0.7.3']);
});

test('installed version outside requested range is reported by npm',t=>{
  const manifest={name:'audit-fixture',version:'1.0.0',dependencies:{'@1agents/fake':'^0.7.0'}};
  const f=fixture(t,manifest);f.put('node_modules/@1agents/fake/package.json',{name:'@1agents/fake',version:'0.6.0'});
  const result=auditDependencies(f.root);assert.equal(result.valid,false);assert.ok(result.npmProblems.some(x=>x.includes('invalid')));
});

test('pnpm project is explicitly not validated using npm',t=>{
  const f=fixture(t,{name:'native-fixture',version:'1.0.0',packageManager:'pnpm@11.27.1'});
  const result=auditDependencies(f.root);assert.equal(result.validationSupported,false);assert.equal(result.valid,false);assert.equal(result.npmExitCode,null);
});

test('missing lockfile is a reproducibility failure',t=>{
  const f=fixture(t);fs.unlinkSync(path.join(f.root,'package-lock.json'));
  const result=auditDependencies(f.root);assert.equal(result.valid,false);assert.ok(result.lockManifestMismatches.some(x=>x.field==='lockfile'));
});


test('an installed version satisfying manifest but differing from lock is still drift',t=>{
  const manifest={name:'audit-fixture',version:'1.0.0',dependencies:{'@1agents/fake':'^0.7.0'}};
  const f=fixture(t,manifest);
  f.put('package-lock.json',{lockfileVersion:3,packages:{'':manifest,'node_modules/@1agents/fake':{version:'0.7.1'}}});
  f.put('node_modules/@1agents/fake/package.json',{name:'@1agents/fake',version:'0.7.2'});
  const result=auditDependencies(f.root);
  assert.equal(result.npmExitCode,0);
  assert.equal(result.valid,false);
  assert.deepEqual(result.lockedInstalledMismatches,[{packagePath:'node_modules/@1agents/fake',lockedVersion:'0.7.1',installedVersion:'0.7.2'}]);
});

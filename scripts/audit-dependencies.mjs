#!/usr/bin/env node
/** Read-only dependency audit. Multiple valid versions are not a failure. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const firstParty = name => name.startsWith('@1agents/') || name.startsWith('@scottzx/');
const digest = file => fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sorted = value => JSON.stringify(Object.entries(value ?? {}).sort(([a],[b]) => a.localeCompare(b)));
const fields = ['dependencies','devDependencies','optionalDependencies','peerDependencies'];

function installedPath(root, name) {
  if (!/^(?:@[^/]+\/)?[^/]+$/.test(name) || name.includes('..')) return null;
  for(let current = root;; current = path.dirname(current)) {
    const file = path.join(current,'node_modules',name,'package.json');
    if(fs.existsSync(file)) return fs.realpathSync(file);
    if(path.dirname(current) === current) return null;
  }
}

export function auditDependencies(inputRoot) {
  const root=fs.realpathSync(path.resolve(inputRoot));
  const manifestFile=path.join(root,'package.json'),manifest=read(manifestFile);
  const manager=manifest.packageManager?.split('@')[0] || (fs.existsSync(path.join(root,'pnpm-lock.yaml'))?'pnpm':fs.existsSync(path.join(root,'yarn.lock'))?'yarn':'npm');
  const lockFile=path.join(root,'package-lock.json');
  const requested=Object.fromEntries(fields.map(field=>[field,Object.fromEntries(Object.entries(manifest[field]??{}).filter(([name])=>firstParty(name)))]));
  const result={schemaVersion:1, root, package:{name:manifest.name??null,version:manifest.version??null,private:manifest.private??false},
    packageManager:manifest.packageManager??manager, hashes:{manifest:digest(manifestFile),lock:manager==='npm'?digest(lockFile):null}, requested,
    lockManifestMismatches:[], lockedInstalledMismatches:[], installed:[], npmProblems:[], npmExitCode:null, validationSupported:manager==='npm',
    runtime:{verified:false,note:'Installed manifests do not establish active profile or running process versions.'}, valid:false};
  if(manager!=='npm') {
    result.unsupportedReason=`${manager} workspace: npm validation was not run. Use the native package manager and its frozen lockfile workflow.`;
    return result;
  }
  if(!fs.existsSync(lockFile)) result.lockManifestMismatches.push({packagePath:'.',field:'lockfile',reason:'missing package-lock.json'});
  else {
    const lock=read(lockFile);
    if(!lock.packages?.['']) result.lockManifestMismatches.push({packagePath:'.',field:'lockfile',reason:'root package metadata is absent; supported lockfile v2/v3 required'});
    else for(const [location,locked] of Object.entries(lock.packages)) {
      if(locked.link) continue;
      if(location.includes('node_modules')) {
        const installedFile=path.resolve(root,location,'package.json');
        if(installedFile.startsWith(root+path.sep) && fs.existsSync(installedFile)) {
          const actual=read(installedFile);
          if(locked.version && actual.version!==locked.version) result.lockedInstalledMismatches.push({packagePath:location,lockedVersion:locked.version,installedVersion:actual.version??null});
        }
        continue;
      }
      const directory=path.resolve(root,location);
      if(directory!==root && !directory.startsWith(root+path.sep)) continue;
      const file=path.join(directory,'package.json');
      if(!fs.existsSync(file)) continue;
      const source=read(file);
      for(const field of fields) if(sorted(source[field])!==sorted(locked[field])) {
        result.lockManifestMismatches.push({packagePath:location||'.',field,declared:source[field]??{},locked:locked[field]??{}});
      }
    }
  }
  const process=spawnSync('npm',['ls','--all','--long','--omit=dev','--json'],{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024,
    env:{...globalThis.process.env,npm_config_ignore_scripts:'true',npm_config_audit:'false',npm_config_update_notifier:'false'}});
  result.npmExitCode=process.status;
  let tree;
  try { tree=JSON.parse(process.stdout); } catch {
    result.npmProblems.push(process.error?.code??'NPM_LS_INVALID_OUTPUT');
    return result;
  }
  result.npmProblems=Array.isArray(tree.problems)?tree.problems:[];
  if(process.error) result.npmProblems.push(process.error.code??'NPM_LS_FAILED');
  const seen=new Set();
  function walk(node,consumer) {
    for(const [installName,entry] of Object.entries(node.dependencies??{})) {
      const file=installedPath(consumer,installName);
      const directory=file?path.dirname(file):consumer;
      const key=`${installName}:${file??'missing'}:${entry.version??''}`;
      if(seen.has(key)) continue; seen.add(key);
      if(firstParty(installName)) {
        let actual=null;
        try{actual=file?read(file):null;}catch{/* invalid manifest reported by npm */}
        result.installed.push({installName,name:actual?.name??installName,version:actual?.version??entry.version??null,
          manifestPath:file,invalid:entry.invalid??false,missing:entry.missing??!file,
          resolution:'installed-node_modules',runtimeVerified:false});
      }
      walk(entry,directory);
    }
  }
  walk(tree,root);
  result.valid=process.status===0 && result.npmProblems.length===0 && result.lockManifestMismatches.length===0 && result.lockedInstalledMismatches.length===0;
  result.installed.sort((a,b)=>a.installName.localeCompare(b.installName)||(a.manifestPath??'').localeCompare(b.manifestPath??''));
  return result;
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2);let root='.',json=false,check=false;
    for(let i=0;i<args.length;i++) {
      if(args[i]==='--root') {root=args[++i];if(!root||root.startsWith('--'))throw new Error('--root requires a directory');}
      else if(args[i]==='--json')json=true;
      else if(args[i]==='--check')check=true;
      else throw new Error(`Unknown argument: ${args[i]}`);
    }
    const result=auditDependencies(root);
    console.log(json?JSON.stringify(result,null,2):`${result.package.name}: ${result.validationSupported?(result.valid?'valid installed dependency tree':'dependency drift or incomplete validation'):'native package manager required'}\n${result.installed.length} first-party installed paths; runtime not inspected.`);
    if(check&&!result.valid)process.exitCode=result.validationSupported?1:2;
  } catch(error) {console.error(`Dependency audit failed: ${error.message}`);process.exitCode=2;}
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { installSkillService, renderSkillServicePlist, renderSkillServiceUnit, SKILL_SERVICE_LABEL, SKILL_SYSTEMD_UNIT } from '../src/daemon.js';

test('the independent process manager command preserves the exact config and Node registration target', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-daemon-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const script = path.join(temp, 'skill & manager', 'cli.js');
  fs.mkdirSync(path.dirname(script));
  fs.writeFileSync(script, '');
  const options = { script, nodeBin: process.execPath, port: 37909,
    agentUrl: 'http://localhost:37908', config: path.join(temp, 'my config.json'), projects: false };
  const plist = renderSkillServicePlist(options);
  assert.ok(plist.includes(`<string>${SKILL_SERVICE_LABEL}</string>`));
  assert.ok(plist.includes('skill &amp; manager'));
  assert.ok(plist.includes('<string>serve</string>'));
  assert.ok(plist.includes('<string>--no-projects</string>'));
  assert.ok(plist.includes('<string>37909</string>'));
  assert.ok(plist.includes('<string>http://localhost:37908</string>'));
  assert.ok(plist.includes('<string>'+options.config+'</string>'));
  assert.ok(plist.includes('<key>PATH</key>'));
  const unit = renderSkillServiceUnit(options);
  assert.ok(unit.includes(`"${script}" "serve"`));
  assert.ok(unit.includes('"--config" "'+options.config+'"'));
  assert.ok(unit.includes('"--no-projects"'));
  assert.ok(unit.includes('Restart=always'));
  assert.equal(SKILL_SYSTEMD_UNIT, 'dreammate-skills.service');
});

test('installation rejects invalid commands before touching a real service manager', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-daemon-invalid-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const script = path.join(temp, 'cli.js');
  fs.writeFileSync(script, '');
  await assert.rejects(installSkillService({ script: path.join(temp, 'cli.ts') }), /TypeScript/);
  await assert.rejects(installSkillService({ script: path.join(temp, 'missing.js') }), /入口脚本不存在/);
  for (const port of [0, -1, 65536, 2.5]) {
    await assert.rejects(installSkillService({ script, port }), /端口/);
  }
  for (const agentUrl of ['https://example.com', 'http://u:p@localhost:36908', 'http://localhost:36908/extra', 'http://localhost:36908/?token=x']) {
    await assert.rejects(installSkillService({ script, agentUrl }), /loopback/);
  }
  await assert.rejects(installSkillService({ script, config: 'invalid\nconfig' }), /换行/);
});

test('systemd render escapes specifiers and quotes paths instead of letting the manager expand them', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-daemon-quoted-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const script = path.join(temp, 'skill%$"name.js');
  fs.writeFileSync(script, '');
  const unit = renderSkillServiceUnit({ script, config: path.join(temp, 'a%$".json') });
  assert.ok(unit.includes('skill%%$$\\"name.js'));
  assert.ok(unit.includes('a%%$$\\".json'));
});

test('daemon installation preserves supported custom discovery roots without copying unrelated environment', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-daemon-env-'));
  const script = path.join(temp, 'cli.js');
  fs.writeFileSync(script, '');
  const keys = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME', 'GROK_HOME', 'DSH_HOME', 'DSH_AGENTS_HOME', 'DSH_BUNDLED_SKILL_DIR', 'PRIVATE_SKILL_TOKEN'];
  const previous = keys.map(key => [key, process.env[key]] as const);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(temp, { recursive: true, force: true });
  });
  for (const key of keys) process.env[key] = path.join(temp, key);
  const plist = renderSkillServicePlist({ script });
  const unit = renderSkillServiceUnit({ script });
  for (const key of keys.slice(0, -1)) {
    assert.ok(plist.includes(`<key>${key}</key><string>${process.env[key]}</string>`));
    assert.ok(unit.includes(`Environment="${key}=${process.env[key]}"`));
  }
  assert.equal(plist.includes('PRIVATE_SKILL_TOKEN'), false);
  assert.equal(unit.includes('PRIVATE_SKILL_TOKEN'), false);
});

test('failed uninstall leaves the service file available for recovery', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-daemon-uninstall-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const home = path.join(temp, 'home');
  const bin = path.join(temp, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'launchctl'), `#!${process.execPath}\nif(process.argv[2] !== 'print') process.exitCode=23;\n`, { mode: 0o755 });
  const child = `
    import fs from 'node:fs';
    import path from 'node:path';
    import assert from 'node:assert/strict';
    Object.defineProperty(process,'platform',{value:'darwin'});
    const library=await import(${JSON.stringify(new URL('../src/daemon.ts', import.meta.url).href)});
    const file=path.join(process.env.HOME,'Library/LaunchAgents',library.SKILL_SERVICE_LABEL+'.plist');
    fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'preserve this job');
    await assert.rejects(library.uninstallSkillService());
    assert.equal(fs.readFileSync(file,'utf8'),'preserve this job');
  `;
  execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', child], {
    env: { ...process.env, HOME: home, PATH: bin + path.delimiter + (process.env.PATH ?? '') },
    encoding: 'utf8', timeout: 15_000,
  });
});

for (const existing of [true, false]) {
  test(`launchd install failure restores the prior running state (existing=${existing})`, t => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-daemon-rollback-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const home = path.join(temp, 'home');
    const bin = path.join(temp, 'bin');
    fs.mkdirSync(home);
    fs.mkdirSync(bin);
    const script = path.join(temp, 'cli.js');
    const state = path.join(temp, 'running.json');
    fs.writeFileSync(script, '');
    fs.writeFileSync(path.join(bin, 'launchctl'), `#!${process.execPath}\n
import fs from 'node:fs';
const args=process.argv.slice(2);
const state=${JSON.stringify(state)};
if(args[0]==='bootout') fs.rmSync(state,{force:true});
if(args[0]==='bootstrap') fs.writeFileSync(state,fs.readFileSync(args[2]));
if(args[0]==='enable') process.exitCode=1;
`, { mode: 0o755 });
    // Use an ESM extension via package type so the executable has no dependency on the checkout.
    fs.writeFileSync(path.join(bin, 'package.json'), '{"type":"module"}');
    const source = new URL('../src/daemon.ts', import.meta.url).href;
    const child = `
      import fs from 'node:fs';
      import path from 'node:path';
      import assert from 'node:assert/strict';
      Object.defineProperty(process,'platform',{value:'darwin'});
      const library=await import(${JSON.stringify(source)});
      const file=path.join(process.env.HOME,'Library/LaunchAgents',library.SKILL_SERVICE_LABEL+'.plist');
      const previous='previous manager configuration';
      if(${existing}) {fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,previous); fs.writeFileSync(${JSON.stringify(state)},previous);}
      await assert.rejects(library.installSkillService({script:${JSON.stringify(script)}}));
      assert.equal(fs.existsSync(file),${existing});
      assert.equal(fs.existsSync(${JSON.stringify(state)}),${existing});
      if(${existing}) {assert.equal(fs.readFileSync(file,'utf8'),previous);assert.equal(fs.readFileSync(${JSON.stringify(state)},'utf8'),previous);}
    `;
    execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', child], {
      env: { ...process.env, HOME: home, PATH: bin + path.delimiter + (process.env.PATH ?? '') },
      encoding: 'utf8', timeout: 15_000,
    });
  });
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  SERVICE_LABEL,
  SYSTEMD_UNIT,
  installService,
  logDir,
  platformOf,
  plistPath,
  renderPlist,
  renderUnit,
  serviceStatus,
  unitPath,
} from '../src/service.js';

/** renderPlist / renderUnit 只接受解析好的入参，这里手工造一份。 */
const resolved = { nodeBin: '/usr/local/bin/node', script: '/opt/app/dist/bin/dreammate-node.js', host: '0.0.0.0', port: 36908 };

test('plist 带上绝对路径的 node 与脚本', () => {
  const plist = renderPlist(resolved);
  // launchd 的 PATH 几乎是空的，写 `node` 会直接起不来。
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(plist, /<string>\/opt\/app\/dist\/bin\/dreammate-node\.js<\/string>/);
  assert.match(plist, /<key>Label<\/key><string>work\.dreammate\.node<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/, '挂了要自动拉起');
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/, '开机要自启');
  assert.match(plist, /<string>36908<\/string>/);
});

test('plist 对路径里的 XML 特殊字符做转义', () => {
  // 一个含 & 的目录会把 plist 变成非法 XML，launchd 直接拒绝加载。
  const plist = renderPlist({ ...resolved, script: '/opt/a&b/dist/bin/x.js' });
  assert.match(plist, /\/opt\/a&amp;b\//);
  assert.ok(!/\/opt\/a&b\//.test(plist), '裸 & 会让 plist 非法');
});

test('plist 与 unit 都补上 PATH —— 否则找不到 tailscale', () => {
  // 实测过的坑：launchd 只给 /usr/bin:/bin:/usr/sbin:/sbin，homebrew 的
  // tailscale 在 /opt/homebrew/bin，于是装成服务后静默回退到本地身份，
  // 同一台机器在前台和服务模式下变成两个 Node。
  assert.match(renderPlist(resolved), /<key>PATH<\/key><string>[^<]*\/opt\/homebrew\/bin/);
  assert.match(renderUnit(resolved), /^Environment=PATH=.*\/usr\/local\/bin/m);
});

test('systemd unit 会自动重启且不提权', () => {
  const unit = renderUnit(resolved);
  assert.match(unit, /ExecStart=\/usr\/local\/bin\/node \/opt\/app\/dist\/bin\/dreammate-node\.js --host 0\.0\.0\.0 --port 36908/);
  assert.match(unit, /Restart=always/);
  // agent 只读本机服务清单，没有要 root 的理由。
  assert.match(unit, /NoNewPrivileges=true/);
  assert.match(unit, /WantedBy=default\.target/);
});

test('拒绝把 TypeScript 源码装成服务', async () => {
  // launchd/systemd 里只有裸 node，没有 tsx——装进去只会在开机时静默失败。
  await assert.rejects(
    () => installService({ script: '/tmp/whatever/bin/dreammate-node.ts' }, '/tmp/whatever/bin/dreammate-node.ts'),
    /TypeScript 源码/,
  );
});

test('入口脚本不存在就报错，而不是装一个永远起不来的服务', async () => {
  const missing = path.join(os.tmpdir(), `nope-${Date.now()}.js`);
  await assert.rejects(() => installService({ script: missing }, missing), /入口脚本不存在/);
});

test('路径约定落在用户目录下，不需要 sudo', () => {
  const home = os.homedir();
  assert.ok(plistPath().startsWith(path.join(home, 'Library', 'LaunchAgents')));
  assert.ok(unitPath().startsWith(path.join(home, '.config', 'systemd', 'user')));
  assert.ok(logDir().startsWith(path.join(home, '.1agents')));
  assert.equal(SERVICE_LABEL, 'work.dreammate.node');
  assert.equal(SYSTEMD_UNIT, 'dreammate-node.service');
});

test('status 在未安装时如实报告，不抛错', async (t) => {
  let platform: string;
  try {
    platform = platformOf();
  } catch {
    return t.skip('当前平台不支持服务安装');
  }
  const status = await serviceStatus(1); // 1 号端口不会有人应答
  assert.equal(status.platform, platform);
  assert.equal(status.responding, false);
  assert.equal(status.installed, fs.existsSync(status.file), 'installed 应该等于文件真的在不在');
});

test('install 是幂等的，且必须让新代码真正生效', async () => {
  // 回归：`systemctl enable --now` 对已 active 的服务不会重启，于是 npm 更新
  // 了文件、进程还在跑旧代码。这里只能检查我们发出的命令里含 restart——
  // 真实行为在装了 systemd 的机器上验证过（manifest 的 protocol 版本从旧值
  // 跳到新值才算数）。
  const source = await fs.promises.readFile(new URL('../src/service.ts', import.meta.url), 'utf8');
  const systemd = source.slice(source.indexOf("const file = unitPath();"));
  assert.match(systemd, /'restart', SYSTEMD_UNIT/, 'systemd 分支必须 restart');
  assert.ok(!/'enable', '--now'/.test(systemd), '不能用 enable --now，它对已运行的服务是 no-op');
  // launchd 分支靠 bootout + bootstrap 达到同样效果。
  const launchd = source.slice(source.indexOf("if (platform === 'launchd')"), source.indexOf("const file = unitPath();"));
  assert.match(launchd, /'bootout'/);
  assert.match(launchd, /'bootstrap'/);
});

# 发版与 DSH profile 升级

本文档记录 `@1agents/dreammate-node` 的版本管理、发版流程，以及把新版本装进运行中的
DeepSeek Harness profile 的标准做法。这里踩过几次坑，按下面的顺序做可以避开。

## 一、版本控制原则

- **版本号只有一个真源**：仓库根的 `package.json`。`package-lock.json` 的两处版本由
  `npm version` 自动同步，不要手工编辑。
- **tag 驱动发布**：`vX.Y.Z` tag 一推，`publish.yml` 就发 npm；CI 会校验 tag 与
  `package.json` 版本一致，不一致直接失败（发出去的包收不回来）。
- **号段语义**：`patch` 修 bug，`minor` 加功能，`major` 破坏性变更。
  0.22.1（回环代理修复）、0.22.2（浏览器 bundle 顶层声明）、0.22.3（去掉 postinstall）
  都是 patch。
- **不要手工改两个文件再打 tag**：漏改 `package-lock.json` 或 tag 名写错都会让 CI 失败。

## 二、发版流程

```bash
# 1. 本地全检。check:all 比 CI 更全（还包含 integration 和独立包边界）
npm run check:all

# 2. 一条命令完成：改 package.json + package-lock.json → commit → tag vX.Y.Z
npm version patch -m "fix: %s"

# 3. 推 commit 和 tag。--follow-tags 保证 tag 一起推上去
git push origin main --follow-tags

# 4. 看 CI（publish.yml）：typecheck → test → build → tag 校验 → embed →
#    pack → 独立包安装 → npm publish --provenance
gh run list --workflow publish.yml --limit 3
gh run watch <run-id> --exit-status
```

CI 日志里出现 `+ @1agents/dreammate-node@X.Y.Z` 才算发布成功。

**等 npm 传播完再升级本机**。registry 有几十秒到几分钟的延迟，立刻装会 ETARGET：

```bash
npm view @1agents/dreammate-node version --registry=https://registry.npmjs.org
```

返回目标版本再继续。若本机 npm 配了镜像/缓存，加 `--prefer-online --cache=/tmp/dm-npm-cache-fresh`
绕过缓存。

## 三、profile 升级四步

不能直接点插件页的升级——`remove_bundle` 会撞 `bundle-in-use`：profile 自己的
`cordis.patch.yml` 启用着 `yima-tailnet-trust` / `yima-shared-loopback` 行，它们的 fiber
还活着。必须先把 bundle 摘掉。

| 步骤 | 操作 | 为什么 / 注意 |
|---|---|---|
| ① | `set_bundle enabled=false` | 摘掉 bundle 的 patch 层，否则第②步被 `bundle-in-use` 挡住。会返回 `restart-required`，正常。 |
| ② | `remove_bundle` | 从 profile 移除旧依赖。**失败时不会自动回滚 bundle 选择**，要检查并恢复。 |
| ③ | `install_bundle @1agents/dreammate-node@X.Y.Z` | 0.22.3 起没有 postinstall，**不需要** `approvedBuilds`；registry 指定 `https://registry.npmjs.org`。 |
| ④ | 把 `@1agents/dreammate-node` 在 `package.json` 的 `dsh.profile.bundles` 里挪回原来的位置 | 安装会把它追加到数组末尾，改变加载顺序。 |

这四步可以用 `scripts/profile-upgrade.mjs` 编排、恢复顺序并验证（见第五节）。

### 升级后必须验证

```bash
# 已安装版本与 profile 声明一致
node -p "require('~/.dsh/profiles/desktop/node_modules/@1agents/dreammate-node/package.json').version"

# 浏览器 bundle 顶层无声明（0.22.2 的回归点）
grep -nE '^(const|let|var|class|function)\s' \
  ~/.dsh/profiles/desktop/node_modules/@1agents/dreammate-node/vendor/dsh/client.js

# 页面热重载图里有这一行，且没有 client-modules 报错
curl -sS -N --max-time 5 http://127.0.0.1:62579/plugins/events | grep dreammate-node
```

第一条应输出目标版本；第二条应**没有输出**；第三条应看到
`"id":"@1agents/dreammate-node"` 且 rev 是最新的。浏览器控制台不应有
`client-modules: could not load ... loaded without registering`。

## 四、踩过的坑与规避

| 坑 | 现象 | 规避 |
|---|---|---|
| 浏览器 bundle 顶层声明 | HMR 重载时 `SyntaxError: Identifier 'STYLE' has already been declared`，报 `loaded without registering` | 所有声明放进 `factory` 闭包；`test/dsh-embed.test.mjs` 的回归测试会拦住 |
| pnpm 11 构建脚本审批 | `ERR_PNPM_IGNORED_BUILDS`，安装失败并**回滚到旧版本** | 包内没有生命周期安装脚本；skill 用 `dreammate-node skills install` 显式装 |
| `bundle-in-use` | `remove_bundle` 失败 | 先 `set_bundle enabled=false`；不要直接改 profile 文件绕过 |
| 失败的操作不回滚 bundle 选择 | 升级失败后插件从图里消失 | 每次失败后检查 `bundles` 数组，必要时 `set_bundle enabled=true` |
| 安装挪动 bundle 顺序 | 加载顺序变化 | 升级后按第四节第④步还原 |
| npm 传播延迟 | `ETARGET`，装不到刚发的版本 | 先用 `npm view` 确认可见 |
| profile 里活着的 fiber | 旧代码还在跑 | 升级后看浏览器控制台，确认无 `client-modules` 报错；必要时重启 DSH（会中断当前会话） |

## 五、profile-upgrade 脚本

`scripts/profile-upgrade.mjs` 把四步流程编排成两阶段，因为中间的
`set_bundle` / `remove_bundle` / `install_bundle` 是 plugin_manager 的 Remote 方法，
只能在 Agent 会话里调用，普通 Node 进程调不到。

```bash
# 阶段一：准备。检查版本已发布、备份 bundle 顺序、打印给 Agent 的调用序列
node scripts/profile-upgrade.mjs prepare --version X.Y.Z

# Agent 按打印的序列调用 set_bundle / remove_bundle / install_bundle

# 阶段二：收尾。恢复 bundle 顺序、验证版本与 bundle、输出热重载 URL
node scripts/profile-upgrade.mjs finalize --version X.Y.Z
```

脚本默认操作 `desktop` profile，可用 `--profile NAME` 指定；`--dry-run` 只打印不落盘。

## 六、回滚

npm 包发布后不可变，不能删版本。回滚只能装回旧版：

1. 按第三节四步把目标版本换成上一个版本号。
2. 代码层回滚用 `git revert <commit>`，然后走第二节重新发一个**更高的 patch 版本**
   （例如 0.22.3 发现问题，就发 0.22.4 而不是重新发 0.22.3）。
3. 不要改写 tag 或重发已存在的版本号；CI 会跳过已发布版本，导致线上仍是旧代码。

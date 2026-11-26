# DSH 远程控制架构选型：自建中转 + WebSocket + 手机客户端

> 调研日期：**2026-11-13**
> 需求：① 手机端远程控制电脑上的 DSH ② **我们只提供中转服务器** ③ 优先原生 App / 微信小程序，不想要纯 Web ④ 计划：先试点、后原生。
> 核实方式：GitHub API 拉源码结构与 README、npm registry 校验包名版本、Release 资产核对。

---

## 0. 先说结论

你要的架构（自建中转 + WebSocket 转发 + 手机客户端）**已经有成熟开源实现**，而且有两条互不兼容的技术路线，选错了后面会返工：

| 路线 | 传输层 | 微信小程序 | 自建中转 | 原生客户端源码 | 代表项目 |
|---|---|---|---|---|---|
| **A. liguobao 全家桶** | WebRTC(P2P/TURN) + Relay 回退，Noise IK 加密 | ❌ 不支持 WebRTC | ✅ `apps/server` 一条 Docker | ✅ Android(React Native) 源码全 | `liguobao/ds-harness-remote` **2 731★ MIT** |
| **B. dsh-remote 三件套** | 纯 WebSocket + XSalsa20-Poly1305 密封记录 | ✅ 官方小程序已上架 | ✅ `dsh-remote/relay` 单文件零依赖 | ⚠️ 客户端仓库已 404 | `dsh-remote/{plugin,protocol,relay}` |
| **C. 微信小程序（另一家）** | WebSocket + E2EE | ✅ 「Agent远程管理助手」已上架 | ⚠️ `relayOrigin` 可配，但**服务端源码未开源** | — | `martinbear1/dsh-wechat-remote` MIT |

> ⚠️ **路线 A 和 B 的协议不通用**。小程序不支持 WebRTC，所以想做小程序**只能走 B**；想复用 liguobao 那套最成熟的原生客户端和 Server，**只能走 A**。这个岔路口要在开工前定死。

---

## 1. 路线 A（推荐做试点）：liguobao/ds-harness-remote

**2 731★ · 202 forks · MIT · 2026-11-12 更新 · npm `ds-harness-remote@0.6.4`**

这几乎就是你描述的架构，一个 monorepo 里全齐了：

```
apps/server     自建中继（Docker 一条命令起，含账号体系 + Web 客户端静态站）
apps/browser    Web/H5 客户端（复用原生 Harness 界面做响应式重排）
apps/android    React Native / Expo 原生 App（Releases 里有 APK）
apps/vscode     VS Code 客户端
packages/protocol   @dsh-remote/protocol 0.5.21（帧名冻结 + golden vectors）
packages/crypto     密封记录 / Noise IK
packages/client-core 客户端核心（跨端复用）
packages/plugin     DSH 宿主插件
packages/webrtc     WebRTC 传输
```

### 试点部署（30 分钟内可跑通）

```bash
# 1) 中继服务器（任何有公网 IP 的机器）
cd apps/server
cp .env.example .env
# 必改：DSH_SERVER_ACCOUNT=owner@example.com
#       DSH_SERVER_PASSWORD=≥12 位随机密码
#       DSH_SERVER_PUBLIC_URL=https://remote.你的域名   ← 必须与浏览器 origin 完全一致
docker compose pull server && docker compose up -d --no-build server
# 镜像：ghcr.io/liguobao/ds-harness-remote/server:latest（linux/amd64 + arm64）

# 2) 电脑端 DSH 装插件
dsh plugin --profile web add -w ds-harness-remote@0.6.4    # web profile
dsh plugin --profile desktop add -w ds-harness-remote@0.6.4 # desktop profile（各装各的）
# 装完必须完全重启 Harness

# 3) 电脑端插件里把 server URL 指到自建地址；Host 只发起出站连接，不开公网端口
```

手机浏览器打开 `https://remote.你的域名/app/remote` → 登录 → 选设备 → 即用。

### 为什么推荐它做试点

1. **一次装完就是你要的效果**：Web 客户端「复用原生 Harness 界面」，不是第三方 CSS 注入式适配，比 `dsh-web-mobile` 那类 UI 适配插件更彻底。
2. **试点成果可复用**：Web 客户端、Android 客户端、iOS(TestFlight) 共用同一个 Server 和同一套协议。阶段 2 做原生时**不需要换中转、不需要换协议**，试点的中转直接投产。
3. **中转侧是真自建**：`apps/server` 源码 + Dockerfile 在仓库里，MIT。
4. **Host 侧零暴露**：插件只发起出站连接，不监听公网端口，不用配路由器。
5. 客户端可换：官方 Android APK 在 Releases；`dsh-Go`（20 848★）也兼容这套协议。

### 它的边界（要说清楚）

- `apps/server` 是**单账号最小 Server**：「不提供完整多账号 Server、Remote Web 会话 UI，也不提供 WebRTC/TURN 部署」。
- 传输是 `Noise_IK_25519_ChaChaPoly_SHA256`，**不是纯 WebSocket 长连接**——小程序用不了。
- iOS 还在 TestFlight beta（[issue #20](https://github.com/liguobao/ds-harness-remote/issues/20)），要正式上架得自己申请。

---

## 2. 路线 B（要做微信小程序，就走这条）：dsh-remote 三件套

**全 MIT · 协议 npm 0.5.4 · 宿主插件 npm 0.5.5 · 中继 v0.5.8**

| 仓库 | 作用 | 获取 |
|---|---|---|
| `dsh-remote/protocol` | 线协议：帧 schema、载荷目录、密封记录、KDF、版本闸。**纯函数零 I/O**，帧名冻结 | npm `@dsh-remote/protocol` |
| `dsh-remote/relay` | **零知识 WebSocket 中继**：单文件 `dist/bundle/main.js`，`ws`/协议层全内联，运行时零依赖 | 不发 npm → 取 Release 的 `main.js`（有 `SHA256SUMS`）或自己 `pnpm build` |
| `dsh-remote/plugin` | 宿主插件：配对、中继连接、会话/命令、审批转发、状态栏 pill | npm `@dsh-remote/plugin` |
| `dsh-remote/client` | **官方微信小程序**：扫码配对 / 会话列表 / 对话 / 审批 / 提问 | ⚠️ **GitHub 404，已不可访问**（小程序本身仍上架可用） |

### 部署要点

```bash
# 中继
scp main.js root@HOST:/opt/dsh-remote-control/server/relay.mjs
export DRC_HOST_TOKEN=$(openssl rand -hex 32)   # 与主机插件那份必须逐字一致
export DRC_PUBLIC_URL=wss://你的域名
node relay.mjs
curl -s http://127.0.0.1:8787/healthz            # 二十八个字段的运维契约

# 电脑端
dsh plugin --profile web add @dsh-remote/plugin
```

关键环境变量：`DRC_BIND` 默认 `127.0.0.1`（TLS 交给反代终止）、`DRC_STATE_FILE` 落盘会话表、`DRC_MP_APPID`/`DRC_MP_SECRET`/`DRC_MP_ENV` 让中继自己签发**小程序码**（`GET /code`）、`DRC_MAX_HOST_TOKENS` 令牌表上限。

中继是**结构性零知识**：构建产物里搜不到 `xsalsa20`/`secretbox`/`tweetnacl`，它没有可解密的代码。

### 代价

`dsh-remote/client` 源码没了 → **小程序 UI 改不了、也拿不到参考实现**。协议 README 提到「与小程序里那份保留实现的 SHA-256 锚定」，说明小程序里有一份协议实现，但源码不可得。

**想自研小程序？** 只能自己按 `@dsh-remote/protocol` 写，用仓库里的 golden vectors 做对拍。

---

## 3. 路线 C（另一个微信小程序，中转可配但服务端闭源）：martinbear1/dsh-wechat-remote

**MIT · 10★ · npm `dsh-wechat-remote@1.7.19` · 2026-11-11**

- 手机端：**微信搜索小程序「Agent远程管理助手」**，已上架，扫码配对即用
- 电脑端：DSH → 插件 → 添加插件 → `dsh-wechat-remote@1.7.19`
- 功能：会话进展、发任务、问答与审批、任务文件
- 支持局域网直连 + 端到端加密公网连接
- **中转可自建**：`~/.dsh/harness-remote-public.json` 里的 `relayOrigin` 可改（默认 `https://relay.xyxfood.xyz`）

⚠️ **但 relay 服务端源码不在仓库里**——只有客户端侧 `src/public-relay-agent.ts`。要真自建，得自己实现服务端协议，工作量不小。

---

## 4. 其他可参考的原生 App 起点

| 项目 | ★ | 许可 | 说明 |
|---|---|---|---|
| `201222-L/dsh-mobile-remote` | 113 | MIT | **Flutter 原生 App + 插件同一仓库**，`dsh-mobile-app/` 源码完整。想自己改原生 UI，这是最好的起点 |
| `SCSpotato/dsh-remote` | 95 | GPL-3.0 | 原生 Android 客户端（Kotlin） |
| `ccch1mneyyy/dsh-go` | **20 848** | AGPL-3.0 | Flutter Android，**手机本机跑 DSH** + 遥控电脑，Trendshift 日榜 #1 |
| `Blank-not-black/dsh-Remote` | 82 | MIT | 局域网 / Tailscale 直连，聊天记录离线可看 |
| `mrRisega/dsh-remote` | 61 | **PolyForm Noncommercial** | 自建 relay + PWA 全量透传，但**非商用许可**，商用需买授权 |

---

## 5. 对你们「先 UI 适配试点、再做原生」计划的修正建议

原计划是「手机端 UI 适配插件 → 加中转 → 试点 → 再做 H5 → 再做原生」。有两处要调：

### ① 试点不要用「UI 适配插件 + 中转」拼装

`mexiaosqwq/dsh-web-mobile`、`Z-6354/dsh-mobile-hanui` 这类插件是在 DSH Web 端注入移动布局/CSS，**它们本身不带远程通道**——你还是得另外配隧道或中转，等于两个插件各干一半，而且它们面向的是「窄屏浏览器」不是「小程序 App」。

而 liguobao 的 Web 客户端是**原生界面的响应式重排 + 自带中转**，一次装完就是你描述的效果，还比 UI 适配插件彻底。试点选它，同样的服务器直接就能切到 Android 原生客户端。

### ② 试点和正式必须是同一套协议 + 同一个中转

否则试点验证完，阶段 2 换栈等于重做一遍。路线 A 的最大价值就在这里：Web → Android → iOS 全程复用。

### ③ 真要做微信小程序，就从一开始走路线 B

小程序有三条硬约束，决定了它不能走路线 A：

1. **不支持 WebRTC** → liguobao 的 Noise IK + WebRTC 传输在小程序里跑不了，只能用路线 B 的纯 WebSocket + 密封记录。
2. **socket 合法域名**必须是**已备案域名 + HTTPS 证书**，`wss://`，不能用 `IP:端口`。中转侧必须配好证书和反代。
3. **无后台常驻 + 推送配额**：长任务完成通知只能走订阅消息（一次性模板，有配额），不能指望 App 常驻。

另外协议层要落到小程序：`tweetnacl`（XSalsa20-Poly1305）在小程序里需要纯 JS 移植或 WASM，`@dsh-remote/protocol` 本身声明「不许出现 node:fs / node:os / process.*」，正好是为无 I/O 环境设计的，可直接复用。

---

## 6. 建议的落地顺序

**第 0 步（半天，定架构）**
先决定：做不做微信小程序？
- 不做 → 路线 A，`dsh-harness-remote` 全家桶，Web 试点直接用官方 Web 客户端，阶段 2 出 Android APK。
- 做 → 路线 B，`dsh-remote/*`，但要先接受「官方小程序 UI 改不了」这个事实；想改 UI 就得自己写客户端。

**第 1 步（1 天，试点）**
路线 A：起 `apps/server` Docker → 装 `ds-harness-remote@0.6.4` 插件 → 手机浏览器连自建域名，实测：会话续接、流式输出、审批弹窗、文件回传、移动网络表现。

**第 2 步（并行，评估小程序可行性）**
把 `dsh-remote/relay` 也起一台，用官方微信小程序实测扫码配对和审批链路（不写代码，1 小时能出结论）。同时确认域名备案和 HTTPS 证书这两件事的周期。

**第 3 步（定路线后）**
- 路线 A：Android 用官方 APK，iOS 排 TestFlight/上架；要做深度定制再考虑 `201222-L/dsh-mobile-remote` 的 Flutter 源码。
- 路线 B：按 `@dsh-remote/protocol` 自研小程序客户端，用 golden vectors 对拍。

---

## 7. 安全边界提醒（这些项目共同的坑）

- **中继默认绑 `127.0.0.1`**，TLS 交给反代终止。别把 Node 监听端口直接暴露公网。
- **配对码有服务端权威寿命**（`DRC_PAIR_TTL_MS` 默认 120 秒），配对凭据落盘一律 0600。
- `/api/pair-status` 默认 **404**：让未认证方能问「6 位码是否有效」等于给码空间装了扫描 oracle，调试用 `DRC_PAIR_STATUS=1`，用完关掉。
- **不要用 `dsh plugin --profile desktop add`** 去装 desktop profile 的包——该 profile 由 Electron 应用独占管理，CLI 会直接拒绝。
- 中继的路由表是**内存的**，重启即全部作废（客户端会看到 `unknown_session`），这是设计不是缺陷。
- 装插件后**必须完全退出再重开** Harness：HMR 只热更 `cordis.patch.yml`，不会重新 import dist。

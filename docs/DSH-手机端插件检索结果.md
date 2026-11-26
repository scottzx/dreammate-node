# DSH 手机端插件检索结果

> 检索日期：**2026-11-13**　检索方式：MiniMax CLI（`mmx search query`）网络检索 + `awesome-dsh-plugin` 官方精选目录（GitHub API 全量拉取 `data/plugins/`，共 10 778 条）+ GitHub API 实时拉取 Star / 许可 / 最近推送 + npm registry 校验包名与版本。
> 关键词命中的手机相关条目共 **108** 条，其中官方目录 `remote`（📱 远程与移动端）类别 **47** 条。Star 数为 2026-11-13 实时值。

## 先分清四种「手机」玩法

不同插件把「执行引擎、凭据、文件、网络暴露面」放在不同位置，装错就是安全事故。DSH 插件注册表（dsh-plugin.net）明确区分了下面几种形态，选之前先确定属于哪一种：

| 形态 | DSH 跑在哪 | 手机做什么 | 代表插件 |
|---|---|---|---|
| ① 手机本机运行 | 手机上（Termux / 原生 App） | 就是主机 | `ccch1mneyyy/dsh-go` |
| ② 远程伴侣（最主流） | 电脑 / 工作站 / 服务器 | 通过网关、浏览器或消息通道控制已有会话 | `saya-ch/dsh-mobile`、`shaobeichen/dsh-pocket` |
| ③ 原生客户端 + 中继 | 电脑 | 原生 App 经自建 WSS 中继接入，4G/5G 可用且电脑不暴露公网端口 | `jayantTang/DSH_Mobile`、`sorsama/deepseek-harness-mobile` |
| ④ 纯手机端 UI 适配 | 电脑 | 只是让 DSH Web 界面在窄屏上好用，不做远程 | `mexiaosqwq/dsh-web-mobile`、`Z-6354/dsh-mobile-hanui` |

⚠️ 安全提醒：目录里大量插件会起独立 HTTP 服务或反向代理（cloudflared / FRP / Tailscale Funnel / 公网中转）。装之前务必确认绑定地址是 `127.0.0.1`/局域网、配对凭据可吊销、隧道有 Basic Auth 或独立 HTTPS。

## 已验证可直接安装的 Top 12

以下 npm 包名与版本均已通过 registry.npmjs.org 校验（2026-11-13）：

```bash
# ② 远程伴侣 — 功能最完整：Android App + iPhone/iPad 主屏幕 Web App + 局域网/多隧道 + 设备配对 + 对话内 /mobile 定制
dsh plugin --profile web add dsh-mobile@latest            # npm dsh-mobile 0.8.8 · saya-ch/dsh-mobile · Apache-2.0 · 840★

# ② 远程伴侣 — Star 最高：扫码即同步，手机浏览器直连官方界面
dsh plugin --profile web add dsh-pocket                    # npm dsh-pocket 2.12.0 · shaobeichen/dsh-pocket · GPL-2.0 · 2939★
dsh plugin --profile web add dsh-web-mobile                # npm dsh-web-mobile 3.3.5 · mexiaosqwq/dsh-web-mobile · MIT · 186★

# ③ 原生 App + 移动网关
dsh plugin --profile web add dsh-plugin-mobile-gateway@latest  # npm 0.12.0 · Clarklevis1995/dsh-plugin-mobile-gateway · MIT · 159★
dsh plugin --profile web add dsh-plugin-mobile-link       # npm 0.8.0 · jayantTang/DSH_Mobile 的 iOS 中继连接器 · MIT · 15★
dsh plugin --profile web add @restregular/dsh-pocket      # npm 0.17.1 · RestRegular/dsh-pocket · MIT · 2★
dsh plugin --profile web add @zyfgood/dsh-mobile          # npm 0.2.0 · zyfgood/dsh-mobile · MIT · 局域网 Web UI + SSE

# ④ 纯 UI 适配
dsh plugin --profile web add dsh-webui-mobile              # npm 0.4.4 · bbtssama/dsh-webui-mobile · MIT · 24★
dsh plugin --profile web add dsh-mobile-hanui              # npm 0.2.5 · Z-6354/dsh-mobile-hanui · MIT · 18★

# ② 安全网关 / 专用 iOS 通道
dsh plugin --profile web add dsh-remote-mobile             # npm 1.10.3 · IceApriler/dsh-remote-mobile · MIT · 50★
dsh plugin --profile web add dsh-mobile-access@1.1.10      # npm 1.1.10 · abbaababa/dsh-mobile-access · iPhone/iPad Safari 8 位配对
dsh plugin --profile web add dsh-mobile-plugin             # npm 0.5.47 · WNLUO/dsh-mobile-plugin · 移动 API + 中继 · 41★
```

**Profile 说明**：绝大多数手机端插件装 `web` profile；`afeack/dsh-mobile-harness` 用 `--profile desktop`。注意 `desktop` profile 由 Electron 应用独占管理，CLI 会直接拒绝执行 `dsh plugin --profile desktop add`（见 `zyfgood/dsh-mobile` README 提示）。

**D. 让 DSH 反向操作真机**（不是"用手机访问 DSH"，而是"Agent 控制你的手机"）：

```bash
dsh plugin --profile web add @zseven-w/dsh-ios@latest      # npm 0.1.0-rc.12 · 464★ · 22 个工具驱动模拟器/USB iPhone
dsh plugin --profile web add @zseven-w/dsh-android@latest  # npm 0.1.0-rc.13 · 350★ · 20 个工具经 adb 驱动安卓
```

## 目录与安装入口

- **DSH 内置插件市场**：`dsh-market`（12 182★，MIT）— 在 DSH 设置里浏览 / 搜索 / 一键安装 / 更新 / 回滚，数据源即 `awesome-dsh-plugin` 官方目录，是最省事的入口。
- **官方精选目录**：`awesome-dsh-plugin/awesome-dsh-plugin` — 分类 `remote`（📱 远程与移动端）为手机端插件的权威名单；收录要求声明 `dsh.bundle`、能正常安装、仍在维护。
- **移动端专项目录**：`WSK-build/awesome-dsh-mobile-plugins`（DSHBox 自建，把上游 `wsl` 分类改为 `phone` 🕹️ 手机控制）。
- **其他聚合/镜像站**：`dshpluginhub.ai`、`dshplugin.app`、`dshfind.com`、`dshhub.org` / `dshhub.dev`、`dshplugin.store`、`dshmp.com`、`dshopen.org`、`dsh.so`、`findharness.com`、`awesome-dsh-plugin.com`。

## 完整清单（官方目录 108 条命中，按 Star 排序）


### A. 手机本机直接跑 DSH（手机 = 主机）

| ★ | 插件 | 类别 | 许可 | 最近推送 | 仓库 | 说明 |
|---:|---|---|---|---|---|---|

### A. 手机本机直接跑 DSH（手机 = 主机）

| ★ | 插件 | 许可 | 最近推送 | 说明 |
|---:|---|---|---|---|
| 20848 | [ccch1mneyyy/dsh-go](https://github.com/ccch1mneyyy/dsh-go) | AGPL-3.0 | 2026-11-13 | **DSH Go**：Flutter 原生 Android 客户端（Android 8+）。手机上直接跑 DSH，也能遥控电脑上的 DSH。2026-10-25 建仓，Trendshift 全语言日榜 #1（2026-10-30）。装法：GitHub Releases 下 APK（arm64），**不是** `dsh plugin add` 包 |

### B. 手机遥控电脑上的 DSH（最主流，远程伴侣）

| ★ | 插件 | 类别 | 许可 | 最近推送 | 仓库 | 说明 |
|---:|---|---|---|---|---|---|
| 840 | `saya-ch/dsh-mobile` | remote | Apache-2.0 | 2026-11-12 | [saya-ch/dsh-mobile](https://github.com/saya-ch/dsh-mobile) | 通过 Android App 或手机浏览器访问 DeepSeek Harness，支持安全局域网连接、远程访问、持久设备配对和可自定义移动界面。 |
| 186 | `mexiaosqwq/dsh-web-mobile` | remote | MIT | 2026-11-11 | [mexiaosqwq/dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile) | DSH Web UI 移动端适配：窄屏好用，宽屏适用。 |
| 159 | `Clarklevis1995/dsh-plugin-mobile-gateway` | remote | MIT | 2026-11-07 | [Clarklevis1995/dsh-plugin-mobile-gateway](https://github.com/Clarklevis1995/dsh-plugin-mobile-gateway) | DeepSeek Harness 的设备鉴权移动网关：通过 WebSocket 连接配套原生 iOS 客户端，支持会话、实时事件、任务、Goal、审批、命令和文件传输，并提供二维码配对与设备撤销。 |
| 50 | `IceApriler/dsh-remote-mobile` | remote | MIT | 2026-11-03 | [IceApriler/dsh-remote-mobile](https://github.com/IceApriler/dsh-remote-mobile) | 远程与移动端安全网关：零改动 DSH 底层代码开放 Tailscale/局域网访问，支持扫码配对、RSA 加密、防暴力破解与移动端样式片段；与其他远程插件共存时自动让出共享配对服务，避免启动崩溃。 |
| 41 | `WNLUO/dsh-mobile-plugin` | remote | MIT | 2026-11-13 | [WNLUO/dsh-mobile-plugin](https://github.com/WNLUO/dsh-mobile-plugin) | 手机 App 的对端插件，自身可作无头宿主单独运行（不需要桌面外壳或 Electron）：经中转隧道或局域网配对提供受限的移动 API，用于列出、新建与操控 DSH 会话、订阅设备实时事件流，并以可吊销的设备凭据鉴权。 |
| 24 | `bbtssama/dsh-webui-mobile` | remote | MIT | 2026-09-05 | [bbtssama/dsh-webui-mobile](https://github.com/bbtssama/dsh-webui-mobile) | DSH Web 界面的移动端外壳：抽屉式侧栏、可拖拽悬浮按钮、移动端输入框修复，以及悬浮在输入框上方的图片上传按钮（原生相册/拍照，走加图校验管线），桌面端零影响。已发布到 npm（dsh-webui-mobile）。 |
| 18 | `Z-6354/dsh-mobile-hanui` | remote | MIT | 2026-10-05 | [Z-6354/dsh-mobile-hanui](https://github.com/Z-6354/dsh-mobile-hanui) | DSH Web 界面的移动端适配：窄屏下把桌面三栏布局改造成触屏友好的手机布局（覆盖式抽屉、可拖拽悬浮按钮、全屏弹窗、上滑加载历史），1024px 断点内生效，桌面端零影响。 — 基于 dsh-mobile-gate 的 |
| 17 | `Mrsirlila/dsh-pocket-plus#plugin` | remote | GPL-2.0 | 2026-11-08 | [Mrsirlila/dsh-pocket-plus](https://github.com/Mrsirlila/dsh-pocket-plus) | dsh-pocket 的增强版：访问密码直接写进二维码，手机扫一次即可登录；新增只读接口 /dsh-pocket/entry.json，手机 App 在局域网时就能同步当前公网地址与密码；内网 / Tailscale / |
| 15 | `jayantTang/DSH_Mobile#mobile-link` | remote | MIT | 2026-11-13 | [jayantTang/DSH_Mobile](https://github.com/jayantTang/DSH_Mobile) | DSH Mobile 的电脑侧连接器：连上可自建的公网 WSS 中转，手机在 4G/5G 下即可访问这台电脑上的 DSH 会话，电脑不需要公网 IP 也不用组网；中转只做鉴权与转发。 |
| 8 | `Imzl-zl/deepseek-harness-mobile#connector` | remote | MIT | 2026-11-12 | [Imzl-zl/deepseek-harness-mobile](https://github.com/Imzl-zl/deepseek-harness-mobile) | 原生安卓手机 App 的电脑侧：扫码配对后，就能在手机上对话、审批工具调用、回答提问、驱动子智能体、跟进后台任务，通道端到端加密；同一时刻只服务一台设备。 |
| 7 | `iimaguest/phone-tunnel-pool` | remote | Apache-2.0 | 2026-10-02 | [iimaguest/phone-tunnel-pool](https://github.com/iimaguest/phone-tunnel-pool) | 为 dsh web GUI 提供自愈式 Cloudflare 快速隧道池：浮窗控件、扫码手机访问、代际轮换、追踪 Service Worker，免提示凭据交接。 |
| 7 | `kinderao/dsh-pocket-relay` | remote | GPL-2.0 | 2026-09-17 | [kinderao/dsh-pocket-relay](https://github.com/kinderao/dsh-pocket-relay) | 手机与远程访问 DSH Web 界面：局域网扫码即用，或用自建 relay 中继服务端（替代 cloudflared 隧道）随时随地连回电脑；每台设备独立凭据，可配对、查看与单独撤销；多台电脑共用一个中继并自动热备。 |
| 7 | `zdx8637-gitdog/dshmobile#dshmobile-plugin` | remote | MIT | 2026-11-09 | [zdx8637-gitdog/dshmobile](https://github.com/zdx8637-gitdog/dshmobile) | 通过自建中继从手机访问 DSH（WSS 由你自己的 TLS 终止代理提供）：含桥接守护与扫码登录的 bundle 插件、原生 Android 应用，并支持服务端设备吊销。 |
| 6 | `Bernardxu123/dsh-mobile-gate` | remote | MIT | 2026-08-14 | [Bernardxu123/dsh-mobile-gate](https://github.com/Bernardxu123/dsh-mobile-gate) | 局域网手机访问网关：独立子进程反向代理 + 首次访问审批 + 设备令牌绑定 + 限流 + 手机端紧凑排版注入（输入区权限/模型小胶囊、randomUUID polyfill）。 |
| 6 | `cindyguyuehu123/dsh-mobile` | remote | MIT | 2026-08-15 | [cindyguyuehu123/dsh-mobile](https://github.com/cindyguyuehu123/dsh-mobile) | 让 DSH 在 iPhone/iPad 上可用：显式开启的局域网反向代理（改写 Host/Origin 通过回环信任栅栏，含 WebSocket 升级）、iOS PWA 外壳（主屏幕图标、standalone meta、 |
| 6 | `Zoragyx/dsh-phone-pair#dsh-phone-pair-kit` | remote | MIT | 2026-10-17 | [Zoragyx/dsh-phone-pair](https://github.com/Zoragyx/dsh-phone-pair) | 需要先装手机端 App，光装这个插件没用：手机那一半是单独的 APK，必须先安装——下载地址 https://github.com/Zoragyx/dsh-phone-pair/releases ——否则电脑端装好了也没 |
| 4 | `JauLukNgai/dsh-on-phone` | remote | Apache-2.0 | 2026-11-03 | [JauLukNgai/dsh-on-phone](https://github.com/JauLukNgai/dsh-on-phone) | 让手机浏览器直接使用电脑上的 DSH 网页界面，远程通道建立在 Tailscale Serve 之上。两边除了 Tailscale 不用再装任何东西：没有专用 App、没有二维码、没有登录页，插件不设账号，也不中转你的内 |
| 4 | `afeack/dsh-mobile-harness#dsh-mobile-harness` | remote | MIT | 2026-11-04 | [afeack/dsh-mobile-harness](https://github.com/afeack/dsh-mobile-harness) | DSH 的远程访问网关：用浏览器或可选的 Android App 扫一个码，接入电脑上正在运行的同一个会话。一次性二维码票据（10 分钟、扫一次失效）、6 位配对码两端核对、四条网络入口（SakuraFrp / Clou |
| 3 | `OrderG-X/dsh-mobile` | remote | MIT | 2026-11-12 | [OrderG-X/dsh-mobile](https://github.com/OrderG-X/dsh-mobile) | 在手机浏览器里用 DSH。点会话顶栏的手机按钮（或插件设置卡）打开手机访问、扫二维码，手机就打开电脑上 DSH 进程提供的官方网页界面，会话相同、实时同步，人不在电脑前也能跟进正在跑的任务、回消息、点批准。DSH 里内置 |
| 3 | `xchannel1987/dsh-mobile-xc` | remote | MIT | 2026-11-11 | [xchannel1987/dsh-mobile-xc](https://github.com/xchannel1987/dsh-mobile-xc) | DSH 移动端 UI 适配插件 - Overlay 抽屉导航、玻璃卡片设计、Safe Area 全覆盖、PWA 支持。 |
| 2 | `ook826092-cloud/dsh-mobile-css` | remote | MIT | 2026-08-15 | [ook826092-cloud/dsh-mobile-css](https://github.com/ook826092-cloud/dsh-mobile-css) | DSH Web UI 移动端适配：紧凑排版、全宽输入卡（含光标修复）、抽屉式侧边栏（点击遮罩关闭）、两页式设置流程、响应式表格与统计、安全触控目标。 |
| 2 | `RestRegular/dsh-pocket` | remote | MIT | 2026-11-06 | [RestRegular/dsh-pocket](https://github.com/RestRegular/dsh-pocket) | 为 DSH 单独做的窄屏移动端 Web 服务，不是把桌面 GUI 缩放塞进手机：自带会话列表与聊天流，随机访问令牌保护，可走局域网、cloudflared / localtunnel / localhost.run 隧道 |
| 2 | `ijry/DeepSeek-Harness-Desktop-Ultra#dsh-plugin-mobile-bridge` | remote | MIT | 2026-09-19 | [ijry/DeepSeek-Harness-Desktop-Ultra](https://github.com/ijry/DeepSeek-Harness-Desktop-Ultra) | 带令牌鉴权的 REST 与 SSE 接口，扫码配对后可在手机 App 上看会话、发消息、批准工具调用。 |
| 2 | `qiaohelenjoe/dsh-app#dsh-mobile-tunnel` | remote | - | 2026-11-11 | [qiaohelenjoe/dsh-app](https://github.com/qiaohelenjoe/dsh-app) | DeepSeek Harness 移动端：用手机使用你电脑上的 DSH。安卓 App 用同一账号登录，在设备列表里选中这台电脑，就能在手机上打开并进入它的 DeepSeek Harness 界面。桌面端插件负责注册与连接 |
| 1 | `Hongjun1-RGB/dsh-phone-access` | remote | MIT | 2026-10-15 | [Hongjun1-RGB/dsh-phone-access](https://github.com/Hongjun1-RGB/dsh-phone-access) | 在 DSH 界面里加一个开关，经由内嵌的 loopback 反向代理与 Cloudflare 快速隧道把当前会话开放给手机浏览器，并把每次的新隧道地址推送到微信。 |
| 1 | `MoRanYue/dsh-pocket` | remote | GPL-2.0 | 2026-11-11 | [MoRanYue/dsh-pocket](https://github.com/MoRanYue/dsh-pocket) | shaobeichen/dsh-pocket 的 fork：手机扫码经局域网或 cloudflared 隧道远程访问 DSH Web 界面并实时同屏；移动端布局交还 DSH 官方，插件只补安全区与触控样式，软键盘回车换行 |
| 1 | `TongaiLinC/dsh-mobile-access` | remote | MIT | 2026-09-01 | [TongaiLinC/dsh-mobile-access](https://github.com/TongaiLinC/dsh-mobile-access) | 移动端访问网关：独立子进程反向代理 + 首次访问 PC 审批（管理 token 认证、DNS rebinding 防护）+ 局域网/VPN/公网自动识别与网络模式切换 + 扫码访问 + WebSocket 实时转发 +  |
| 1 | `abbaababa/dsh-mobile-access` | remote | MIT | 2026-10-29 | [abbaababa/dsh-mobile-access](https://github.com/abbaababa/dsh-mobile-access) | 用 iPhone 或 iPad 的 Safari 打开 Mac 或 Windows 上的 DeepSeek Harness Web：8 位配对码、回环监听的局域网网关、可选 Tailscale Serve，以及仅 iOS |
| 1 | `chenacc1/agentbridge#dsh-phone` | remote | MIT | 2026-11-12 | [chenacc1/agentbridge](https://github.com/chenacc1/agentbridge) | 把手机控制台接到当前这条 DSH Desktop 会话：执行 /phone 出现一次性二维码，扫码后可从手机发消息、审批工具调用、切换模型和停止任务，电脑仍是唯一执行端。需本机运行 AgentBridge。 |
| 1 | `huanlanmie/dsh-mobile-access` | remote | MIT | 2026-09-05 | [huanlanmie/dsh-mobile-access](https://github.com/huanlanmie/dsh-mobile-access) | 受 PIN 保护的 DeepSeek Harness 移动端对话界面，在独立端口上通过局域网或自备隧道访问。 |
| 0 | `David060323/dsh-phone-remote` | remote | MIT | 2026-10-19 | [David060323/dsh-phone-remote](https://github.com/David060323/dsh-phone-remote) | DSH 手机远程访问的开箱即用修复套件：把 PWA manifest 的 start_url 改到 /pair-app，解决 iOS「添加到主屏幕」后打开停在 401 的问题；附常驻/守护脚本、自动登录与电源设置说明、中 |
| 0 | `Gaudi-XIX/dsh-pocket-glide` | remote | MIT | 2026-10-26 | [Gaudi-XIX/dsh-pocket-glide](https://github.com/Gaudi-XIX/dsh-pocket-glide) | 把桌面 DSH 的电话面做成克制遥控器：白名单透传会话读写、发消息与权限审批，页面由宿主直接产出、无构建链，扫码配对，隧道地址变了自动推回手机。 |
| 0 | `NOirBRight/dsh-mobile-pairing` | remote | MIT | 2026-09-25 | [NOirBRight/dsh-mobile-pairing](https://github.com/NOirBRight/dsh-mobile-pairing) | DSH 手机远程配对：提供二维码 offer、回环 Host Gateway、加密 Relay 或 Quick Tunnel、同网 WebRTC Direct，以及可撤销的 Android Device Token。 |
| 0 | `chinahhy/DSH-plugins#dsh-tether-ios` | remote | MIT | 2026-10-10 | [chinahhy/DSH-plugins](https://github.com/chinahhy/DSH-plugins) | 面向 macOS Apple Silicon 上 DSH Desktop 0.2.0-rc.2 的 iOS 远程控制插件，支持配对、审批通知与设备撤销。 |
| 0 | `jyb114/pocket-bridge` | remote | MIT | 2026-10-21 | [jyb114/pocket-bridge](https://github.com/jyb114/pocket-bridge) | 在 DSH 设置里为 Pocket Bridge 提供本机手机配对、网关控制与诊断面板。 |
| 0 | `opentandem/dsh-phone` | remote | MIT | 2026-11-06 | [opentandem/dsh-phone](https://github.com/opentandem/dsh-phone) | 在 dsh web 中新增「手机连接」页并显示二维码，用手机扫码、登录 OpenTandem 并点「允许」后，即可在 OpenTandem 里把任务发给这台电脑上的 dsh。首次使用会安装 OpenTandem 命令行和 |
| 0 | `solla-h/dsh-plugin-mobile-gateway` | remote | MIT | 2026-11-06 | [solla-h/dsh-plugin-mobile-gateway](https://github.com/solla-h/dsh-plugin-mobile-gateway) | 让 DSH Mobile App 通过认证的 WebSocket 与自托管 DeepSeek Harness 宿主配对的手机网关插件。Clarklevis1995/dsh-plugin-mobile-gateway 的分 |
| 0 | `ssy-in/dsh-my-phone` | remote | MIT | 2026-11-13 | [ssy-in/dsh-my-phone](https://github.com/ssy-in/dsh-my-phone) | 让手机连上本机的 DeepSeek Harness 桌面版：局域网或 Cloudflare 隧道二维码配对，实时消息列表与授权提醒，桌面悬浮球。局域网与 Cloudflare 隧道两个入口默认都开启；每台手机用自己的配对 |
| 0 | `xiaoxin3309/dsh-phone-control#plugin` | remote | MIT | 2026-11-13 | [xiaoxin3309/dsh-phone-control](https://github.com/xiaoxin3309/dsh-phone-control) | 从 DeepSeek Harness 控制已配对的 Android 手机：读取无障碍节点树、按文字点击、输入文字、截图、启动应用，还能读写手机上的文件；连接走加密 WebSocket。需要配套的 Android App（ |
| 0 | `yubi233/dsh-phone-remote` | remote | MIT | 2026-11-04 | [yubi233/dsh-phone-remote](https://github.com/yubi233/dsh-phone-remote) | dsh 的 Host 侧插件：经自托管中继把手机配到 dsh 实例，一条出站连接承载会话列表、流式对话、审批、附件与文件预览，送达专用手机网页壳；设备用一次性二维码链接配对，可在 dsh 网页内的控制台随时撤销。 |
| 0 | `zyfgood/dsh-mobile` | remote | MIT | 2026-10-22 | [zyfgood/dsh-mobile](https://github.com/zyfgood/dsh-mobile) | DSH 手机端 Web UI：带令牌认证的局域网服务，手机可浏览全部会话、通过 SSE 实时查看回复并继续对话；桌面 GUI 提供二维码入口，配合 dsh-whale-girl 0.3.0+ 现在还可以点桌宠鳍里的小手机 |
| 0 | `zylzyqzz/dsh-mobile-pwa` | remote | - | HTTP Error | [zylzyqzz/dsh-mobile-pwa](https://github.com/zylzyqzz/dsh-mobile-pwa) | 基于 dsh-mobile-gate 的完整移动端 PWA：安全远程访问网关 + 可安装到主屏（manifest + service worker）+ 离线可用 + 触屏手势（下拉刷新/边缘返弹/捏合缩放字体）+ age |

### C. 纯手机端 UI 适配（不远程，只让 DSH Web 在手机上好用）

| ★ | 插件 | 类别 | 许可 | 最近推送 | 仓库 | 说明 |
|---:|---|---|---|---|---|---|
| 10 | `AcidGr/dsh-web-mobile-fix` | ui | MIT | 2026-09-24 | [AcidGr/dsh-web-mobile-fix](https://github.com/AcidGr/dsh-web-mobile-fix) | Web UI 移动端布局修复：窄屏下设置面板全屏化、插件导航单行排满、侧边栏全屏、弹层居中、会话日志按钮图标化。 |
| 5 | `jasondu/dsh-ui-mobile` | ui | MIT | 2026-08-20 | [jasondu/dsh-ui-mobile](https://github.com/jasondu/dsh-ui-mobile) | 面向手机的 DeepSeek Harness 界面，提供可安装 PWA、响应式导航，以及 Agent 成功完成时的 Web Push 通知。 |
| 3 | `TZHR-invest/dsh-plugins#dsh-mobile-ui` | ui | MIT | 2026-10-13 | [TZHR-invest/dsh-plugins](https://github.com/TZHR-invest/dsh-plugins) | Web GUI 移动端适配：窄屏全宽响应式布局、会话抽屉、44px 触摸目标、安全区适配与阅读增强，桌面端零影响。 |
| 3 | `TecFancy/dsh-mobile` | ui | MIT | 2026-09-23 | [TecFancy/dsh-mobile](https://github.com/TecFancy/dsh-mobile) | DSH Web 移动端适配插件：侧边栏/详情抽屉浮层化、输入栏与设置页响应式适配，桌面零回归。 |
| 3 | `moophone/dsh-sidebar-fold` | ui | MIT | 2026-10-19 | [moophone/dsh-sidebar-fold](https://github.com/moophone/dsh-sidebar-fold) | 把侧边栏里所有面板行（slot 注册与插件直接注入两类）折叠成单独一行「插件大全」，把被挤掉的工作区高度还给会话列表。 |
| 2 | `better-er/dsh-mobile-drawer` | ui | MIT | 2026-11-04 | [better-er/dsh-mobile-drawer](https://github.com/better-er/dsh-mobile-drawer) | 窄屏下侧栏收起为左上角 44 像素悬浮方块、展开为 280 像素覆盖式抽屉，点会话自动收起，并压掉切会话时自动抢焦点导致的软键盘顶起。 |
| 2 | `langyo/dsh-mobile-upgrade` | ui | NOASSERTION | 2026-11-06 | [langyo/dsh-mobile-upgrade](https://github.com/langyo/dsh-mobile-upgrade) | 需要 DSH 0.1.5-rc.1。dsh web profile 的手机端体验修复：窄屏抽屉与设置标签、全宽模型菜单、卡住请求的网络状态芯片，以及把会话层级、subagent 与后台任务芯片收进一张可点开面板的窄屏头部 |
| 2 | `mengqinlol/dsh-mobile-shell` | ui | MIT | 2026-10-24 | [mengqinlol/dsh-mobile-shell](https://github.com/mengqinlol/dsh-mobile-shell) | 为 DSH Web 界面提供移动端适配，并增加支持预览和下载的工作区文件浏览器。 |
| 2 | `wwumit/dsh-phone#client` | ui | MIT | 2026-09-02 | [wwumit/dsh-phone](https://github.com/wwumit/dsh-phone) | 苹果风格智能体手机：双面板电话/短信、RCS 群聊（信任门禁）、跨设备智能体消息（registry 收件箱桥）、L0–L4 信任徽章与证据审计。实验性：信任摘要非安全保证，短信/信令经运营方收件箱中继（运营方可见）；E2 |
| 2 | `yuanzhenqi/dsh-mobile-ui` | ui | MIT | 2026-09-01 | [yuanzhenqi/dsh-mobile-ui](https://github.com/yuanzhenqi/dsh-mobile-ui) | 为 DSH Web 做成真正的手机壳：会话列表收成抽屉，点会话自动收起且不弹键盘，设置页改为全宽 sheet。 |
| 1 | `Htao-uu/dsh-mobile-shell` | ui | MIT | 2026-10-28 | [Htao-uu/dsh-mobile-shell](https://github.com/Htao-uu/dsh-mobile-shell) | 为 DSH Web UI 提供接近 DeepSeek App 的移动端壳层：抽屉导航、App 风格输入与设置；Android 返回键需搭配 dsh-android App（单独安装也能用，但作者不建议且可能有 bug）。 |
| 1 | `Odefined/dsh-mobile-webui` | ui | MIT | 2026-08-19 | [Odefined/dsh-mobile-webui](https://github.com/Odefined/dsh-mobile-webui) | 修复 dsh web GUI 的手机视口体验：抽屉式侧栏与滑动手势、纯图标 composer 与「权限·模型·思考深度」状态行、浮窗居中、横向溢出与滚动条挤压居中修复。 |
| 1 | `XiaoPb/dsh-mobile-layout` | ui | MIT | 2026-11-09 | [XiaoPb/dsh-mobile-layout](https://github.com/XiaoPb/dsh-mobile-layout) | DSH Web UI 的手机竖屏布局壳：侧边栏变成左侧右滑打开的抽屉，输入区下方常驻一条 56px 操作栏，设置页与模型 / 权限选择器按触控重排；提供原生、融合、悬浮三套布局预设，全部样式受 html[data-dsh |
| 1 | `feng-yifan/dsh-plugins#dsh-pwa-icon` | ui | - | 2026-11-12 | [feng-yifan/dsh-plugins](https://github.com/feng-yifan/dsh-plugins) | PWA 图标：把 Web GUI 安装 / 添加到桌面时使用的图标与应用名换成自定义内容，覆盖桌面浏览器与 iOS 主屏幕。包内自带开箱即用的图标集，也支持换成自己的图片并覆盖 manifest 字段。 |
| 1 | `kaijia323/dsh-mobile-ui` | ui | MIT | 2026-11-12 | [kaijia323/dsh-mobile-ui](https://github.com/kaijia323/dsh-mobile-ui) | 为 DSH Web 提供手机端外壳：抽屉导航、触控尺寸控件、安全区适配和全宽对话区，桌面端布局保持不变。 |
| 1 | `rsbsnv/dsh-mobile-adapt` | ui | MIT | 2026-10-25 | [rsbsnv/dsh-mobile-adapt](https://github.com/rsbsnv/dsh-mobile-adapt) | 手机上的 DSH 界面优化：侧边栏变可滑动抽屉、手势开关侧栏、宽度可调、返回键逐层退出、按钮放大、回车换行而不是直接发送、键盘不挡输入框、字号不小于 15px。 |
| 0 | `68110923/dsh-plugin-mobile-ux` | ui | MIT | 2026-11-10 | [68110923/dsh-plugin-mobile-ux](https://github.com/68110923/dsh-plugin-mobile-ux) | DSH Web 壳层的手机端体验优化：窄屏布局修复、iOS 键盘与视口跟随、侧边栏单击切换会话。 |
| 0 | `Canary-Builds/dsh-mobile-ui` | ui | MIT | 2026-09-06 | [Canary-Builds/dsh-mobile-ui](https://github.com/Canary-Builds/dsh-mobile-ui) | 为 DeepSeek Harness 现有 Web 界面加上触屏友好的导航、布局微调与独立 PWA 样式。 |
| 0 | `YiRan0/dsh-mobile-glass` | ui | MIT | 2026-08-18 | [YiRan0/dsh-mobile-glass](https://github.com/YiRan0/dsh-mobile-glass) | DSH Web 移动端适配：窄屏下聊天页在上/侧栏在下的 reveal 抽屉、拖动手势、设置面板底部卡片上滑、composer 与头部修复，桌面端零影响。 |
| 0 | `androidly/dsh-restart-control` | ui | MIT | 2026-10-22 | [androidly/dsh-restart-control](https://github.com/androidly/dsh-restart-control) | 在 DSH Web 侧边栏底部添加重启控件：宿主经自身的优雅退出通道退出，由检测到的进程守护（systemd、Kubernetes 或 Docker）拉起新进程，没有守护时插件自行拉起；右下角提示条轮询宿主 pid，直到 |
| 0 | `liudapeng0311/dsh-pwa-launcher` | ui | MIT | 2026-09-23 | [liudapeng0311/dsh-pwa-launcher](https://github.com/liudapeng0311/dsh-pwa-launcher) | 接管你桌面上已有的浏览器 PWA 快捷方式（保留原图标），双击即静默拉起 dsh web 并以应用窗口打开界面；网页右上角提供重启与 dsh 自助升级（失败自动回滚）两个控件。仅 Windows。 |
| 0 | `liujuntao123/dsh-mobile-keys` | ui | MIT | 2026-11-02 | [liujuntao123/dsh-mobile-keys](https://github.com/liujuntao123/dsh-mobile-keys) | 为 DSH Web 输入框增加「移动端热键模式」：自动检测移动/触控设备后切换为 Ctrl+Enter 发送、裸 Enter 换行，桌面键位保持不变，并提供设置面板开关、/mobilekeys 命令与 window.__ |
| 0 | `liuzwZYW/dsh-pwa-ui` | ui | MIT | 2026-10-13 | [liuzwZYW/dsh-pwa-ui](https://github.com/liuzwZYW/dsh-pwa-ui) | 通过 Window Controls Overlay 让已安装的 dsh Web 应用拥有原生观感的窗口标题栏——清单路由带 display_override 返回，应用自身的侧边栏品牌行与会话 header 成为拖拽区 |
| 0 | `lzpway-jpg/dsh-plugin-brand-custom` | ui | MIT | 2026-10-12 | [lzpway-jpg/dsh-plugin-brand-custom](https://github.com/lzpway-jpg/dsh-plugin-brand-custom) | 自定义 DSH Web 侧边栏与会话页的品牌图标和名称，插件详情页内置设置卡片，保存即生效。 |
| 0 | `mdalboni/dsh-mobile` | ui | MIT | 2026-11-07 | [mdalboni/dsh-mobile](https://github.com/mdalboni/dsh-mobile) | 移动端视口锁定、滚动溢出阻断、虚拟键盘自适应及侧边栏自动收起。 |
| 0 | `renlang119/dsh-web-mobile-pmsfh` | ui | MIT | 2026-11-12 | [renlang119/dsh-web-mobile-pmsfh](https://github.com/renlang119/dsh-web-mobile-pmsfh) | DSH 的独立移动端页面，挂在 /dsh-web-mobile-pmsfh/ 下，不是给官方界面做移动适配：会话按工作区分组，聊天支持流式输出、markdown 与思考过程折叠，附件走官方 fileUploads 接口， |
| 0 | `wilsonchengassistant/dsh-mobile-sidebar` | ui | MIT | 2026-10-22 | [wilsonchengassistant/dsh-mobile-sidebar](https://github.com/wilsonchengassistant/dsh-mobile-sidebar) | 視窗闊度細過 1024px 時，側欄完全移出 shell frame，改由頁首按鈕以浮動抽屜方式打開，令對話可以用盡整個螢幕闊度；闊螢幕版面唔受影響。 |

### D. 让 DSH 反向操作真机（Agent 控 Android/iOS）

| ★ | 插件 | 类别 | 许可 | 最近推送 | 仓库 | 说明 |
|---:|---|---|---|---|---|---|
| 464 | `ZSeven-W/dsh-ios` | remote | MIT | 2026-11-10 | [ZSeven-W/dsh-ios](https://github.com/ZSeven-W/dsh-ios) | 在对话里直接操作 iOS 模拟器或 USB 连接的 iPhone：22 个 Agent 工具用于启动、构建、按无障碍标识或 OCR 文本驱动 UI、列表行操作与 SwiftUI 预览热重载，并附带可点击拖拽的流式侧边栏面 |
| 350 | `ZSeven-W/dsh-android` | remote | MIT | 2026-11-10 | [ZSeven-W/dsh-android](https://github.com/ZSeven-W/dsh-android) | 在对话里直接操作 Android 设备——模拟器或 USB 手机，完全通过 adb 驱动：20 个 Agent 工具用于流式投屏、Gradle 构建运行、UI 树或 OCR 交互、logcat、进程与内存检查，并附带三键 |
| 12 | `kunjinkao-os/dsh-mobile-gui-agent` | tools | MIT | 2026-08-20 | [kunjinkao-os/dsh-mobile-gui-agent](https://github.com/kunjinkao-os/dsh-mobile-gui-agent) | Android GUI Agent：ADB 截图、压缩 UI hierarchy 定位、逐步动作验证、审批和 Mobile Web 视图。 |
| 4 | `regrevia/dsh-mobile-use` | remote | MIT | 2026-11-08 | [regrevia/dsh-mobile-use](https://github.com/regrevia/dsh-mobile-use) | 安卓真机，在右栏，用文字而不是截图驱动。30 个工具直接读界面树、按文字/id/ref 点按、量动效曲线；画面实时推到右栏，圈一处、写一句话，「发送」把带圈的画面连同圈内控件一起回到对话，不用你复述屏幕。省 token  |
| 2 | `liyuhan7/dsh-phone-mirror` | remote | MIT | 2026-11-02 | [liyuhan7/dsh-phone-mirror](https://github.com/liyuhan7/dsh-phone-mirror) | 在 DSH 右侧栏通过 adb 投屏并反控安卓手机/平板，视频、短视频和聊天留在电脑上，在工位上不必再拿手机；声音转发需 Android 11+，仅支持 Windows。 |
| 1 | `Lovepeace-art/dsh-android-phone` | tools | Apache-2.0 | 2026-10-26 | [Lovepeace-art/dsh-android-phone](https://github.com/Lovepeace-art/dsh-android-phone) | 在 DSH 侧栏实时显示 USB 连接的安卓手机，并通过 scrcpy 控制协议直接操作手机：12 个 agent 工具（点按/滑动/输入/按键）、多帧滚动拼接的长截图，以及「默认交给 agent、人一碰手机就立刻交出控 |
| 1 | `hoyyang/dsh-android-pane` | tools | MIT | 2026-11-04 | [hoyyang/dsh-android-pane](https://github.com/hoyyang/dsh-android-pane) | 在 DSH 对话旁打开 Android 设备实时画面：scrcpy H.264 串流，agent 可点按操作并用截图与控件树自证，截图 / 录屏 / 调试证据统一存进你指定的电脑目录；调试会话自带分段视频、全量 logc |
| 0 | `guzhou079-arch/dsh-plugin-android-vscreen` | remote | LGPL-3.0 | 2026-10-17 | [guzhou079-arch/dsh-plugin-android-vscreen](https://github.com/guzhou079-arch/dsh-plugin-android-vscreen) | 在虚拟显示器上启动安卓应用，用读屏、点击与滑动驱动它们，主屏不受影响。 |

### E. 其他手机/远程相关条目

| ★ | 插件 | 类别 | 许可 | 仓库 | 说明 |
|---:|---|---|---|---|---|
| 2939 | `shaobeichen/dsh-pocket` | notify | GPL-2.0 | [shaobeichen/dsh-pocket](https://github.com/shaobeichen/dsh-pocket) | 手机远程访问 DSH Web 界面：扫码即用局域网或公网（cloudflared 隧道）访问，实时同屏、移动端适配布局，带设置页管理。 |
| 4 | `boheastill/phone-eye` | vision | MIT | [boheastill/phone-eye](https://github.com/boheastill/phone-eye) | 让 AI 助手看见并操作真实安卓手机：phone_look（视觉+UI 树融合判读）、点击/滑动/输入、截图——经 adb，适用于任何 MCP 客户端。 |
| 3 | `good-boy4069/dsh-mobile-remote` | notify | MIT | [good-boy4069/dsh-mobile-remote](https://github.com/good-boy4069/dsh-mobile-remote) | 微信遥控 DeepSeek Harness：iLink 双向加密文件收发（入站自动解密落盘 + /send 出站）、weixin_send 主动通知、完成通知、多会话切换、健康面板与文件日志。 |
| 2 | `picsky/dsh-pocket-console` | notify | MIT | [picsky/dsh-pocket-console](https://github.com/picsky/dsh-pocket-console) | 把无人值守运行时 DeepSeek Harness 的工具调用审批与 ask_user_question 提问推送到手机飞书卡片。桌面 GUI 优先作答——只有在 `delaySeconds`（默认 120 秒）内无人应 |
| 2 | `yxqfg/phone-lens#phone-lens` | vision | MIT | [yxqfg/phone-lens](https://github.com/yxqfg/phone-lens) | 手机变 dsh 会话的全功能摄像头（需配合开源的 Android 手机 App——安装插件后扫插件提供的二维码即可下载 APK）：1. 局域网或 USB 直连实时取景，画面可直接注入对话框或保存到指定位置；2. 提供可调 |
| 1 | `Void-LifeStream/dsh-phone-butler` | tools | MIT | [Void-LifeStream/dsh-phone-butler](https://github.com/Void-LifeStream/dsh-phone-butler) | 用 adb 查看并打理一台真实的 Android 手机：存储体检、未 root 也能读到的逐应用数据大小（来自 dumpsys diskstats）、只清缓存不动数据的清理、目录统计与截图——共五个工具；读取永不改动任何 |
| 1 | `zjhaaa042-cloud/dsh-mobile-notify` | notify | MIT | [zjhaaa042-cloud/dsh-mobile-notify](https://github.com/zjhaaa042-cloud/dsh-mobile-notify) | DSH 任务停下来时把通知推送到手机，支持 10 个渠道：ntfy、Bark、钉钉、企业微信、飞书、Server酱、PushPlus、Telegram、Qmsg 与通用 webhook；消息里带会话、目录、耗时、回合号与 |
| 0 | `PocketSWPU/dsh-serendipity` | fun | - | [PocketSWPU/dsh-serendipity](https://github.com/PocketSWPU/dsh-serendipity) | 把用户本人当作 RPG 主角：每轮对话结束后有几率触发随机「奇遇」，事件库 700+，覆盖科幻/玄幻/远古/动漫/小说/武侠/都市七大主题，增减力量/智力/敏捷/魅力/幸运/体魄六维属性，积累经验升级并随等级解锁更宏大的 |
| 0 | `dsh-slipway` | tools | MIT | [7gzgn/dsh-slipway](https://github.com/7gzgn/dsh-slipway) | 一条命令把本地 DSH 插件工程发到 GitHub 并开市场收录 PR：逐文件上传带字节校验、市场条目 PR，最后把线上文件逐个拉回来比 sha256。 |
| 0 | `AHIOSUZ/dsh-workspace-tools` | security | - | [AHIOSUZ/dsh-workspace-tools](https://github.com/AHIOSUZ/dsh-workspace-tools) | 按工作区规则为新建根会话自动应用 Agent 预设与权限预设（设置 - 工作区默认设置），仅使用官方扩展点。 |
| 0 | `HYClub/deepseek-harness-game-studios` | agi | - | [HYClub/deepseek-harness-game-studios](https://github.com/HYClub/deepseek-harness-game-studios) | Claude Code Game Studios（CCGS v1.1.2，MIT）的 DeepSeek Harness 移植：76 个技能、49 个代理与钩子桥。 |
| 0 | `HeliosTangDev/dsh-ops-conventions` | workflow | - | [HeliosTangDev/dsh-ops-conventions](https://github.com/HeliosTangDev/dsh-ops-conventions) | 每会话每版本注入一条极短的「操作约定」门铃（入口清单绝对路径 + 版本号）；约定版本一改，下一轮就重新注入（闲聊轮也算）。可选硬拦截：操作类轮次里未读索引前，拒绝 write/edit 等写类工具（闲聊轮与 shell  |
| 0 | `IceyVanci/dsh-phonephoto-ezinput` | tools | MIT | [IceyVanci/dsh-phonephoto-ezinput](https://github.com/IceyVanci/dsh-phonephoto-ezinput) | 通过一个简单的局域网服务，把手机中的照片发送到 DeepSeek Harness 的对话中。 |
| 0 | `PerryLink/dsh-phone-inbox` | session | Apache-2.0 | [PerryLink/dsh-phone-inbox](https://github.com/PerryLink/dsh-phone-inbox) | 列出当前会话通过微信桥实际收到的附件，并按需将其中一个采纳到工作区。 |
| 0 | `RaulLazaro/dsh-pwa-plugin` | dev | - | [RaulLazaro/dsh-pwa-plugin](https://github.com/RaulLazaro/dsh-pwa-plugin) | DSH 的 PWA 插件：离线支持、Service Worker 缓存，并可作为应用安装。 |
| 0 | `SongZijianlove/dsh-phone-drop` | tools | MIT | [SongZijianlove/dsh-phone-drop](https://github.com/SongZijianlove/dsh-phone-drop) | 局域网手机直传：电脑屏幕上出一个二维码，手机扫开就能拍照或扫描，文件直接落进电脑文件夹，全程局域网直连，不经过隧道也不经过云端。文档模式在手机浏览器里本地做自适应二值化、去噪、裁边，把普通照片变成黑白扫描件。插件会在 D |
| 0 | `Verchiel666/dsh-termux` | dev | - | [Verchiel666/dsh-termux](https://github.com/Verchiel666/dsh-termux) | 在 DSH 内部安装并运行 Android 原生命令行工具：从 Termux 仓库取 aarch64 bionic 包、纯 JS 解包，再经 /system/bin/linker64 执行，无需 root、Shizuku |
| 0 | `Verchiel666/dsh-usage-android` | usage | - | [Verchiel666/dsh-usage-android](https://github.com/Verchiel666/dsh-usage-android) | 以 host 侧工具统计 DSH 会话 token 用量，数据取自本地会话日志：总量、输入、输出与缓存读取拆分、按天时间线、按天或按会话分组的用量，以及可选成本估算。 |
| 0 | `ZiOstudio/dsh-budget-handoff` | usage | - | [ZiOstudio/dsh-budget-handoff](https://github.com/ZiOstudio/dsh-budget-handoff) | 给 DeepSeek Harness 的会话设预算上限：按官方价目表实时算账，80% 预警、100% 拦停任务，并落盘一份交接快照，让下一个会话接着干。 |
| 0 | `androidly/dsh-web-m3e` | theme | - | [androidly/dsh-web-m3e](https://github.com/androidly/dsh-web-m3e) | 叠加在宿主浅色/深色/跟随系统偏好之上的 Material 3 Expressive 主题：把宿主全部别名 token 映射到官方算色库生成的颜色角色，并补上方圆轮廓、动效、M3 弹层菜单与触屏适配。 |
| 0 | `chengyu-xin1/dsh-classroom-mobile` | tools | MIT | [chengyu-xin1/dsh-classroom-mobile](https://github.com/chengyu-xin1/dsh-classroom-mobile) | 手机浏览器录课堂音频，本机 faster-whisper 转写；生成总结、思维导图、由易到难的题与错题门控、专注报告；内置 HTTPS 隧道，手机在任何网络都能连。转写需本机 Python、ffmpeg 与 faster |
| 0 | `dttGitHu/dsh-video-android` | vision | MIT | [dttGitHu/dsh-video-android](https://github.com/dttGitHu/dsh-video-android) | 安卓上的 DSH 视频工作台：分镜编辑、多供应商图像/视频生成与自动切换、FFmpeg 合成 MP4、提示词优化、手机窄屏工作台。 |
| 0 | `dzwalker/dsh-session-keepwarm` | session | MIT | [dzwalker/dsh-session-keepwarm](https://github.com/dzwalker/dsh-session-keepwarm) | 让浏览器最近用过的会话保持常驻：切走再切回来直接复用已加载的历史、不再重新读取；常驻数量可配置，并可整体关闭。 |
| 0 | `flyinghouse-ma/dsh-pet-android-community` | fun | - | [flyinghouse-ma/dsh-pet-android-community](https://github.com/flyinghouse-ma/dsh-pet-android-community) | 安卓桌宠社区补丁：需先装上游 dsh-pet（≥0.3.7），另装自签名壳 APK（Android 11+），并在本机常驻 3080→38019 转发；修好悬浮窗无法聚焦导致键盘不弹、聊天发不出去、回复被窗口裁掉三个问题 |
| 0 | `limingyao-xx/dsh-sidebar-mobile-browser` | browser | - | [limingyao-xx/dsh-sidebar-mobile-browser](https://github.com/limingyao-xx/dsh-sidebar-mobile-browser) | 右侧边栏的移动端视口预览标签页：九种预设尺寸（手机、平板、笔记本）及自定义宽高，一键复制当前地址，并可通过 @ 按钮或 /url 指令把页面地址插入输入框。 |
| 0 | `lucagiftzek/dsh-phone` | tools | MIT | [lucagiftzek/dsh-phone](https://github.com/lucagiftzek/dsh-phone) | dsh-better-sidebar 里的 Phone 标签页：通过 Twilio 与经 Asterisk 桥接的 SIP 线路收发短信和通话，通话音频走你的服务器，提供 Live、Voicemail、勿扰模式与实时语音 |
| 0 | `regrevia/pocket-harness#pocket-harness` | voice | - | [regrevia/pocket-harness](https://github.com/regrevia/pocket-harness) | Pocket Harness：DSH 的手机端。在手机上接着用电脑里的同一份 DSH——同一条会话、历史、项目、目标、队列和待确认提问，可经局域网、自建域名或自建中转连接（不经作者服务器、无需账号）。需要配套的 Andr |
| 0 | `skyjjgw/dsh-plugin-android-preview` | dev | - | [skyjjgw/dsh-plugin-android-preview](https://github.com/skyjjgw/dsh-plugin-android-preview) | 在 Windows 的 DSH 侧栏预览已配置的星伴 / Operit2 衍生工程，操作真实安卓画面并在保存 Dart 后热重载；需要工程预览脚本、预构建调试 APK、Android SDK、Flutter 和 scrc |
| 0 | `sleepwalk2887/transproof-dsh-plugin` | tools | Apache-2.0 | [sleepwalk2887/transproof-dsh-plugin](https://github.com/sleepwalk2887/transproof-dsh-plugin) | 译校助手 TransProof 的 DSH 插件：内置完整网页界面，支持 AI 翻译（需自备模型 API Key 或本地 Ollama 端点）、三段流水线校对、术语与专名核验、批量体检改错与一键交付报告；网页版与插件内置 |
| 0 | `zhz8888/dsh-android-emulator-helper` | dev | - | [zhz8888/dsh-android-emulator-helper](https://github.com/zhz8888/dsh-android-emulator-helper) | 在 DeepSeek Harness 里驱动 Android 开发工具链：23 个 android_* 工具负责探测 SDK、创建与管理 AVD、启停模拟器、生成 Kotlin/Compose 工程、用 Gradle 构 |
| 0 | `zhz8888/dsh-ios-simulator-helper` | dev | - | [zhz8888/dsh-ios-simulator-helper](https://github.com/zhz8888/dsh-ios-simulator-helper) | 把官方 ZCode ios-simulator 插件移植为 DSH 原生工具：原有 20 个 ios_* 工具的命名与参数保持不变，另加 ios_shutdown_simulator，覆盖 Xcode 工程发现与生成、模 |
## 核查备注

- Star / 许可 / 最近推送时间来自 GitHub API 实时查询（2026-11-13），非目录内置快照（目录 `data/stars.json` 快照停留在 2026-08-19，仅覆盖 1 452 个仓库，因此大部分新插件在快照里查不到）。
- npm 包名与版本经 `registry.npmjs.org` 直查确认存在；本机 `npm` CLI 因沙箱无法写 `~/.npm/_logs` 而报错，非包不存在。
- `KongFangXun/dsh-mobile-apk`（awesome README 里提到的安卓壳 APK）与 `linxin666/dsh-remote-web-ui` 两个仓库地址均返回 404，无法核实，故未列入推荐。
- `ccch1mneyyy/dsh-go` 未收录进 `awesome-dsh-plugin` 官方目录（目录靠仓库名匹配关键词，`dsh-go` 匹配不上），但仓库活跃、Star 最高，单独补入。
- 搜索结果里的第三方站点（`dsh.so`、`dshopen.org` 等）内容由社区维护，**收录 ≠ 安全背书 ≠ 兼容性验证**；安装前请自行核对仓库源码与 manifest。

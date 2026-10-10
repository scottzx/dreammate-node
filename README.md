# @1agents/dreammate-node

> DreamMate Network 的**本机 node agent**：让设备和软件向智能体公开自己的能力，并提供统一的发现与调用入口。
> 服务端固定监听 **36908**；`cli` 模式按需执行，不监听端口。运行时依赖 L0 协议包与 MCP SDK。

一台机器跑一个。它是这台机器对网络的唯一入口，负责**登记、发现、执行**——
外部节点探这一个端口，就能知道这台机器上有什么，并经由它发起调用。
它不承担业务流程：什么时候处理新录音、如何判断客户、如何生成跟进事项，仍需要业务流程或智能体承担。

```
        Control Plane / 任意节点 / 智能体
                  │  探 36908（每台机器只探一个端口）
                  ▼
        node-agent :36908
         ├─ GET  /manifest                      本机聚合视图：节点身份 + 已报备服务
         ├─ GET  /health
         ├─ GET  /nodes                         本 tailnet 内的设备节点
         ├─ GET  /services                      各服务的存活与可达性
         ├─ POST /services                      服务报备（**仅接受 localhost**）
         ├─ DELETE /services/:id
         ├─ POST /services/:id/invoke           统一调用（转发到本机 HTTP 或 CLI）
         ├─ POST /capabilities/:name/invoke
         ├─ POST /services/:id/start|stop       部分服务的启停
         └─ GET  /services/:id/skills/:name/archive
                  ▲
      ┌───────────┴───────────┐  localhost 报备
 session-reader :7777    task-service :xxxx
```

这把 pull 探测的成本从「N 个节点 × M 个端口」降到「N × 1」，
并把「找到能力」和「执行调用」收成同一个入口。

## 跑起来

DeepSeek Harness 可以直接安装配套插件，复用本机已运行的 node，未启动时自动拉起：

```bash
pnpm dsh plugin --profile web add @1agents/dsh-dreammate-node
# 重启 DSH 后生效；desktop 使用 --profile desktop
```

当前 DSH 插件依赖 `dreammate-node ~0.7.1`，提供发现、查看契约和调用等 7 个旧工具，默认使用本机 `36908`。
本仓库网关源码新增的搜索与有界发现功能，可通过构建后的 CLI/MCP 使用；插件需要后续升级其依赖才能提供这些功能。
配置与进程生命周期见 [DSH 插件说明](packages/dsh-plugin/README.md)。

```bash
npm i -g @1agents/dreammate-node
dreammate-node install      # 装成开机自启的常驻服务
dreammate-node status       # 看服务与端口状态
dreammate-node uninstall
```

macOS 装 launchd LaunchAgent（`~/Library/LaunchAgents/work.dreammate.node.plist`），
Linux 装 systemd user unit（`~/.config/systemd/user/dreammate-node.service`），
**两边都不需要 sudo**——agent 只读本机服务清单，没有要 root 的理由。
挂了会自动拉起（KeepAlive / Restart=always），日志在 `~/.1agents/logs/`。

> Linux 上用户级 systemd 服务在登出后会被停掉，服务器上要真常驻得开 linger：
> `sudo loginctl enable-linger <user>`。`install` 会检测并提示。

前台跑（调试用）：

```bash
dreammate-node                        # 0.0.0.0:36908
dreammate-node --host 127.0.0.1       # 只对本机可见
```

### npm 安装时自动安装对应 skill

包内包含两份同名 `dreammate-node` skill，安装时只选择一种：

| 环境 | 安装的指引 |
| --- | --- |
| iSH（Linux 内核版本含 `ish` 标记，或存在 `/proc/ish`） | 一次性 CLI 与手动地址缓存，连接其他设备的网关，不启动本机守护进程 |
| 其他终端 | 远程 CLI、本机网关、报备与 MCP；仅远程调用时无需安装本机网关 |

`postinstall` 默认写入 `~/.agents/skills/dreammate-node/SKILL.md`，并同步到**已存在**的
`~/.claude/skills`、`${CODEX_HOME:-~/.codex}/skills`、`~/.gemini/skills` 和
`~/.gemini/config/skills` 下的 `dreammate-node` 目录。它不联网、不启动服务、不修改 MCP
配置。CLI 不运行常驻进程；skill 文件只在 npm 安装或手动补装时写入，设备地址簿则由用户手动导入更新。

默认自动识别不依赖 Alpine、CPU 架构或主机名；普通 Alpine 不会仅因发行版被判为 iSH。
安装记录保存来源、版本和内容校验值：未改动的本包 skill 可自动升级或切换版本，用户自建或
修改过的同名 skill 会保留并提示路径。某个目录安装失败不影响其他目录或 npm 包安装。

```bash
# 安装脚本被禁用、后装智能体、识别不符时，手动补装
dreammate-node skills install
dreammate-node skills install --profile ish
dreammate-node skills install --profile terminal --dir ~/.agents/skills

# 安装时覆盖识别结果或目标目录（--dir/环境变量指向 skills 根目录）
DREAMMATE_SKILL_PROFILE=ish npm i -g @1agents/dreammate-node
DREAMMATE_SKILLS_DIR="$HOME/.agents/skills" npm i -g @1agents/dreammate-node

# 跳过自动 skill 安装，不影响以后手动补装
DREAMMATE_SKIP_SKILLS=1 npm i -g @1agents/dreammate-node
```

`--profile auto|ish|terminal` 优先于 `DREAMMATE_SKILL_PROFILE`；`--dir` 优先于
`DREAMMATE_SKILLS_DIR`，指定目录时只安装该处，目录须为绝对路径或以 `~/` 开头。
源码目录尚未构建时可用 `npm run skills:install -- --profile ish`。安装/同步后由智能体重新
加载技能；已打开的会话是否立即更新取决于宿主。`npm --ignore-scripts` 或安装脚本策略可阻止
自动执行，此时使用手动补装命令。`dreammate-node uninstall` 仅卸载守护进程，保留 skill。

## iSH / 无常驻进程的客户端

如果设备主要调用其他机器上的服务，使用 `dreammate-node cli`。每次运行直接请求
一台在线设备的 node-agent，输出 JSON 后退出，不启动本机 HTTP/MCP 服务，不执行
Tailscale CLI，不生成本机身份或服务注册表。可以手动导入一份持久化的设备地址簿；日常调用只读缓存，不后台刷新。桌面和服务器上的常驻模式继续可用。

```bash
# 指向已有的、从 iSH 可以访问的网关；把地址替换成自己的设备地址
export DREAMMATE_AGENT_URL=http://100.x.y.z:36908

dreammate-node cli nodes
dreammate-node cli search --query '读取笔记'           # 默认跨已知节点搜索，最多 15 条方法摘要
dreammate-node cli search --query '读取笔记' --node localhost # 只搜入口网关所在设备
dreammate-node cli services                 # 分页浏览入口网关上的服务摘要
dreammate-node cli services --node all      # 显式浏览：从入口网关取清单，再直连各节点
dreammate-node cli inspect --node my-mac --service notes # 仅分页方法摘要
dreammate-node cli inspect --node my-mac --service notes --method read
dreammate-node cli invoke --node my-mac --service notes --method read --params '{"id":"123"}'

# 较大参数可通过标准输入提供
cat params.json | dreammate-node cli invoke --service notes --method read --params -
dreammate-node cli manage --service notes --action status
dreammate-node cli tools                    # 离线查看工具的参数 Schema
dreammate-node cli --help
```

业务调用首选 `search → inspect --method → invoke`。`search` 必须提供 1–2000 字符的非空 `--query`，
默认跨已知节点搜索，只返回方法摘要；`--node localhost` 限定入口网关所在设备，也支持
指定节点、`--service ID` 和 `--kind TYPE` 过滤。结果在相关性门槛与预算允许时尽量覆盖
2–3 个工具集，按 `service_id` 区分，跨节点相同 ID 仍算一个集；不强求不同节点或用不相关结果凑数。
显式 `--service ID` 时只搜该集。
`search`、`services` 和 `inspect` 支持 `--limit`、`--offset`、`--max-chars`：
每页 1–20 条（搜索默认最多 15，目录默认 10），偏移 0–1000000，摘要 JSON 预算 1000–12000
字符（搜索默认 12000，目录默认 6000，并非 token 估计）。相关候选不足或字符预算不够时返回更少结果。
分页与查询参数在联网前校验；候选不合适时改写查询或显式翻页。
省略 `inspect --method` 只返回方法摘要目录，不再展开整个服务的参数 Schema。
`results` 中的 `score` 是排序信号，不是可执行性或置信概率；当前没有拒识分类器。
先确认候选说明符合任务再 inspect，不符合时继续改写查询，不能因有返回结果就调用。

入口优先级：`--agent` → `DREAMMATE_AGENT_URL` → 已导入地址簿的 `default_node`。
`search` 省略 `--node` 时扫描已知节点；其他命令省略时目标是**入口网关所在设备**。
有缓存时按缓存解析节点名称、ID、DNS 名或 IP；
没有缓存时通过入口网关的 `/nodes` 解析，然后由客户端直连目标节点。入口网关不是跨节点
中继，所以目标网关也必须从 iSH 可达。CLI 不需要本机运行 `tailscaled`，但网络连通性需要自行配置。

### 手动同步设备地址簿

设备列表比较稳定时，在 Mac 或其他能读取节点清单的终端导出，再把 JSON 文件传给 iSH：

```bash
# 在 Mac：读取已运行的本机网关；也可 --agent 指向其他在线网关
# --default-node 可以是节点名或 ID；省略时使用导出来源网关的自身节点
dreammate-node cli nodes export --default-node scott-pc-1 --file nodes.json

# 把 nodes.json 传到 iSH 后：校验并完整替换本地缓存
dreammate-node cli nodes import --file nodes.json
dreammate-node cli nodes                          # 离线查看缓存，不探测
dreammate-node cli services                       # 主动访问默认的 scott-pc-1
dreammate-node cli services --node scott-pc-1
dreammate-node cli services --node all             # 主动查询缓存中的所有地址
```

设备地址簿由用户单独传输，`nodes.json` 不随 npm 包分发；安装包只包含程序与通用 skill。

缓存默认保存在 `~/.1agents/nodes.json`，可用 `--nodes-file PATH` 或
`DREAMMATE_NODES_FILE` 覆盖。缓存**没有自动过期或后台更新**；设备变化时重新导出、导入。
导入验证格式、版本、默认节点和别名唯一性，校验失败保留原缓存，成功时原子替换，不保留已删除设备。
导出省略 `--file` 时直接输出 JSON；导入支持 `--file -` 从 stdin 读取。

文件只存节点 ID、名称、类型和网关地址等路由信息，不保存凭据、源设备 `is_self` 标记或在线状态。
因此从 Mac 导入不会把 Mac 误认成 iSH 本机。缓存节点列表的 `online`、`network_online` 和
`gateway_reachable` 都是 `null`，并显示导出/导入时间；不是实时在线证明。
`services --node all` 的扫描结果是实时的，但 `discovery.status=cached`、`scope=imported_nodes_only`
和 `partial=true` 明确表示只覆盖导入清单，不能保证包含当前整个 tailnet。

需要临时忽略缓存时使用 `--live --agent URL`，例如：

```bash
dreammate-node cli nodes --live --agent http://scott-pc-1:36908
```

`--live` 不覆盖缓存。缓存里缺少某个名称时会报错，避免偷偷依赖拓扑发现；可重新导入或通过
`--node http://设备地址:36908` 显式直连。连接失败不会自动重试写调用。
如果当前只有一个已知可达设备，也可手动准备以下格式后导入（地址须替换为实际可达地址）：

```json
{
  "format": "dreammate.nodes",
  "version": 1,
  "exported_at": "2026-09-29T00:00:00Z",
  "default_node": "pc-1",
  "nodes": [
    { "node_id": "pc-1", "name": "scott-pc-1", "type": "windows", "agent_url": "http://scott-pc-1:36908" }
  ]
}
```

地址簿不建立 VPN 隧道；它利用已有的出站 TCP 连通性，也不会让 iSH 自动变成可被远程访问的节点。

当缓存的 HTTP 地址使用节点自身名称或 `dnsName`，且带有 `ipv4` 时，CLI 会优先使用该 IP，
保留端口与路径，以减少 MagicDNS 抖动的影响。HTTPS、代理域名及显式 `--agent URL` 保持原地址。
`--node all` 仍逐个直连缓存节点，`--agent` 不会把这些请求改为经入口转发。
没有缓存或默认入口时，也可用 `services --node IP` 或 `--node http://HOST:PORT` 直接查询已知设备。

服务扫描每个节点最多等待 3 秒（包括响应体），保留成功节点和失败诊断。
单次 CLI 命令默认最多运行 30 秒，`invoke` 默认 150 秒；可用 `--timeout-ms N` 调整。
达到命令截止时间会输出 `COMMAND_TIMEOUT` 并以退出码 1 退出；写调用可能已经执行，先核对远端结果。
结果写完后 CLI 退出，不再等待残留的 DNS 任务。不要把空 stdout 当作“没有服务”：
应同时检查退出码、stderr、`isError` 以及扫描的 `partial` / `scans`。

```sh
dreammate-node cli services --node all --timeout-ms 15000
dreammate-node cli nodes export --help
dreammate-node cli nodes import --help
```

iSH 使用手动导入和单次调用；无需为此启动本机 daemon 或 tailscaled。
`install` 会拒绝 iSH，并在普通 Linux 写入 unit 前检查 systemd 用户管理器是否可用。
端口拒绝连接只表示当时网关不可达，不能据此断定软件没安装。

stdout 输出完整 MCP 结果 JSON，保留 `content`、`structuredContent`、`isError` 和
元数据；脚本可用 `jq` 提取。退出码 `0` 表示成功，`1` 表示网络、HTTP 或 MCP 业务错误，
`2` 表示参数错误（stdout 返回错误结果，同时在 stderr 写入诊断 JSON）。调用不会自动重试，避免重复执行写操作。
`manage start|stop` 会改变远端服务状态；本机仍不运行常驻进程。

这个模式仍需要 **Node.js >=22.5**，解决的是“不常驻”，不是“无需 Node.js”。
用户已在 iSH 完成 0.8.0 安装、地址簿导入及离线列节点；后续超时修复通过本地故障注入测试，
仍需 iSH 真机复验。它不会让 iSH 成为可随时被远程调用的服务提供节点。

当前源码可用 `npm install && npm run build` 构建，再运行
`node dist/bin/dreammate-node.js cli ...`；若需要命令名，可在源码目录执行 `npm link`。

## 服务怎么报备

```ts
import { reportAndHoldRegistration } from '@1agents/dreammate-node/client';

await reportAndHoldRegistration({
  id: 'session-registry',
  kind: 'session_registry',
  capabilities: ['sessions.list', 'sessions.read'],
  port: 7777,
  reachability: 'localhost',   // 或 'network'
});
```

**报备是可选的，而且永不抛错。** agent 没装、没起、版本对不上，服务都该照常
工作——返回值告诉你成没成，要不要提示用户由你决定。不报备也能被发现，只是
外部得靠[约定端口](https://github.com/scottzx/dreammate-network)碰运气。

## 两件容易想错的事

**Node 在线 ≠ Service 在线。** tailnet 的 `Online` 只说明机器开着；进程被 kill
了它照样报在线。所以 agent 必须自己定期探各服务的 `/health`，连续失败 5 次
才移除——抖一下不该被清掉。

**reachability 不是「能不能被调用」。** `localhost` 表示服务只监听回环，远端调用方**不能直接**连那个端口；`network` 表示服务可被直连。manifest 仍然如实报告可达性，避免给一个看着能连、连上却超时的地址。

但 node agent **会做代理**：跨节点调用走 `:36908` 的 `POST /services/:id/invoke`（或 MCP `dreammate_invoke`），再转发到本机回环 HTTP 或本地 CLI（`execution: cli|http|hybrid`）。因此 `reachability: localhost` 的服务仍然可以被远端智能体使用——只是不能绕过 agent 直连那个端口。

## 智能体怎么发现和调用

智能体不需要直连各服务端口。本机跑 `dreammate-node mcp` 后，暴露一组**稳定的元工具**：
业务任务首选 `search → inspect(method) → invoke`；服务列表用于显式浏览。
搜索和目录都有条数与文本预算，省略方法的 inspect 只返回摘要目录，堵住自动全量展开的路径。
只有选定具体方法后才展开该方法的参数 Schema；技能指南也按需读取。

| 工具 | 作用 |
|------|------|
| `dreammate_list_nodes` | 发现 Tailnet / 局域网中的设备节点 |
| `dreammate_search_tools` | 必填 `query`，默认跨已知节点检索，最多 15 条方法摘要；相关性允许时尽量覆盖 2–3 个工具集 |
| `dreammate_list_services` | 分页浏览本机、指定节点或全网（`node: "all"`）已报备服务摘要 |
| `dreammate_list_capabilities` | `list_services` 的向后兼容别名 |
| `dreammate_inspect` | 无 `method` 时分页看摘要目录；指定方法时读取该方法 Schema，或按需读技能指南 |
| `dreammate_invoke` | 经本机或对端 `:36908` 代理执行（HTTP 或本地 CLI） |
| `dreammate_download_skill` | 下载并安装/预览服务配套技能包 |
| `dreammate_manage_service` | 部分服务的生命周期：`start` / `stop` / `status` |

HTTP 侧对应 `GET /nodes`、`POST /services/:id/invoke`、`POST /capabilities/:name/invoke`、`GET /services/:id/skills/:name/archive`、`POST /services/:id/start|stop`；已报备模型另有只读编码路由 `POST /services/:id/embed`。

渐进式发现的设计说明见 [docs/architecture-mcp-mesh.md](docs/architecture-mcp-mesh.md)。

搜索自动从本次扫描到的服务中发现已就绪的本地模型，无需为每个 CLI/MCP 客户端填写模型 URL。模型可只运行在一台内网设备上，其他设备无需安装权重。先显式准备离线权重，然后在模型设备的本仓库根目录启动：

```sh
node scripts/local-embeddings/serve.mjs --model qwen3 --port 8766 --agent http://127.0.0.1:36908
```

启动器预热模型，服务只监听 loopback；确认就绪后向本机 agent 登记模型别名、revision、维度、编码配置和优先级，每 15 秒刷新，正常退出时注销。客户端直连选中模型设备的网关，由 `POST /services/<id>/embed` 只代理该设备已登记的本机回环端口；入口网关不承担跨节点中继。多个模型按优先级、健康状态和稳定 URL 排序，最多尝试两个，共享默认 5 秒语义预算；自动发现路径下，单次尝试的查询和文档固定同一模型版本与编码配置。

模型发现范围随 `node`：默认跨已知节点，`node: "localhost"` 只看入口设备；`service_id` 仅筛业务工具，不排除同一节点范围内的模型服务。未发现可见的就绪 provider 时，返回 `search.semantic_status: "no_provider"` 和有界词法结果；存在 `partial` 扫描或导入目录时，不能据此断言全网没有安装模型。模型失败也保留有界词法结果，不展开全量工具。

显式 `DREAMMATE_EMBEDDING_URL` 仍优先并固定使用该地址，失败时不会自动切到发现的模型；`DREAMMATE_EMBEDDING_MODEL` 可限定模型别名。运行时不会下载权重、自动部署模型或选举全局 leader，也不依赖云模型。部署细节与检索评测方法见 [docs/local-embeddings.md](docs/local-embeddings.md)。

## 为什么报备只认回环（与安全模型）

`POST /services` 是整个 agent 唯一的写入口。限制回环（`127.0.0.1`）是为了阻断**外部网络**直接往你的节点里塞假服务或恶意摘除服务。

> ⚠️ **澄清认知误区：回环 ≠ 100% 绝对安全。**  
> `127.0.0.1` 只能防止外部网络机器直连，但**不防同机其他非受信任进程**——任何本地进程都能向 `POST /services` 报备。当前 MVP 基于**受信任主机（Trusted Host）威胁模型**。  
> 长期架构演进中（Phase 2），我们将升级为 **Unix Domain Socket (UDS)**，结合操作系统内核鉴真（`SO_PEERCRED` 提取进程 PID 与可执行文件指纹）并由 Node 权威签发短期 **Capability Lease** 租约，实现真正的双向零信任。  
> 完整设计见 [安全架构规范文档](docs/security-architecture.md)。

## 节点身份

优先取自 tailnet（`tailscale status --json` 的 `Self`，缓存 60s），本机所有
进程读到同一份，不会各自生成 id 把一台机器裂成几个 Node。

```
node_id   example-tailnet-node-id    ← tailscale ID，重启不变
name      scott-mac            ← DNSName 前缀，不是 HostName
type      macos                ← 由 tailscale 的 OS 映射
```

> ⚠️ 名字取 **DNSName** 而非 HostName：iOS 设备的 HostName 全是 `localhost`，
> 实测一个 11 节点的 tailnet 里只有 9 个 HostName 唯一。

> ⚠️ **找 tailscale 不能只靠 PATH。** launchd 给的 PATH 只有
> `/usr/bin:/bin:/usr/sbin:/sbin`，systemd 的也好不到哪去，而 homebrew 的
> tailscale 在 `/opt/homebrew/bin`。不处理的话，装成常驻服务后会静默回退到
> 本地身份——同一台机器在前台和服务模式下变成**两个 Node**，而且没人会注意到。
> 所以这里除了 PATH 还会依次试几个已知位置，plist / unit 里也补了 PATH。
> 装在别处用 `DREAMMATE_TAILSCALE_BIN` 指定。

没装 / 没登录 tailscale 时静默回退到本地身份（hostname + 首次生成的 uuid，
存在 `~/.1agents/node.json`），`metadata.identity_source` 如实报告来源。

## 它在架构里的位置

node 注册与探活是从 Control Plane 里**领出来**的——原本设想中 Control Plane
的其余职责（Task、Agent 编排、Execution 账本）降级为平级的普通服务，各自独立
起进程、各自向本机 agent 报备。于是不再有「必须先起 Control Plane」的启动顺序，
任何一个服务挂掉也不会让整个控制面消失。

协议定义见 [`@1agents/dreammate-network`](https://github.com/scottzx/dreammate-network)（L0）。

### 发现与调用的诊断字段

- 节点名按本机 `/nodes` 清单解析，优先使用已登记的 Tailscale IP；本机、显式 IP 和带端口的 URL 保持可用。所有 MCP 路由共用解析逻辑，写请求不因网络错误自动重放。
- `dreammate_list_services(node="all")` 返回 `scans`（每个节点的地址、状态、时间与 HTTP/连接错误）、`discovery` 和 `partial`。部分节点失败时仍返回成功结果；全部扫描失败会设置 `isError:true`，不能把零匹配解释为全网无服务。节点清单读取失败时，本机降级会显式标注。
- `dreammate_list_nodes` 保留旧 `online` 字段，增加 `network_online`、`network_checked_at`、`gateway_reachable` 与 `gateway_checked_at`。网关探测针对 `/health`，不代表业务服务可用。旧节点没有可靠网络检查时间时返回 null。
- 服务摘要、inspect 和生命周期 status 返回 `service_health`，包含最后探测时间、探测范围；未探测为 unknown，`methods_verified:false`。方法 inspect 的 `declared`/旧 `defined` 仅指契约声明，`availability` 表示部署证据和调用观测，不能混用。
- `dreammate_invoke` 原样保留有效 MCP 结果的内容块、结构化数据和错误状态；普通业务 JSON 作为结构化结果返回。HTTP 200 仍可能包含 `isError:true`，调用方必须检查它。HTTP 转发超时返回 504，传输失败返回 502，均不自动重试写操作。

Plane 的错误分类、方法观测和当前部署的 Pages 限制见 [bridge 说明](deploy/plane-bridge/README.md)。`npm test` 同时执行 Node 与 Plane bridge 回归测试。

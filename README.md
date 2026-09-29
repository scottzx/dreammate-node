# @1agents/dreammate-node

> DreamMate Network 的**本机 node agent**：让设备和软件向智能体公开自己的能力，并提供统一的发现与调用入口。
> 固定监听 **36908**。运行时依赖 L0 协议包与 MCP SDK。

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

智能体不需要直连各服务端口。本机跑 `dreammate-node mcp` 后，暴露一组**稳定的元工具**：先 list，再 inspect，再 invoke；方法契约与技能指南按需展开，避免上下文溢出。

| 工具 | 作用 |
|------|------|
| `dreammate_list_nodes` | 发现 Tailnet / 局域网中的设备节点 |
| `dreammate_list_services` | 轻量检索本机、指定节点或全网（`node: "all"`）已报备服务 |
| `dreammate_list_capabilities` | `list_services` 的向后兼容别名 |
| `dreammate_inspect` | 按需查看方法契约、入参 Schema 或配套技能指南 |
| `dreammate_invoke` | 经本机或对端 `:36908` 代理执行（HTTP 或本地 CLI） |
| `dreammate_download_skill` | 下载并安装/预览服务配套技能包 |
| `dreammate_manage_service` | 部分服务的生命周期：`start` / `stop` / `status` |

HTTP 侧对应 `GET /nodes`、`POST /services/:id/invoke`、`POST /capabilities/:name/invoke`、`GET /services/:id/skills/:name/archive`、`POST /services/:id/start|stop`。

渐进式发现的设计说明见 [docs/architecture-mcp-mesh.md](docs/architecture-mcp-mesh.md)。

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
node_id   nigVtDS1s521CNTRL    ← tailscale ID，重启不变
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

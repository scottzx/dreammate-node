# MCP 中转服务（多租户）产品化方案

> 调研日期：**2026-11-13**　目标：提供公网 MCP 中转服务，让每个用户把自己的 localhost MCP（`dreammate-node mcp` 或自研的）暴露成公网可调用的 MCP。
> 所有项目均已核实仓库结构、README 与许可；许可结论以各仓库 LICENSE 为准。

---

## 0. 一句话结论

**三层里，前两层有成熟件不用写，第三层有 4,813★ 的开源成品 —— 你真正要写的只有「用户侧 Agent」和「产品逻辑」。**

| 层 | 职责 | 现状 |
|---|---|---|
| **L1 协议转换** | stdio → Streamable HTTP | ✅ 成熟件，**不用写** |
| **L2 出站隧道 + 公网暴露** | 用户机器在 NAT 后，仍能被公网访问 | ✅ 成熟件，**不用写**（但要想清楚谁掌控） |
| **L3 多租户中转网关** | 统一入口、租户鉴权、路由、审计、配额 | ⚠️ 有开源成品可选；或照 `mcp-ferry` 架构自研（不复杂） |

**最容易被低估的工程量不在网关，在「用户侧 Agent 里的流式转发」** —— MCP Streamable HTTP 的响应可能是 SSE 流，转发必须分块流式，不能等完整响应。

---

## 1. 产品三角色

```
   用户本机（NAT 后）                    你的中转（唯一公网资产）              任意 MCP Client
┌──────────────────────┐              ┌────────────────────────────┐        ┌──────────────┐
│ ① 本地 Agent         │              │ ③ 中转网关                 │        │ Claude Code  │
│  ├ supergateway      │  出站长连接  │  ├ 租户认证                │  HTTPS │ Cursor/Codex │
│  │  ├ srvA :4001     │◀──WS/TLS──▶│  ├ 路由 /m/{t}/{s}/mcp    │◀──────▶│ DSH/任意     │
│  │  └ srvB :4002     │              │  ├ 会话亲和               │        └──────────────┘
│  └ 反向隧道客户端     │              │  ├ 审计 + 配额            │
└──────────────────────┘              │  └ ② 租户/配额/注册表     │
                                      └────────────────────────────┘
```

- **① 本地 Agent**（用户侧，你要发一个安装包）：起本地 MCP、连中转、转发
- **② 控制面**（你）：租户、配额、注册表、审计存储
- **③ 数据面**（你）：鉴权 + 路由 + 转发

---

## 2. 现成件盘点

### L1 协议转换 —— 不用写

| 项目 | ★ | 许可 | 备注 |
|---|---|---|---|
| `supercorp-ai/supergateway` | 2 959 | MIT | **首选**。`--config` 直接吃 Claude Desktop 的 `mcpServers.json`；每个 server 可单独配 `outputTransport`/`apiKey`/`toolPrefix`/`tools` 白名单；`--printConfig` 自动打码 |
| `punkpeye/mcp-proxy` | 294 | MIT | 同时服务 `2026-07-28` 与 2025 系列协议；FastMCP 官方用它 |
| `sparfenyuk/mcp-proxy` | 2 824 | — | Python 版，最精简 |

> `supergateway` 的多 server 托管 + `tools` 白名单，**直接对应你要的「一个用户多个 MCP + 工具级管控」**。

### L2 出站隧道 + 公网暴露 —— 不用写，但要想清楚谁掌控

| 项目 | ★ | 许可 | 架构 |
|---|---|---|---|
| **`dalberto/mcp-ferry`** | 6 | MIT | ⭐ **架构最接近产品**：一条 Cloudflare Named Tunnel 前置**多个** MCP（`/bear` `/things` 各一个 stdio 子进程）；**Cloudflare Access Managed OAuth** 做 OAuth 2.1 授权服务器（PKCE + RFC 7591 DCR），远端 client 自助发现+认证，无需手工注册 client 凭据 |
| `mcptunnel/mcptunnel` | 3 | MIT | 一条命令 + **`--allow-tool` 工具白名单** + `--public` 走 Quick Tunnel + Basic 认证 |
| `988hj7tczd-oss/dsh-mcp-tunnel` | 0 | MIT | DSH 插件：mcp-proxy + cloudflared，出站-only，**自动注册到 dsh-mcp-client** |
| `joaoh82/rustunnel` | 662 | — | 通用自建隧道（HTTP/HTTPS/TCP/UDP），Rust |

> ⚠️ **产品化决策点**：`mcp-ferry` / `mcptunnel` 让用户**自己**装 cloudflared、用**自己的** Cloudflare 账号。适合「个人自用工具」，但**不适合你要的 SaaS** —— 你拿不到统一域名、统一鉴权、审计和配额。
> → **SaaS 必须你自己掌控隧道**：用户只装你的 Agent，Agent 出站连你的中转。

### L3 多租户中转网关 —— 有成品可选，也可自研

| 项目 | ★ | 许可 | 多租户能力 |
|---|---|---|---|
| **`IBM/mcp-context-forge`** | **4 813** | Apache-2.0 | ⭐ **federation**：把任意 MCP/A2A/REST/gRPC 聚合成一个端点；Tools Gateway、虚拟 server、guardrails、discovery、可观测；PyPI/Docker 部署，Redis 支持多集群 federation；有 admin UI |
| `agentic-community/mcp-gateway-registry` | 1 048 | Apache-2.0 | 企业级 registry + **nginx 数据面** + Keycloak/Entra + MongoDB + 审计 + scopes |
| `microsoft/mcp-gateway` | 917 | MIT | K8s 反代 + adapter 路由 + 数据面 Bearer/RBAC；**强制 MCP `2026-07-28`**，不兼容老协议 |
| `decocms/studio`（MCP Mesh） | 419 | MIT | ⭐ **Local-first**：本地 Docker Compose 起步，同步到云做远程访问；Virtual MCPs（一个端点按策略暴露不同工具集）；OAuth 2.1 + **tool-scoped API key**；组织/项目级隔离 + 审计日志 |
| `agentgateway/agentgateway` | — | — | Agent-to-agent / agent-to-tool 的治理代理 |
| `Pomerium/pomerium` | — | — | MCP 网关 + **per-tool 访问控制** |
| `AmoyLab/Unla` | 173 | — | **轻量**网关，零代码把现有 MCP/API 转成 MCP server |
| `smart-mcp-proxy/mcpproxy-go` | — | — | 本地 MCP proxy，单端点路由多 server + BM25 工具过滤 + 活动日志 + web UI |
| `lasso-security/mcp-gateway` | 403 | — | 插件式，编排其他 MCP |
| `Klavis-AI/klavis` | — | — | MCP 集成平台 |

---

## 3. 三个必须先定的架构决策

### 决策 1：中转理不理解 MCP 协议？

| | 字节隧道（不理解） | MCP 感知（理解） |
|---|---|---|
| 中转做什么 | HTTP-over-WS 转发 | 终止 MCP 会话，向 agent 说另一种协议 |
| 鉴权粒度 | **按 server** | 按 server **和按工具** |
| 多 server 聚合 | ❌ 一个端点一个 server | ✅ Virtual MCP，一个端点聚合多 server |
| 审计粒度 | 请求级 | **工具级**（哪个 tool、什么参数、结果多大） |
| 协议升版 | 中转不用改 | 中转要跟着改 |
| 工作量 | 小（≈1–2 周） | 大（≈3–5 周） |

> **建议：分两期。** MVP 走字节隧道 + 按 server 鉴权，先跑通商业闭环；V2 上 MCP 感知层，或直接换成 `mcp-context-forge`（Apache-2.0，已有 federation + 虚拟 server + admin UI）。
> **但工具级管控从第一天就要留口子** —— 因为 bash / 文件系统这类 MCP 一旦上公网就是远程执行后门。

### 决策 2：每用户一条隧道，还是统一中转连接？

| | 每用户一条（cloudflared named tunnel） | **统一中转连接（推荐）** |
|---|---|---|
| 用户侧依赖 | 要装 cloudflared、注册 CF 账号 | **只装你的 Agent** |
| 你的掌控力 | 低（域名和鉴权在 CF 手里） | **高**（域名、token、审计、配额全在你手里） |
| 运维 | CF 账号配额、每用户一条隧道 | 一套连接多路复用 |
| 隔离性 | 天然隔离 | 逻辑隔离，要自己保证 |

→ **SaaS 必须选右边的。** `mcp-ferry`/`mcptunnel` 的形态留给「个人自用」场景。

### 决策 3：鉴权模型

| 方案 | 复杂度 | 兼容性 | 建议 |
|---|---|---|---|
| **Bearer token**（静态 per-tenant） | 低 | 所有 client 都能用 | **MVP 用这个**。`supergateway --apiKey` / `mcptunnel` / `mcp-proxy` 都原生支持 |
| **OAuth 2.1**（PKCE + DCR） | 中高 | 需 client 支持；`mcp-remote` 可兜底 | 对外正式提供时补。**别自己写 OAuth 服务器** —— Cloudflare Access Managed OAuth 直接给你一个合规的授权服务器（`mcp-ferry` 就是这么做的） |

---

## 4. 落地路线

### 路线 A：复用 `mcp-context-forge`（快，能力最全）

```
用户本机                        你的中转
Agent(supergateway + 出站隧道) ──▶ mcp-context-forge
                                    ├ 租户 → (agent 隧道 URL) 的映射
                                    ├ federation：把每个隧道 URL 注册成一个 remote MCP server
                                    ├ Virtual Server：把一个租户的多个 server 聚合成一个端点
                                    ├ 内置鉴权 / RBAC / 审计 / admin UI
                                    └ 你只写：注册流程、配额、计费
```

**你写的：**
1. 本地 Agent（起 supergateway + 出站隧道 + 心跳）
2. 注册 API：Agent 上报 `(tenant, serverName, tunnelUrl)` → 写入 context-forge 的 server 注册表
3. 把租户与 MCP server 绑成 context-forge 的 **Virtual Server**（一步就实现「一个端点聚合多 server」）

**成本**：后端几乎白嫖，1–2 周能出 MVP。代价是 Python 技术栈 + 一个不算轻的部署（可选 Postgres/Redis）。

### 路线 B：自研轻量中转（照 `mcp-ferry` 架构）

**你写的全部：**

| 模块 | 职责 | 预估 |
|---|---|---|
| `agent/` 本地 Agent | 起 supergateway、出站 WS、心跳、重连、转发 | 300–500 行 |
| `relay/` 数据面 | 租户认证、路径路由、**流式转发**、取消传播 | 400–700 行 |
| `registry/` 控制面 | 租户表、server 注册表、配额、审计入库 | 300–500 行 |
| `web/` | 用户控制台（拿 token、看 server、配额、审计） | 视投入 |

**成本**：2–3 周 MVP。

---

## 5. 本地 Agent 的详细设计

### 5.1 进程模型

```
Agent
 ├─ supergateway (子进程)  ← 托管用户的所有 MCP server
 │    http://127.0.0.1:4001/<serverName>/mcp
 └─ WS 客户端 ──────────────▶ 中转
```

`supergateway --config` 直接吃用户已有的 `mcpServers.json`，用户零改造。

### 5.2 转发协议（中继 ↔ Agent）

自定一个最小帧协议即可：

```
Agent → 中继 (CONNECT)
  { type:"connect", tenantToken, agentId, servers:[{name, localPath, tools:[...]}] }

中继 → Agent (REQ)                Agent → 中继 (RES)
  { id, method, path, headers,       { id, status, headers, bodyChunks:[...] }
    body }                           （bodyChunks 持续推送直到 end）
```

**三个必须处理对的点：**

1. **流式**：MCP Streamable HTTP 的响应可能是 SSE 流。**必须分块流式转发**，不能缓冲到完整响应 —— 否则长任务的进度通知全丢失。
2. **取消**：客户端断开 → 中转发 `CANCEL` → Agent 杀掉上游请求/进程。
3. **大 payload**：文件读取可能几十 MB，要分帧（建议 256 KB/帧）并限制单请求上限。

### 5.3 会话亲和

MCP Streamable HTTP 是**有状态**的：客户端拿到的 `Mcp-Session-Id` 必须回到**同一个**本地 stdio 进程。

- 中转侧：`Mcp-Session-Id` → `(tenant, agentConnId, localSession)` 的映射
- 或更简单：**一个租户一条 Agent 连接**，亲和天然成立（推荐 MVP）
- 若中转多实例部署 → 必须粘性哈希，否则 `tools/call` 打到另一个进程报 `unknown_session`

---

## 6. 安全设计（公网服务的生死线）

### 6.1 工具级默认拒绝

`supergateway` 的 `--tools` 白名单、`mcptunnel` 的 `--allow-tool` 都是现成范式。

**必须默认关闭的高危工具：**

| 工具 | 危险 |
|---|---|
| `bash` / `execute_command` / `shell` | 🔴 任意命令执行 = 公网后门 |
| `write_file` / `delete` | 🟠 破坏本地数据 |
| 任何 `*_admin` / `*_exec` | 🟠 |
| `read_file` / `list_directory` | 🟡 限定 allowed dirs |

**默认只放行 `read_*` / `list_*` / `search_*`，写和执行要显式开。**

### 6.2 用户自己的 MCP server 也要审

用户可能写一个 bash MCP 挂上来。→ 中转侧需要**服务准入**：
- 新 server 首次接入时，工具清单进「待审」队列
- 管理员/规则引擎按工具名模式判定（`bash|exec|shell` 一律拒）
- 记录服务端指纹（stdio 命令 / HTTP URL）用于审计

### 6.3 隔离与配额

| 维度 | 做法 |
|---|---|
| 租户隔离 | 每个租户独立 token；路径里带 tenant id；审计按 tenant 分区 |
| 频率限制 | 按 tenant + IP + server 三级限流 |
| 配额 | 每租户每月调用数 / 并发连接数 / 出站带宽 |
| 审计 | 记录 tenant、client IP、server、method、参数大小、结果大小、耗时、错误码 |
| 凭据 | 上游 MCP 的凭据**永不离开用户机器**（在本地 supergateway 进程里用） |

### 6.4 明确告知用户的安全边界

中转是**可信边界内**的：它能看到工具名、参数和返回内容。要在产品页写清楚：

> 与「载荷级 E2EE」的方案不同，中转是明文可见的。若需要内容不可见，用户的 MCP server 需自行在本地做加解密。

---

## 7. 协议版本坑（实测当前生态状况）

| 项目 | 支持 |
|---|---|
| `punkpeye/mcp-proxy` | `2026-07-28` + `2024-10-07`~`2025-11-25` **双协议**，同一端点 |
| `supergateway` | 默认 `2024-11-05`，`--protocolVersion` 可改 |
| `microsoft/mcp-gateway` | **强制 `2026-07-28`**，不提供 legacy 初始化或降级 |

→ **你的中转最好双协议兼容**。用 `punkpeye/mcp-proxy` 作为本地侧 L1，比 `supergateway` 的协议兼容性更好；`supergateway` 胜在多 server 托管和配置格式。

**折中**：`supergateway` 托管多 server + `mcp-proxy` 兜底协议版本，或直接选 `mcp-proxy`（单 server 的话）。

---

## 8. 分阶段计划

### 第 0 阶段（2 天）：技术验证，不写中转

```bash
# 本机
npx -y supergateway --config ~/.config/mcp/servers.json \
  --outputTransport streamableHttp --port 4001 --apiKey "$TOKEN" \
  --toolPrefix "local_"
# 另开一个终端，验证 streamable + 白名单 + 鉴权
```

目标：确认 `tools/list` 只返回白名单工具、未带 token 被拒、SSE 流式正常。

### 第 1 阶段（1 周）：单租户闭环

- 本地 Agent：起 supergateway + 出站 WS + 转发
- 中转：最小实现（一个租户、一个 server、HTTP over WS 转发 + Bearer）
- 验证：公网任意 MCP client 能调通

### 第 2 阶段（1–2 周）：多租户

- 租户表 + token 签发/吊销
- URL 形态统一为 `/m/{tenant}/{server}/mcp`
- 审计入库 + 控制台（看 server、配额、审计）
- 限流与配额

### 第 3 阶段：MCP 感知层

- 要么自研：工具级鉴权 + Virtual MCP 聚合
- 要么换成 `mcp-context-forge`（Apache-2.0，4 813★，自带 federation / 虚拟 server / admin UI），你只保留 Agent + 业务逻辑

---

## 9. 与 DreamMate 的关系

DreamMate 的**网关部分**（`/services/:id/invoke`）可以复用，但它有两个属性不适合直接当产品中转：

1. **它没有入口鉴权** —— `network` 共享模式下「不增加按设备或 Agent 的身份鉴权」
2. **它不是 MCP 协议** —— 是 DreamMate 自己的 invoke 语义

→ **但它是一个极好的「用户侧 Agent 能力源」**：用户的 DreamMate 已经报备了 20 个本地服务，只要在 Agent 里把 `POST /services/:id/invoke` 包成一个 stdio MCP server（`dreammate-node mcp` 就是干这个的），它就变成一个标准 MCP server，走同一条隧道出去。

```
用户本机
├─ dreammate-node 网关 :36908  (20 个本地服务)
└─ Agent
   ├─ supergateway (托管用户自己的 MCP)
   └─ 一个 stdio MCP 适配器：把 dreammate-node mcp 包成 MCP
        ↓ 一条出站隧道
      你的中转 → 公网
```

即：**DreamMate 用户零改造就能把你的中转用起来**（他们只需要装你的 Agent + 填一个 token）。

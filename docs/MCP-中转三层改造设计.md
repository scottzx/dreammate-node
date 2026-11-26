# MCP 中转服务：三层改造设计（基于改 dreammate-node 包）

> 前提：`scottzx/dreammate-node` 是自-owned 仓库，可直接改造并发版。
> 所有现状均已核实（2026-11-13）：包依赖、dist 源码、网关实际返回。

---

## 0. 三层归属与工作量总览

| 层 | 干什么 | 放在哪 | 工作量 | 现成件可替代吗 |
|---|---|---|---|---|
| **L1 协议层** | 本地 MCP → 标准 MCP over HTTP | **dreammate-node 包内** | ~280 行 | ❌ SDK 给传输，不给业务 |
| **L2 隧道层** | NAT 后的机器 → 公网可达 | 包内出站连接器 **或** 外挂 cloudflared | 0 / ~400 行 | ✅ 外挂可零代码 |
| **L3 中转网关** | 多租户路由 + 鉴权 + 审计 + 配额 | 独立服务端 | ~300 / ~800 行 | ✅ `mcp-context-forge`（Apache-2.0，4 813★） |

> **关键判断**：L1 一定要自己改包（否则鉴权/审计/摊平都只能外挂一层通用 shim，做不到产品级粒度）。L2/L3 都可以先用现成件跑通再优化。

---

## L1 协议层 —— 改 dreammate-node

### 1.1 已核实的前提

| 事实 | 证据 |
|---|---|
| 已依赖 MCP SDK | `package.json` → `@modelcontextprotocol/sdk: ^1.30.0`（实装 1.32.1） |
| `Server` 是传输无关的 | `mcp.js:509` `new Server({...})` + `setRequestHandler(...)` + `:1254` `server.connect(new StdioServerTransport())` |
| 只用了 Stdio 传输 | `grep StreamableHTTPServerTransport\|SSEServerTransport` → 仅 `StdioServerTransport` ×2 |
| **原生工具 schema 已在手** | 网关 `/services` 返回完整 `parameters` / `annotations.readOnlyHint` / `title` / `original_name` / `aliases` |
| schema 本地也存着 | `mcp-sources.js:116` `state.schemas = new Map()`、`state.schemaJobs`（异步加载） |
| 跨节点无隧道基建 | `grep WebSocket\|wss://` → **无命中**；跨节点只是 `fetch` 到 `http://<node>:36908/services/:id/invoke` 的请求-响应 |

### 1.2 改造项 A：新增 HTTP transport

```js
// dist/src/mcp.js
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// 现有
server = createMcpServer(options);
await server.connect(new StdioServerTransport());

// 新增分支（--transport http）
if (options.transport === 'http') {
  await serveHttp({ server, options });
}
```

```js
async function serveHttp({ server, options }) {
  const http = createServer(async (req, res) => {
    // 1) 鉴权：Bearer / X-Tenant-Token → tenant
    // 2) sessionId = req.headers['mcp-session-id']
    // 3) 无 session → 新建 Server 实例 + Transport，走 initialize
    // 4) 转交 transport.handleRequest(req, res, body)
  });
  http.listen(options.port, options.bind);
}
```

**会话模式选择：**

| | stateful | stateless |
|---|---|---|
| SDK 配置 | `sessionIdGenerator: () => randomUUID()` | `sessionIdGenerator: undefined` |
| 代价 | 必须**每 session 一个 Server + 一个 transport 实例**（SDK 要求一一对应），维护 `sessionId → {server, transport}` map | 每次请求重新握手 |
| 坑 | `createMcpServer()` 每次 new 一个实例 —— **不建 map 就会串状态** | 性能略差 |

→ **MVP 先 stateless**，简单且不会串；量起来再上 stateful。

### 1.3 改造项 B：两种工具暴露模式（产品的核心体验）

| | **元工具模式**（现有行为） | **摊平模式**（新增） |
|---|---|---|
| client 看到 | 固定 10 个元工具 | 每个来源的原生工具直接摊出来 |
| 工具面 | 恒定（20 服务还是 200 服务都一样） | 随来源数膨胀 |
| 调用路径 | `search_tools` → `inspect` → `invoke`（三步） | 直接 `tools/call`（一步） |
| token 成本 | 低 | 高 |
| 延迟 | 高（每步一次往返） | 低 |
| 工具名冲突 | 不存在 | 用前缀：`mcp__<source>__<tool>` 或 `<source>_<tool>` |
| 适用 | 工具多、需要语义检索 | **普通 MCP client（Claude Code/Cursor）直接可用** |

**摊平模式的数据已就绪** —— 网关 `/services` 已返回每个原生方法的完整 JSON Schema：

```json
"mcp-wordcraft.execute": {
  "parameters": { "type": "object", "properties": {...} },
  "annotations": { "title": "...", "readOnlyHint": true, "openWorldHint": false },
  "original_name": "execute",
  "aliases": ["execute"]
}
```

**安全策略现成** ⭐ —— `annotations.readOnlyHint` 已经标好了，可以直接实现：

> **默认只暴露 `readOnlyHint === true` 的工具**，`write`/`exec`/`bash` 类自动被挡。

这把上一轮说的「工具级默认拒绝」从「要自己解析工具名」变成了「读已有标注」，成本几乎为零。

**摊平模式的实现要点：**
1. `tools/list` → 遍历可见来源的 `methods`，按命名空间重写 `original_name` → `mcp__<source>__<tool>`
2. `tools/call` → 拆回 `(source, original_tool)` → 直接转发到该来源（**不走 `dreammate_invoke` 的 search/inspect 流程**）
3. 来源不可用时 → 返回 `-32602 Unknown tool` 或明确的不可用诊断，不要静默消失
4. `catalog.status === 'unsupported'` 的来源（当前本机 7 个来源**全是** unsupported）→ 要确认 schema 是否完整；本机实测 `mcp-wordcraft` 的方法 schema 完整可用，所以 `unsupported` 指的是「子动作目录展开」不支持，不是 schema 缺失

**模式切换开关：**
```
--tool-mode meta      # 默认，10 个元工具
--tool-mode flat      # 摊平
--tool-mode both      # 两者都出（工具名不冲突时）
--tool-allow read-only|all   # 默认 read-only
```

### 1.4 改造项 C：鉴权

与现有 `sharing: local/network` **并存**，职责不同：

| | 管什么 | 现状 |
|---|---|---|
| **入口鉴权**（新增） | 谁能连到这个 HTTP 端点 | ❌ 没有 |
| `sharing`（现有） | 进来之后能看到哪些来源 | ✅ 有 |

```js
// 中间件
const tenant = await resolveTenant(req.headers['authorization']);  // Bearer / X-Tenant-Token
if (!tenant) return 401;
// 配额 / 速率限制 / 审计都挂在 tenant 上
```

### 1.5 改造项 D：审计（放 L1 最准）

**审计放在 L1，而不是 L3** —— 因为只有这里能看到 tool 名、参数、结果、耗时，而且不受隧道方案影响（L2 用 cloudflared 时 L3 根本抓不到流量）。

每次 tool call 记录：`tenant / node / source / tool / params 大小 / 结果大小 / 耗时 / 错误码`，POST 到你的控制面。

### 1.6 改造项 E：顺手修一个 bug（一行）

```js
// mcp.js:447
params: {
  type: 'object',
  description: '传递给该方法的参数键值对对象',
  additionalProperties: true,     // ← 加这行
},
```

现状是无 `additionalProperties` 的手写 JSON Schema，数值类型信息缺失 → 实测 `head: 6` 被转成字符串，上游报 `expected number, received string`。影响所有带数值参数的方法（`head`/`tail`/`timeout_ms`/`max_output_bytes`）。

### L1 工作量汇总

| 项 | 行数 |
|---|---|
| HTTP transport + 路由 + stateless 会话 | ~120 |
| 摊平模式（tools/list 聚合 + tools/call 分发） | ~120 |
| 鉴权中间件 | ~40 |
| 审计上报 | ~40 |
| **合计** | **~320 行**（含单测 ~500） |

---

## L2 隧道层 —— 让 NAT 后的机器公网可达

### 2.1 现状

`dreammate-node` **没有任何隧道基建**（grep 确认无 WebSocket / 流式 / 隧道代码）。跨节点只是普通 HTTP 请求-响应。

### 2.2 方案 A：外挂 cloudflared（做 MVP，0 代码）

```bash
dreammate-node mcp --transport http --port 8787 --api-key "$TOKEN" &
cloudflared tunnel --url http://127.0.0.1:8787
# → https://<random>.trycloudflare.com/mcp
```

Named Tunnel + 自己的域名可以做到统一域名：`https://<uuid>.mcp.yourdomain.com/mcp`。

| 优点 | 缺点 |
|---|---|
| 零代码、免费额度、稳定、自带 DDoS 防护 | **审计拿不到**（L3 抓不到流量）→ 靠 L1 上报补 |
| Cloudflare Access 可直接给 OAuth 2.1 | 依赖 CF（国内访问一般） |
| 每用户独立 UUID 域名 | 域名不是我们完全掌控的资产 |

### 2.3 方案 B：自建出站 WS（产品形态正解，~400 行）

```
dreammate-node mcp --transport http --port 8787 \
    --relay wss://relay.yourdomain.com \
    --tenant-token-file ~/.1agents/tenant.token
```

用户零依赖；域名、鉴权、审计、计费全在我们手里。

**帧协议（最小可用）：**

```
Agent → Relay   { t:"hello", tenant, agentId, servers:[{name, path, toolCount}] }
Relay → Agent   { t:"req",  id, method, path, headers, body }          // body 可分帧
Agent → Relay   { t:"res",  id, status, headers }                       // 先回头
                { t:"chunk", id, data }                                 // 流式分块，可多次
                { t:"end",  id }
Relay → Agent   { t:"cancel", id }
```

**四个必须做对的点：**

1. **流式** —— MCP Streamable HTTP 的响应可能是 SSE 流。**必须分块流式转发**，不能缓冲到完整响应，否则长任务的进度通知全丢。
2. **取消传播** —— 客户端断开 → Relay 发 `cancel` → Agent 杀掉上游请求/进程。
3. **大 payload** —— 文件读取几十 MB，要分帧（建议 256 KB/帧）并设单请求上限。
4. **会话亲和** —— `Mcp-Session-Id` 必须回到**同一个**本地 stdio 进程。
   → 最简做法：**一个租户一条 Agent 连接**，亲和天然成立；多实例部署再加粘性哈希。

---

## L3 中转网关 —— 多租户、路由、审计、配额

### 3.1 关键洞察：L2 选 A 还是 B，决定 L3 的复杂度

| L2 选择 | L3 是什么 | 工作量 | 代价 |
|---|---|---|---|
| **A. cloudflared** | CF 边缘就是数据面，你的 L3 退化成**控制面**（租户表/token/审计收集/配额计费） | ~300 行 | **数据面不归你**，产品定位有落差 |
| **B. 自建 WS** | L3 是**真正的中转**（WS 接 agent + HTTP 接 client + 路由 + 鉴权 + 配额） | ~800 行 | 数据面完全自控，可做工具级策略与协议级审计 |
| **B + 复用 ContextForge** | ContextForge 的 federation 本身就是「注册 remote MCP server URL → 聚合」；你 L2 的隧道端点有个稳定 URL（`https://relay/agent/<agentId>/mcp`）就能直接注册成一个 remote server | ~200 行（只写注册+配额） | Python 技术栈 + Postgres/Redis；L2/L3 解耦 |

### 3.2 无论选哪条，审计都落在 L1

L3 只做**存储与查询**。原因见 L1.5 —— 只有 L1 拿得到 tool 级语义。

### 3.3 L3 必备能力

| 能力 | 说明 |
|---|---|
| 租户与 token | 签发 / 吊销 / 过期；token → tenant |
| 路由表 | tenant ↔ agent ↔ server 列表 |
| 速率限制 | 按 tenant + IP + server 三级 |
| 配额 | 调用数 / 并发连接数 / 出站带宽 / 每月额度 |
| 审计存储与查询 | 写入 L1 上报的数据，提供控制台 |
| 计费 | 按量 / 套餐 |

---

## 4. 三层如何协同（一条完整链路）

```
   远端 MCP client
        │  https://<uuid>.mcp.yourdomain.com/mcp
        │  Authorization: Bearer <tenant-token>
        ▼
┌─────────────────────────────────────────────────────────┐
│ L3 中转（或 cloudflared 边缘）                            │
│   租户鉴权 → 路由 → 限流/配额 → 审计落库                  │
└─────────────────────────────────────────────────────────┘
        ▲
        │  出站 WS（L2 方案 B）／或 CF tunnel（L2 方案 A）
        │
┌──┴──────────────────────────────────────────────────────┐
│ 用户本机                                                  │
│  L1 dreammate-node --transport http :8787                │
│    ├ 鉴权中间件（tenant-token → tenant）                  │
│    ├ 工具暴露模式：meta / flat                           │
│    │    flat 时按 annotations.readOnlyHint 过滤 + 前缀命名 │
│    ├ 审计上报（tool/参数/结果/耗时）→ L3                  │
│    └ 后端：                                                 │
│        ├ DreamMate 20+ 服务（:36908）→ 元工具              │
│        └ 用户自己的 MCP（mcp add 注册）→ 摊平工具          │
└───────────────────────────────────────────────────────────┘
```

**DreamMate 用户零改造**：他们已有的 20 个报备服务、语义检索、跨节点能力，通过「元工具模式」直接出去。
**普通用户**：他们的 MCP 走「摊平模式」，得到跟 Claude Code 装本地 MCP 一样的体验。

---

## 5. 落地顺序

| 阶段 | 做什么 | 验收标准 | 工作量 |
|---|---|---|---|
| **P0** | L1 的 HTTP transport + 鉴权 + 摊平模式 | 本机 `claude mcp add --transport http` 能调通，能看到摊平后的原生工具 | ~280 行 |
| **P1** | L1 审计上报 + L2 用 cloudflared 外挂 | 公网可调，控制台能看到 tool 级审计 | ~40 行 + 0 |
| **P2** | L2 自建出站 WS，替换 cloudflared | 用户零依赖；域名/鉴权/计费全自控 | ~400 行 |
| **P3** | L3 控制面（租户/配额/计费/控制台） | 多租户可运营 | ~300–800 行 |

**建议 P0 先做** —— 它不依赖 L2/L3，本机就能验通，而且能一次性回答「摊平模式体验到底行不行」这个最关键的产品问题。

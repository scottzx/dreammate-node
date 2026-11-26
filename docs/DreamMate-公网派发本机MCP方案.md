# 用 DreamMate 从公网派发指令到本机 MCP

> 验证日期：**2026-11-13**　全部结论在本机 `scott-mac` 实测，非文档推断。

---

## 0. 结论

**你不需要新写 MCP 转发网关 —— DreamMate 已经是这个东西了。**

本机 `dreammate-node` 网关已在运行，20 个本地服务已报备，跨节点派发链路**已实测跑通**。

缺的只有两件事：
1. **公网入口**（现在是 Tailnet，不是公网）
2. **入口鉴权**（网关本身没有，而这恰恰是能不能放公网的前提）

---

## 1. 本机现状（实测）

| 项 | 状态 |
|---|---|
| node-agent | launchd 常驻 `work.dreammate.node.plist`，running |
| 监听地址 | `*:36908`（**0.0.0.0，所有网卡**）—— Tailnet/局域网已可达 |
| 已报备服务 | **20 个**，其中 filesystem / bash / git / 网页抓取 / 时间时区 / 项目记忆 / rea 等全部 `live: up` |
| MCP 数据源 | 7 个：`mcp-wordcraft`/`gridcraft`/`deckcraft`/`rea`/`ios-agenda` = `sharing: local`；`mcp-erp-admin`/`mcp-erp-readonly` = `network`（当前连接失败） |
| Tailnet | `scott-mac.tailfb4720.ts.net` → 100.88.227.56；9 个已知节点，5 个 `gateway_reachable` |
| Tailscale Funnel | 命令可用，但现有 3 条 serve 规则**都是 `tailnet only`**，公网未开 |

### 网关 HTTP API 面

| 端点 | 说明 |
|---|---|
| `GET /health` | 健康 |
| `GET /manifest` | 节点身份 + 当前调用方可见的服务 |
| `GET /services` | 各服务存活与可达性 |
| `POST /services` | 服务报备（**仅接受 localhost**） |
| `DELETE /services/:id` | 注销 |
| `POST /services/:id/invoke` | **调用指定服务的方法 ← 就是「派发指令」** |

> ⚠️ **网关没有 `/mcp` HTTP 端点**（探测 404）。DreamMate 的 MCP 接入方式是 **stdio 适配层**：`dreammate-node mcp --agent http://GATEWAY:36908`。

---

## 2. 已验证的跨节点派发链路 ✅

**实测**：从 `scott-pc-wsl`（Linux，Tailnet 100.75.225.56）发指令，读取 `scott-mac` 本地文件。

```
scott-pc-wsl
  → curl http://100.88.227.56:36908/services/filesystem/invoke
      {"method":"filesystem.read_text_file",
       "params":{"path":".../file-system-mcp/package.json"}}
  → 拿到 scott-mac 本地文件内容 ✅
```

### 派发方式（MCP 语义，三步）

```
dreammate_search_tools  query="读取本地文件"      → 找到 filesystem.read_text_file
dreammate_inspect       service_id=filesystem
                        method=filesystem.read_text_file  → 拿到入参 Schema
dreammate_invoke        同上 + params={"path":"..."}     → 派发指令
```

### 或者绕开 MCP，直接 HTTP（更轻）

```bash
curl -X POST http://<host>:36908/services/<service_id>/invoke \
  -H 'Content-Type: application/json' \
  -d '{"method":"<service>.<method>","params":{"path":"..."}}'
```

CLI 等价物：

```bash
dreammate-node cli invoke --agent http://<host>:36908 \
  --node scott-mac --service filesystem \
  --method filesystem.read_text_file \
  --params '{"path":"/abs/path/file"}'
```

---

## 3. ⚠️ 放公网前必须解决的安全问题

### 3.1 网关入口没有任何鉴权

官方 README 原文：

> `network` 延续**可信网络共用模式**，不增加按设备或 Agent 的身份鉴权；允许访问该来源的调用方**共用上游凭据**。细粒度授权后续再做。

### 3.2 本机哪些服务是 `network` 共享

实测 `/services` 返回：

| 服务 | 端口 | sharing | 危险度 |
|---|---|---|---|
| **Bash 终端与结构化搜索 MCP** | 7785 | **network** | 🔴 **任意命令执行** |
| **文件系统 MCP** | 7784 | **network** | 🔴 任意读文件（限 allowed dirs） |
| Git MCP / 网页抓取 MCP / 时间时区 / 项目记忆 / 分步思考 | — | network | 🟠 |
| 老板 IP 工作台 | — | **network** | 🟠 |

> **`sharing: local` 对 `mcp add` 的数据源才有效**，且语义是「仅回环入口可调用」——不能拿来当公网共享开关。
> **直接 Funnel 36908 到公网 = 把这台 Mac 变成公网上的远程执行后门。绝对不要。**

---

## 4. 正确做法：公网只暴露一个带 token 的 MCP 端点

思路：**不要暴露 36908 整个网关**（它带 `/services` 报备、`/manifest` 节点清单等管理面），只在前面加一层**只暴露 MCP 语义 + Bearer 鉴权**的薄网关。

### 4.1 本机起带鉴权的 MCP 端点

```bash
# DreamMate 本身是 stdio MCP server，用 supergateway 转成 streamable-http 并加 Bearer
npx -y supergateway \
  --stdio "npx -y @1agents/dreammate-node mcp --agent http://127.0.0.1:36908" \
  --outputTransport streamableHttp \
  --port 8000 \
  --apiKey "$TOKEN" \
  --healthEndpoint /healthz
```

- 暴露的是 `POST /mcp`（标准 MCP），**没有** `/services`、`/manifest` 这些管理面
- 客户端必须带 `Authorization: Bearer $TOKEN`，否则拒绝
- `supergateway` 本身还有 `--toolPrefix` / `--tools` 白名单 / `--printConfig`（自动打码）等

### 4.2 公网入口（三选一）

| 方案 | 做法 | 备注 |
|---|---|---|
| **Tailscale Funnel** ⭐ | `tailscale funnel --bg 8000` | 本机已装，命令可用；给公网 HTTPS 域名；需 tailnet policy 允许 Funnel；**启用前确认下面第 5 节** |
| cloudflared | `cloudflared tunnel --url http://127.0.0.1:8000` | 免账号、随机域名，适合试 |
| 自建中转 | 你上一轮说的那套 | 长期方案，可控性最高 |

### 4.3 远端 Agent 接入

```bash
# Claude Code（原生 http transport）
claude mcp add --transport http dm https://<公网域名>/mcp \
  --header "Authorization: Bearer $TOKEN"

# 只支持 stdio 的客户端（Cursor / Windsurf 等）
{
  "mcpServers": {
    "dm": {
      "command": "npx",
      "args": ["mcp-remote", "https://<公网域名>/mcp",
               "--header", "Authorization: Bearer ${DM_TOKEN}"],
      "env": { "DM_TOKEN": "..." }
    }
  }
}
```

接上之后，远端 Agent 拿到的就是 `dreammate_search_tools` / `dreammate_inspect` / `dreammate_invoke` / `dreammate_list_nodes` 这一组元工具，**跟本机 DSH 里的完全一致**。

---

## 5. 上公网前必须收紧的四件事

### 5.1 文件系统 MCP 的 allowed dirs 只有一个目录

实测报错：

```
Access denied - path outside allowed directories:
  ... not in /Users/scott/Documents/01-开发项目/1agents/mcp/file-system-mcp
```

来源（`src/bridge.mjs`）：`validateRoots` 要求 `--root` 目录或 `FILESYSTEM_ALLOWED_DIRS`（JSON 数组）。

→ 要让远端读你的工作文件，必须**显式加 root**，例如：

```json
{ "FILESYSTEM_ALLOWED_DIRS": "[\"/Users/scott/Documents/01-开发项目\", \"/Users/scott/.config\"]" }
```

⚠️ 加 root = 加暴露面，按需最小化。

### 5.2 Bash MCP（7785）在 network 共享里

它是**任意命令执行**。三个处理方式：

- **a)** 暴露前把 Bash 服务停掉（`dreammate_manage_service` / `cli manage --action stop`），需要时再起
- **b)** 改 `sharing: local` —— 但那样**远端也调不到**它（这正是 `local` 的语义），只适合「确认暴露面」
- **c)** 在 supergateway 用 `--tools` 白名单，只放行读文件的工具，屏蔽 bash

> ⚠️ 关键点：DreamMate 的 `sharing: local` 对 `mcp add` 数据源生效；**报备服务（`POST /services`）默认就是 network 共用**。所以「关掉 bash」得靠停服务或工具白名单，不能只靠 sharing。

### 5.3 token 要够长

`openssl rand -hex 32`。`supergateway --apiKey` 支持 Bearer 或 `X-API-Key` 两种写法，可多把（逗号分隔）。

### 5.4 隧道层还要再加一道

Funnel / cloudflared 之上再叠一层（Basic Auth、IP 白名单、Cloudflare Access），别让 Bearer 成为唯一防线。

---

## 6. 顺手发现的两个 bug / 限制

### 6.1 `dreammate_invoke` 的数值参数被转成字符串

```
dreammate_invoke(params={"path":"...","head":6})
→ MCP error -32602: expected number, received string at head
```

复现边界：

| 调用方式 | 数值参数 |
|---|---|
| 直连网关 HTTP `POST /services/:id/invoke` | ✅ 正常 |
| `dreammate-node cli invoke` | ✅ 正常 |
| **MCP 工具 `dreammate_invoke`** | ❌ 被转成字符串 |

原因：`dreammate_invoke` 的工具声明里 `params` 是**无属性的 object**（`type: 'object'`，没有 `additionalProperties` 约束），数值类型信息在工具声明层就缺失，字符串化发生在宿主的工具调用适配层，**不是网关的锅**。

影响面：所有带数值参数的方法（filesystem 的 `head`/`tail`、bash 的 `timeout_ms`/`wait_ms`/`max_output_bytes`）经 MCP 走这条路都会挂。

**绕过**：数值参数改走 HTTP / CLI；或让工具声明带上 `additionalProperties` 的类型。

### 6.2 filesystem 的 `read_file` 已废弃

`filesystem.read_file` 描述里写明 `DEPRECATED: Use read_text_file instead`。

---

## 7. 落地顺序

**第 0 步（不写代码，5 分钟）** — Tailnet 内先跑通

```bash
# 远端任意装了 Tailscale 的机器
npx -y @1agents/dreammate-node mcp --agent http://scott-mac.tailfb4720.ts.net:36908
```

**第 1 步（1 小时）** — 加鉴权层，本机验证

```bash
npx -y supergateway --stdio "npx -y @1agents/dreammate-node mcp --agent http://127.0.0.1:36908" \
  --outputTransport streamableHttp --port 8000 --apiKey "$TOKEN"
claude mcp add --transport http dm http://127.0.0.1:8000/mcp --header "Authorization: Bearer $TOKEN"
```

**第 2 步（半天）** — 收紧暴露面
- 停掉或白名单屏蔽 Bash 服务
- 扩 filesystem 的 allowed dirs（最小必要）
- 确认 `mcp list` 里 `sharing` 状态符合预期

**第 3 步（半天）** — 上公网
- 开 Funnel 或 cloudflared
- 隧道层再加一道鉴权
- 用另一台**不在 Tailnet 内**的机器验证

---

## 8. 与前两轮方案的关系

| | 上一轮 MCP 转发网关 | 本轮 DreamMate |
|---|---|---|
| 核心 | 自己写一个通用 MCP 转发 | **已有，且跨节点验证通过** |
| 轻量做法 | supergateway / mcp-proxy | **supergateway + DreamMate stdio 适配层**（同一个 supergateway） |
| 差异化 | — | DreamMate 多给了：**跨设备节点发现**、语义检索（`search_tools`）、技能目录、`reachability: localhost` 的代理转发 |

**建议**：不要另起炉灶写转发层。直接把 DreamMate 当**本机能力总线**，只补「带鉴权的公网 MCP 入口」这一层 —— 也就是第 4 节的 supergateway + 隧道，约 1 小时的事。

> 顺带：这也回答了上一轮那个「多主机路由」的 gap —— DreamMate 的 `/nodes` + `/services/:id/invoke` **本身就是多主机路由**，而且已经在跑了。

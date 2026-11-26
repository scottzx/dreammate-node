# 轻量 MCP 远程转发网关：设计与选型

> 日期：**2026-11-13**　需求：做一个轻量东西，把**本地 MCP 服务**暴露出去，让**任意地点的任意 Agent**装个 MCP 配置就能调用。
> 核实方式：GitHub API 读源码与 README、npm registry 校验、DSH 上游 `docs/subsystems/mcp.zh.md` + `packages/mcp/mcp-client/README.zh.md`。

---

## 0. 核心判断

你的直觉对了一半：**MCP over Streamable HTTP 本质就是 HTTP POST + JSON-RPC over SSE，数据确实是 JSON 文本**。

但真正的难点不在 JSON，在这四件事：

| # | 难点 | 谁来解决 |
|---|---|---|
| 1 | **stdio ↔ HTTP 双向转换 + 会话生命周期**（通知流、取消、进度、订阅） | ⚠️ **别自己写**，用 `mcp-proxy` / `supergateway` |
| 2 | **会话亲和**：`Mcp-Session-Id` 必须回到同一个本地 stdio 进程 | 由第 1 项的库一并解决 |
| 3 | **鉴权**（远端 agent 怎么带凭据） | 你要写 |
| 4 | **多主机路由**（哪个客户端调哪台机器的哪个 server） | **你要写 —— 这就是你要做的东西** |

GitHub 全库搜下来，**第 4 项没有现成的 MCP 实现**（`Cognipeer/console` 27★ 那种是 LLM 网关，不是 MCP）。所以你的活是：把 1、2 交给现成库，自己只写 3、4 和那层薄薄的中转路由。

---

## 1. 可直接复用的现成件

| 组件 | 项目 | ★ / 许可 | 在你架构里的位置 |
|---|---|---|---|
| **stdio → HTTP 服务端** | `supercorp-ai/supergateway` | 2 959★ MIT | **本机侧主力**。一个进程跑多个 MCP server，直接吃 Claude Desktop 的 `mcpServers.json` |
| stdio → HTTP 服务端（TS） | `punkpeye/mcp-proxy` | 294★ MIT | 同时服务 2025 与 2026-07-28 两代协议 |
| stdio ↔ HTTP 桥 | `sparfenyuk/mcp-proxy` | 2 824★ MIT | 备选实现 |
| **远端客户端桥** | `punkpeye/mcp-remote` | 1 668★ MIT | **远端 agent 侧**。让只支持 stdio 的客户端接远程 HTTP MCP，带 `--header "Authorization: Bearer …"` |
| DSH 出站隧道栈 | `988hj7tczd-oss/dsh-mcp-tunnel` | MIT | 现成的「本地 MCP → 公网」DSH 插件（mcp-proxy + cloudflared Quick Tunnel） |
| 反向（DSH → MCP） | `Nigheart/dsh-mcp-relay` | MIT | 把 DSH **本身**暴露成 MCP server（让外部 agent 操作 DSH 会话），与你的方向相反 |
| DSH 客户端 | `@deepseek-ai/dsh-mcp-client` | 原生内置 | DSH 侧接入点，`transport: streamable-http` + `url` + `headers` |
| MCP 客户端桥（DSH 插件） | `Chhlafiu4312/dsh-mcp-bridge` | MIT | 零依赖，把 stdio/HTTP MCP server 的工具注册进 DSH |

### supergateway 值得单独说

```bash
npx -y supergateway --config servers.json
```

- `--config` 直接读 **Claude Desktop 那种 `mcpServers` 文件**，不用自己写配置格式
- 每个 server 可单独配 `outputTransport`（`streamableHttp` / `sse` / `ws`）、`apiKey`、`toolPrefix`、`tools` 白名单、`env`、`cwd`
- 顶层 `apiKey` / `apiKeyFile` 一把锁全部 server
- `--healthz` + `--healthCheck server`（会真起一个 server 做 initialize+ping）
- `--toolPrefix` 解决多 server 同名工具冲突
- `--printConfig` / `--checkConfig`（输出时自动把 token、env 值、敏感 URL 参数打码）
- 支持 `${VAR}` / `${VAR:-default}` / `${env:VAR}` 环境变量插值

---

## 2. 三种拓扑

### A. 每机一条隧道（最省事，先能跑）

```
远端 Agent ──HTTPS──► cloudflared 边缘 ──隧道──► 本机 supergateway ──stdio──► 本地 MCP server
```

- ✅ 零自建，10 分钟跑通
- ❌ 域名随机、客户端配置因机器而异、没有统一吊销和审计

### B. 中心中转 + 出站本机 Agent（你想要的形态）⭐

```
远端 Agent ──HTTPS──► 【中转】──WSS──► 本机轻量 Agent ──HTTP──► supergateway ──stdio──► 本地 MCP server
        (装一条 MCP 配置)   (唯一公网资产)   (出站，不需公网 IP)      (本机回环)
```

- ✅ 统一域名 `gw.example.com/m/<token>/<server>`，客户端配置一致
- ✅ token 可吊销、可过期、可审计、可按 server 授权
- ✅ 本机无需公网 IP、无需端口映射
- ❌ 你要写：中转路由层 + 本机 Agent

### C. 纯静态暴露（每机一个固定子域）

中转只做 TLS + 路径路由到各机的 cloudflared/Tailscale 隧道。介于 A、B 之间，写得最少但统一域名要靠通配 DNS + 证书。

---

## 3. 中转应该做到多轻？（关键设计决策）

**建议：中转只做 L7 HTTP 路由 + Bearer 鉴权，不解析 JSON-RPC。**

理由：

1. 中转**不理解 MCP 协议** → 未来协议升版不用改它
2. 中转可以就是 nginx + 一层鉴权中间件 → 极轻、极稳、易审计
3. JSON-RPC 语义交给 `supergateway` / `mcp-proxy` 在**本机侧**处理，那里才知道本地进程状态

**唯一例外**：如果要做「一个远端客户端同时连多个本地 server 并合并工具列表」，那就需要一个理解 MCP 的聚合层 —— 那时用 `supergateway` 的 "Combining servers on one URL" 能力，而不是自己写。

### 中转要有的最小能力

| 能力 | 说明 |
|---|---|
| 路径路由 | `/m/:token/:server` → 该 token 所属 host 的该 server |
| 鉴权 | `Authorization: Bearer <token>`；token → host 映射查库 |
| 租户隔离 | 一个 token 只能看到自己授权的 server 列表 |
| WebSocket 帧转发 | 本机 Agent 的出站长连接（控制面） |
| 健康与状态 | 哪些 host 在线、哪些 server 活着 |
| 吊销 | token 立即失效；host 断开即不可达 |

---

## 4. 本机轻量 Agent 要做的事

1. **出站注册**：连上中继，登记 `hostId` + 本地 server 清单 + 端点
2. **心跳与保活**：host 掉线自动摘除
3. **拉起本地 MCP server**：用 `supergateway --config`（多 server 一条命令）
4. **出站隧道**：把本地 `http://127.0.0.1:<port>` 桥到中转（参考 `dsh-mcp-tunnel` 的 `cloudflared` 与 `mcp-proxy` 共用 network namespace 的做法）
5. **凭证不出门**：本地 MCP server 需要的 API Key / 环境变量**只在本机**

---

## 5. 客户端怎么接（各 Agent 的配置）

### DSH（原生支持 streamable-http）

DSH 的 MCP 客户端在 Cordis 作用域里配置，**Web 与 Desktop profile 各自独立**：

```yaml
- id: mcp-remote
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: myremote          # 工具命名空间，[A-Za-z0-9_-]{1,32}
    transport: streamable-http
    url: https://gw.example.com/m/<token>/git
    headers:
      Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'
    toolCallTimeoutMs: 60000
    reconnect:
      enabled: true
      initialDelayMs: 500
      maxDelayMs: 30000
```

> 还可以开 `expandTemplates: true`，用 `${credential:REF}` 引用凭据提供方；解析后的值在失败诊断和工具结果里会被替换成 `[redacted]`。
> 工具名带 `serverName` 前缀 → `mcp__myremote__<tool>`，天然避免多 server 同名工具冲突。

### Claude Code（原生支持 http transport）

```bash
claude mcp add --transport http myremote https://gw.example.com/m/<token>/git \
  --header "Authorization: Bearer $MCP_TOKEN"
```

### 只支持 stdio 的客户端（Cursor / Windsurf / 老 Claude Desktop 等）

用 `mcp-remote` 做客户端侧桥：

```json
{
  "mcpServers": {
    "myremote": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://gw.example.com/m/<token>/git",
        "--header", "Authorization: Bearer ${MCP_TOKEN}"
      ],
      "env": { "MCP_TOKEN": "sk-..." }
    }
  }
}
```

---

## 6. 真正的坑（按踩中概率排序）

1. **stdio MCP server 是有状态的** —— filesystem server 依赖本地路径、git server 依赖仓库、很多 server 从环境变量读 token。
   → **MCP server 必须跑在用户本机**，中转只能转发调用，不能代替。这决定了整个拓扑。

2. **多 server 同名工具冲突** —— 两个 server 都有 `search` 就撞了。
   → supergateway 用 `toolPrefix`；DSH 用 `serverName` 做命名空间；远端裸客户端要注意。

3. **`Mcp-Session-Id` 会话亲和** —— 客户端拿到的 session id 必须回到**同一个**本地进程。
   → 若中转做了多实例负载均衡，必须做会话亲和（粘性哈希），否则 `tools/call` 会打到另一个进程报 `unknown_session`。

4. **鉴权放在哪一层** —— MCP 规范要求远程 server 支持 OAuth，但实际工程里 **Bearer token 够用**（`mcp-proxy`、`mcp-remote`、`supergateway` 都原生支持 `--apiKey` / `--header`）。别一上来就上 OAuth。

5. **本地进程生命周期** —— 远端断连后，本地 stdio 进程留不留？
   → supergateway 的 SSE 模式是「每个 SSE 连接起一个 server 进程」，连接断了进程就死；Streamable HTTP 有 stateful/stateless 两种。**用 stateless 更省资源**，但要注意每次调用是否需要重新 initialize。

6. **stdio 的 stderr 会污染协议流** —— MCP 协议走 stdout，server 的日志必须走 stderr。转发层别把 stderr 混进 JSON 流。

7. **大结果与超时** —— 文件读取类工具返回几十 MB 是常事。`toolCallTimeoutMs` 默认 60s，超时后远端看到的是「调用失败」而不是「结果过大」，要在网关侧区分。

8. **审计与吊销粒度** —— token 粒度太粗（一个 token 通吃所有 server）和太细（每个 server 一个 token）都不好用。建议 **token → server 白名单**。

9. **`dsh plugin --profile desktop add` 会被拒** —— desktop profile 由 Electron 应用独占管理，CLI 直接拒绝。desktop profile 的插件只能从 Desktop 的插件管理器装。

---

## 7. 建议的落地顺序

**第 0 步（半天）**：不写任何代码，先用现成件验证链路

```bash
# 本机
npx -y supergateway --config ~/.config/mcp-relay/servers.json --port 8000 --apiKey "$TOKEN" --outputTransport streamableHttp
cloudflared tunnel --url http://127.0.0.1:8000     # 拿到 https://xxx.trycloudflare.com

# 远端
claude mcp add --transport http test https://xxx.trycloudflare.com/mcp --header "Authorization: Bearer $TOKEN"
```

能调通 → 说明协议侧没有隐藏坑，再谈自研。

**第 1 步（1~2 天）**：写「本机 Agent + 中转路由」的最小版
- 中转：Bearer 鉴权 + 路径路由 + 一个静态 token 表（先不用 DB）
- 本机 Agent：出站 WSS 注册 + 心跳 + 复用 supergateway
- 目标：`https://gw/m/<token>/<server>` 可用，token 可吊销

**第 2 步**：再决定要不要做微信小程序 / 原生客户端
- 客户端侧完全不用改协议 —— 远端 agent 装的还是同一条 MCP 配置
- 小程序/原生只是**另一个 MCP client**，只要它能发 `POST /mcp`（或用 `mcp-remote` 桥）就能用

**第 3 步（可选）**：多租户、审计、per-server 授权、配额

---

## 8. 与你上一轮「DSH 远控」方案的关系

两者**技术栈完全不同，但可以互补**：

| | DSH 远控（上一轮） | 本轮 MCP 转发 |
|---|---|---|
| 转发的是什么 | DSH 会话/工具调用的**语义** | MCP 的 **JSON-RPC 报文** |
| 加密 | Noise IK / 密封记录，**载荷级 E2EE** | 中转看到明文 JSON（或你在中转加 TLS 就够） |
| 客户端 | 微信小程序 / 原生 App | **任意 MCP client**（Claude Code、Cursor、Codex、DSH…） |

> ⚠️ 安全模型差异要跟用户讲清楚：MCP 转发模式下，**中转是可信边界内的**，它能看到你的工具名、参数和返回内容（除非本地 MCP server 自己返回加密内容）。DSH 远控那条路是端到端加密的，中继连密文都看不到。做产品时要按需选，别混为一谈。

如果同一个中转要同时承载这两类流量，注意：DSH 远控那套用的是 `@dsh-remote/protocol`（自研帧格式 + 密封记录），MCP 用的是标准 JSON-RPC，**协议不通用**，中转要么做协议无关的纯帧转发，要么开两条独立通道。

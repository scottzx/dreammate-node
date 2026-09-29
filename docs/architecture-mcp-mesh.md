# DreamMate MCP Capability Mesh 架构设计

> **定位**：基于 `dreammate-node` 与 `@1agents/dreammate-network` 的大模型能力服务网格（Service Mesh for LLMs）。  
> **核心目标**：实现“一次配置、全网自发现、防上下文溢出、天然零信任”的分布式 Agent 工具消费体系。

---

## 1. 背景与核心痛点

### 1.1 传统点对点 MCP 的局限
在传统的大模型工具调用（MCP）实践中，开发者面临两大核心瓶颈：
1. **开发与配置繁琐**：每一个业务工具（如播客抓取、微信读取、日程查询）都需要引入 `@modelcontextprotocol/sdk` 并手写 JSON-RPC 样板代码，且必须逐一手改宿主（Claude Desktop / Cursor / Antigravity 等）的客户端配置文件并重启。
2. **上下文暴涨（Context Bloat）与注意力涣散**：若将所有工具的入参 Schema（JSON Schema）在启动时全量注入模型上下文，50 个工具就会吃掉 10,000~30,000 tokens，严重拉长首字延迟（TTFT），并导致模型在海量工具中挑选错误。
3. **分布式孤岛**：多设备（MacBook、NAS、GPU 服务器、树莓派等）并存的局域网/Tailnet 环境中，传统 MCP 无法做到跨节点自发现与透明寻址。

---

## 2. 核心设计：两阶段渐进式发现（Progressive Discovery）

为杜绝上下文膨胀，大模型侧只暴露一组**稳定的小集合元工具（Meta-Tools）**，保持极低且相对恒定的 Token 占用。原始三条 `list → inspect → invoke` 仍是发现/调用主路径；额外工具覆盖节点发现、技能包分发与部分生命周期，**不会**在启动时把各业务方法的入参 Schema 全量注入上下文。

```
┌─────────────────────────────────────────────────────────────┐
│                       大模型 / Agent                         │
└──────────────────────────────┬──────────────────────────────┘
                               │ 0. 可选：先看有哪些节点
                               ▼
            dreammate_list_nodes({ keyword?, online_only? })
                               │ 1. 查找服务列表（极低 Token 开销）
                               ▼
            dreammate_list_services({ keyword })
            （dreammate_list_capabilities 为向后兼容别名）
                               │ 2. 命中目标服务 (例如: "tingqi-adapter")
                               ▼
              dreammate_inspect({ service_id, method })
                               │ 3. 按需展开具体入参 Schema、技能指南
                               ▼
       dreammate_invoke({ service_id, method, params })
                               │ 4. 经 :36908 路由，executeService 执行
                               ▼
┌─────────────────────────────────────────────────────────────┐
│   dreammate-node (:36908) -> 本机回环 HTTP / 本地 CLI        │
└─────────────────────────────────────────────────────────────┘
```

### 2.1 元工具（Meta-Tools）契约

实现见 `src/mcp.ts` 的 `MCP_TOOLS`。

#### ① `dreammate_list_nodes`
- **功能**：发现局域网 / Tailnet 中所有已知设备节点（本机与远端 Linux、Windows、Mac、移动设备等），展示在线状态、操作系统与地址。
- **参数**：`online_only`（默认 true）、`keyword`（模糊匹配节点名称或操作系统）。

#### ② `dreammate_list_services`
- **功能**：轻量检索本机、指定节点或全网（`node: "all"`）已报备的服务列表与概要（两阶段发现第 1 步）。不包含入参 Schema。
- **现阶段策略**：不做重量级的向量 Embedding 检索，采用**确定性的关键词与标签过滤**（匹配 `id`、`name`、`kind`、`capabilities`、方法名、技能名）。
- **别名**：`dreammate_list_capabilities` 为向后兼容别名，推荐使用本工具。
- **返回结构**（精简卡片，含方法名与技能名，不含入参 Schema）：
  ```json
  {
    "scope": "local",
    "total_matched": 1,
    "services": [
      {
        "node": "scott-mac",
        "service_id": "tingqi-adapter",
        "name": "播客与音频转写服务",
        "methods": ["podcast.latest", "podcast.transcribe"],
        "capabilities": ["podcast.latest", "podcast.transcribe"],
        "execution": "http",
        "liveness": "up"
      }
    ]
  }
  ```

#### ③ `dreammate_inspect`
- **功能**：按需查看指定服务的方法契约、入参 JSON Schema，或配套业务 SOP / 技能指南（两阶段发现第 2 步）。
- **参数**：`service_id`（必填）；可选 `method`（`capability` 为别名）、`skill`、`node`。
- **返回结构**（仅将该方法的入参 Schema 送入当前上下文）：
  ```json
  {
    "service_id": "tingqi-adapter",
    "method": "podcast.transcribe",
    "defined": true,
    "details": {
      "description": "将本地音频文件转写为字幕文本",
      "parameters": {
        "file_path": { "type": "string", "description": "音频绝对路径", "required": true }
      }
    }
  }
  ```

#### ④ `dreammate_invoke`
- **功能**：通用分布式执行器（Universal RPC Dispatcher）。
- **参数**：`{ service_id, method, params, node? }`（`capability` 为 `method` 的向后兼容别名）。
- **职责**：
  - 请求目标节点 `:36908` 的 `POST /services/:id/invoke`；
  - 本机 `executeService` 按 `execution: cli|http|hybrid` 转发：纯 CLI 走本地命令，纯 HTTP 走回环 `http://127.0.0.1:<port>/invoke`，hybrid 优先 CLI、命令不存在再降级 HTTP；
  - 格式化结果返回给大模型。
  - **天然优势**：无需依赖 MCP 客户端的动态工具热重载（`list_changed`），在所有 MCP 客户端中 100% 稳定兼容。

#### ⑤ `dreammate_download_skill`
- **功能**：从目标节点下载指定服务的配套技能包（含 `SKILL.md`、脚本与静态资源），可安装到本地技能目录，或以内存预览。
- **HTTP**：`GET /services/:id/skills/:name/archive`。

#### ⑥ `dreammate_manage_service`
- **功能**：部分服务的生命周期：`start`（按需拉起常驻 HTTP）、`stop`（优雅停止以释放显存/内存）、`status`。
- **HTTP**：`POST /services/:id/start|stop`。仅对声明了 `lifecycle.can_spawn` / `can_shutdown` 的服务有效。

---

## 3. 服务自声明自治协议（Self-Declaration）

业务工具完全无需理解 MCP 协议，仅需向本机 `dreammate-node:36908`（基于 MVP 受信任主机假设，详见 [安全架构规范](./security-architecture.md)）进行自声明报备：

```ts
import { reportAndHoldRegistration } from '@1agents/dreammate-node/client';

await reportAndHoldRegistration({
  id: 'podcast-tool',
  name: '本地播客抓取与转写服务',
  port: 7780,
  capabilities: ['podcast.latest', 'podcast.transcribe'],
  // 扩展声明：方法与参数定义
  methods: {
    'podcast.latest': {
      description: '获取指定播客的最新单集列表',
      parameters: {
        feed_url: { type: 'string', description: '播客 RSS 地址', required: true },
        limit: { type: 'number', description: '获取条数，默认 5', required: false },
      },
    },
    'podcast.transcribe': {
      description: '将本地音频转写为文本',
      parameters: {
        file_path: { type: 'string', description: '音频绝对路径', required: true },
      },
    },
  },
  metadata: {
    enabled: true, // 服务端状态开关
  },
});
```

### 3.1 服务启停与生命周期控制
- **状态软开关**：服务可通过更新报备将 `metadata.enabled` 设为 `false`，进入维护状态，检索端自动标记不可用。
- **主动注销**：服务下线时调用 `DELETE /services/:id`，立即从节点清单移除。
- **被动探活剔除**：若服务异常退出，节点通过 `/health` 探活，连续 5 次失败自动从注册表剔除（EVICT）。
- **按需启停**：声明了 `lifecycle.start_command` / `stop_endpoint` 的服务，可通过 `POST /services/:id/start|stop` 或 MCP `dreammate_manage_service` 部分启停（例如释放 GPU 显存）。这不替代服务自己的进程管理。

---

## 4. 实施阶段规划

> 2026-09-29 个人 Demo 范围决定：上游 API Key 采用执行节点本地配置，DreamMate 层连接管理与细粒度授权暂缓，不作为 Plane MCP 接入前置条件。当前方案与后续需求见 [个人 Demo：凭证配置与授权范围](demo-auth-scope.md)。

### 阶段 1（当前 MVP 核心路线）
- [x] **扩展注册表协议**：在 `Registration` 结构中支持 `methods`（包含入参定义）。
- [x] **实现 MCP 网关子命令**：`dreammate-node mcp`。原始三条 `list → inspect → invoke` 仍是发现/调用主路径（`dreammate_list_services`，`list_capabilities` 为别名）。
- [x] **节点发现**：`dreammate_list_nodes` / `GET /nodes`。
- [x] **技能包分发**：`dreammate_download_skill` / `GET /services/:id/skills/:name/archive`。
- [x] **部分生命周期**：`dreammate_manage_service` / `POST /services/:id/start|stop`。
- [x] **服务开关与过滤**：支持 `metadata.enabled` 过滤与关键词列表匹配。

### 阶段 2（零信任双向通信与能力租约 - 详见 [安全架构规范](./security-architecture.md)）
- [ ] **UDS 进程鉴真与 Node 权威签发 Capability Lease**：
  - 通道升级至 Unix Domain Socket，以 `0600` 文件权限阻断本地其他用户进程；
  - Node 通过内核元数据（`SO_PEERCRED` / `LOCAL_PEERCRED`）核验服务进程身份（PID、路径指纹）；
  - 权威签发反转：Node 验证身份后向 Service 签发短期 `Capability Lease`（包含 `service_id`、`allowed_methods`、`audience`、`expires_at`）；
  - 代理调用时双向验签，支持 TTL 自动过期、静默轮换与瞬时吊销（Revocation）。
- [ ] **跨节点 Tailnet 凭证分发与权限委托**：
  - Node A 调用 Node B 时，通过 Tailscale WireGuard 权威节点互信验证；
  - Node B 作为本地信任根，代表远程调用方在物理机本地派生并注入局部 Capability Lease 调用下游服务。

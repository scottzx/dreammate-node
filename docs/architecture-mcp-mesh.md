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

为杜绝上下文膨胀，大模型侧**永远只暴露 3 个固定元工具（Meta-Tools）**，保持极低且恒定的 Token 占用（约 300 tokens）：

```
┌─────────────────────────────────────────────────────────────┐
│                       大模型 / Agent                         │
└──────────────────────────────┬──────────────────────────────┘
                               │ 1. 查找能力列表（极低 Token 开销）
                               ▼
            dreammate_list_capabilities({ keyword })
                               │ 2. 命中目标服务 (例如: "tingqi-adapter")
                               ▼
              dreammate_inspect({ service_id, capability })
                               │ 3. 按需展开具体入参 Schema、使用示例
                               ▼
       dreammate_invoke({ service_id, capability, params })
                               │ 4. 路由并执行
                               ▼
┌─────────────────────────────────────────────────────────────┐
│        dreammate-node (:36908) -> 本地服务 / 远程网络服务    │
└─────────────────────────────────────────────────────────────┘
```

### 2.1 元工具（Meta-Tools）契约

#### ① `dreammate_list_capabilities`
- **功能**：轻量级检索当前节点及网络中已在线的能力列表。
- **现阶段策略**：不做重量级的向量 Embedding 检索，采用**确定性的关键词与标签过滤**（匹配 `id`、`name`、`capabilities`、`kind`）。
- **返回结构**（精简卡片，不包含入参 Schema）：
  ```json
  [
    {
      "node": "scott-mac",
      "service_id": "tingqi-adapter",
      "name": "播客与音频转写服务",
      "capabilities": ["podcast.latest", "podcast.transcribe"],
      "status": "up"
    }
  ]
  ```

#### ② `dreammate_inspect`
- **功能**：当大模型确定需要使用某项能力时，按需请求该能力的具体定义。
- **返回结构**（仅将该方法的入参 Schema 送入当前上下文）：
  ```json
  {
    "service_id": "tingqi-adapter",
    "capability": "podcast.transcribe",
    "description": "将本地音频文件转写为字幕文本",
    "parameters": {
      "file_path": { "type": "string", "description": "音频绝对路径", "required": true }
    }
  }
  ```

#### ③ `dreammate_invoke`
- **功能**：通用分布式执行器（Universal RPC Dispatcher）。
- **参数**：`{ service_id, capability, params, node_id? }`
- **职责**：
  - 查询内部注册表，找到目标服务的 `access.base_url`（如 `http://127.0.0.1:7780` 或对端 Tailscale 地址）；
  - 发送 HTTP 请求并等待响应；
  - 格式化结果返回给大模型。
  - **天然优势**：无需依赖 MCP 客户端的动态工具热重载（`list_changed`），在所有 MCP 客户端中 100% 稳定兼容。

---

## 3. 服务自声明自治协议（Self-Declaration）

业务工具完全无需理解 MCP 协议，仅需向本机 `dreammate-node:36908`（受信任回环链路）进行自声明报备：

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

---

## 4. 实施阶段规划

### 阶段 1（当前 MVP 核心路线）
- [ ] **扩展注册表协议**：在 `Registration` 结构中支持 `methods`（包含入参定义）。
- [ ] **实现 MCP 网关子命令**：`dreammate-node mcp`，提供 `dreammate_list_capabilities`、`dreammate_inspect`、`dreammate_invoke` 三个元工具。
- [ ] **服务开关与过滤**：支持 `metadata.enabled` 过滤与关键词列表匹配。

### 阶段 2（零信任能力凭证与跨节点调用 - 见 GitHub Issue）
- [ ] **报备换凭证（Ephemeral Capability Token）**：
  - 服务启动时生成一次性随机 Token，报备给 `dreammate-node`，保存在节点内存中。
  - 服务业务端口强制校验 `Authorization: Bearer <token>`，杜绝局域网内非授权直探端口绕过。
  - `dreammate-node` 代理调用时自动注入该 Token。
- [ ] **跨节点 Tailnet 凭证分发与权限委托**：
  - Node A 调用 Node B 时，通过 Tailscale 节点互信验证，Node B 代为注入本地 Secret 调用底层服务。

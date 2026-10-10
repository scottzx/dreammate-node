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

大模型侧只暴露一组**稳定的小集合元工具（Meta-Tools）**，业务主路径为 `search → inspect(method) → invoke`。搜索直接定位具体方法，服务列表用于显式浏览。搜索和目录统一施加分页及文本预算，无方法的 inspect 不再全量展开 Schema，堵住使用时重新灌入整个工具目录的路径。额外工具覆盖节点发现、技能包分发与部分生命周期。

```
┌─────────────────────────────────────────────────────────────┐
│                       大模型 / Agent                         │
└──────────────────────────────┬──────────────────────────────┘
                               │ 0. 可选：先看有哪些节点
                               ▼
            dreammate_list_nodes({ keyword?, online_only? })
                               │ 1. 用非空任务描述查找少量方法摘要
                               ▼
            dreammate_search_tools({ query })
            （默认跨已知节点，最多 15 条相关方法摘要）
            （list_services 仅在需要浏览目录时调用）
                               │ 2. 选中节点、服务和具体方法
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

#### ② `dreammate_search_tools` / `dreammate_list_services`
- **业务搜索**：`dreammate_search_tools` 要求 1–2000 字符的非空 `query`，默认跨已知节点搜索；`node: "localhost"` 限定入口网关所在设备，也支持指定节点、`service_id` 与 `kind` 过滤，`include_disabled` 可显式包含禁用服务。返回 `results` 数组，每项是具体方法的 `node`、`service_id`、`method`、简短 `description` 和 `score`，不包含参数 Schema。
- **搜索策略**：从本次节点扫描的全部服务中自动发现就绪的 embedding provider，`service_id` 与 `kind` 只限制业务工具候选；无可见就绪 provider 或模型失败时使用有界词法检索。完整方法名精确匹配优先，其余先按语义相似度排序，再在相关候选中平衡工具集，词法候选作为补充。没有匹配时改写查询或扩大候选，禁止自动全量展开。
- **工具集覆盖**：按 `service_id` 分组，跨节点相同 ID 视为同一工具集。在相关性门槛内选择最多 3 个优先代表组，保留排名首位与前 3 种不同动作后补充组代表，对同组数量和同方法跨节点重复施加折扣。强相关的第 4 个集仍可进入结果。尽量让结果覆盖 2–3 个相关工具集；不强求节点数量，没有足够相关组时不凑数，显式 `service_id` 过滤保持单集。
- **分数语义**：`score` 只是排序信号，不代表可执行性或置信概率；当前没有拒识分类器。候选说明与任务相符才 inspect，否则继续改写查询，不能因有返回结果就调用。
- **目录浏览**：`dreammate_list_services` 返回服务摘要；`dreammate_list_capabilities` 为其向后兼容别名。没有关键词也必须分页，不能一次返回整个目录。
- **摘要预算**：搜索、服务列表、inspect 接受 `limit`（1–20）、`offset`（0–1000000）、`max_chars`（1000–12000）。搜索默认最多 15 条、12000 字符；目录默认 10 条、6000 字符。预算按摘要 JSON 字符计，并非 token 估计；无效参数在任何节点或模型请求前拒绝。相关候选不足或预算不够时可返回更少条数，后续通过返回的续页信息显式查询。指定方法的完整 Schema 与单独请求的技能指南按需读取，不使用目录分页。
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
- **功能**：省略 `method` 时只返回分页的方法摘要目录，不返回整个服务的完整契约。指定 `method` 才读取该方法的参数 Schema；配套业务 SOP / 技能指南通过 `skill` 单独读取。
- **参数**：`service_id`（必填）；可选 `method`（`capability` 为别名）、`skill`、`node`，以及统一分页和文本预算参数。
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

### 2.2 可选的本地语义检索

模型节点运行 `node scripts/local-embeddings/serve.mjs --model qwen3 --port 8766 --agent http://127.0.0.1:36908`。启动器只在本机 loopback 启动已准备权重的适配器，完成真实编码并确认就绪后，向本机 agent 报备 `metadata.embedding_provider`：`protocol: "dreammate.embedding.v1"`、模型别名、精确 revision、向量维度、编码配置指纹、`ready: true` 与优先级。登记每 15 秒刷新，正常退出注销；适配器本身禁止主动外联。模型权重和依赖需事先显式下载，搜索不会自动安装或部署模型。

客户端复用本次节点扫描发现的 provider，按 priority 高优先、健康状态和稳定 URL 选择。`node` 限定工具与模型来源的节点范围；默认跨已知节点，显式 `localhost` 只看入口设备。`service_id` 仅筛业务方法，同一节点范围内其他服务报备的模型仍可使用。找不到可见且就绪的 provider 时，返回 `search.semantic_status: "no_provider"` 与原有分页/文本预算下的词法结果；扫描部分失败或只使用导入目录时，保留范围不完整证据，不能断言全网没有模型。

调用端直连所选节点的 `POST /services/<id>/embed`，该网关只转发到本机注册端口的 `127.0.0.1:<port>/embed`，不会从入口网关中继到另一节点，也不采用 metadata 中的任意 URL。代理仅接受已启用的本机 HTTP provider、固定编码字段与已登记模型，拒绝重定向。模型服务可以只驻留一台设备，其他节点无需加载权重；调用端仍需能直连目标网关。

自动发现路径下，一次语义尝试固定 provider、revision、维度与编码配置，query 和全部 document 向量必须一致。最多尝试两个 provider，共享默认 5000 ms 的总语义预算；切换备用时重新计算该 provider 所需的查询和文档，不混用向量空间。客户端缓存按 provider 地址、模型版本、维度、编码配置和卡片内容隔离；经校验的批次可保留进度。目录扫描不计入该语义预算。

显式 `DREAMMATE_EMBEDDING_URL` 优先于自动发现，固定地址失败时直接词法降级；`DREAMMATE_EMBEDDING_MODEL` 可限制自动发现的模型别名。地址只接受 localhost 或私网 IP 的 `/embed`、固定服务编码路由，拒绝公网与重定向。没有全局 leader、中心搜索 API、自动模型部署或持久化全网向量索引；目录扫描与结果排序仍在 CLI/MCP 进程完成。

当前本地向量模型只保留 Qwen3-Embedding-0.6B，Gemma 已移除。索引单位是具体方法，参数 Schema 留到 inspect 阶段；比较召回、调用成功率、上下文字符/token 与延迟，不能只看模型排行榜。安装、离线运行和评测说明见 [本地 embedding 方案](local-embeddings.md)。

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
- [x] **实现 MCP 网关子命令**：`dreammate-node mcp`。业务主路径为 `search → inspect(method) → invoke`；服务目录保留分页浏览与兼容别名。
- [x] **有界工具发现**：方法级搜索、统一分页/文本预算、无方法 inspect 只返回摘要，模型失败仍有界降级。
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

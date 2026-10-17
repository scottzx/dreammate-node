# 自定义 MCP 接入

网关既向智能体提供固定的发现和调用元工具，也可作为 MCP 客户端连接外部数据源。一个配置项对应一个 `mcp-<名称>` 服务，上游工具映射为 `mcp-<名称>.<工具名>`，因此不同来源的同名工具可以同时存在。搜索、分页目录、单方法 Schema 和跨节点调用沿用现有路径。

添加 MCP 后自动完成原生工具遍历、可识别的子动作目录同步、名称转换、搜索索引和调用路由。标准 MCP 的 `tools/list` 适用于所有来源；隐藏在元工具背后的动作，需要来源声明下述通用目录协议，或由内置适配器识别。目前内置 Activepieces 适配器，无需单独配置 GitHub 等应用。

## 接入与共享

接入配置决定网关怎样连接上游 MCP，`sharing` 独立决定接入后的能力可被哪些设备使用。无需把 Agent 注册为 client，也不通过 client/server 角色决定共享权限。同一网关对 Agent 提供 MCP server，同时作为 client 连接上游 MCP。

| `sharing` | 范围 |
| --- | --- |
| `network` | 网格网络内可发现、查看契约和调用；默认值，兼容已有配置 |
| `local` | 仅网关所在设备可发现、查看契约和调用；其他设备即使知道服务 ID，也不能通过网关直接调用 |

`local` 以网关所在设备为边界，同一设备上的多个 Agent 仍可共用该来源。它与下文客户端私有来源的进程隔离不同；客户端私有来源不会因 `sharing` 而发布到网络。

同样的共享范围也可用于普通服务：在向本机 `POST /services` 报备时声明顶层
`sharing: "local" | "network"`，省略仍按 `network`。按需 embedding 模型可用
`dreammate-node embedding config --sharing local` 设置，具体配置见 [本地模型共享范围](local-embeddings.md#通过配置限制共享范围)。
`mcp share` 管理 MCP 来源；普通服务通过其自身报备更新范围，二者共用网关的发现与调用限制。

上游的网络可达性与共享范围是两件事：上游只监听 localhost，网关仍可代理它并按 `network` 共享；上游使用远程 HTTP，也可以设置为 `local`。共享策略只约束经 DreamMate 访问的能力，不改变上游 MCP 本身的访问规则。

目前仍采用可信网络共用模式，`network` 不提供独立的调用方身份验证。上游 API Key/OAuth 凭据由使用该来源的调用方共用，`local`/`network` 不提供按 Agent、服务方法或用户的细粒度鉴权。

## 配置与添加

### 客户端私有配置（独立 Token 身份）

需要按客户端 Token 区分权限的来源，放在 DreamMate 客户端配置中。默认读取
`~/.1agents/mcp-client.json`，也可用 `--mcp-config PATH` 或 `DREAMMATE_MCP_CONFIG`
指定；优先级为参数、环境变量、默认文件。配置沿用下方 `mcpServers` 格式，文件必须属于
当前用户且权限为 600。仅默认文件不存在时允许无私有来源；显式路径错误、配置损坏或连接失败
会终止加载。`--mcp-config none` 可显式禁用。客户端配置中的环境变量由当前进程读取。

```sh
dreammate-node cli search --node @client --query 'ERP 客户与项目'
dreammate-node cli inspect --node @client --service mcp-erp-site --method erp_count
dreammate-node cli invoke --node @client --service mcp-erp-site --method erp_count --params '{"doctype":"Project"}'
dreammate-node cli invoke --mcp-config /private/erp-admin.json --node @client --service mcp-erp-site --method erp_whoami
dreammate-node mcp --mcp-config /private/erp-readonly.json
```

CLI 和 Stdio MCP 进程在内存中独立连接这些来源，不启动 HTTP 服务、不调用 `mcp add`、
不写入共享注册表。默认搜索与 `node: all` 同时发现网络服务与私有工具，显式指定其他节点时
只查该节点。私有工具返回 `node: "@client"`，后续 inspect/invoke 必须使用该节点标记；
缺少配置或服务时不会回退至网络上的同名服务。来源、Token 身份只能在进程启动时选择，
工具参数不能切换。配置改变后重启该客户端进程。

CLI 完成、超时或取消时关闭私有连接和子进程；Stdio MCP 在标准输入关闭或收到退出信号时
同样清理，包括上游初始化尚未完成的情况。超时与取消不会重试已发送的调用。

例如 ERP 管理员和只读分别使用不同的客户端文件，日常默认只读，管理员执行时显式指定文件。
Token 可由私有 stdio 适配器的 `--token-file` 读取，或通过远程来源的私有 `headers` 提供；
上游 ERP MCP 仍校验每个请求。持有同一操作系统账号和两个 Token 文件的人可以选择两种身份；
只分发只读 Token 的客户端无法通过选择服务名取得管理员身份。

下面的 `mcp add/list/remove/refresh/share` 管理的是**节点来源**，可分别设为 `local` 或 `network`，其固定凭据由允许访问该来源的调用者共用，
不适合保存需要区分调用者权限的管理员 Token。

支持粘贴 JSON 字符串、JSON 文件或标准输入，接受标准 `mcpServers` 包装、具名配置表，以及通过 `--name` 命名的单个源配置。添加操作由已启动的本机 node 执行，不会在 CLI 退出时关闭连接。

```json
{
  "mcpServers": {
    "local-tools": {
      "command": "/absolute/path/to/node",
      "sharing": "local",
      "args": ["/absolute/path/to/server.mjs"],
      "cwd": "/absolute/path/to/project",
      "env": { "API_KEY": "${LOCAL_API_KEY}" }
    },
    "remote-tools": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${REMOTE_MCP_TOKEN}" }
    },
    "legacy-tools": {
      "type": "sse",
      "url": "https://example.com/sse"
    }
  }
}
```

本地源默认使用 stdio，直接执行 `command` 和 `args`，不通过 shell。远程源默认使用 Streamable HTTP（`type: "http"`），也接受 `streamable-http` 别名。旧服务可显式设置 `type: "sse"`；HTTP 初始化返回 404/405 时可尝试 SSE。工具调用失败不会切换协议或自动重试，避免重复执行写操作。

```bash
dreammate-node mcp add --file ./mcp.json
dreammate-node mcp add --config '{"url":"https://example.com/mcp"}' --name remote-tools
dreammate-node mcp list
dreammate-node mcp share mcp-remote-tools --scope local
dreammate-node mcp share mcp-remote-tools --scope network
dreammate-node mcp refresh mcp-remote-tools
dreammate-node mcp remove mcp-remote-tools
```

管理命令支持 `--agent http://127.0.0.1:36908` 和 `--timeout-ms`。添加同名源会拒绝覆盖；更新时先移除旧源，再添加新配置。新增批次配置会先整体校验，再分别连接；暂时连接失败的合法源会保留配置，后续自动重连，CLI 返回失败状态并显示各源状态。

省略 `sharing` 时按 `network` 接入，stdio、HTTP 和 SSE 均可独立设置共享范围。`mcp share ID --scope local|network` 必须显式提供范围，只允许在本机管理入口执行；它会保存共享设置并更新目录与访问范围，不重新连接上游。连接参数发生变化时仍需移除并重新添加来源。

`${ENV_VAR}` 从运行 node 网关的进程环境读取，不从调用 CLI 的终端环境读取；`$$` 表示字面的 `$`。通过 launchd/systemd 运行时，需将变量配置到该服务环境并重启；也可以在受保护的配置文件中填写值。启动命令和 URL、环境变量、HTTP 头不出现在公共注册表或源状态中。源配置文件包含连接所需凭证，以权限 600 原子写入 `~/.1agents/mcp-sources.json`，不会作为业务服务 metadata 广播。

远程源还支持可选的 `oauth` 配置：`tokenUrl`、`clientId`、`refreshToken` 为必填，可提供 `accessToken`、`expiresAt`（Unix 毫秒）、`clientSecret` 和 `scope`。初始 access token 不存在、有效期未知或接近到期时，网关通过标准 refresh_token grant 获取新 token；同一源的并发请求共用一次刷新。服务端返回轮换后的 refresh token 时，同步写回受保护的配置文件。凭证刷新不重放失败的工具调用；已经发送的操作返回认证错误后，调用方仍需核实结果。首次浏览器授权需在外部完成。

## 发现与调用

```bash
dreammate-node cli search --agent http://127.0.0.1:36908 --node localhost --service mcp-remote-tools --query '查找工具'
dreammate-node cli inspect --agent http://127.0.0.1:36908 --service mcp-remote-tools --method mcp-remote-tools.upstream_tool
dreammate-node cli invoke --agent http://127.0.0.1:36908 --service mcp-remote-tools --method mcp-remote-tools.upstream_tool --params '{}'
```

发现会遍历上游 `tools/list` 分页，并保留工具描述、输入 Schema、输出 Schema 与 annotations。上游发出工具列表变化通知后自动刷新，也可以手动 `mcp refresh`。连接断开时服务标记不可用，并按间隔尝试恢复；移除源会关闭连接和本地子进程，并从搜索目录删除工具。网关正常退出会清理 MCP 连接。

默认连接和发现截止时间为 12 秒，工具调用为 120 秒。管理 CLI 的 `--timeout-ms` 控制该次管理命令的等待时间，不改变业务工具的运行时限。

子动作目录在接入、重连、上游工具列表变化和手动刷新时同步，每 5 分钟自动检查一次；目录错误会在后续心跳重试。目录只存动作摘要，`inspect(method)` 或第一次调用才请求该动作的完整 Schema，并缓存至目录下次刷新。同一动作的并发 Schema 请求合并；调用前校验参数。目录错误独立于 MCP 连接状态，原生工具仍可使用，错误子目录不会作为可用动作返回。

目录发现与单动作 Schema 获取默认最多等待 30 秒。每个来源最多 10,000 个原生工具、5,000 个子动作；每种分页最多 100 页。Schema 限制 512,000 字符，目录响应限制 2,000,000 字符。重连和目录刷新会作废旧 Schema，已经失效的路由不会继续执行。

上游 `content`、`structuredContent`、`isError` 和 `_meta` 保留至调用方。已完成的业务错误仍使用 HTTP 200 并保留 `isError: true`；传输失败使用 502，超时使用 504，两者均标记 `retryable: false`。annotations 是上游提示信息，不作为权限规则。

## 名称转换与匹配

原生工具的完整名称为 `mcp-<来源>.<工具名>`。简单 ASCII 名称保持原样；空格、斜杠、中文、点号、过长名称和保留后缀会转换成安全片段，并附加原名的稳定摘要。原始名称保留为 `original_name`，用于搜索和匹配。

子动作名称为 `mcp-<来源>.actions.<工具集>.<动作>__dm_<稳定摘要>`。摘要由适配器、工具集和原始动作名共同生成，工具顺序、连接数量和其他工具集的变化不会改变已有名称。完整名称仅含 ASCII 字母、数字、下划线、连字符和命名空间点号，长度不超过 128。

指定 `service_id` 后，inspect 和 invoke 接受完整名称、唯一的原始名，以及 `工具集.动作名` 等别名。例如 `github.list_my_repositories` 会自动匹配它的完整名称。多个工具集都包含 `list` 时，传入 `list` 返回 HTTP 409 和 `candidates`，调用方选择候选完整名称后重试；不会任意选一个执行。大小写不同的名称也可能形成歧义，精确完整名称优先。

## 通用子动作目录协议

普通 MCP 来源已通过 `tools/list` 直接公开所有动作时，无需扩展。如果来源采用“列目录 → 查 Schema → 执行动作”的元工具模式，可在任一原生工具的 `_meta` 中声明以下协议，三个工具必须同时存在于标准目录：

```json
{
  "name": "catalog_list",
  "inputSchema": { "type": "object" },
  "_meta": {
    "dreammate/catalog": {
      "version": 1,
      "list": "catalog_list",
      "describe": "catalog_describe",
      "invoke": "catalog_invoke"
    }
  }
}
```

| 工具 | 输入 | 结构化返回 |
| --- | --- | --- |
| list | `{ "limit": 100, "cursor": "可选游标" }` | `{ "tools": [{ "group": "github", "name": "list", "description": "..." }], "nextCursor": "可选游标" }` |
| describe | `{ "group": "github", "name": "list" }` | `{ "inputSchema": { "type": "object", "properties": {} }, "outputSchema": {}, "annotations": {} }`，后两项可选 |
| invoke | `{ "group": "github", "name": "list", "params": {} }` | 原样保留有效的 MCP CallToolResult |

目录和 Schema 优先读取 `structuredContent`，也接受文本中独立的 JSON 对象。每个适配器内 `(group, name)` 必须唯一；重复身份、重复游标、截断目录或超限响应会报告目录错误。网关不会根据未知元工具的名字猜测内部调用协议。

## HTTP 管理接口

这些接口仅接受回环来源。添加配置可能启动本机程序，应在配置所属节点上执行；其他节点通过已有 `/services/:id/invoke` 使用工具。

| 请求 | 用途 |
| --- | --- |
| `GET /mcp/sources` | 查看脱敏后的来源和连接状态 |
| `POST /mcp/sources` | 添加 `{ "config": "粘贴的 JSON 字符串或对象", "name": "单源名称，可选" }`，也可直接提交 `mcpServers` 对象 |
| `POST /mcp/sources/:id/refresh` | 重新连接并刷新工具目录 |
| `PATCH /mcp/sources/:id/sharing` | 设置 `{ "sharing": "local" }` 或 `{ "sharing": "network" }`，不重连上游 |
| `DELETE /mcp/sources/:id` | 移除持久化配置并关闭连接 |

读取单动作契约使用 `GET /services/:id/methods/:method`，沿用普通服务读取入口的跨节点访问方式。路径中的方法名需要 URL 编码；返回 `{ "method": "匹配后的完整名称", "details": { ... } }`。服务摘要目录不会附带所有子动作 Schema。

## Activepieces

Activepieces 的原生 MCP 是远程 Streamable HTTP 服务。以实际部署的 Settings → MCP Server 提供的地址为准。需要 OAuth 的部署应先完成授权，再将已有 refresh grant 配置给 node；仅粘贴短期 access token 会在到期后失效。通用来源管理不执行浏览器首次登录。

```json
{
  "mcpServers": {
    "activepieces": {
      "url": "https://activepieces.example.com/mcp",
      "headers": {
        "x-forwarded-host": "activepieces.example.com",
        "x-forwarded-proto": "https"
      },
      "oauth": {
        "tokenUrl": "https://activepieces.example.com/token",
        "clientId": "${ACTIVEPIECES_MCP_CLIENT_ID}",
        "refreshToken": "${ACTIVEPIECES_MCP_REFRESH_TOKEN}"
      }
    }
  }
}
```

添加后，使用 `mcp-activepieces` 搜索并 inspect 实际发现的方法。验证可选择 `ap_list_flows` 或 `ap_list_tables` 等读取工具，按返回的 Schema 填参数；不以发现工具目录作为所有操作均已验证的证明。

适配器自动调用 `ap_list_connections` 获取 ACTIVE 连接，按应用分组，通过 `ap_research_pieces` 枚举其内部动作。没有有效连接的应用不自动展开。搜索 `GitHub repositories` 可直接找到 `list_my_repositories` 等子动作；选中时才调用 `ap_get_piece_props`，将属性、枚举、必填项和动态子字段转换为 JSON Schema。

子动作统一使用 `{ "input": { ...动作参数 }, "connection_id": "可选连接 externalId" }`。一个应用只有一个有效连接时自动绑定；存在多个连接时 Schema 要求明确选择 `connection_id`。执行时还原原始 `pieceName`、`actionName` 和连接 ID，转给 `ap_run_action`。动态字段的解析提示保存在 `x-activepieces-note`；依赖尚未提供的输入或特定连接才能解析的选项，仍可使用原生 `ap_get_piece_props` / `ap_resolve_property_options` 补充查询。

```bash
dreammate-node cli search --agent http://127.0.0.1:36908 --node my-wsl-node --service mcp-activepieces --query 'GitHub repositories'
dreammate-node cli inspect --agent http://127.0.0.1:36908 --node my-wsl-node --service mcp-activepieces --method github.list_my_repositories
dreammate-node cli invoke --agent http://127.0.0.1:36908 --node my-wsl-node --service mcp-activepieces --method github.list_my_repositories --params '{"input":{"visibility":"all"}}'
```

Activepieces 官方连接说明：[MCP Server](https://www.activepieces.com/docs/mcp/overview)。

2026-10-16 实际验证：从 WSL 的原生 Activepieces `/mcp` 接入本机 Mac 网关，使用已有 OAuth grant 自动刷新过期 token，自动发现 42 个工具。现有搜索返回 `mcp-activepieces.ap_list_flows`，inspect 保留其输入 Schema 与 annotations，经网关调用返回 `structuredContent: { "flows": [], "count": 0 }`。仅调用读取方法；工具发现不代表所有写入操作都已验证。

随后按部署要求将该来源迁移至 WSL 网关，Mac 不保存 Activepieces 来源。客户端继续通过 DreamMate 跨节点调用 WSL 的 `mcp-activepieces`。

同日升级子目录发现后，WSL 首次自动发现 42 个原生工具和 94 个子动作，其中 GitHub 93 个、mcp-client 1 个，合计 136 项。使用新启动的 stdio MCP 客户端从 Mac 搜索 `list_my_repositories`，返回 `mcp-activepieces.actions.github.list_my_repositories__dm_d011c963900e4ca1`；以 `github.list_my_repositories` inspect 自动匹配该完整名称，并按需返回 visibility / affiliation / sort 参数。通过 `github.get_authenticated_user` 读取到 `scottzx`；通过 `github.custom_api_call` GET `/user/repos` 成功读取 5 个仓库；未知连接 ID 在上游执行前返回 400。Activepieces 出网访问 GitHub 仍偶发 `fetch failed`，本次只读复测成功，网关不自动重放业务请求。

随后连接自动恢复时目录更新为 42 个原生工具和 97 个子动作，另一已连接应用的 3 个动作也被自动纳入；GitHub 仍为 93 个，原有完整名称保持一致。数量随已连接应用及上游目录变化。

已经运行的 stdio MCP 客户端可能仍持有升级前的工具处理器；更新网关或在其他会话新建连接不会替换当前会话的实例。新版 stdio 服务支持通过 `SIGHUP` 重载处理器，保留 MCP 连接及正在执行的请求，不重放调用。该信号只适用于已经支持重载的新版进程；升级前的旧实例应通过所属客户端重新加载。

指定 method 的 inspect 会检查单方法契约是否包含完整 parameters；若上游错误地只返回摘要，会明确返回错误及 `schema_loaded: false`，不会把它当成已加载的 Schema。完整契约返回顶层与 details 中的 `schema_loaded: true`；不指定 method 的目录仍仅返回摘要。

2026-10-17 修复驻留旧客户端后，直接通过当前会话的 DreamMate MCP 元工具完成验证：刷新目录清空 Schema 缓存后，search 与目录 inspect 均保持缓存为 0；选中 `list_my_repositories` 后只缓存该动作，返回 visibility / affiliation / sort 的完整属性与枚举。再 inspect `github.custom_api_call`，返回嵌套 url、method 枚举、headers、queryParams、body 等参数及必填项，缓存增加到 2。简称与完整名称匹配一致，目录仍不包含任何子动作参数；对同一个驻留实例执行处理器重载后再次 inspect 成功，MCP 连接保持不变。

本地回归测试同时覆盖 stdio、HTTP、SSE、分页、工具变化通知、完整 MCP 结果、配置重启恢复、自动重连、超时不重放和子进程清理：

```bash
npm run typecheck
npm test
npm run build
```

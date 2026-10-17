---
name: dreammate-node
description: 在普通桌面或服务器终端使用 DreamMate，发现本机或其他设备的服务、查看契约并调用能力，也支持按需管理本机网关、服务报备与 MCP 接入。用户提到 DreamMate、dreammate-node、跨设备服务调用、本机节点安装或网关故障时使用；仅远程调用时优先一次性 CLI。
compatibility: 需要 Node.js 22.5 或更新版本和 dreammate-node；自动常驻安装支持 macOS launchd 与 Linux systemd user。
metadata:
  profile: terminal
---

# DreamMate：普通终端

根据用户目的选择方式：调用已有网关用一次性 CLI；把本机能力提供给网络或持续接收报备时才需要本机 node-agent。npm 安装包和 skill 不等于安装或启动常驻服务。

## 调用已有服务

检查 `node --version` 与 `dreammate-node cli --help`。使用用户给定的 `--agent URL` 或已有 `DREAMMATE_AGENT_URL`。
已明确使用运行中的本机网关时可传 `--agent http://127.0.0.1:36908`；远程调用则用可达的远程地址，缺地址时询问，不盲目启动本机服务。

```sh
dreammate-node cli nodes --agent http://GATEWAY:36908
dreammate-node cli search --agent http://GATEWAY:36908 --query '用户要完成的任务'
dreammate-node cli inspect --agent http://GATEWAY:36908 --node DEVICE --service SERVICE --method METHOD
dreammate-node cli invoke --agent http://GATEWAY:36908 --node DEVICE --service SERVICE --method METHOD --params '{"key":"value"}'
```

地址、节点、服务、方法、参数都是占位示例。业务任务首选 `search → inspect --method → invoke`：从真实搜索结果选择具体节点、服务与方法，再读取该方法 Schema，按契约调用；不要杜撰业务方法。
`search` 必须带非空 `--query`，默认跨已知节点搜索；`--node localhost` 只搜入口网关所在设备，也可指定节点、`--service ID` 或 `--kind TYPE` 缩小范围。服务目录浏览才使用 `cli services`；无 `--method` 的 inspect 只返回摘要目录，不展开全部 Schema。
`score` 仅是排序信号，不代表可执行性或置信概率，当前没有拒识分类器。先确认候选说明匹配任务再 inspect；候选不符时继续改写查询，不能因为有结果就调用。
搜索、services 与 inspect 支持 `--limit 1..20`、`--offset 0..1000000`、`--max-chars 1000..12000`；搜索默认最多 15 条、12000 字符，目录默认 10 条、6000 字符，均按摘要 JSON 字符预算。搜索在相关性与预算允许时尽量覆盖 2–3 个工具集，跨节点相同 `service_id` 算同一集，不强求节点数或用不相关候选凑数；显式服务过滤只搜该集，候选不足时结果可更少。候选不合适时改写查询或显式翻页，不自动遍历全网全部服务与契约。
大参数用 `--params -` 读取 stdin JSON 对象。读取服务附带的业务指南用 `cli inspect --service SERVICE --skill SKILL`，并传入同一入口与目标节点。
`cli tools` 展示工具协议 Schema，CLI 的参数拼写以 `cli --help` 为准，例如 `service_id` 对应 `--service`。

`search` 省略 `--node` 时扫描已知节点；其他命令省略时、或显式使用 `--node localhost` 时，目标是入口网关所在设备。指定名称时优先用导入的地址簿，未导入时从入口 `/nodes` 解析目标，再从当前终端直连该节点；入口不是跨节点中继。

## 发现和读取业务技能

用户需要专门流程或项目里的操作指南时，用 `cli search-skills --query '任务描述'`（带真实入口，默认跨节点）。
选择匹配的候选后，用结果中的 `node`、`id`、`revision`：

```sh
dreammate-node cli read-skill --agent http://GATEWAY:36908 --node DEVICE --skill SKILL_ID --revision HASH
dreammate-node cli read-skill --agent http://GATEWAY:36908 --node DEVICE --skill SKILL_ID --revision HASH --resource references/stages.md
```

占位参数替换为真实搜索结果；相对资源路径去除 Markdown 的 `#锚点`。先读完整主指南，再按需读取资源。
HTTP 409 / `SKILL_REVISION_CHANGED` 表示源文件已变更，重新搜索并读新版本，不混用新旧脚本与指南。
来源目录原件不复制到客户端，读取不会安装或执行脚本。根据指南确认实际执行设备、依赖和文件可达性。
MCP 对应 `dreammate_search_skills` → `dreammate_read_skill`。目录返回 `partial` / `unsupported` 时说明覆盖限制。
用户要求发布项目技能时，在原件所在设备用 `dreammate-node skills add --name NAME --project /absolute/project`；
项目扫描 `.agents/skills`、`.claude/skills`、`skills`。共享或单个技能包用 `--dir /absolute/skills`。
只登记用户要发布的来源；可用 `skills list`、`skills refresh [ID]`、`skills remove ID` 管理，remove 保留原件。
来源管理仅接受 loopback，不能从客户端向远端网关登记本地目录。
这些命令由 Node 转发给独立运行、已报备的 Skill Manager；Node 不包含目录扫描器，也不依赖该 npm 包。
HTTP 503 表示没有已接入的技能服务，先在原件所在设备确认 Manager 进程和报备，不能解释为没有技能。
用户已要求本机提供技能管理时，检查 `dreammate-skills status`；未安装包时安装 `@1agents/skill-manager`，
调试可运行 `dreammate-skills serve --agent http://127.0.0.1:36908`，长期托管用 `dreammate-skills install`。
Manager 默认只监听 `127.0.0.1:36909`，每 15 秒向本机 Node 重报备；Node 重启不要求重建来源。
`dreammate-skills list|read|sources` 可不经网关直接使用本地来源；`serve --no-register` 不报备。
常见用户/系统共享目录会由 Manager 自动登记；Manager 在后台通过已安装的 `1session` 补充历史会话工作目录中的项目技能，
也可用 `dreammate-node skills discover` 立即更新，`--no-projects` 只发现共享目录。
reader 不可用时共享发现仍可用，诊断不表示没有项目技能；历史工作目录不等于当前存在或包含所有命令 PWD。
链接技能按真实目录去重，删除自动来源后会排除其目录，避免下次刷新重新添加。
通过 `/services/:id/invoke` 直接调用来源管理也受通用 `metadata.local_only_methods` 回环限制。
历史 `service.skills` 附带 SOP 与技能管理服务的目录是两种接口，继续按服务实际契约读取。

## 给 iSH 导出设备地址簿

用户要把稳定设备清单带到 iSH 时，在能访问节点网关的终端执行：

```sh
dreammate-node cli nodes export --agent http://127.0.0.1:36908 --default-node scott-pc-1 --file nodes.json
```

`--default-node` 使用真实名称/ID，省略时默认来源网关自身节点。导出读取网关的 `/nodes`，包括离线设备，不导出在线状态、凭据或源端 `is_self` 标志。不需要在导出过程中登录或安装新的 Tailscale。
把文件交给用户在 iSH 运行 `dreammate-node cli nodes import --file nodes.json`。导入后
`cli nodes` 离线读缓存，`cli services --node scott-pc-1` 主动直连地址簿里的网关，省略 `--node` 使用默认节点。
设备清单变化时再导出、导入；没有后台刷新或有效期。客户端可用 `--live --agent URL` 暂时忽略缓存，不覆盖文件。
默认缓存为 `~/.1agents/nodes.json`，只用于寻址，不证明在线或网络隧道已建立。

## 本机网关与服务报备

用户需要本机提供能力时，先执行 `dreammate-node status` 看现状，避免重复启动。

- macOS 或具备 systemd user 的 Linux：用户已要求安装常驻网关时运行 `dreammate-node install`，再运行 `dreammate-node status` 验证。无需 sudo。
- 仅本机可访问的部署可用 `dreammate-node install --host 127.0.0.1`；默认监听 `0.0.0.0:36908`，让远端设备访问时需要合适的网络连通性。
- Linux 没有 systemd user、Windows 或其他环境：不要假定 `install` 可用；调试时可在用户认可的终端会话运行 `dreammate-node --host 127.0.0.1`。需要长期托管则依据实际环境选择，别反复调用不支持的安装器。
- 用户要求卸载本机守护进程时用 `dreammate-node uninstall`。此命令不等于卸载 npm 包或 skill。

服务只能在**网关所在设备**通过 loopback 向 `POST /services` 报备；不要从其他机器向远端 `/services` POST 注册。
开发服务时可从 `@1agents/dreammate-node/client` 导入 `reportAndHoldRegistration`，按真实端口、方法和可达性报备。报备失败不应该让业务服务停止。
声明 `reachability: localhost` 的服务也能由 node-agent 代理调用，但不能直接从远端访问业务端口。

## MCP 与生命周期

节点来源的接入与共享独立：`dreammate-node mcp add --file CONFIG` 添加来源，源 JSON 的
`sharing` 支持 `local` / `network`，省略默认 `network`，旧配置继续网络共用。
在网关所在设备执行 `dreammate-node mcp share MCP_ID --scope local|network` 可单独切换，
即时生效且持久保存，不重连上游；`mcp list` 查看范围。占位 CONFIG/MCP_ID 替换为真实文件与来源 ID。
`local` 仅允许网关回环请求发现、读取契约和调用，同机多个 Agent 可共用；`network` 不区分调用方身份。
`reachability: localhost` 是上游直连限制，与共享策略独立；不要据此认定来源仅供本机使用。

按客户端 Token 区分权限时，使用 DreamMate 的私有 `mcpServers` 配置：默认
`~/.1agents/mcp-client.json`（属于当前用户，权限 600），或在 CLI/MCP 启动参数中
指定 `--mcp-config PATH`；`DREAMMATE_MCP_CONFIG` 次之，`none` 禁用。
`cli search --node @client --query 'ERP 项目'` / MCP `node: "@client"` 仅发现该进程私有来源；
后续 inspect/invoke 使用搜索返回的 `@client`、service_id 和 method。
这类来源不通过 `mcp add` 写入共享节点，不把 Token 放进工具参数。
日常配置只读 Token，管理员需启动时显式选择另一文件；配置变更后重启客户端。
不要将两个角色固定凭据都注册到共享网关，否则调用者可任选管理员来源。

宿主明确需要 MCP 时配置 stdio 命令 `dreammate-node mcp --agent http://GATEWAY:36908`。MCP 进程由宿主按会话管理；该命令是客户端适配层，不会自动启动目标 HTTP 网关。不要把 MCP 协议日志写入 stdout。

业务任务使用 `dreammate_search_tools`（必填 `query`）→ `dreammate_inspect`（指定 `method`）→ `dreammate_invoke`。`dreammate_list_nodes` 用于节点发现，`dreammate_list_services` 用于显式目录浏览。元工具的 `service_id` 和 `method` 来自真实搜索与契约；上下文中只展开当前需要的 Schema。
搜索自动从本次扫描到的全部服务发现就绪模型，其他设备无需安装权重或逐个配置模型 URL。发现范围随 `--node`，显式 `localhost` 只看入口设备；`--service ID`／`service_id` 只筛业务方法，不排除同一节点范围内其他服务提供的模型。没有可见就绪 provider 时返回 `search.semantic_status=no_provider` 和有界词法结果；结合 `partial`、`discovery`、`scans` 说明范围，不能据此称全网没安装模型。模型请求失败同样有界降级。
多个 provider 按 priority 高优先、健康状态、稳定 URL 选择，最多尝试两个，共享默认 5 秒语义预算。自动发现路径下，一次尝试的 query 与 documents 固定 provider、revision、维度和编码配置；切备用不能混用向量。显式 `DREAMMATE_EMBEDDING_URL` 优先并固定地址，失败不自动切到其他模型；`DREAMMATE_EMBEDDING_MODEL` 可限定别名。
模型服务可以只驻留一台内网设备。客户端直连选中节点的 `POST /services/<id>/embed`，该网关仅代理本机已注册的 loopback HTTP 端口，不跨节点中继。用户要求部署语义检索时，先显式准备离线权重，再在模型设备的仓库目录运行 `node scripts/local-embeddings/serve.mjs --model qwen3 --port 8766 --agent http://127.0.0.1:36908`；启动器只在真实就绪后登记模型信息，每 15 秒刷新，正常退出注销。普通调用不自动下载或部署模型；没有全局 leader 或中心搜索 API。

用户明确要求 Mac 按需使用已有本地模型时，用 `dreammate-node embedding install --python /absolute/venv/bin/python --manifest /absolute/manifest.json --device mps --batch-size 8 --idle-timeout-ms 300000 --priority 100 --sharing local`；先核验环境与权重存在，不自动下载。
`embedding status` 只探活，不加载模型；`embedding uninstall` 停止启动器及其模型子进程。
优先级用 `embedding config` 查看，`embedding config --priority N` 持久修改，无需重填安装路径。
按需启动器每 15 秒读取 `~/.1agents/embedding-config.json`（`{"version":1,"priority":100,"sharing":"local"}`），配置分别覆盖 `--priority` / `--sharing` 启动兜底值；`--config` 可指定其他文件。
用 `embedding config --sharing local|network` 单独修改范围；`local` 仅本机 Agent 共用，应使用 loopback 网关入口，其他设备目录隐藏且直接调用返回 404。本机仍可回退到网络共享的远端模型。
旧配置未提供 sharing 时保持启动参数，启动参数默认 network；只改 priority 不丢已有 sharing。local 报备先验证网关支持通用服务共享范围，旧网关不支持时拒绝发布并报告注册错误。
修改不重启模型或 MCP，也不重置空闲计时；运行中配置无效保留最近有效值并通过 `health.config.last_error` 报告。
轻量启动器常驻，首次实际编码才加载 Qwen，最后一个请求结束后空闲 5 分钟退出 Python；健康检查与服务报备不会保活。
按需 worker 只把文档文本哈希及向量写入 `~/.1agents/cache/embeddings/`，下次按模型版本、维度和编码配置校验恢复，不保存描述原文或查询。
按需服务的 `loaded`/`loading`/`worker_pid` 表示真实模型状态，`embedding_provider.ready` 仅表示启动器可接单。
广告优先级 100 高于普通远端的 0，默认全网搜索保留远端回退；优先级只在共享范围内生效。
不固定 `DREAMMATE_EMBEDDING_URL`，已有 MCP 可自动发现。独立 CLI 不继承 MCP 专属超时变量，验证时显式设置 `DREAMMATE_EMBEDDING_TIMEOUT_MS=30000` 并给整命令 `--timeout-ms 60000`。

服务生命周期通过 `cli manage --service SERVICE --action status|start|stop` 或 `dreammate_manage_service`；传入正确的入口和节点。只在用户已要求时启停服务。写入、发布、删除等业务方法同样以用户当前授权为限。

## 结果与故障诊断

CLI stdout 是 MCP 结果 JSON。读 `structuredContent` 或 `content` 文本块，保留其他内容块和 `isError`。
退出码 `0` 成功、`1` 网络/HTTP/MCP 业务失败、`2` 参数错误（stdout 错误结果，同时 stderr 诊断 JSON）。HTTP 200 不保证业务成功。

- 查看 `services --node all` 的 `partial`、`discovery`、`scans`，将部分失败和“所有节点扫描成功但无匹配”区分开。
- Tailnet 在线不代表 node-agent 可达；`/health` 成功不代表业务服务或所有方法可用；方法 `declared` 只表示契约声明。
- 写调用超时或连接中断不自动重试，先通过只读查询核实是否已经生效。
- 单次 CLI 默认截止时间 30 秒、invoke 为 150 秒，可用 `--timeout-ms N` 调整；`COMMAND_TIMEOUT` 表示结果未知。服务扫描每个节点最多 3 秒。空 stdout 不是“没有服务”的有效结果。
- 排障先分清运行时缺失、参数不合法、入口不可达、目标不可达、服务不存在和业务错误，再处理对应层。

回复实际访问的设备、服务、方法及结果。对未执行的步骤和未验证的部署状态明确说明，不把安装成功当成运行成功。

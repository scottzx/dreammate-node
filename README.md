# @1agents/dreammate-node

> DreamMate Network 的**本机 node agent**：让设备和软件向智能体公开自己的能力，并提供统一的发现与调用入口。
> 服务端固定监听 **36908**；`cli` 模式按需执行，不监听端口。运行时依赖 L0 协议包与 MCP SDK。

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
      ┌───────────┼──────────────────────┐  localhost 报备
 session-reader :7777   skill-manager :36909   task-service :xxxx
```

这把 pull 探测的成本从「N 个节点 × M 个端口」降到「N × 1」，
并把「找到能力」和「执行调用」收成同一个入口。

## 跑起来

DeepSeek Harness 可以直接安装配套插件，复用本机已运行的 node，未启动时自动拉起：

```bash
pnpm dsh plugin --profile web add @1agents/dsh-dreammate-node
# 重启 DSH 后生效；desktop 使用 --profile desktop
```

当前 DSH 插件依赖 `dreammate-node ~0.7.1`，提供发现、查看契约和调用等 7 个旧工具，默认使用本机 `36908`。
本仓库网关源码新增的搜索与有界发现功能，可通过构建后的 CLI/MCP 使用；插件需要后续升级其依赖才能提供这些功能。
配置与进程生命周期见 [DSH 插件说明](packages/dsh-plugin/README.md)。

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

### npm 安装时自动安装对应 skill

包内包含两份同名 `dreammate-node` skill，安装时只选择一种：

| 环境 | 安装的指引 |
| --- | --- |
| iSH（Linux 内核版本含 `ish` 标记，或存在 `/proc/ish`） | 一次性 CLI 与手动地址缓存，连接其他设备的网关，不启动本机守护进程 |
| 其他终端 | 远程 CLI、本机网关、报备与 MCP；仅远程调用时无需安装本机网关 |

`postinstall` 默认写入 `~/.agents/skills/dreammate-node/SKILL.md`，并同步到**已存在**的
`~/.claude/skills`、`${CODEX_HOME:-~/.codex}/skills`、`~/.gemini/skills` 和
`~/.gemini/config/skills` 下的 `dreammate-node` 目录。它不联网、不启动服务、不修改 MCP
配置。CLI 不运行常驻进程；skill 文件只在 npm 安装或手动补装时写入，设备地址簿则由用户手动导入更新。

默认自动识别不依赖 Alpine、CPU 架构或主机名；普通 Alpine 不会仅因发行版被判为 iSH。
安装记录保存来源、版本和内容校验值：未改动的本包 skill 可自动升级或切换版本，用户自建或
修改过的同名 skill 会保留并提示路径。某个目录安装失败不影响其他目录或 npm 包安装。

```bash
# 安装脚本被禁用、后装智能体、识别不符时，手动补装
dreammate-node skills install
dreammate-node skills install --profile ish
dreammate-node skills install --profile terminal --dir ~/.agents/skills

# 安装时覆盖识别结果或目标目录（--dir/环境变量指向 skills 根目录）
DREAMMATE_SKILL_PROFILE=ish npm i -g @1agents/dreammate-node
DREAMMATE_SKILLS_DIR="$HOME/.agents/skills" npm i -g @1agents/dreammate-node

# 跳过自动 skill 安装，不影响以后手动补装
DREAMMATE_SKIP_SKILLS=1 npm i -g @1agents/dreammate-node
```

`--profile auto|ish|terminal` 优先于 `DREAMMATE_SKILL_PROFILE`；`--dir` 优先于
`DREAMMATE_SKILLS_DIR`，指定目录时只安装该处，目录须为绝对路径或以 `~/` 开头。
源码目录尚未构建时可用 `npm run skills:install -- --profile ish`。安装/同步后由智能体重新
加载技能；已打开的会话是否立即更新取决于宿主。`npm --ignore-scripts` 或安装脚本策略可阻止
自动执行，此时使用手动补装命令。`dreammate-node uninstall` 仅卸载守护进程，保留 skill。

### 让项目里的 Skill 可以被搜索和使用

本机技能目录发现、来源配置、包版本和资源读取由独立包
[`@1agents/skill-manager`](packages/skill-manager/README.md) 负责。它是独立服务，
通过本机 HTTP 向 Node 报备技能管理能力；Node 发现并调用该服务，提供 HTTP/MCP、跨节点发现与检索。
两者位于同一个仓库，npm workspace 仅用于共同开发；生产安装时双方没有彼此的 npm 依赖，
分别维护版本、测试、构建和发布。Skill Manager 核心可脱离网关使用，
接入层使用 Node 的通用报备协议；session-reader 仅是可选的项目目录提供者。

```text
智能体 → Node :36908 → Skill Manager 127.0.0.1:36909 → 技能原目录
                     ↑ 本机服务报备
```

在保存技能原件的设备上安装并运行 Skill Manager：

```sh
npm i -g @1agents/skill-manager
dreammate-skills serve --agent http://127.0.0.1:36908
# macOS / Linux systemd user 长期托管
dreammate-skills install --agent http://127.0.0.1:36908
dreammate-skills status
```

默认只监听 `127.0.0.1:36909`。`serve` 可指定 `--port`、`--config`，
`--no-projects` 关闭项目目录枚举，`--no-register` 仅运行本地服务。
它每 15 秒向 Node 重报备，网关尚未启动或暂时离线不影响本地 CLI、目录读取和服务运行。
Node 重启后由下一轮报备恢复接入；两个守护进程分别安装、检查和卸载。

```sh
npm ci
npm run build                          # 只构建 Node，无需构建 Skill Manager
npm run typecheck && npm test           # 只检查 Node
npm run skill-manager:check            # 独立类型检查、测试和构建
npm run test:packages                   # 在临时目录验证两个发布包的独立安装与消费
npm run check:all                       # 全仓检查及两个服务的集成验收
```

独立版本与发布方式见 [Skill Manager 开发与发布说明](packages/skill-manager/README.md)，双方发布没有先后依赖。
Node 自带指南的 `postinstall` 仍由 Node 维护，它属于该产品的安装流程。
历史 `service.skills` 随服务附带的 SOP 及归档接口保留原有轻量兼容实现；
项目来源发现、来源配置和版本化资源读取只由 Skill Manager 实现。

Skill Manager 启动时自动发现常见共享目录，随后在后台通过可选的 `1session projects --global --json`
补充项目技能，每五分钟刷新候选来源。普通搜索只读取已知来源，不启动会话枚举。
也可立即触发一次自动登记：

```sh
dreammate-node skills discover
dreammate-node skills discover --no-projects
```

共享目录采用已知约定：`~/.agents/skills`、Claude、Codex、Gemini、Antigravity、Grok、DSH
的用户目录及相应环境变量；系统目录包括 `/etc/codex/skills` 和平台对应的 1agents 共享目录。
只登记本机实际存在的目录，现有链接技能按目标真实路径去重，手工登记的来源优先。
session-reader 提供会话记录的工作目录及归并后的项目路径；历史路径需先在本机核验，
并补充最近 Git 根目录，不扫描整个磁盘。它记录的是会话工作目录，不保证包含每次命令切换过的全部 PWD。
没有安装 reader 或枚举失败时，返回独立诊断，共享目录和手工来源仍然可用。
移除自动来源会记录排除项，后续自动刷新不会重新加回；源技能文件始终保留。

在保存技能原件的设备上登记来源。项目模式扫描 `.agents/skills`、`.claude/skills` 和
其他常见智能体约定的技能目录；也可以直接登记一个技能包或技能集合目录。登记操作通过本机 loopback
网关转发到已报备的 Skill Manager，配置保存在 `~/.1agents/skill-sources.json`；服务重启后恢复。
独立 CLI 改写配置后，Skill Manager 会在后续读取时自动加载。并发写入以同目录 `.lock` 文件互斥，冲突返回 409，重试即可；
异常退出遗留锁时，先检查锁记录中的 PID 已停止，再删除该锁文件并重试，正常写入会自动清理锁。

```sh
dreammate-node skills add --name my-project --project /absolute/path/to/project
dreammate-node skills add --name my-skills --dir /absolute/path/to/skills
dreammate-node skills list
dreammate-node skills refresh skills-my-project
dreammate-node skills remove skills-my-project
```

只登记需要发布的目录：目录中的技能指南和未排除的配套文件可经网关读取。
单个技能包需要 `SKILL.md`（优先使用 `SKILL.remote.md`）及非空名称、用途说明。
正文、脚本、参考资料和素材保留在原目录；只持久保存来源配置，不复制到各宿主的技能目录。
每次查询从源端重新扫描，新增、修改和删除自动反映到目录，缺失或无效来源有独立诊断。
包内符号链接、隐藏文件、`node_modules` 和凭据文件不发布，扫描有数量、深度和大小上界。

任意可达的客户端先搜索摘要，再用结果中的 `node`、`id`、`revision` 读取完整指南：

```sh
dreammate-node cli search-skills --agent http://GATEWAY:36908 --query '改进三维场景的灯光和材质'
dreammate-node cli search-skills --agent http://GATEWAY:36908 --query 'CAD 提取' --source skills-my-skills
dreammate-node cli read-skill --agent http://GATEWAY:36908 --node DEVICE --skill SKILL_ID --revision HASH
dreammate-node cli read-skill --agent http://GATEWAY:36908 --node DEVICE --skill SKILL_ID --revision HASH --resource references/stages.md
```

`DEVICE`、`SKILL_ID`、`HASH` 都取真实搜索结果；资源路径不含 Markdown 的 `#锚点`。
搜索默认跨已知节点，支持 `--node localhost`、`--limit`、`--offset`、`--max-chars`。
关键词与可选向量检索复用现有模型发现及预算策略；结果只含技能摘要，不携带正文或脚本。
向量是可重建的检索索引，不承担内容存储；按需模型可持久保存文档向量，原技能仍在来源目录。来源不在线时无法读取其技能。
语义检索默认共享 5 秒模型预算，超时仍返回关键词结果。CPU 模型响应较慢时可显式设置
`DREAMMATE_EMBEDDING_TIMEOUT_MS=15000`，并让 CLI 的 `--timeout-ms` 覆盖节点发现及模型预算。

正文加载后可直接供当前会话使用。返回的资源清单只含相对路径与文件大小，配套资源按需读取，
二进制以 base64 返回。整个发布包的内容哈希作为 `revision`，脚本或文档变化时旧版本读取
返回 HTTP 409 / `SKILL_REVISION_CHANGED`，需要重新搜索并读取。读取不执行脚本；设备软件、
图纸及运行依赖属于实际执行节点，远程读取指南不等于具备在客户端运行脚本的环境。
`revision` 是 Skill Manager 计算的整包版本令牌；业务工件合同里的 `skill.sha256` 若另有计算规范，仍按其规范生成，二者不直接互换。

MCP 对应 `dreammate_search_skills` → `dreammate_read_skill`。HTTP 为分页
`GET /skills?limit=100&offset=0`、`GET /skills/:id?revision=HASH&resource=PATH`；
来源管理为仅 loopback 的 `GET|POST /skills/sources`、`DELETE /skills/sources/:id`、
`POST /skills/sources/discover`、`POST /skills/sources/:id/refresh`（或 `/skills/sources/refresh` 刷新全部）。
这些路径是 Node 的协议适配层，只代理已报备且声明
`metadata.skill_provider.protocol = "dreammate.skills.v1"` 的服务。
没有已报备的技能服务时返回 HTTP 503，表示服务未接入；Node 不会扫描目录或自行启动 Manager。
来源管理方法同时受 Node 通用 `metadata.local_only_methods` 限制，仅允许 loopback 调用。
旧网关未提供目录接口时，
跨节点搜索保留 `unsupported` 扫描诊断与 `partial`，不能把它解释为节点没有技能。

### Mac 按需使用本地向量模型

已准备本地 Python 环境和 Qwen 权重后，可以安装轻量启动器。下面在已准备模型的仓库根目录执行：

```sh
dreammate-node embedding install \
  --python "$PWD/.local/tool-search/venv/bin/python" \
  --manifest "$PWD/.local/tool-search/manifest.json" \
  --device mps --batch-size 8 --idle-timeout-ms 300000 --priority 100 --sharing local
dreammate-node embedding status
dreammate-node embedding uninstall
```

优先级和共享范围可持久配置：`dreammate-node embedding config` 查看，
`dreammate-node embedding config --priority 100 --sharing local` 修改。
默认文件 `~/.1agents/embedding-config.json` 的 `priority` 覆盖安装时的 `--priority` 兜底值，数值越大越优先。
运行中的启动器每 15 秒重读并更新报备，无需重启模型或 MCP；配置变更不延长模型空闲时间。
详细格式和异常处理见 [本地模型配置](docs/local-embeddings.md#通过配置调整优先级)。

macOS launchd 只保持轻量 HTTP 启动器在线；首次实际编码请求才启动 Python 和模型。
最后一个编码请求结束后连续空闲 5 分钟，退出 Python 释放模型内存；下一次检索重新加载。
健康检查和每 15 秒的服务报备不会加载模型或重置空闲时间，多个 CLI/MCP 共用同一个模型进程。
`status` 的 `loaded`、`loading`、`worker_pid`、`idle_timeout_ms` 分别报告模型状态，启动器在线不等于模型已加载。
按需运行器将文档文本哈希及向量保存在 `~/.1agents/cache/embeddings/`，不保存原文或查询。
模型卸载后保留该缓存，下一次启动按模型版本和编码配置校验恢复，避免反复编码整个目录。

默认服务优先级为 100，高于普通远端模型的 0；默认全网搜索会先尝试本机这个服务，失败时仍按现有预算尝试备用。
`sharing: local` 仅允许本机 Agent 发现和使用模型，其他设备不能经网关调用；
本机仍可使用网络共享的远端备用模型。`network` 才会向其他设备开放本模型，旧配置省略时保持网络共享行为。
显式 `--node localhost` 没有远端回退，与模型共享范围分别配置。
不设置固定 `DREAMMATE_EMBEDDING_URL`，已有 MCP 可在后续搜索中自动发现新服务。
首次模型加载和未缓存的目录编码都计入语义预算；当前 Mac 的 MCP 配置为 30 秒，独立 CLI 需显式传
`DREAMMATE_EMBEDDING_TIMEOUT_MS=30000`，并以 `--timeout-ms 60000` 为整条命令预留发现时间。
这一步不下载模型，安装路径、完整生命周期及故障说明见 [本地模型文档](docs/local-embeddings.md)。

## iSH / 无常驻进程的客户端

如果设备主要调用其他机器上的服务，使用 `dreammate-node cli`。每次运行直接请求
一台在线设备的 node-agent，输出 JSON 后退出，不启动本机 HTTP/MCP 服务，不执行
Tailscale CLI，不生成本机身份或服务注册表。可以手动导入一份持久化的设备地址簿；日常调用只读缓存，不后台刷新。桌面和服务器上的常驻模式继续可用。

```bash
# 指向已有的、从 iSH 可以访问的网关；把地址替换成自己的设备地址
export DREAMMATE_AGENT_URL=http://100.x.y.z:36908

dreammate-node cli nodes
dreammate-node cli search --query '读取笔记'           # 默认跨已知节点搜索，最多 15 条方法摘要
dreammate-node cli search --query '读取笔记' --node localhost # 只搜入口网关所在设备
dreammate-node cli services                 # 分页浏览入口网关上的服务摘要
dreammate-node cli services --node all      # 显式浏览：从入口网关取清单，再直连各节点
dreammate-node cli inspect --node my-mac --service notes # 仅分页方法摘要
dreammate-node cli inspect --node my-mac --service notes --method read
dreammate-node cli invoke --node my-mac --service notes --method read --params '{"id":"123"}'

# 较大参数可通过标准输入提供
cat params.json | dreammate-node cli invoke --service notes --method read --params -
dreammate-node cli manage --service notes --action status
dreammate-node cli tools                    # 离线查看工具的参数 Schema
dreammate-node cli --help
```

业务调用首选 `search → inspect --method → invoke`。`search` 必须提供 1–2000 字符的非空 `--query`，
默认跨已知节点搜索，只返回方法摘要；`--node localhost` 限定入口网关所在设备，也支持
指定节点、`--service ID` 和 `--kind TYPE` 过滤。结果在相关性门槛与预算允许时尽量覆盖
2–3 个工具集，按 `service_id` 区分，跨节点相同 ID 仍算一个集；不强求不同节点或用不相关结果凑数。
显式 `--service ID` 时只搜该集。
`search`、`services` 和 `inspect` 支持 `--limit`、`--offset`、`--max-chars`：
每页 1–20 条（搜索默认最多 15，目录默认 10），偏移 0–1000000，摘要 JSON 预算 1000–12000
字符（搜索默认 12000，目录默认 6000，并非 token 估计）。相关候选不足或字符预算不够时返回更少结果。
分页与查询参数在联网前校验；候选不合适时改写查询或显式翻页。
省略 `inspect --method` 只返回方法摘要目录，不再展开整个服务的参数 Schema。
`results` 中的 `score` 是排序信号，不是可执行性或置信概率；当前没有拒识分类器。
先确认候选说明符合任务再 inspect，不符合时继续改写查询，不能因有返回结果就调用。

入口优先级：`--agent` → `DREAMMATE_AGENT_URL` → 已导入地址簿的 `default_node`。
`search` 省略 `--node` 时扫描已知节点；其他命令省略时目标是**入口网关所在设备**。
有缓存时按缓存解析节点名称、ID、DNS 名或 IP；
没有缓存时通过入口网关的 `/nodes` 解析，然后由客户端直连目标节点。入口网关不是跨节点
中继，所以目标网关也必须从 iSH 可达。CLI 不需要本机运行 `tailscaled`，但网络连通性需要自行配置。

### 手动同步设备地址簿

设备列表比较稳定时，在 Mac 或其他能读取节点清单的终端导出，再把 JSON 文件传给 iSH：

```bash
# 在 Mac：读取已运行的本机网关；也可 --agent 指向其他在线网关
# --default-node 可以是节点名或 ID；省略时使用导出来源网关的自身节点
dreammate-node cli nodes export --default-node scott-pc-1 --file nodes.json

# 把 nodes.json 传到 iSH 后：校验并完整替换本地缓存
dreammate-node cli nodes import --file nodes.json
dreammate-node cli nodes                          # 离线查看缓存，不探测
dreammate-node cli services                       # 主动访问默认的 scott-pc-1
dreammate-node cli services --node scott-pc-1
dreammate-node cli services --node all             # 主动查询缓存中的所有地址
```

设备地址簿由用户单独传输，`nodes.json` 不随 npm 包分发；安装包只包含程序与通用 skill。

缓存默认保存在 `~/.1agents/nodes.json`，可用 `--nodes-file PATH` 或
`DREAMMATE_NODES_FILE` 覆盖。缓存**没有自动过期或后台更新**；设备变化时重新导出、导入。
导入验证格式、版本、默认节点和别名唯一性，校验失败保留原缓存，成功时原子替换，不保留已删除设备。
导出省略 `--file` 时直接输出 JSON；导入支持 `--file -` 从 stdin 读取。

文件只存节点 ID、名称、类型和网关地址等路由信息，不保存凭据、源设备 `is_self` 标记或在线状态。
因此从 Mac 导入不会把 Mac 误认成 iSH 本机。缓存节点列表的 `online`、`network_online` 和
`gateway_reachable` 都是 `null`，并显示导出/导入时间；不是实时在线证明。
`services --node all` 的扫描结果是实时的，但 `discovery.status=cached`、`scope=imported_nodes_only`
和 `partial=true` 明确表示只覆盖导入清单，不能保证包含当前整个 tailnet。

需要临时忽略缓存时使用 `--live --agent URL`，例如：

```bash
dreammate-node cli nodes --live --agent http://scott-pc-1:36908
```

`--live` 不覆盖缓存。缓存里缺少某个名称时会报错，避免偷偷依赖拓扑发现；可重新导入或通过
`--node http://设备地址:36908` 显式直连。连接失败不会自动重试写调用。
如果当前只有一个已知可达设备，也可手动准备以下格式后导入（地址须替换为实际可达地址）：

```json
{
  "format": "dreammate.nodes",
  "version": 1,
  "exported_at": "2026-09-29T00:00:00Z",
  "default_node": "pc-1",
  "nodes": [
    { "node_id": "pc-1", "name": "scott-pc-1", "type": "windows", "agent_url": "http://scott-pc-1:36908" }
  ]
}
```

地址簿不建立 VPN 隧道；它利用已有的出站 TCP 连通性，也不会让 iSH 自动变成可被远程访问的节点。

当缓存的 HTTP 地址使用节点自身名称或 `dnsName`，且带有 `ipv4` 时，CLI 会优先使用该 IP，
保留端口与路径，以减少 MagicDNS 抖动的影响。HTTPS、代理域名及显式 `--agent URL` 保持原地址。
`--node all` 仍逐个直连缓存节点，`--agent` 不会把这些请求改为经入口转发。
没有缓存或默认入口时，也可用 `services --node IP` 或 `--node http://HOST:PORT` 直接查询已知设备。

服务扫描每个节点最多等待 3 秒（包括响应体），保留成功节点和失败诊断。
单次 CLI 命令默认最多运行 30 秒，`invoke` 默认 150 秒；可用 `--timeout-ms N` 调整。
达到命令截止时间会输出 `COMMAND_TIMEOUT` 并以退出码 1 退出；写调用可能已经执行，先核对远端结果。
结果写完后 CLI 退出，不再等待残留的 DNS 任务。不要把空 stdout 当作“没有服务”：
应同时检查退出码、stderr、`isError` 以及扫描的 `partial` / `scans`。

```sh
dreammate-node cli services --node all --timeout-ms 15000
dreammate-node cli nodes export --help
dreammate-node cli nodes import --help
```

iSH 使用手动导入和单次调用；无需为此启动本机 daemon 或 tailscaled。
`install` 会拒绝 iSH，并在普通 Linux 写入 unit 前检查 systemd 用户管理器是否可用。
端口拒绝连接只表示当时网关不可达，不能据此断定软件没安装。

stdout 输出完整 MCP 结果 JSON，保留 `content`、`structuredContent`、`isError` 和
元数据；脚本可用 `jq` 提取。退出码 `0` 表示成功，`1` 表示网络、HTTP 或 MCP 业务错误，
`2` 表示参数错误（stdout 返回错误结果，同时在 stderr 写入诊断 JSON）。调用不会自动重试，避免重复执行写操作。
`manage start|stop` 会改变远端服务状态；本机仍不运行常驻进程。

这个模式仍需要 **Node.js >=22.5**，解决的是“不常驻”，不是“无需 Node.js”。
用户已在 iSH 完成 0.8.0 安装、地址簿导入及离线列节点；后续超时修复通过本地故障注入测试，
仍需 iSH 真机复验。它不会让 iSH 成为可随时被远程调用的服务提供节点。

当前源码可用 `npm install && npm run build` 构建，再运行
`node dist/bin/dreammate-node.js cli ...`；若需要命令名，可在源码目录执行 `npm link`。

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

智能体不需要直连各服务端口。本机跑 `dreammate-node mcp` 后，暴露一组**稳定的元工具**：
业务任务首选 `search → inspect(method) → invoke`；服务列表用于显式浏览。
搜索和目录都有条数与文本预算，省略方法的 inspect 只返回摘要目录，堵住自动全量展开的路径。
只有选定具体方法后才展开该方法的参数 Schema；技能指南也按需读取。

| 工具 | 作用 |
|------|------|
| `dreammate_list_nodes` | 发现 Tailnet / 局域网中的设备节点 |
| `dreammate_search_tools` | 必填 `query`，默认跨已知节点检索，最多 15 条方法摘要；相关性允许时尽量覆盖 2–3 个工具集 |
| `dreammate_search_skills` | 必填 `query`，跨节点检索项目或独立目录发布的技能摘要，返回来源和内容版本 |
| `dreammate_read_skill` | 按搜索返回的节点、技能 ID 和 revision 读取完整指南或一个配套资源 |
| `dreammate_list_services` | 分页浏览本机、指定节点或全网（`node: "all"`）已报备服务摘要 |
| `dreammate_list_capabilities` | `list_services` 的向后兼容别名 |
| `dreammate_inspect` | 无 `method` 时分页看摘要目录；指定方法时读取该方法 Schema，或按需读技能指南 |
| `dreammate_invoke` | 经本机或对端 `:36908` 代理执行（HTTP 或本地 CLI） |
| `dreammate_download_skill` | 下载并安装/预览服务配套技能包 |
| `dreammate_manage_service` | 部分服务的生命周期：`start` / `stop` / `status` |

HTTP 侧对应 `GET /nodes`、`POST /services/:id/invoke`、`POST /capabilities/:name/invoke`、`GET /services/:id/skills/:name/archive`、`POST /services/:id/start|stop`；已报备模型另有只读编码路由 `POST /services/:id/embed`。

渐进式发现的设计说明见 [docs/architecture-mcp-mesh.md](docs/architecture-mcp-mesh.md)。

## 添加自定义 MCP

按客户端 Token 隔离权限时，将标准 `mcpServers` 配置保存为权限 600 的
`~/.1agents/mcp-client.json`，由 DreamMate CLI/Stdio MCP 私有加载。通过
`--mcp-config PATH` 选择其他身份；`--node @client` 仅发现和调用当前进程的私有工具。
这些来源不导入共享网关，身份不能通过工具参数切换。配置及 ERP 双 Token 示例见
[客户端私有配置](docs/custom-mcp.md#客户端私有配置独立-token-身份)。

在运行网关的机器上粘贴标准 `mcpServers` JSON，即可连接本地 stdio 或远程 Streamable HTTP / SSE MCP，自动发现工具并接入现有搜索、inspect 和调用：

```bash
dreammate-node mcp add --config '{"mcpServers":{"demo":{"command":"npx","args":["-y","your-mcp-server"]}}}'
dreammate-node mcp add --file ./mcp.json
cat ./mcp.json | dreammate-node mcp add --file -
dreammate-node mcp list
dreammate-node mcp share mcp-demo --scope local
dreammate-node mcp share mcp-demo --scope network
dreammate-node mcp refresh mcp-demo
dreammate-node mcp remove mcp-demo
```

原有 `dreammate-node mcp --agent ...` 仍用于启动面向客户端的 MCP 网关。添加后服务 ID 为 `mcp-<配置名>`，方法为 `mcp-<配置名>.<上游工具名>`。源配置持久化到本机 `~/.1agents/mcp-sources.json`（权限 600），网关重启后自动恢复，连接断开后自动重连。管理入口仅接受本机回环请求。

MCP 接入与共享独立设置：每个来源的 `sharing` 支持 `local` / `network`，省略时默认 `network`，已有配置继续网络内共用。`local` 仅允许通过本网关的回环入口发现、读取契约和调用；远端即使知道服务或方法名也不能访问。可在源 JSON 中设置 `"sharing":"local"`，或用 `mcp share` 单独切换，即时生效并持久保存，无需重连上游。`mcp list` 显示当前共享范围。`reachability: localhost` 只描述上游直连地址，不代表仅本机可调用。

`network` 延续可信网络共用模式，不增加按设备或 Agent 的身份鉴权；允许访问该来源的调用方共用上游凭据。细粒度授权后续再做。

添加时自动遍历标准工具目录；支持子动作目录的来源会进一步展开工具集。Activepieces 自动识别已连接应用，GitHub 等内部动作直接进入搜索，选中后按需加载参数，再通过原有调用入口执行。完整方法名包含来源、工具集和稳定标识；特殊字符自动转换，唯一简称可自动匹配，重名简称会返回候选名称供选择。

远程凭证可通过 `headers` 提供，本地进程可通过 `env` 提供，支持 `${ENV_VAR}` 在网关进程中解析。已有 OAuth 授权可通过 `oauth` 配置 refresh token 自动续期；当前不提供浏览器首次登录。完整配置、HTTP 接口与 Activepieces 示例见 [自定义 MCP 接入](docs/custom-mcp.md)。

搜索自动从本次扫描到的服务中发现已就绪的本地模型，无需为每个 CLI/MCP 客户端填写模型 URL。模型可只运行在一台内网设备上，其他设备无需安装权重。先显式准备离线权重，然后在模型设备的本仓库根目录启动：

```sh
node scripts/local-embeddings/serve.mjs --model qwen3 --port 8766 --agent http://127.0.0.1:36908
```

启动器预热模型，服务只监听 loopback；确认就绪后向本机 agent 登记模型别名、revision、维度、编码配置和优先级，每 15 秒刷新，正常退出时注销。客户端直连选中模型设备的网关，由 `POST /services/<id>/embed` 只代理该设备已登记的本机回环端口；入口网关不承担跨节点中继。多个模型按优先级、健康状态和稳定 URL 排序，最多尝试两个，共享默认 5 秒语义预算；自动发现路径下，单次尝试的查询和文档固定同一模型版本与编码配置。

模型发现范围随 `node`：默认跨已知节点，`node: "localhost"` 只看入口设备；`service_id` 仅筛业务工具，不排除同一节点范围内的模型服务。未发现可见的就绪 provider 时，返回 `search.semantic_status: "no_provider"` 和有界词法结果；存在 `partial` 扫描或导入目录时，不能据此断言全网没有安装模型。模型失败也保留有界词法结果，不展开全量工具。

显式 `DREAMMATE_EMBEDDING_URL` 仍优先并固定使用该地址，失败时不会自动切到发现的模型；`DREAMMATE_EMBEDDING_MODEL` 可限定模型别名。运行时不会下载权重、自动部署模型或选举全局 leader，也不依赖云模型。部署细节与检索评测方法见 [docs/local-embeddings.md](docs/local-embeddings.md)。

## 为什么报备只认回环（与安全模型）

服务报备、MCP 来源配置和技能来源管理入口限制回环（`127.0.0.1`），阻断**外部网络**直接往节点里塞假服务、改动来源或摘除服务。

> ⚠️ **澄清认知误区：回环 ≠ 100% 绝对安全。**  
> `127.0.0.1` 只能防止外部网络机器直连，但**不防同机其他非受信任进程**——任何本地进程都能向 `POST /services` 报备。当前 MVP 基于**受信任主机（Trusted Host）威胁模型**。  
> 长期架构演进中（Phase 2），我们将升级为 **Unix Domain Socket (UDS)**，结合操作系统内核鉴真（`SO_PEERCRED` 提取进程 PID 与可执行文件指纹）并由 Node 权威签发短期 **Capability Lease** 租约，实现真正的双向零信任。  
> 完整设计见 [安全架构规范文档](docs/security-architecture.md)。

## 节点身份

优先取自 tailnet（`tailscale status --json` 的 `Self`，缓存 60s），本机所有
进程读到同一份，不会各自生成 id 把一台机器裂成几个 Node。

```
node_id   example-tailnet-node-id    ← tailscale ID，重启不变
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

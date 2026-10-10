---
name: dreammate-node
description: 在 iOS iSH 中通过 DreamMate 一次性 CLI 导入设备地址簿、发现设备、查询远端服务、查看方法契约并调用能力。用户提到 DreamMate、dreammate-node、查其他设备的服务、跨设备调用或 iSH 不适合常驻进程时使用。只调用已有网关，不在 iSH 安装或启动守护进程。
compatibility: 需要可执行短命令的 Node.js 22.5 或更新版本、dreammate-node CLI，以及可达的远端网关。
metadata:
  profile: ish
---

# DreamMate：iSH 远程客户端

使用 `dreammate-node cli`，每条命令执行完退出。此模式不监听端口、不保存本机身份或服务注册表；允许手动导入设备地址簿并长期保留。
把 iSH 当作调用方；持续接收远程调用需要另一台运行网关的设备。

## 先确认入口

1. 用 `node --version`、`dreammate-node cli --help` 检查运行时与命令。此版本仍依赖 Node.js，不能解决 Node 本身无法运行的问题。不要宣称已经在这台 iSH 上验证，除非实际执行成功。
2. 优先使用用户提供的 `--agent URL` 或已有 `DREAMMATE_AGENT_URL`，其次使用已导入地址簿的默认节点。都没有时询问可用的导出 JSON 或已在线网关地址；不猜 IP、不安装本机 agent。
3. 命令示例中的地址、节点、服务和方法均为占位示例，替换成用户配置及实际发现结果。已知地址可直接通过参数传入，不必修改 shell 配置文件。

```sh
dreammate-node cli nodes --agent http://GATEWAY:36908
dreammate-node cli search --agent http://GATEWAY:36908 --query '用户要完成的任务'
```

后续示例假定已导入带默认节点的地址簿，或已设置 `DREAMMATE_AGENT_URL`；否则每条命令传入 `--agent URL`。
`search` 省略 `--node` 时扫描已知节点；其他命令省略时操作的是入口网关所在设备。`--node localhost` 将搜索或调用限定到入口网关所在设备，不是手机。
`--node DEVICE` 有缓存时直接按缓存解析，没有缓存时通过入口网关的节点清单解析，然后从 iSH **直连目标网关**。
因此入口可达不代表所有设备都可达，入口网关不是跨节点中继。

## 从 Mac 导出，向 iSH 导入

用户无法在 iSH 运行 Tailscale 或获取设备清单时，使用手动地址簿。已有导出文件就直接导入，避免要求 iSH 再做拓扑发现。

```sh
# 这条在 Mac 执行，读取已运行的本机网关；默认节点用真实名称/ID
dreammate-node cli nodes export --default-node scott-pc-1 --file nodes.json
# 把文件传到 iSH 后执行
dreammate-node cli nodes import --file nodes.json
dreammate-node cli nodes
dreammate-node cli services --node scott-pc-1
```

默认节点 `scott-pc-1` 只是示例，按用户设备名称选择。Mac 端可用 `--agent URL` 指定清单来源；省略默认节点时使用来源网关自身节点。不要在 iSH 运行导出流程来修复 Tailscale 不可用。
缓存位于 `~/.1agents/nodes.json`，可用 `--nodes-file PATH` / `DREAMMATE_NODES_FILE` 指定其他文件。
只在用户导入时更新；不自动过期、刷新或探测。重新导入是完整替换，非法文件不会破坏旧缓存。

- `cli nodes` 有缓存时离线列出全部节点，在线状态为 `null`；即使旧文件很久没更新，也不能把设备当作已离线或已在线。
- 默认 `search` 或 `services --node all` 主动访问缓存中的地址，结果包含实时扫描诊断；`discovery.status=cached` 与 `partial=true` 表示清单覆盖范围未经实时发现验证。
- 缓存里没有的名字会报错，可重新导入；用户已给完整地址时可 `--node http://HOST:36908` 直连。
- 只有用户需要实时拓扑时使用 `--live --agent URL` 忽略缓存；它不会更新缓存，也不依赖 iSH 本地 `tailscaled`。
- 地址簿只解决寻址，不提供 VPN 或入站能力；保持使用已有出站网络，不把导入当作隧道已建立。
- 缓存 HTTP 地址匹配节点自身名称或 `dnsName` 且带 `ipv4` 时自动优先走 IP，保留端口与路径。HTTPS、代理地址与显式 `--agent` 不改写。`--agent IP` 不会改写 `--node all` 的其他目标地址。
- 子命令语法可直接查看 `cli nodes export --help` 和 `cli nodes import --help`。没有缓存时也可用 `cli services --node IP` 或完整 URL 直连已知网关。

## 先搜索方法，再查看契约，再调用

```sh
dreammate-node cli search --query '用户要完成的任务'
dreammate-node cli inspect --node DEVICE --service SERVICE --method METHOD
dreammate-node cli invoke --node DEVICE --service SERVICE --method METHOD --params '{"key":"value"}'
```

- 业务任务首选 `search → inspect --method → invoke`。从真实搜索结果选取节点、`service_id` 与具体方法，再通过指定方法的 `inspect` 查看入参，不凭空编造方法名。
- `search` 必须带非空 `--query`，默认跨已知节点搜索；可用 `--node localhost` 限定入口设备，或指定节点、`--service ID`、`--kind TYPE` 过滤。只有显式浏览目录时用 `services`；无 `--method` 的 inspect 只返回方法摘要目录，不展开整个服务 Schema。
- `score` 仅是排序信号，不代表可执行性或置信概率，当前没有拒识分类器。先确认候选说明匹配任务再 inspect；候选不符时继续改写查询，不能因为有结果就调用。
- 搜索、services 与 inspect 支持 `--limit 1..20`、`--offset 0..1000000`、`--max-chars 1000..12000`；搜索默认最多 15 条、12000 字符，目录默认 10 条、6000 字符，均按摘要 JSON 字符预算。相关性与预算允许时尽量覆盖 2–3 个工具集，跨节点相同 `service_id` 算同一集，不强求节点数或用不相关候选凑数；显式服务过滤只搜该集，候选不足时结果可更少。候选不合适时改写查询或显式翻页，不自动遍历全量目录与契约。
- 搜索自动从本次扫描到的服务发现就绪模型，不需要在 iSH 安装权重或逐个填写模型 URL。`--node` 同时限定业务工具与模型来源，`localhost` 指入口设备；`--service ID`／`service_id` 只筛业务工具，不排除同一节点范围内其他服务的模型。没有可见就绪 provider 时为 `search.semantic_status=no_provider`，仍返回有界词法结果；结合 `partial`／扫描范围说明不确定性，不能断言全网没安装模型。
- 多个 provider 按 priority 高优先、健康状态、稳定 URL 选择，最多两个共用默认 5 秒语义预算；自动发现路径的单次尝试固定版本、维度和编码配置，不混用向量。显式 `DREAMMATE_EMBEDDING_URL` 优先并固定地址，失败不自动切模型；`DREAMMATE_EMBEDDING_MODEL` 可限制别名。手机需手动固定远端模型时使用模型设备网关的私网 IP 编码路由，不填手机自身的 `127.0.0.1`。
- 模型可只运行在另一台内网设备，适配器在那台设备预热后向本机 agent 登记，每 15 秒刷新，正常退出注销。iSH 直连选中模型节点的 `/services/<id>/embed`；该网关只代理它本机的 loopback HTTP 模型端口，不通过入口网关跨节点转发。iSH 不运行模型启动器、不为普通调用安装或下载模型；没有全局 leader、中心搜索 API 或自动模型部署。
- 大参数使用 `--params -` 从 stdin 读取 JSON 对象：`cat params.json | dreammate-node cli invoke --service SERVICE --method METHOD --params -`。正确引用 shell 参数，不拼接未经处理的用户输入。
- 业务技能指南可用 `cli inspect --service SERVICE --skill SKILL` 读取，方法契约与技能指南分别查询。
- `cli tools` 离线展示工具 Schema；其中 `service_id` 等是工具协议字段，CLI 参数写作 `--service`，以 `cli --help` 为准。
- 调用的写入、发布、删除等影响以用户当前授权为限；查看一个服务不等于授权执行其中所有方法。

## 读结果与失败处理

stdout 是完整 MCP 结果 JSON：优先读 `structuredContent`，没有时读 `content` 中的文本块；保留图像等非文本内容和 `isError`。退出码 `0` 为成功，`1` 为网络/HTTP/MCP 业务失败，`2` 为参数错误，参数错误同时在 stderr 输出诊断 JSON。

- `services --node all` 的 `partial`、`discovery`、`scans` 表示扫描完整性。部分失败不能说“全网没有服务”，应报告成功扫描的范围与失败节点。
- 节点网络在线、网关可达、服务健康、某方法可用是不同证据；`inspect` 中 `declared` 仅代表方法有声明。
- HTTP 200 也可能返回 `isError: true`；不能只凭 HTTP 状态或存在 `content` 就判定成功。
- 写调用超时后不要自动重试；可能已执行但响应丢失，先用可用的只读方法核对结果。
- 网关不可达时检查配置与目标设备。不要在 iSH 运行 `dreammate-node install`、裸 `dreammate-node`、本机常驻 MCP 或 `tailscaled` 来“修复”远端连接问题。
- 扫描每个节点最多 3 秒，单条命令默认 30 秒、invoke 默认 150 秒。可用 `--timeout-ms 15000` 缩短整条查询的等待时间；命令级超时返回 `COMMAND_TIMEOUT`，不能作为写操作未执行的证据。
- 空 stdout 不代表没有服务；同时取 stdout、stderr 和退出码。`ECONNREFUSED` 只代表当时地址的端口拒绝连接，不能推断设备未安装软件。
- DNS 不稳时优先已有 IP，不用无限等待的 `getent` 探测。必要的网络诊断使用独立、有限超时的调用（如 BusyBox `wget -T 5`），不要把清理进程、等待、DNS 和 HTTP 探测串成一条长 shell 命令；不要假定 Alpine ash 支持 `/dev/tcp`。
- 不用 `killall node` 清理网关，可能杀掉承载当前会话的进程；不要默认 iOS 快捷指令、launchd 或 cron 能保证 iSH 常驻。需要周期执行时先确认宿主实际提供的调度能力。

需要远端生命周期操作时，`cli manage --node DEVICE --service SERVICE --action status` 查状态；只有用户已要求时才执行 `start` 或 `stop`，它们修改远端服务。

## 回复用户

给出实际目标节点、服务和方法，以及结果或具体失败阶段。列出部分扫描失败时保留不确定性。命令未运行就说明只是建议步骤，不编造调用结果。不要把“npm 包已安装”说成“本机网关已启动”。

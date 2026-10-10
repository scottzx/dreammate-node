# 本地 embedding：Qwen3

搜索会自动使用本次节点扫描中发现的已就绪模型服务，无需在所有客户端安装模型或填写 URL。没有可见且就绪的 provider 时直接使用有界词法检索。模型编码参与排序时，完整方法名精确匹配最先，其余先按语义相似度排序，再在相关候选中平衡工具集，关键词匹配补在后面；故障时仍保留数量与字符上限。运行时不接入 Jev 或其他云端模型 API。

## 当前模型

仅保留 [Qwen/Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)：别名 `qwen3`，0.6B 参数、1024 维向量、FP32。Gemma 的运行、下载和自动发现支持已移除，本地权重与配置已清理；过去的对比数据仍保存在评测记录中。

查询使用工具检索任务指令，文档不加指令；适配器显式设置前缀。默认选择 CUDA、MPS 或 CPU，可直接运行 Python 服务并用 `--device cpu` 固定 CPU。默认最多 512 tokens，适合工具卡片；`--max-length` 会改变编码配置指纹。同一模型可在多台节点部署，客户端稳定选择主用与备用。实测见 [评测记录](tool-search-evaluation.md)。

## 准备：需要一次联网下载

从本仓库根目录运行；本次在 Python 3.12、Apple MPS 上验证 Qwen 的真实离线编码：

```sh
python3 scripts/local-embeddings/prepare.py
```

这一步在 `.local/tool-search/venv` 安装独立 Python 依赖，下载 Qwen 模型到 `.local/tool-search/models/`，将解析出的不可变提交 SHA 写入 `manifest.json`，成功后保存 `requirements.resolved.txt`。该目录已被 Git 忽略；不更改系统 Python，不注册系统服务。`--models qwen3` 可只准备一个模型；`--skip-install` 在已有任务环境中重试模型下载。

首次依赖安装由 pip 解析支持版本，最终精确版本以准备命令生成的 resolved 文件为准。当前只安装文本编码所需依赖，不再要求 Pillow 或 torchvision。模型更新需要显式再次运行 prepare；运行服务不会自动更新或补下载。

## 启动模型并向本机网关登记

在模型设备上，确认 node-agent 已运行；从本仓库根目录执行：

```sh
node scripts/local-embeddings/serve.mjs --model qwen3 --port 8766 --agent http://127.0.0.1:36908
```

启动器使用 `.local/tool-search/venv/bin/python`，以预热的单一模型运行 Python 适配器，只监听 `127.0.0.1`。它检查子进程 PID 和真实编码后的就绪信息，再经回环向本机 agent 注册 `dreammate-embedding-<port>`；每 15 秒刷新登记，正常退出时注销。agent 暂时不可达不终止已就绪模型，启动器会继续尝试登记；登记成功前客户端无法自动发现它。异常退出且来不及注销时，由 agent 的服务探活移除失效记录。

可用 `--priority N` 设置选择优先级，默认 0；自动发现接受 -1000–1000。`--python PATH` 和 `--manifest PATH` 可指定已有运行环境与权重清单。启动器只运行现成依赖和权重，不安装系统服务、不自动下载，也不部署到其他设备。

CPU 默认逐条编码文档，GPU 默认批量 8 条；可用启动器的 `--batch-size 1..64` 显式设置。客户端每次提交的 16 张卡片仍会在适配器内部拆分，不能把请求条数当作实际推理批量。内存有限的 CPU 节点先用 `--batch-size 1` 建立缓存，再验证默认预算下的热查询；`/health` 会报告实际 `batch_size`。

Python 进程在导入模型库前设置 `HF_HUB_OFFLINE=1`、`TRANSFORMERS_OFFLINE=1` 并关闭遥测，加载时强制 `local_files_only=True` 与 `trust_remote_code=False`，禁止主动 socket 连接和 DNS 查询。Node 启动器只向本机 loopback 检查健康、登记与注销；远端请求通过 node-agent 接入，无需开放模型端口。默认日志不记录请求文本。

`GET /health` 的 HTTP 成功只证明适配器响应；自动登记要求 `embedding_provider.ready: true`，且包含模型别名、精确 revision、维度和编码配置指纹。`loaded_model: null` 不能证明模型已就绪。直接运行 Python 服务适合诊断，不会代为注册：

```sh
# 不启动 HTTP，逐个检查已准备模型的真实编码与出站连接阻断。
.local/tool-search/venv/bin/python scripts/local-embeddings/server.py --self-test
```

## 客户端自动发现与选择

客户端只需已有网关入口，不必另填模型 URL。例如将下面地址替换为实际可达网关：

```sh
node dist/bin/dreammate-node.js cli search \
  --agent http://100.100.10.30:36908 --query '把会议录音变成字幕'

# MCP 宿主同样只需网关入口。
node dist/bin/dreammate-node.js mcp --agent http://100.100.10.30:36908
```

搜索默认扫描入口已知的 `online` 或 `is_self` 节点；导入地址簿时扫描缓存清单。模型候选来自这次扫描到的全部注册服务，因此可以只在一台 Mac 或内网服务器运行模型，手机等客户端无需加载权重。客户端直连所选模型节点的网关 `POST /services/<id>/embed`；该网关只代理本机已登记端口的 `127.0.0.1:<port>/embed`，不从入口网关跨节点中继，也不采用 metadata 提供的任意目标 URL。调用端必须能访问候选模型所在设备的网关。

发现范围随 `--node`：`--node localhost` 只搜索入口设备的业务工具和模型，指定节点同理。`--service ID`／`service_id` 与 `kind` 只过滤业务工具；同一节点范围内其他服务提供的模型仍可用于检索。需要跨这个节点范围固定模型时，可显式配置模型 URL。

多个 provider 按以下顺序稳定选择：priority 高优先、`liveness: up` 优于未知、网关编码 URL 的稳定顺序。非 Qwen、禁用、已下线、未就绪、无有效本机 HTTP 端口或带 CLI 命令的服务不会成为自动候选；`DREAMMATE_EMBEDDING_MODEL` 可只保留指定别名。最多尝试前两个 provider，备用仅在主候选失败时尝试，不做全局选主或逐次随机切换。

没有可见且就绪的 provider 时，返回 `search.semantic_status: "no_provider"` 和有界词法结果。该状态只描述本次可查询范围：存在 `partial`、失败扫描或导入目录时，不能推断全网没安装模型。模型已发现但全部尝试失败时为 `unavailable`；成功时 `search.provider`、`search.model`、`search.encoding` 与 `search.provider_attempts` 提供所选节点、版本及尝试证据。

搜索默认最多返回 15 条方法摘要、12000 个摘要 JSON 字符。结果以 `service_id` 区分工具集，跨节点同 ID 算同一集；相关性与预算允许时尽量覆盖 2–3 个工具集，强相关的第 4 个集也可保留，不为凑数加入无关候选。显式服务过滤保持单集，相关候选不足或预算不够时可以返回更少结果。

## 显式固定模型地址

`DREAMMATE_EMBEDDING_URL` 优先于自动发现；指定地址失败时直接词法降级，不会改用其他已发现模型。可以固定模型节点的网关编码路由，而不开放其 loopback 模型端口：

```sh
export DREAMMATE_EMBEDDING_URL=http://100.100.10.20:36908/services/dreammate-embedding-8766/embed
export DREAMMATE_EMBEDDING_MODEL=qwen3

node dist/bin/dreammate-node.js cli search \
  --agent http://100.100.10.30:36908 --query '把会议录音变成字幕'
```

地址仅接受 HTTP(S) 的 localhost、回环或私网 IP（含 Tailscale IP）的 `/embed` 或固定 `/services/<id>/embed` 路由；根路径规范为 `/embed`。拒绝公网域名、公网 IP、凭据、query/hash 和重定向；MagicDNS 名称应换成私网 IP。`--agent` 仍是目录入口，可以与固定模型节点不同。在模型设备本机调试时也可直接指定 `http://127.0.0.1:8766`。显式 URL 兼容旧适配器，响应可以不带 `encoding`；已登记编码指纹的严格匹配属于自动发现路径。程序调用 `searchTools` 时，显式 `embeddingUrl: ''` 可禁止自动模型选择；普通 CLI 无需设置空字符串环境变量。

## 超时、版本与缓存

`DREAMMATE_EMBEDDING_TIMEOUT_MS` 为一次搜索的总语义预算，默认 5000 ms，范围 1–60000；最多两个 provider 共用该预算，不按尝试次数相乘。目录扫描耗时另计。自动发现模式下，一次尝试的 query 与全部 document 请求固定同一个 provider、模型 revision、维度及编码配置；任一响应不一致即拒绝。换备用模型时重新计算该向量空间所需的查询和文档，不能混用不同模型或配置的向量。

客户端每批最多编码 16 张卡片。自动发现模式的版本、维度、编码配置及向量数值校验通过后，可保留已完成批次，下次继续；换 provider 后不复用另一个 provider 的批次。该路径的进程内文档缓存最多 4096 条、TTL 5 分钟，键包含 provider 地址、模型版本、维度、编码配置和卡片内容。方法说明或参数名变化、后端 revision 或编码配置变化都会生成独立缓存键。

适配器另有跨请求共享的文档 LRU 缓存，最多 4096 条，寿命与进程相同。键为 `alias@revision` 与卡片文本 SHA-256；每个适配器进程的编码配置固定。只有缺失卡片需要编码，同批重复卡片只编码一次，结果保持原顺序。有效向量以 FP32 数组保存；查询每次重新编码，不占文档缓存；缓存不写磁盘，重启后需要重建。

模型预热不等于工具目录已编码。冷文档缓存或较慢设备可能超过默认预算并有界降级；需要时可先执行一次较长预算的只读搜索建立缓存，再恢复默认值：

```sh
DREAMMATE_EMBEDDING_TIMEOUT_MS=60000 node dist/bin/dreammate-node.js cli search \
  --agent http://100.100.10.30:36908 --query '读取文件并查询 Git 状态' --timeout-ms 90000
```

确认 `search.semantic_status=ok` 后再评估热查询。适配器重启、改用尚未索引的模型或目录大幅扩展后可能需要重新预建。当前没有持久化目录索引、目录扫描缓存、中心搜索 API 或自动模型部署；目录扫描、向量比较与排序仍在各 CLI/MCP 进程完成。实测数据保留在 [评测记录](tool-search-evaluation.md)。

`DREAMMATE_EMBEDDING_MIN_SCORE` 为余弦召回阈值（默认 0.35、范围 -1–1），不是置信概率。返回的 `semantic_score` 是余弦值，`score` 是分组排名信号（语义候选为 1+余弦，关键词补充为倒数排名），不能当作执行授权。阈值仍需结合实际请求校准。当前尚无专门的任务拒识分类器，候选描述不匹配时应改写查询或说明目录不支持。禁止因无匹配而自动展开全目录。

## 协议与验证

这是 DreamMate 的小型适配协议，不能直接把 Ollama 或 TEI 的地址填入后假定兼容：

```json
{"model":"qwen3","texts":["读取一个文本文件"],"input_type":"query"}
```

网关编码路由与适配器 `/embed` 使用相同请求结构，文档使用 `input_type: "document"`。成功响应包含 `model: "qwen3@<revision>"`、`encoding` 和 `embeddings`；自动发现路径的 query 与 document 必须符合已登记版本、维度与编码配置；每次最多 64 段非空文本、每段最多 8192 字符。网关只接受固定的 `model`、`texts`、`input_type` 字段，模型别名必须与本机 provider 一致。适配器不返回参数 Schema。

注册服务的声明示例：

```json
{
  "protocol": "dreammate.embedding.v1",
  "model": "qwen3",
  "revision": "<snapshot SHA>",
  "dimensions": 1024,
  "encoding": "dreammate.tool-search.v1:fp32:max512:dim1024",
  "ready": true,
  "priority": 0
}
```

该对象位于 `metadata.embedding_provider`，不是对外模型 URL。登记仅允许回环来源；模型原始端口保持 loopback，网关路由只代理同机 HTTP 服务，拒绝重定向并校验上游模型版本、编码配置和响应数量。

无权重的契约测试与网关测试：

```sh
python3 -m unittest discover -s scripts/local-embeddings -p 'test_*.py'
npm run typecheck
npm test
```

真实 Qwen 召回/延迟使用 [评测脚本](../scripts/benchmark-tool-search.ts)。它在任何模型条件降级时立即报错，不把词法回退计作模型成绩。另有 [只读调用验证](../scripts/test-local-tool-search.mjs) 与 [跨节点搜索验证](../scripts/test-network-tool-search.mjs)，检查真实网关搜索、方法契约与业务输出、自动 provider 发现及默认语义预算表现。当前结论限于本机目录与少量人工请求，详见 [评测记录](tool-search-evaluation.md)。

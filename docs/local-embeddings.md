# 本地 embedding：Qwen3 与 EmbeddingGemma 2

搜索会自动使用本次节点扫描中发现的已就绪模型服务，无需在所有客户端安装模型或填写 URL。没有可见且就绪的 provider 时直接使用有界词法检索。模型编码参与排序时，完整方法名精确匹配最先，其余先按语义相似度排序，再在相关候选中平衡工具集，关键词匹配补在后面；故障时仍保留数量与字符上限。运行时不接入 Jev 或其他云端模型 API。

## 当前模型

工具和技能文本检索使用 [Qwen/Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)：别名 `qwen3`，0.6B 参数、1024 维向量、FP32。可选的 EmbeddingGemma 2 用于图片、视频等多模态素材，生成独立的 768 维向量；它不参与 Qwen 工具目录的自动 provider 选择。两套索引分别保存，不能混用查询向量、候选向量或相似度分数。

查询使用工具检索任务指令，文档不加指令；适配器显式设置前缀。默认选择 CUDA、MPS 或 CPU，可直接运行 Python 服务并用 `--device cpu` 固定 CPU。默认最多 512 tokens，适合工具卡片；`--max-length` 会改变编码配置指纹。同一模型可在多台节点部署，客户端稳定选择主用与备用。实测见 [评测记录](tool-search-evaluation.md)。

## 准备：需要一次联网下载

从本仓库根目录运行；本次在 Python 3.12、Apple MPS 上验证 Qwen 的真实离线编码：

```sh
python3 scripts/local-embeddings/prepare.py
```

这一步在 `.local/tool-search/venv` 安装独立 Python 依赖，下载 Qwen 模型到 `.local/tool-search/models/`，将解析出的不可变提交 SHA 写入 `manifest.json`，成功后保存 `requirements.resolved.txt`。该目录已被 Git 忽略；不更改系统 Python，不注册系统服务。`--models qwen3` 可只准备一个模型；`--skip-install` 在已有任务环境中重试模型下载。

首次依赖安装由 pip 解析支持版本，最终精确版本以准备命令生成的 resolved 文件为准。当前 Qwen 准备脚本只安装文本编码所需依赖，不要求 Pillow 或 torchvision。模型更新需要显式再次运行 prepare；运行服务不会自动更新或补下载。

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

## macOS 按需加载，空闲后释放模型

权重和 Python 环境已按前文准备后，可安装轻量按需服务，而不让模型始终占用内存：

```sh
dreammate-node embedding install \
  --python "$PWD/.local/tool-search/venv/bin/python" \
  --manifest "$PWD/.local/tool-search/manifest.json" \
  --device mps --batch-size 8 --idle-timeout-ms 60000 --priority 100 --sharing local
dreammate-node embedding status
dreammate-node embedding uninstall
```

以上从已准备权重的仓库根目录运行，`--python` 与 `--manifest` 使用绝对路径；安装不会准备或下载缺少的依赖。
macOS launchd 标签为 `work.dreammate.embedding`，仅常驻轻量 Node 启动器，默认监听 `127.0.0.1:8766`。
Qwen 模型通过私有标准输入输出子进程提供编码，不额外开放 Python HTTP 端口；可选 Gemma 模型使用受同一启动器管理的本机 worker。
日志位于 `~/.1agents/logs/dreammate-embedding.log` 与 `.err.log`。

首次 `POST /embed` 才启动并预热 Python/Qwen，验证其真实版本、维度、编码配置后执行请求。
并发请求共享一次启动及一个模型进程。最后一个实际编码请求完成后重新计时，连续空闲默认 60000 ms 后退出 Python。
有正在运行或排队的请求时不执行空闲关闭；定期 `/health` 和服务报备不加载模型，也不延长驻留时间。
下一次编码自动重新启动。停止启动器会同时结束其模型子进程。

`GET /health` 返回 `service: dreammate-embedding-on-demand` 和 `loaded`、`loading`、`worker_pid`、
`pending_requests`、`last_used`、`idle_timeout_ms`。按需服务的 `embedding_provider.ready: true`
表示启动器已准备好按需接单，重型模型是否已加载以 `loaded` 为准；`lifecycle: on_demand` 区分此模式。
仅探测健康或运行 `status` 不会加载模型。模型进程退出后，内存和进程内缓存释放。
按需 Qwen worker 另将文档 SHA-256 与 FP32 向量原子保存到 `~/.1agents/cache/embeddings/`，最多 4096 条、单文件 64 MiB，
目录权限 700、文件权限 600；不保存描述原文或用户查询。模型版本、维度和编码配置共同确定缓存文件，
下次启动校验并恢复有效向量。坏缓存或指纹变化不会当成可用向量；未缓存的新文档仍需要编码。

默认广告优先级为 100，普通模型为 0。已有 MCP 每次搜索重新发现服务，可以自动选用它；无需固定模型 IP。
该优先级在共享范围内生效；上面的 `--sharing local` 限制为本机 Agent 共用。
默认 `all` 范围保留远端候选，显式 `localhost` 范围只使用入口设备的模型。
显式固定 `DREAMMATE_EMBEDDING_URL` 会关闭自动模型回退，因此这里不使用该选项。

### 通过配置调整优先级与待命时间

按需启动器默认读取 `~/.1agents/embedding-config.json`，格式为：

```json
{
  "version": 1,
  "priority": 100,
  "sharing": "local",
  "idle_timeout_ms": 60000
}
```

`priority` 必须是 -1000–1000 的整数，数值越大越优先。可以直接编辑文件，也可以运行：

```sh
dreammate-node embedding config                  # 查看配置值与启动兜底值
dreammate-node embedding config --priority 100   # Mac 优先于 priority=0 的远端
dreammate-node embedding config --priority -10   # priority=0 的远端优先
dreammate-node embedding config --idle-timeout-ms 60000  # 编码或预热结束后待命 1 分钟
```

配置文件的 `priority` 覆盖启动参数 `--priority`；文件不存在时使用启动参数，按需启动器的参数默认值为 100。
`install --priority N` 设置启动兜底值，不改写已有 JSON；安装结果同时给出兜底值和有效值。
`install --config /absolute/path.json` 可指定配置文件，后续 `config` 默认沿用已安装服务的路径；
前台运行启动器也支持 `--config`。单独执行 `config --config PATH` 只选择本次读写的文件，
不会切换已运行服务所监听的路径。

运行中的启动器每 15 秒重新读取配置并向 Node 更新报备；下一次发现服务时使用更新后的优先级。
只调整优先级不会重启模型、触发加载、重置空闲时间或使向量缓存失效，也无需重启已有 MCP 会话。
运行中遇到损坏或不合法的配置会保留最近有效值，并在 `/health` 的 `config.last_error` 中报告；
启动时已有配置不合法则拒绝启动。删除文件恢复启动参数的兜底值。
同分时的健康状态与地址排序、最多两个模型候选及超时分配仍使用下述检索策略。

### 通过配置限制共享范围

`sharing` 沿用 MCP 的 `local` / `network` 语义，决定哪些调用方能发现和使用这个模型；
`priority` 只决定调用方可见模型的尝试顺序。按需模型是普通 HTTP 服务，不需要转换成 MCP 来源。

```sh
dreammate-node embedding config --sharing local    # 仅本机 Agent 共用
dreammate-node embedding config --sharing network  # 允许网络内其他设备使用
```

优先级、共享范围、待命时间可单独修改，也可同时传入；只修改其中一项会保留其他已有配置字段。
`sharing` 配置覆盖安装参数 `--sharing`，旧 JSON 省略此字段时沿用启动参数；
启动参数也省略时保持 `network`，兼容已有部署。设置 `local` 时应通过
`http://127.0.0.1:36908` 访问本机网关；以 socket 回环来源为准，不采信转发头。

本机看到并使用 Mac 模型，其他设备的目录隐藏该服务，知道服务 ID 也无法直接调用网关编码路由。
本机搜索仍能发现网络共享的远端模型，本机模型失败时可继续回退；
`sharing: local` 不等于将搜索范围缩成 `--node localhost`。
共享范围也每 15 秒更新报备，不启动或重启模型、不改变空闲计时。
按需启动器在 `local` 报备前验证网关声明 `service_sharing: dreammate.service-sharing.v1`；
旧网关未支持时不发布本地模型，并通过注册错误报告，避免把 `local` 当成已执行的限制。

首次启动与全部缺失文档编码共用检索预算。当前 Mac 的 Codex MCP 已配置 30 秒；独立 CLI 不继承 MCP 的专属环境：

```sh
DREAMMATE_EMBEDDING_TIMEOUT_MS=30000 dreammate-node cli search-skills \
  --agent http://127.0.0.1:36908 --query '制作小红书封面和图文卡片' --timeout-ms 60000
```

无 launchd 或只需前台诊断时，可直接执行 `node scripts/local-embeddings/on-demand.mjs`，传入同样的路径和运行参数；
`--no-register` 可不报备，仅在本机测试。当前按需服务安装管理命令只支持 macOS。
完整参数以 `dreammate-node embedding --help` 为准。

### 双模型互斥调度

需要多模态检索时，先准备 Gemma 的本地权重、清单和包含视觉依赖的 Python 环境，再将它们交给同一个按需启动器。Qwen 的 `prepare.py` 不会额外下载 Gemma；安装器仅验证已有路径，不导入 Torch、不下载模型或安装 Python 包。清单必须包含不可变 revision 和已准备的模型目录。

为 Gemma 创建独立 venv，不向系统 Python 或已有 Qwen 环境补装媒体依赖。视觉编码需要 Pillow、torchvision，视频解码还需要 torchcodec，以及系统可执行的 `ffmpeg`、`ffprobe`。下面列出本次 Mac MPS 实测的版本组合，供复现参考；其他操作系统和 CUDA 环境应选择彼此兼容的构建，不要求所有平台使用相同版本。

```sh
python3 -m venv /absolute/path/to/gemma-venv
/absolute/path/to/gemma-venv/bin/python -m pip install \
  'torch==2.14.1' 'torchvision==0.29.1' \
  'sentence-transformers==6.1.0' 'transformers==5.19.0' \
  'torchcodec==0.17.0' Pillow

# macOS 示例；确保安装服务时的 PATH 能找到这两个命令。
brew install ffmpeg
ffmpeg -version
ffprobe -version
```

MPS 推理进程不要同时导入 PyAV：它捆绑的 FFmpeg 与 TorchCodec 使用的系统 FFmpeg 可能发生冲突。当前视频路径使用独立 `ffprobe` 进程检查时长，再由 TorchCodec 解码，不需要在模型进程中导入 PyAV。

首次权重准备须显式完成：从 `google/embeddinggemma-2` 下载选定不可变提交的完整快照，保存到绝对本地目录，至少包含 `config.json`、权重和模型所需的其余配置文件；运行时不会下载缺失文件。随后创建清单，例如下面的 revision 是本次实测快照；替换 `path` 为自己的快照目录，使用其他快照时同步修改 revision。

```json
{
  "format": 1,
  "models": {
    "embeddinggemma2": {
      "repo": "google/embeddinggemma-2",
      "revision": "914f7f89142e33e77833254d9c9b90c3cef7303b",
      "path": "/absolute/path/to/embeddinggemma-2-snapshot"
    }
  }
}
```

```sh
# 将以下三个值替换为本机已准备的绝对路径。
GEMMA_PYTHON="/absolute/path/to/gemma-venv/bin/python"
GEMMA_MANIFEST="/absolute/path/to/gemma-manifest.json"
MEDIA_ROOT="/absolute/path/to/media-inbox"

dreammate-node embedding install \
  --python "$PWD/.local/tool-search/venv/bin/python" \
  --manifest "$PWD/.local/tool-search/manifest.json" \
  --device mps --batch-size 8 --port 8766 \
  --gemma-python "$GEMMA_PYTHON" \
  --gemma-manifest "$GEMMA_MANIFEST" \
  --media-root "$MEDIA_ROOT" --gemma-port 8767 \
  --gemma-modalities vision --gemma-max-length 2048 --mps-limit-mb 4096 \
  --idle-timeout-ms 60000 --priority 100 --sharing local
```

`--gemma-python`、`--gemma-manifest`、`--media-root` 必须一起提供，分别指向可执行 Python、清单文件和媒体根目录；Gemma 端口必须与 Qwen 端口不同。省略所有 Gemma 参数时保持单 Qwen 模式。`--gemma-modalities` 支持 `all`、`text`、`vision`、`audio`，默认 `vision`，加载文本与视觉编码部分；`--gemma-max-length` 范围 1024–8192、默认 2048，`--mps-limit-mb` 范围 1024–16384、默认 4096。MPS 限额约束模型进程的设备内存，不表示整机总内存占用。

两个端口属于同一个轻量 Node 管理进程，重量模型采用同一队列和互斥生命周期：同种请求复用当前模型；切换到另一模型前，先等待正在执行的请求完成，结束旧 worker 并确认退出，再加载目标 worker。排队中的请求不会同时启动第二个模型。此互斥仅覆盖该管理进程拥有的 Qwen/Gemma worker，不管理其他应用自行启动的模型进程，也不约束其他设备的模型。

### 按检索内容选择向量空间

统一调用入口为启动器的 `POST /invoke`。`embedding.encode` 默认将纯文本输入交给 Qwen，将含图片、视频、音频的输入交给已启用对应模态的 Gemma。可以用 `target: "text"` 或 `target: "multimodal"` 显式选择目标空间；不支持的模态或缺少 Gemma 配置会返回错误，不用其他模型生成不兼容向量。

**文字描述搜索图片或视频时也必须使用 Gemma。** 选择依据包括被检索索引的类型；输入只有“眼镜”两个字，不代表要搜索 Qwen 的工具文本索引。调用方知道目标是多媒体素材，应显式传入 `target: "multimodal"`，不要由关键词猜测目标库。

```json
{"method":"embedding.encode","params":{"texts":["读取文本文件"],"input_type":"query","target":"text"}}
```

```json
{"method":"embedding.encode","params":{"texts":["戴眼镜的人"],"input_type":"query","target":"multimodal"}}
```

图片、视频通过 `embedding.encode_media` 编码，路径相对于 `--media-root`，沿用媒体根目录访问校验。例如：

```json
{"method":"embedding.encode_media","params":{"items":[{"image":"portraits/person.png"}]}}
```

`embedding.compare` 在 Gemma 空间比较查询与候选媒体；以下请求返回相似度，不自动决定候选是否可以直接使用：

```json
{"method":"embedding.compare","params":{"query":"眼镜","items":[{"image":"portraits/person.png"}]}}
```

`/embed` 始终固定到接收端口对应的模型：8766 为 Qwen 工具文本空间，8767 为 Gemma 多媒体空间，不能通过输入内容改变其向量空间。Gemma 端口的 `embedding.encode_text` 兼容方法同样固定为 Gemma，因此仍可用于文字查询已有多媒体向量。工具/技能自动检索继续只选择 Qwen；Gemma 服务不会混入 Qwen 工具索引。两套向量需分别校验模型 revision、维度和编码指纹，不能直接跨空间比较，也不能把两个库的余弦分数当成相同尺度合并。

### 普通文档索引与工具索引共用推理器

独立的 [`@1agents/artifact-index`](../packages/artifact-index/README.md) 负责 PDF、PPT、Excel 与视频的解析、定位和 SQLite 索引；网关不依赖或内嵌该包。它复用这里安装的模型服务和权重，不启动另一套推理进程。

Qwen 普通文档查询使用独立的任务契约，经现有 `/invoke` 请求：

```json
{"method":"embedding.encode_text","params":{"texts":["备份保留多久"],"input_type":"query","task":"document_search"}}
```

建立文档向量时使用同样的 `task` 和 `input_type: "document"`。返回编码为 `dreammate.artifact-search.v1:fp32:max512:dim1024`；工具 `/embed` 的 `dreammate.tool-search.v1`、缓存与响应保持原约定。两者共用同一个 Qwen worker，任务和索引空间分开。`embedding.status.embedding_profiles` 公开支持的文档 profile；`media_input` 仅在本机状态接口公布已有媒体 inbox，注册摘要不携带本地路径。

该任务从 `@1agents/dreammate-node@0.14.0` 提供，`0.13.0` 尚未支持。升级模型设备的 npm 包后，使用原 Python、manifest、媒体根目录等参数重新执行 `embedding install`，让已安装的常驻启动器切换到新版脚本；npm 升级本身不等于启动器已重启。独立索引包连接旧调度器会报告不支持并降级文字检索，不自动安装第二份模型。完整的文件导入与只读检索接口见产物包文档。

### 预热、状态与自动卸载

可通过统一 `/invoke` 显式预热或查询状态：

```json
{"method":"embedding.prewarm","params":{"target":"multimodal"}}
```

```json
{"method":"embedding.status","params":{}}
```

预热也遵守互斥规则；预热完成后进入默认 60 秒待命。每次实际编码完成后重新计算待命时间，有运行或排队请求时保持模型可用；连续空闲超过阈值则终止重量 worker、释放其内存，保留轻量 Node 管理器和磁盘向量数据。下一次编码按需重新加载，产生冷启动耗时。健康检查和状态读取不加载模型，也不延长待命。

配置文件可加入 `"idle_timeout_ms": 60000`，或运行 `dreammate-node embedding config --idle-timeout-ms 60000`；必须为 1–86400000 的整数。启动器每 15 秒热更新配置，并按最后一次使用时间重新评估剩余待命时间，调整配置本身不算使用模型。显式配置覆盖 `--idle-timeout-ms` 启动值；旧 JSON 未包含该字段时沿用启动参数，未指定启动参数时默认 60000。已有 plist 中显式设置的旧 300000 ms 不会被代码默认值覆盖，需要通过配置或重新安装显式调整。

`embedding status` 的 `configuration.idleTimeoutMs` 为有效值，`fallbackIdleTimeoutMs` 为启动回退值；安装结果另给出 `effectiveIdleTimeoutMs`。只改待命时间会保留已有优先级和共享范围，不重启 Node 管理器；删除配置文件后恢复启动参数。索引保留与模型驻留独立，空闲卸载不会删除权重、媒体或已有向量。

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

`DREAMMATE_EMBEDDING_TIMEOUT_MS` 为一次搜索的总语义预算，范围 1–60000；最多两个 provider 共用该预算，不按尝试次数相乘。通常默认 5000 ms；自动发现首选按需 provider 带有合法的 `cold_start_timeout_ms` 时，默认预算按该值扩大（最多 60000 ms），使首次模型加载有时间完成。调用方或环境显式设置的超时优先。目录扫描耗时另计。自动发现模式下，一次尝试的 query 与全部 document 请求固定同一个 provider、模型 revision、维度及编码配置；任一响应不一致即拒绝。换备用模型时重新计算该向量空间所需的查询和文档，不能混用不同模型或配置的向量。

首选按需 provider 声明了合法冷启动预算时，可以使用完整的有效总预算，不因发现备用模型而提前缩短。例如显式配置 30000 ms 时，首选可等待约 30 秒，不再提前于 21 秒切换；提前失败仍可在剩余时间内尝试备用模型，总预算耗尽后直接降级。普通 provider 保留为备用模型预留时间的策略。`search.timeout_ms` 记录总语义预算；`provider_attempts` 中的 `budget_ms` 与 `elapsed_ms` 分别记录该次尝试的预算和实际耗时。

客户端按摘要内容去重后，每批最多请求 16 个向量；同一摘要在多个来源发布仍保留各自的技能条目，只传输一次向量。网关的向量响应使用紧凑 JSON，并在客户端接受时使用 gzip 压缩，减少 Tailscale 中继传输量。自动发现模式的版本、维度、编码配置及向量数值校验通过后，可保留已完成批次，下次继续；换 provider 后不复用另一个 provider 的批次。该路径的进程内文档缓存最多 4096 条、TTL 5 分钟，键包含 provider 地址、模型版本、维度、编码配置和卡片内容。方法说明或参数名变化、后端 revision 或编码配置变化都会生成独立缓存键。

适配器另有跨请求共享的文档 LRU 缓存，最多 4096 条，寿命与进程相同。键为 `alias@revision` 与卡片文本 SHA-256；每个适配器进程的编码配置固定。只有缺失卡片需要编码，同批重复卡片只编码一次，结果保持原顺序。有效向量以 FP32 数组保存；查询每次重新编码，不占文档缓存。普通 `serve.mjs` 模式仅使用内存缓存；前述按需 Qwen worker 额外保存经过校验的文档向量，模型卸载后仍可恢复。

缓存读写使用独立短锁；命中缓存不等待正在运行的模型推理。未命中的文档和新查询仍串行使用模型，同一文档的并发缺失请求会在获得推理锁后再次检查缓存，避免重复计算。

滚动部署时可给 `serve.mjs` 传入 `--restore-document-cache /absolute/snapshot-directory`，在模型预热后恢复已有 `vector_cache.py` 格式的快照。版本、维度、编码配置和向量数值都需通过校验。此选项只负责恢复指定快照，不持续保存新增向量。

技能目录先探测网关可达性，再按页读取；每次页面请求最多 10 秒，整个节点目录最多 30 秒、5 页。目录响应同样支持 gzip，避免摘要经较慢中继传输时耗尽页面预算。只读页面遇到暂时的超时或 502/503/504 可重试一次，已成功读取的页在后续失败时保留，并通过 `partial` 与节点扫描状态报告覆盖限制。

模型预热不等于工具目录已编码。冷文档缓存或较慢设备可能超过默认预算并有界降级；需要时可先执行一次较长预算的只读搜索建立缓存，再恢复默认值：

```sh
DREAMMATE_EMBEDDING_TIMEOUT_MS=60000 node dist/bin/dreammate-node.js cli search \
  --agent http://100.100.10.30:36908 --query '读取文件并查询 Git 状态' --timeout-ms 90000
```

确认 `search.semantic_status=ok` 后再评估热查询。适配器重启且没有可恢复向量、改用尚未索引的模型或目录大幅扩展后可能需要重新预建。按需模式的磁盘缓存只保存可重建向量，当前没有目录扫描缓存、中心搜索 API 或自动模型部署；目录扫描、向量比较与排序仍在各 CLI/MCP 进程完成。实测数据保留在 [评测记录](tool-search-evaluation.md)。

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

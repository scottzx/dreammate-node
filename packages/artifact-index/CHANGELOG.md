# Changelog

## 0.3.1 — 2026-11-19

- 修复：文本分块会把 emoji 等代理对从中间切开，留下半个码元；序列化成 JSON 后本地编码器抛 `TypeError`，整批返回 503。分块现在按码元边界回退，入库前再兜底把孤立代理项替换为 U+FFFD。
- 修复：一处 503 就打掉整组表示——45 个大文本文件共 5608 条表示曾因此全部掉线。现在按批重试（默认 2 次，2s/15s 退避，覆盖编码器重启窗口），单批失败只标记该批并继续。
- 新增按批对半拆分：反复失败的批次自动二分重试，能定位到真正无法编码的单条表示，其余正常入库；连续 4 批失败才熔断。
- 新增 `textRetries` / `mediaRetries` / `maxConsecutiveFailures` / `retryDelays` 选项；`diagnostics.embedding_errors` 区分单批失败（`circuit_open: false`）与熔断（`circuit_open: true`）。
- 只对传输与服务端错误重试；被拒绝的批次参数不重试。
- 嵌入失败信息带上游原因（如 `Local encoder returned an invalid response`），不再只有 HTTP 状态码。

## 0.3.0 — 2026-11-18

- 新增 Word（`.docx`/`.docm`）、纯文本与 Markdown（`.txt`/`.md`/`.markdown`）解析，单元按内容块定位（`{"block": N}`）。
- Word 解析只依赖标准库 OOXML 读取，不新增 Python 依赖；旧版 `.doc` 通过本地 LibreOffice 转换副本后读取，不改原文件。
- 纯文本按 BOM、UTF-8、UTF-16 特征和 GB18030 顺序探测编码，中文本地文件不再乱码。
- 标题单独成块，正文块继承所属标题作为检索上下文；标题、中文段落与表格均可独立命中。
- `index` 支持目录：遍历本地可解析格式，跳过隐藏项与不支持的扩展名，`--exclude`、`--max-depth`、`--include-hidden` 可控。
- 增量索引：大小与修改时间未变的文件保留既有单元与向量；解析器版本变化时强制重读，`--reindex` 可显式重读。
- 词法匹配加入词频饱和与文件名权重；文本表示改为按完整单元文本分块，使用共享文档模型的完整窗口。
- 解析器版本升至 `artifact-local-v2`；SQLite 表结构不变，无需迁移。
- 大目录可跑：扫描器按需剪枝构建产物目录、跳过符号链接、只保留有限数量的跳过样本并给出计数；`--exclude-dir` 按目录名整棵排除。
- 索引改为分块提交（`--chunk-size`）并在块间报进度，长任务可中断续跑；解析并发可用 `--concurrency` 调整。
- embedding 客户端缓存网关目录与模型 profile，避免每批重复拉取数 MB 服务清单。
- 检索新增路径权重：命中「简历」「讲师」等个人材料路径的结果排在批量语料之前；`--exclude-path` 可排除指定路径。
- 新增 `--exclude-keyword`：扫描时按路径子串（大小写不敏感）排除，适合一次排除整类代码生态文档（人格模板、README、CHANGELOG、测试夹具、第三方源码目录）；CLI 从 `~/.1agents/artifacts/config.json` 的 `exclude_keywords` 读取默认规则。
- 修复：向量未落库的资源会在下次运行时重试，不再永久停留在 pending。
- 索引时跳过重复解析：字节相同、扩展名相同、解析器版本相同的文件直接沿用已解析单元，只登记路径并共享向量；同一批次内先解析一份、其余等待复用。`diagnostics.reused` 与 `resources[].reused_from` 记录来源；`--no-visual` 索引过的文件不会作为视觉开启时的复用来源。
- 检索默认按内容去重：字节相同的文件副本只返回一条结果，其余副本进入 `duplicates`，`--keep-duplicates` 可关闭；去重键为「内容哈希 + locator」，复制一份的 PDF 不会重复每一页。
- 修复：词法/语义排名在完全同分时用哈希 ID 打破平局，同一份材料的两个副本谁被保留会随运行变化；现在按源路径字典序，结果稳定可复现。
- 新增 `search --query-image 图片路径`：以本地图片作为查询，在同一条多模态向量空间里直接找相似的页面图、幻灯片图与视频片段；只进入 Gemma 空间，跳过 Qwen 文字空间与词法通道，`--mode lexical` 会明确报错。
- 检索结果新增 `similarity`（最佳向量余弦，0–1）与 `query_image` 字段：`score` 仍是融合排名分，判断像不像请看 `similarity`。
- 修复：`matches[].similarity` 之前返回的是叠加路径权重后的分数，可能大于 1；现在返回真实余弦。
- 修复：空查询（图片查询）也会触发「个人材料路径加权」，把普通报告抬到结果首位；该加权现在要求查询词非空。
- 图像查询遇到只有文字向量的库时不再计入「部分失败」：`semantic_status` 按实际可查询的向量空间统计。
- 修复：macOS 上 LibreOffice 无头转换在 `sandbox-exec` 严格规则下静默失败，幻灯片与旧版 Office 文件的视觉提取缺失；Office 转换改用 `deny network-outbound`（仍禁止一切对外连接），其余外部命令保持 `deny network*`。

## 0.2.0 — 2026-10-19

- Explicit getTextProfile(model) and embedDocuments(texts, profile) APIs for Qwen/Gemma text indexing.
- Preserve query/document task identities and reject incompatible revisions or vector profiles.
- Existing default Qwen and multimodal callers remain supported.


## 0.1.0 — 2026-10-18

首版独立本地产物索引包，提供 CLI、ESM 库与可选 DreamMate 只读服务。

- 支持 PDF 页面、PPT/PPTX 幻灯片、XLS/XLSX 单元格区域与视频时间片段，保留页码、工作表/A1 范围和毫秒时间定位。
- SQLite 三层资源、单元与表示结构，记录源文件版本、解析器、分享范围、结构化单元格/备注及模型 profile；使用 foreign keys、WAL 和事务替换。
- 复用现有 Qwen 文档 profile 和 Gemma 媒体服务，不下载模型，不启动独立模型进程。Qwen `document_search` 需要 DreamMate Node `0.14.0` 或更新版本的共享调度器。
- 同内容向量复用、缺失表示重试、后端故障熔断、词法降级与明确的视觉不可用诊断。
- 按模型空间排序后融合，按资源限制返回数量；支持库级模态过滤、分享/类型过滤与有界结果摘要。
- 显式路径索引、更新和删除；源文件变更/删除后重建失败保留 `stale` 快照，默认检索排除。
- 本地解析器能力检查、Python 网络阻断、支持平台的系统网络隔离、Office 外部关系清理和受限 FFmpeg 协议。

首版边界：扫描 PDF 不做 OCR；视频不索引音轨/台词；Excel 不执行公式、宏或自动渲染图表；旧 PPT 不提供原始备注；旧 XLS 表达式无法还原时保留 BIFF token。媒体调用只支持 loopback 网关，移除资源不会自动清理磁盘派生缓存。

# @1agents/artifact-index

独立的本地产物索引包。把 PDF 页面、PowerPoint 幻灯片、Excel 单元格区域和视频片段变成可检索、可定位、可更新的记录。提供 CLI、JavaScript 库和可选的 DreamMate 只读服务。

本包没有 Node.js 运行时依赖，也不依赖 `@1agents/dreammate-node`。解析器、数据库和原始文件留在本机；向量编码复用工具检索使用的同一组 Qwen/Gemma 服务。本包不会下载模型、复制模型权重或启动另一套模型进程。

## 支持范围

| 文件 | 检索单元与定位 | 本地提取方式 |
| --- | --- | --- |
| PDF | `page`，从 1 开始 | 正文提取；可选页面 PNG，供 Gemma 检索扫描页、图片和图表 |
| PPTX/PPTM | `slide`，从 1 开始 | 标题、正文、表格、备注；LibreOffice 渲染幻灯片供视觉检索 |
| 旧版 PPT | `slide`，从 1 开始 | LibreOffice 转换后提取正文和页面；无法取得原始演讲者备注 |
| XLSX/XLSM/XLS | `sheet` + A1 格式 `range` | 按行块提取单元格、表头、公式及已有缓存值；不执行公式或宏 |
| 视频 | `start_ms` + `end_ms` | 默认 6 秒切段、重叠 1 秒，生成本地画面片段并编码；保留完整时间覆盖 |

PDF 扫描页没有 OCR 转写；有页面图片和 Gemma 时仍可进行视觉检索。视频仅索引画面，不转写音轨、台词或音乐。Excel 当前使用结构化文字检索，不自动把工作表或图表渲染为图片；精确数值计算需要读取原始单元格。旧 XLS 的公式在不能还原表达式时保留原始 BIFF token 与缓存值，不宣称已理解该公式。

原始文件不会被修改。Office 渲染使用缓存副本与临时用户配置，缓存副本会移除外部资源关系。

## 安装与依赖检查

需要 Node.js **22.13 或更新版本**，使用内置 `node:sqlite`。部分 Node.js 版本会输出 SQLite 实验性功能提示。

通过 npm 安装：

```sh
npm install -g @1agents/artifact-index
```

也可从源码打包安装：

```sh
cd packages/artifact-index
npm pack
npm install -g ./1agents-artifact-index-0.1.0.tgz
```

本包的安装过程不会自动安装 Python、系统解析器或模型。

解析依赖按需要安装到独立环境，例如：

```sh
python3 -m venv ~/.1agents/artifacts/parser-venv
~/.1agents/artifacts/parser-venv/bin/python -m pip install pypdf python-pptx openpyxl xlrd Pillow
```

PDF 页面渲染需要 Poppler 的 `pdftoppm`；`pdftotext` 可改善 PDF 文本布局提取。幻灯片渲染和旧 PPT 需要 LibreOffice（`soffice`）；视频需要 `ffmpeg` 和 `ffprobe`。这些工具应预先安装并加入 `PATH`。

```sh
artifact-index doctor --python ~/.1agents/artifacts/parser-venv/bin/python
```

`doctor` 只检查本地解析能力、网络隔离等级及已登记的共享模型，不加载模型、不下载依赖。缺少页面渲染工具时，PDF/PPTX 可以保留文字索引，并通过 `warnings` 明确说明缺少视觉表示；不能把文字提取成功当作视觉检索成功。

纯离线部署可事先准备 Python wheels、npm 包与系统工具，再在目标机器安装。安装依赖可能需要联网，索引运行本身不需要访问公网。

## 复用现有模型

默认连接 `http://127.0.0.1:36908` 的现有 DreamMate 网关，由网关发现并调用相同的共享模型服务：

- 文字文档使用 Qwen 的独立 `document_search` profile；不沿用工具描述检索的任务提示。
- 页面图片、幻灯片图片和视频使用 Gemma。用文字搜索图片或视频时，查询文字也由 Gemma 编码，保持相同向量空间。
- 两种模型的加载、互斥切换与空闲卸载，继续由已有模型调度器管理。

**Qwen 文档任务需要 DreamMate Node `0.14.0` 或更新版本的共享模型调度器。** `0.13.0` 不包含该文档契约。仅安装本包不会更新调度器：先升级模型设备上的 `@1agents/dreammate-node`，再使用原来的 Python、manifest、媒体根目录等安装参数重新执行 `dreammate-node embedding install`，使常驻启动器运行新版本。复用原模型路径，无需重新下载权重。旧服务缺少 `document_search` 时，`doctor`/向量诊断会明确报错，文字检索可降级到词法检索。

Gemma 媒体通过现有服务的本地 inbox 传递，本包只写入派生页面或片段的内容缓存。**当前媒体文件调用只支持 loopback 网关**；不会把本地路径误当成远程路径，也不会自动向远程节点复制媒体。`--media-root` 可指定已有 inbox，默认读取调度器公布的路径。网关客户端拒绝公网地址和 HTTP 重定向。

## CLI

只处理明确传入的文件路径，不自动扫描全盘、不默认启动后台监控：

```sh
artifact-index index ./产品手册.pdf ./产品介绍.pptx ./销售明细.xlsx ./演示.mp4 \
  --python ~/.1agents/artifacts/parser-venv/bin/python

artifact-index search --query '眼镜' --mode hybrid
artifact-index search --query '木马' --types video --mode semantic
artifact-index search --query '戴眼镜的人' --modalities image,video
artifact-index list
artifact-index stats
artifact-index read --id 'unit:检索返回的ID'
artifact-index read --id 'unit:检索返回的ID' --section metadata
artifact-index remove --id 'resource:资源ID'
```

`--db` 默认 `~/.1agents/artifacts/index.sqlite`；`--cache-dir` 保存派生页面和视频片段，不保存模型权重。`--no-semantic` 只解析与保存文字/定位，`--no-visual` 显式跳过页面图片或视频片段生成。扫描 PDF 和纯视频在缺少视觉向量时可能没有可检索内容，诊断会显示这一点。

搜索默认最多返回 15 条、约 12,000 字符预算，每个资源最多 3 个单元，避免一份长文档占满结果。结果包含 `resource_id`、`unit_id`、`source_node`、`source_uri`、原始定位、摘要与命中模态。图片/视频的匹配度不会与 Qwen 的余弦分数直接混比：每个 profile 内排序，再把名次转换为 `1 / (60 + rank)`；每个单元采用所有通道中的最高分，词法、文字向量与视觉向量不会累加投票。这样同一 PDF 页面拥有多种表示，不会仅因向量多而超过视觉通道第一名的视频。全部命中证据保留在 `matches`，同分按最佳命中所在通道的稳定顺序排列。

CLI 与服务的 `read` 按字符预算分页；默认读取正文，`--section metadata` 读取结构化单元格等元数据的 JSON，`--section representations` 读取表示清单的 JSON。根据 `next_offset` 继续使用 `--offset`，拼接各页 `text` 后即可恢复完整内容。库的 `index.read()` 保留完整结构。搜索 `offset` 上限为 10,000；`--modalities text` 仅查询文字空间，`image,video` 仅查询视觉空间，可减少已知内容类型下的模型切换。

更新文件后再次运行 `index`；成功后在 SQLite 事务中替换旧版本。若发现源文件已经变化或删除，而重建失败，旧快照会保留并标记 `stale`，默认搜索排除它。`list` 和直接 `read` 可看到状态与错误，显式 `remove` 删除该资源及其定位、向量关联。重复索引会复用同内容、同 profile 的向量，并重试之前缺少的向量。

默认资源为 `local`。通过 `index --sharing network` 显式改变该资源的分享范围；内容哈希只用于去重，不用于权限判断。

## JavaScript 库

```js
import { ArtifactIndex } from '@1agents/artifact-index';
import { createEmbeddingClient } from '@1agents/artifact-index/embeddings';
import { extractArtifact } from '@1agents/artifact-index/extract';

const index = new ArtifactIndex({
  dbPath: '/absolute/path/artifacts.sqlite',
  cacheDir: '/absolute/path/derived',
  sourceNode: 'scott-mac',
  extractor: (file, options) => extractArtifact(file, {
    ...options,
    python: '/absolute/path/parser-venv/bin/python',
  }),
  embeddings: createEmbeddingClient({ agent: 'http://127.0.0.1:36908' }),
});

try {
  await index.index(['/absolute/path/产品手册.pdf']);
  const text = await index.search('镜片参数', { modalities: ['text'] });
  const visual = await index.search('戴眼镜的人', {
    mode: 'semantic',
    modalities: ['image', 'video'],
  });
  const page = text.results[0] ? index.read(text.results[0].unit_id) : null;
  console.log({ text, visual, page });
} finally {
  index.close();
}
```

不传 `embeddings` 时仍可建立文字与定位索引；检索返回明确的 `semantic_status` 和降级信息。纯视觉资源不会伪造词法命中。索引与检索有模型请求超时、候选数量、返回数量和字符预算；某后端首批失败后，本轮索引停止继续请求该后端，其余表示标记为待补。

一个批次会先解析全部输入，再批量编码 Qwen 文字、Gemma 媒体，避免每一页来回切模型。长页可有多个重叠文字向量，但仍对应一个页码；同内容在不同位置共享编码，分别保留定位。

## 元结构和持久化

```text
resource：源文件身份、节点、URI、revision、分享范围、解析器版本、状态
  └─ unit：页面 / 幻灯片 / 单元格区域 / 时间片段，包含原始定位与全文
       └─ representation：文字块 / 页面图片 / 视频片段，包含内容哈希
            └─ vector：float32 向量 → profile：模型完整版本与编码约定
```

资源 ID 根据来源节点和 canonical realpath 生成，文件内容变化更新 revision，不改变资源身份。unit ID 根据资源与 locator 生成。`read().metadata` 还保留提取器的结构化单元格、表头、备注等字段；它们不会被当成新的源文件地址。

SQLite 使用 foreign keys、WAL 和事务；`PRAGMA user_version` 与返回值的 `schema_version` 都为 1。数据库版本高于当前支持范围时拒绝打开，不自动覆盖。文件解析失败不提交一半新页与一半旧页；提交前再次检查原始文件内容，避免把处理过程中改变的文件标成当前版本。

profile 包含 `id`、带 revision 的 `model`、`alias`、`revision`、`dimensions`、`encoding` 及可选 `task`。profile ID 不依赖服务地址、端口或进程。入库时验证向量维度、有限数值与单位范数；查询必须获得完全相同 profile 的向量。共享范围和类型在向量评分前过滤。

本包保留索引数据库和派生文件，模型卸载不会删除索引。`remove` 清理数据库中的资源和无引用向量；当前不会自动清理磁盘上的派生缓存或现有 Gemma inbox，可按实际缓存管理策略另行清理。

## 只读 DreamMate 服务

```sh
artifact-index serve --sharing local
# 显式允许网络共享资源：
artifact-index serve --sharing network
```

服务监听 loopback，由现有网关发布 `artifacts.search`、`artifacts.read`、`artifacts.list` 和 `artifacts.status`。远程调用不会触发新增索引、删除资源或扫描磁盘。`network` 服务仅返回标为 `network` 的资源；本机 `local` 服务可读取 owner 的本地与网络资源。新网关确认支持本地分享机制后才允许发布/调用 local 服务，旧网关会明确拒绝这一流程。

## 本地网络隔离

解析器禁止 Python 网络连接。派生转换命令在支持的平台使用额外系统隔离：macOS 的 `sandbox-exec`（`os-sandbox`）或 Linux 可用的用户网络命名空间（`os-network-namespace`）。FFmpeg 仅允许 `file,pipe` 协议，Office 使用移除外部关系的缓存副本并禁用宏。

若系统不提供这些能力，`doctor` 会返回 `application-only`，提取结果也会记录限制说明。该等级有应用内阻断与文件处理约束，但不等于对外部转换程序实施了系统级断网。需要严格断网的部署应使用系统隔离等级或由部署环境额外限制网络。

## 验证

```sh
npm test
npm run test:python
```

测试覆盖持久化、定位、版本替换/删除、陈旧快照、失败降级、向量验证、profile 隔离、融合排名、结果多样性和共享过滤。实际检索评估应同时使用可控 PDF/PPT/Excel 样本与已有短片，分别记录文字/视觉向量数、未完成表示、首次加载与热查询时间、命中位置和误命中。此文档不预设模型准确率，具体测评结果另附实际运行记录。

2026-10-18 的本机小样本验收：4 文件、13 个定位单元、32 个向量；按目标模态检索 12/12 查询首位命中，默认混合检索 8/12 首位、12/12 前三命中。热查询中位数约 193 ms；双模型互斥切换的真实混合查询为 15–59 秒。重复建库全部复用向量。完整方法、定位、误召回与测试限制见仓库的 `docs/artifact-index-evaluation.md`，不能外推为生产准确率。

## 独立发布

版本维护在本目录的 `package.json` 与 `CHANGELOG.md`。推送 `artifact-index-v<version>` tag 后，独立 workflow 在 Node 22.13/24 验证包、解析器和独立安装，再发布已测试的 tarball。DreamMate Node 使用自己的 `v<version>` tag，两者没有 npm 运行时依赖关系；本版的文档向量能力需要模型设备上的 Node 调度器至少为 `0.14.0`。

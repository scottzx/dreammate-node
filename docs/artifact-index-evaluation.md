# 统一产物索引：本地验收记录（2026-10-18）

独立包 `@1agents/artifact-index@0.1.0` 已完成本地建库、真实向量检索与 DreamMate 网关调用，配套共享调度器版本为 `@1agents/dreammate-node@0.14.0`。模型和权重复用现有工具检索服务；没有新下载模型。本记录描述发布前的本机验收，具体发布状态以 npm registry 为准。

## 样本与方法

本机 Apple M3 / 16 GiB，Qwen 与 Gemma 均为现有 MPS FP32 服务，互斥运行、空闲 60 秒卸载。解析器在 macOS 网络沙箱下运行，源文件及派生文件均在本地。测试过程中同时执行了仓库回归，以下耗时不能视为空闲设备吞吐。

受控 PDF/PPT/Excel 文档由本次验收生成，业务条款是虚构样例；视觉内容来自之前用户授权的眼镜、木马、产品短片。不是新的生产文档覆盖率测评。

| 文件 | 定位单元 | 文字/视觉表示 |
| --- | --- | --- |
| guide.pdf | 3 页 | 6 / 3 |
| briefing.pptx | 3 张幻灯片 | 6 / 3 |
| operations.xlsx | Equipment、Timeline、Finance 共 3 个单元格区域 | 10 / 0 |
| sequence.mp4 | 0–6、5–11、10–16、15–18.542 秒 | 0 / 4 |

合计 4 个源文件、13 个单元、32 个向量、2 个 profile、0 个待补表示。SQLite 为 286,720 字节（280 KiB），派生页面/片段约 5.4 MiB，不包含模型权重。Excel 的 Equipment!D4 保留 `=SUM(D2:D3)` 和已有缓存值 4080，并未重新计算公式。

12 条中英文查询及 14 个预期位置在推理前固定；答案集 SHA-256 为 `aea740a3feadd1ee4b0c53120096cce8ed0c8da4720a7fcb232e282cb69b21f8`。PDF 第 3 页和 PPT 第 2 张只有 Reference A/B 标签，没有眼镜、木马关键词；不把生成提示词当作画面命中证据。视频以返回窗口至少一半落入预期内容区间算定位命中；返回的是索引切段窗口，并非逐帧物体轨迹。

初轮记录完整模型调用耗时。最终排名验收先按模型分组进行真实查询编码，再用相同 profile 的查询向量重放最终检索算法，避免每条混合查询反复加载模型；重放耗时未计作线上查询性能。另外对“眼镜”“木马”和采购审批运行了真实默认混合链路。

## 检索结果

Top1/Top3 指一条查询至少一个预期位置进入首位/前三。最后一列单独统计全部预期位置，避免一个内容有文档与视频两个答案时只报其中一个。

| 方式 | 查询 Top1 | 查询 Top3 | 全部预期位置进入 Top3 |
| --- | --- | --- | --- |
| 词法基线 | 4/12 | 5/12 | 5/14 |
| 按目标模态的向量检索 | 12/12 | 12/12 | 14/14 |
| 默认混合检索 | 8/12 | 12/12 | 13/14 |

按模态向量检索本次全部命中，但样本仅 12 条，不能外推为生产准确率。混合检索仍有跨模型误召回：例如“眼镜”首位是 0–6 秒视频、第 3 位是 PDF 眼镜页，第 2 位仍混入不相关 Finance 区域。两个模型内的第一名不代表相同置信度。已消除 PDF/PPT 多表示重复投票优势；每单元仅取最佳排名分，保留全部命中证据。

| 预先固定的查询 | 按目标模态向量检索的预期位置与排名 |
| --- | --- |
| 离线备份要保留多久，恢复之前怎样确认文件完整？ | guide.pdf · 返回 第 1 页：第 1 名 |
| Who must sign off when an equipment order costs more than five thousand yuan? | guide.pdf · 返回 第 2 页：第 1 名 |
| 超过五千元的采购需要谁书面批准？ | guide.pdf · 返回 第 2 页：第 1 名 |
| 戴圆形眼镜的年轻男子 | guide.pdf · 返回 第 3 页：第 2 名<br>sequence.mp4 · 返回 0–6 秒：第 1 名（预期内容 0–6 秒） |
| 木制的马形道具，底座上有车轮 | briefing.pptx · 返回 第 2 张：第 1 名<br>sequence.mp4 · 返回 5–11 秒：第 3 名（预期内容 6–12 秒） |
| Which encoder handles document text and which one handles visual media in the offline design? | briefing.pptx · 返回 第 3 张：第 1 名 |
| 这个项目能给哪些文件类型返回精确的位置？ | briefing.pptx · 返回 第 1 张：第 1 名 |
| 头戴设备计划买几台，每台多少钱？ | operations.xlsx · 返回 Equipment!A1:E4：第 1 名 |
| What is the combined procurement budget for the cameras and headsets? | operations.xlsx · 返回 Equipment!A1:E4：第 1 名 |
| 本地网关安排哪一天部署，由谁负责？ | operations.xlsx · 返回 Timeline!A1:D4：第 1 名 |
| When is the LocalLens equipment invoice due and has it been paid? | operations.xlsx · 返回 Finance!A1:E3：第 1 名 |
| 穿红色衣服的女子在展示产品 | sequence.mp4 · 返回 15–18.542 秒：第 1 名（预期内容 12–18.542 秒） |

## 耗时、缓存及日常用法

| 环节 | 实测 |
| --- | --- |
| 首次建库，含解析、渲染、加载与编码 | 182.14 秒 |
| 重复建库 | 14.12 秒；32/32 表示复用；0 次编码调用 |
| Qwen 首次查询，含切换与加载 | 31.54 秒 |
| Gemma 首次查询，含切换与加载 | 26.95 秒 |
| 已加载模型的单模态查询 | 145–225 ms，中位数 193 ms |
| 真实默认混合查询：眼镜 | 15.49 秒 |
| 真实默认混合查询：木马 | 58.95 秒 |
| 真实默认混合查询：超过五千元的采购需要谁书面批准？ | 36.10 秒 |

混合查询每次可能查询两个向量空间，在单模型互斥策略下发生卸载/加载，明显慢于已知内容类型的查询。日常明确搜索文档时使用 `--modalities text`；查画面或视频使用 `--modalities image,video`，搭配 `--mode semantic`。跨全部内容的默认混合搜索适合召回候选，本次 Top3 为 12/12、首位为 8/12。

```sh
artifact-index search --query '采购审批规则' --modalities text --mode semantic
artifact-index search --query '戴圆形眼镜的年轻男子' --modalities image,video --mode semantic
artifact-index read --id UNIT_ID --section metadata
```

模型卸载后 SQLite 和派生内容保留。无模型时文字降级词法检索；实际已有向量库关闭 client 后，采购页仍可检索，纯视觉查询返回空结果及 `visual_search_unavailable`，不伪造视觉命中。

## 包边界与验证

- 新包 Node 测试 46 项、Python 解析测试 9 项通过；Qwen task 适配器 Python 20 项通过。
- Skill Manager 60 项、跨包集成 14 项通过；根目录类型检查通过。
- 三包独立 tarball 安装、严格 TypeScript 示例、包白名单及真实 HTTP 服务边界通过。网关不包含产物索引代码；产物包没有运行时 npm 依赖、模型下载钩子、权重或用户文件。
- 实际 scott-mac 网关完成 search → inspect → invoke：发现 `artifact-index/artifacts.search`，读取采购 PDF 第 2 页，并分页读取 Excel 结构化元数据。
- 根目录整套测试首轮 365/367 通过；在并发建库负载下，两项旧 MCP 时序测试失败。分页案例单独复测通过；模型卸载、其他套件结束后，private-exit 文件 7/7 通过，两个原失败的 1800 ms 截止时间案例恢复。本次未修改相关生产代码或放宽测试；首轮完整运行仍记录为失败，不能把分开复测说成同一次全绿运行。

当前范围：PDF/PPT 页图可做视觉检索；扫描页未 OCR；视频仅画面、无语音转写；Excel 不自动渲染图表、不计算公式。缺少模型或转换器时有明确诊断。Linux 若无网络命名空间仅为 application-only 隔离等级；本机验收为 os-sandbox。

## 本机复现记录

验收目录：`.local/tool-search/artifact-index-eval-20261018/`。主要文件为 `ground-truth.json`、`manifest.json`、`final-results.json`、`index.sqlite`、`query-vectors.json`、`fallback.json` 和测试日志；这些样本、模型输出和数据库不会随 npm 包发布。

参考 [独立包使用文档](../packages/artifact-index/README.md) 与 [共享模型契约](local-embeddings.md)。

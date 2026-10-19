# Changelog

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

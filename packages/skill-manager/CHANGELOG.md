# Changelog

本文件只记录 `@1agents/skill-manager` 的版本，与 DreamMate Node 独立维护。

## 0.2.0

- 提供独立 HTTP 服务与 `dreammate-skills serve`，默认监听本机 `127.0.0.1:36909`。
- 使用 `dreammate.skills.v1` 协议向 Node 报备目录、版本化读取和来源管理方法，定期重报备，网关离线时继续提供本地能力。
- 提供 macOS / Linux 用户级服务安装、状态和卸载命令，独立管理进程生命周期。
- Node 移除对本包的生产依赖，兼容技能路由改为代理已报备服务，双方可分别构建、安装和发布。
- 发布包验收分别验证单包安装和两个独立服务的报备与读取。

## 0.1.0

- 提供独立的 `SkillSourceManager` 库和 `dreammate-skills` CLI，无运行时 npm 依赖。
- 发现常见智能体的用户级、系统级共享技能目录，并通过可选的 `1session projects` 接入项目工作目录。
- 管理来源、目录去重、删除排除和并发配置写入，按整包 SHA256 版本读取原始指南与资源。
- 提供通用技能解析、目录读取、归档和安装 API，网关保留兼容导出。
- 将来源、发现和 CLI 测试放入包内，提供独立类型检查、构建、测试和 tarball 安装验证。

该版本记录描述包的内容；是否已发布以 npm registry 中的版本为准。

# 个人 Demo：凭证配置与授权范围

决策日期：2026-09-29。

当前是个人演示 Demo，沿用可信主机与个人 Tailnet 网络的假设。优先跑通现有 MCP 服务的发现与调用；DreamMate 层的授权系统暂不实现，也不作为 Plane 接入的前置条件。

## 当前采用的轻量方案

- 一个 Plane 实例、一个工作区、一份现有 API Key。
- 在运行 Plane MCP 的节点本地配置 `PLANE_BASE_URL`、`PLANE_WORKSPACE_SLUG` 和 `PLANE_API_KEY`，由启动程序读取并传给 MCP 子进程。
- 可以使用仓库外的本地环境配置文件，并限制文件访问权限；不建设统一凭证库或 `SecretStore` 抽象。
- API Key 不写入代码仓库、服务注册表、技能包或日志，也不作为 `dreammate_invoke` 的参数。
- DreamMate 薄适配器负责工具发现、Schema 映射、调用转发和进程生命周期；不增加调用方角色、授权弹窗、操作白名单或短期租约。
- 上游 Plane 自身的认证和权限检查继续生效。暂缓的是 DreamMate 内部授权，而非取消 Plane 必需的 API Key。

此方案默认能访问该服务的可信调用方共享配置凭证的能力，不提供不同 Agent、用户或设备之间的权限隔离。

此处定义接入范围。2026-09-29 已按此方案部署官方 Plane MCP 与薄桥接：30 个官方工具接入现有 `plane-pm` 服务，已验证工作区、项目、工作项及迭代的只读调用。部署代码和维护说明见 [Plane MCP 薄桥接](../deploy/plane-bridge/README.md)。

## 后续需求：暂缓，不阻塞 Demo

当出现多人使用、共享给非完全可信的设备，或需要不同调用方拥有不同权限时，再评估以下需求：

- [ ] 区分业务连接、上游凭证与调用授权（Connection / Credential / Grant）。
- [ ] 统一凭证引用与存储，支持轮换、撤销及未来的 OAuth。
- [ ] 验证调用方身份，并限制可使用的连接或角色；不能仅凭选择 admin 服务 ID 获得权限。
- [ ] 在服务端校验具体工具操作；对 Plane 一类带 `action` 的工具按操作授权。
- [ ] 分开呈现服务在线状态与凭证授权状态，提供重新授权流程。
- [ ] 记录调用审计信息并脱敏；按需实现 DreamMate 内部短期调用凭证。

上游 API Key 与 DreamMate 内部调用凭证各自独立，内部租约失效不意味着上游 API Key 被撤销。长期安全方向见 [安全架构规范](security-architecture.md)，不在本轮实现。

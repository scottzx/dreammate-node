# Plane MCP 薄桥接

复用 [Plane 官方 MCP](https://github.com/makeplane/plane-mcp-server)，不重写业务 REST API。个人 Demo 共用本地配置凭证，不实现 DreamMate 内部授权系统。

调用链：DreamMate Windows 网关 `:36908` → WSL 回环桥接 `:7792` → 官方 MCP stdio 子进程 → Plane `:8082`。

## 文件与部署

- `bridge.mjs`：读取 tools/list，转换方法 Schema，转发 tools/call。
- `windows-register.mjs`：将 WSL 桥接的目录注册到 Windows 网关，15 秒刷新一次。
- `dreammate-plane-bridge.service`：WSL systemd 服务，自动启动与故障重启；停止时清理整个进程组。
- `requirements.txt`：固定官方 MCP 版本；`requirements.lock.txt` 记录部署时完整 Python 依赖，`package-lock.json` 固定桥接依赖。

当前部署目录为 `/home/scott/.local/share/dreammate-plane/`：`venv/` 安装官方 Python MCP，`bridge/` 放置桥接及 npm 依赖。在 WSL 中执行：

```bash
python3 -m venv /home/scott/.local/share/dreammate-plane/venv
/home/scott/.local/share/dreammate-plane/venv/bin/pip install -r requirements.lock.txt
# 在部署后的 bridge/ 目录中：
npm ci --omit=dev
sudo cp dreammate-plane-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dreammate-plane-bridge
```

凭证由 systemd 读取 `/home/scott/.config/dreammate/plane.env`（权限 600），包含 `PLANE_API_KEY`、`PLANE_BASE_URL`、`PLANE_WORKSPACE_SLUG`。密钥仅传给官方 MCP 子进程，不进入注册表、参数或部署文件。轮换配置后重启桥接即可。

Windows 将 `windows-register.mjs` 放到 `C:\Users\Administrator\.1agents\`。现有 `dreammate-runtime.mjs` 得到 registry 后调用：

```js
const { attachPlaneRegistration } = await import('./windows-register.mjs');
await attachPlaneRegistration(registry);
```

重启 Windows 的 `DreamMate Node` 计划任务使其生效。桥接出现后会替换原有 `plane-pm` 状态服务，保留 `plane-pm.status` 方法。

## 使用与验证

先通过 `dreammate_inspect` 查询实际方法契约，再调用：

```json
{
  "node": "100.125.201.118",
  "service_id": "plane-pm",
  "method": "plane.project",
  "params": { "action": "list", "per_page": 5 }
}
```

桥接透传官方 MCP 的 `content`、`structuredContent`、`isError`。已完成的工具调用（包括业务错误）使用 HTTP 200，调用方必须检查 `isError`；真正的传输失败使用 502，超时使用 504。错误分类放在 `_meta.dreammate_upstream`，含 `kind`、`upstream_status`、`status_source`（能从明确的官方错误格式提取时）与 `retryable:false`。没有可靠状态时返回 null，不猜测。超时不自动重试，避免重复创建或修改。所有工具沿用上游 Schema 和 annotations；annotations 不充当授权规则。

`/health` 和 `plane-pm.status` 只验证 API 凭证与连通性，返回 `checked_at`、`service_health.scope=api_credentials` 和 `methods_verified:false`，不保证每个方法可用。离线时状态调用使用 HTTP 503。

`metadata.method_availability` 默认将每个工具标记为 `unknown`。真实调用后保存最近 20 条 action/资源范围观测，记录成功、失败、时间与错误分类；不存正文、凭证，也不主动发写请求探测能力。单资源 404 仍是 unknown，不会把整个工具禁用。Windows 注册器每 15 秒同步观测，重启后观测重新开始。

### 当前部署的 Pages 限制

2026-09-29 对实际 `makeplane/plane-backend:v1.4.2` 容器进行了只读路由核查：`plane.api.urls` 没有 Pages，Django `resolve()` 对工作区和项目级 `/api/v1/.../pages/` 都返回 `NO_ROUTE`；只有网页端 `/api/workspaces/.../pages/` 存在。已安装的 `plane-sdk 0.3.1` 使用 `/api/v1`，因此 Pages 404 来自该部署缺少公开路由，不是 Dreammate 发现失败。

随附 `capabilities.plane-v1.4.2.json` 保存这个部署的证据和替代方案。仅在相同部署确认后启用：

```ini
# systemd drop-in [Service] 或现有 EnvironmentFile；不用修改凭证
PLANE_CAPABILITIES_FILE=/home/scott/.local/share/dreammate-plane/bridge/capabilities.plane-v1.4.2.json
```

若使用 systemd 的 `[Service]` 段，写成 `Environment=PLANE_CAPABILITIES_FILE=...`。启用后方法仍保持 declared，但 availability 为 unsupported，调用直接给出明确原因与替代方案，不再发送必然失败的上游请求。PRD 可保存到 `plane.workitem.description_html` 并回读，或由用户在网页端维护独立页面。没有自动切换到网页内部 API。

配置是显式、可撤销的部署限制，不按版本字符串自动猜测支持度；升级 Plane 后先重新核查公开路由，再移除/更新限制文件并重启桥接。新源码和限制文件需要部署并重启服务才生效。

官方工具目录不代表当前 Plane 版本支持所有操作。当前自托管 Plane 为 v1.4.2，高级或版本受限接口需按实际结果判断。

2026-09-29 已部署官方 MCP 0.3.3，注册 30 个官方工具及兼容的状态方法。通过 DreamMate 实测 workspace retrieve、project list、workitem list、cycle list 成功；验证了参数透传、上游错误保留、密钥脱敏和不自动重试写操作。业务写入未执行，高级接口未逐一验证。

```bash
node --test deploy/plane-bridge/bridge.test.mjs  # 仓库根目录
sudo systemctl status dreammate-plane-bridge
sudo journalctl -u dreammate-plane-bridge -n 30
curl http://127.0.0.1:7792/health
```

桥接仅监听 WSL 回环，不新增公网端口。Windows 通过 WSL localhost forwarding 访问它。删除 Windows runtime 中的 attachPlaneRegistration 调用并重启原计划任务，即可恢复原有状态目录；再停止/禁用新建的 systemd unit 即可撤回桥接，不涉及 Plane 业务数据或 API Key 的吊销。

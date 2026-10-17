# @1agents/skill-manager

独立的本机 Skill 管理服务、来源管理库和命令 `dreammate-skills`。原件保留在项目或智能体共享目录，来源配置只保存目录位置，技能摘要和内容版本从源文件生成，完整指南与资源按需读取。读取不会执行技能脚本。

## 向 Node 提供技能管理能力

Skill Manager 使用本机 HTTP 向 DreamMate Node 报备，Node 为客户端提供统一发现、路由和调用入口。双方没有彼此的运行时 npm 依赖；Manager 核心与离线 CLI 不需要网关。

```text
智能体 → Node :36908 → Skill Manager 127.0.0.1:36909 → 技能原目录
                     ↑ POST /services 报备
```

```bash
npm install -g @1agents/skill-manager
dreammate-skills serve --agent http://127.0.0.1:36908
# 自定义来源配置和端口；只发现共享目录
dreammate-skills serve --port 36909 --agent http://127.0.0.1:36908 --config ~/.1agents/skill-sources.json --no-projects
# 不报备，只运行本地 HTTP 服务
dreammate-skills serve --no-register
```

默认监听 `127.0.0.1:36909`，只允许本机访问服务端口。接入层每 15 秒报备一次，Node 未启动或暂时离线不会使 Manager 退出；恢复后自动重报备，正常退出时注销。远端通过 Node 调用，无需访问 `36909`。

需要长期运行时，在 macOS 或具有 systemd user 的 Linux 使用独立的守护进程命令：

```bash
dreammate-skills install --agent http://127.0.0.1:36908
dreammate-skills status
dreammate-skills uninstall
```

Node 与 Manager 各自管理进程。卸载守护进程保留来源配置和技能原件。没有受支持的系统托管环境时，使用前台 `serve` 或已有进程管理器。

报备包含 `metadata.skill_provider.protocol = "dreammate.skills.v1"`，声明 `catalog`、`read`、`sources`、`add_source`、`remove_source`、`refresh_sources`、`discover_sources` 方法。管理来源的方法列入 `metadata.local_only_methods`，Node 的通用调用入口也只允许从 loopback 发起这些方法。Node 的 `/skills` 和 `/skills/sources` 兼容路径转发到该服务；没有提供者时返回 HTTP 503，Node 不承担目录扫描或来源配置。

```bash
# 下面命令由 Node 转发给已经报备的 Manager
dreammate-node skills discover --no-projects
dreammate-node cli search-skills --agent http://127.0.0.1:36908 --query '三维灯光与材质'
```

## 不经过网关使用

```bash
dreammate-skills discover
dreammate-skills sources
dreammate-skills list
dreammate-skills read --skill '检索返回的技能ID' --revision '检索返回的SHA256'
dreammate-skills read --skill '技能ID' --revision 'SHA256' --resource references/stages.md
```

`discover` 自动登记当前设备已有的常见共享目录，并通过本机 `1session projects` 获取工作目录，再检查各项目的约定技能位置。未安装 `1session` 时，共享目录发现仍会完成，并在 JSON 中返回项目发现状态和诊断；使用 `--no-projects` 可只扫描共享目录。

```bash
dreammate-skills discover --no-projects
dreammate-skills add --name tesla --project /absolute/tesla-project
dreammate-skills add --name visual --dir ~/.agents/skills/threejs-visual-iteration
dreammate-skills remove skills-visual
```

来源配置默认为 `~/.1agents/skill-sources.json`，由 Skill Manager 维护。命令可用 `--config PATH` 指定独立配置，路径支持相对路径和 `~/`。`sources`、`list`、`read` 只使用已登记来源，不运行自动发现。`remove` 仅移除来源记录，保留技能原文件。

服务在读取时自动感知独立 CLI 的配置改动。并发写入通过同目录 `${config}.lock` 互斥，冲突返回 409，重新读取后重试即可。正常写入会清理锁；进程异常退出遗留锁时，先读取其中的 PID，确认原进程已停止，再删除该锁并重试。

自动发现兼容 `.agents`、Claude、Codex、Gemini CLI、Antigravity、Grok、DSH 的常见用户级位置，尊重已支持的环境覆盖，并只探测已知的系统级位置。相同真实目录通过符号链接出现在多个位置时合并发现记录；同名但原件不同的技能保留独立身份。项目工作目录来自可选的 `1session`，不递归扫描整个用户目录，也不保证包含会话中每一次命令切换的 PWD。

读取必须使用摘要返回的整包 SHA256 `revision`。任一指南、脚本或资源变化都会使旧版本失效，调用方需重新获取摘要。资源路径限定在技能包内；返回 UTF-8 文本或以 `base64` 标识的二进制内容。读取脚本仅返回文件内容，执行位置和依赖由使用方确定。

一次性命令的 stdout 输出 JSON。退出码 `0` 表示成功，`1` 表示运行失败或部分发现/扫描失败（已完成部分仍保留），`2` 表示参数无效。参数校验在读取或修改配置之前完成。`serve` 持续运行，监听成功后输出服务地址及报备状态，运行诊断写入 stderr。

```ts
import { SkillSourceManager } from '@1agents/skill-manager';

const manager = new SkillSourceManager();
await manager.discover({ projects: false });
const { skills } = await manager.catalog();
if (skills[0]) {
  const guide = await manager.read(skills[0].id, skills[0].revision);
  console.log(guide.content);
}
```

本包负责来源发现、扫描、去重、版本与资源读取，也保留 `loadSkillsFromDir`、`parseSkillMarkdown`、`archiveSkill`、`listSkillArchive` 和 `installSkillPackage` 等通用包处理 API。`createSkillService` / `serveSkillService` 提供 HTTP 与报备接入。DreamMate 节点发现、跨节点检索、MCP 和模型发现属于 Node；技能正文不作为长期缓存保存。

## 独立开发与验证

同仓开发使用 npm workspace，仅共享开发工具与测试入口。Node 的生产代码没有本包依赖，也不加载本包源码。仓库根目录安装依赖后，可单独运行：

```bash
npm ci --ignore-scripts
npm run check --workspace @1agents/skill-manager
npm pack --workspace @1agents/skill-manager --pack-destination /tmp
```

`check` 包含源码与包内测试的类型检查、包内测试和构建。测试覆盖来源登记、版本资源读取、共享与项目目录发现、并发配置写入、独立 CLI 及服务报备。Node 的代理协议与跨节点检索测试保留在仓库根目录，两个发布包的真实集成通过根目录 `npm run test:packages` 验证。

本目录也可以复制到仓库外独立开发：

```bash
cd /absolute/path/to/skill-manager
npm install --workspaces=false --package-lock=false --ignore-scripts
npm run check
npm pack
```

CI 在 Node 22 和 24 上把本目录复制到仓库外，独立安装开发依赖、检查并打包，再把 tarball 安装进没有 Node 包或源码的消费项目，验证标准包导入、版本化读取和 CLI。无需安装 `1session` 或运行其他智能体。

## 版本与发布

版本只在本目录的 `package.json` 中维护，变更记录写入 [CHANGELOG.md](./CHANGELOG.md)。Node 与 Manager 通过 `dreammate.skills.v1` 协议协作，各自的版本和发布没有先后依赖。变更协议时，应验证已有兼容路径与客户端行为。

```bash
npm version patch --workspace @1agents/skill-manager --no-git-tag-version
npm run check --workspace @1agents/skill-manager
npm run test:packages
npm pack --workspace @1agents/skill-manager --pack-destination /tmp
```

`npm version` 同时更新仓库锁文件。检查生成的 tarball 和消费项目安装结果后，将版本、变更记录与锁文件一起纳入提交。独立标签约定为 `skill-manager-v<version>`。该标签以及手动触发的 [Skill Manager workflow](../../.github/workflows/skill-manager.yml) 只检查并上传 tarball；标签版本必须与包版本一致。

实际发布是单独的操作：对已经验证的 tarball 执行 `npm publish /absolute/path/1agents-skill-manager-<version>.tgz --access public`。Skill Manager 的 CI 不执行 npm 发布，也不需要发布凭据。发布完成后，再验证 `npm install @1agents/skill-manager@<version>` 和 `dreammate-skills --help`。

根目录的 `npm run test:packages` 分别验证 Node 单包安装、Manager 单包安装，再在临时消费项目启动两个独立进程，验证真实服务报备和技能读取；不会通过仓库源码或全局安装包补齐缺失依赖。

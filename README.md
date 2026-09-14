# @1agents/dreammate-node

> DreamMate Network 的**本机 node agent**：节点身份、服务报备、探活。
> 固定监听 **36908**。零运行时依赖（除了 L0 协议包）。

一台机器跑一个。它是这台机器对网络的唯一入口——外部节点探这一个端口，
就能知道这台机器上有什么：

```
        Control Plane / 任意节点
                  │  探 36908（每台机器只探一个端口）
                  ▼
        node-agent :36908
         ├─ GET  /manifest      本机聚合视图：节点身份 + 所有已报备的服务
         ├─ GET  /health
         ├─ GET  /services      各服务的存活与可达性
         ├─ POST /services      服务报备（**仅接受 localhost**）
         └─ DELETE /services/:id
                  ▲
      ┌───────────┴───────────┐  localhost 报备
 session-reader :7777    task-service :xxxx
```

这把 pull 探测的成本从「N 个节点 × M 个端口」降到「N × 1」。

## 跑起来

```bash
npm i -g @1agents/dreammate-node
dreammate-node install      # 装成开机自启的常驻服务
dreammate-node status       # 看服务与端口状态
dreammate-node uninstall
```

macOS 装 launchd LaunchAgent（`~/Library/LaunchAgents/work.dreammate.node.plist`），
Linux 装 systemd user unit（`~/.config/systemd/user/dreammate-node.service`），
**两边都不需要 sudo**——agent 只读本机服务清单，没有要 root 的理由。
挂了会自动拉起（KeepAlive / Restart=always），日志在 `~/.1agents/logs/`。

> Linux 上用户级 systemd 服务在登出后会被停掉，服务器上要真常驻得开 linger：
> `sudo loginctl enable-linger <user>`。`install` 会检测并提示。

前台跑（调试用）：

```bash
dreammate-node                        # 0.0.0.0:36908
dreammate-node --host 127.0.0.1       # 只对本机可见
```

## 服务怎么报备

```ts
import { reportAndHoldRegistration } from '@1agents/dreammate-node/client';

await reportAndHoldRegistration({
  id: 'session-registry',
  kind: 'session_registry',
  capabilities: ['sessions.list', 'sessions.read'],
  port: 7777,
  reachability: 'localhost',   // 或 'network'
});
```

**报备是可选的，而且永不抛错。** agent 没装、没起、版本对不上，服务都该照常
工作——返回值告诉你成没成，要不要提示用户由你决定。不报备也能被发现，只是
外部得靠[约定端口](https://github.com/scottzx/dreammate-network)碰运气。

## 两件容易想错的事

**Node 在线 ≠ Service 在线。** tailnet 的 `Online` 只说明机器开着；进程被 kill
了它照样报在线。所以 agent 必须自己定期探各服务的 `/health`，连续失败 5 次
才移除——抖一下不该被清掉。

**agent 不做代理。** `reachability: 'localhost'` 的服务，manifest 里如实写
`http://127.0.0.1:<port>`，让调用方一眼看出连不上，而不是给一个看着能连、
连上却超时的地址。要对外服务就自己监听 `0.0.0.0`。

## 为什么报备只认回环

`POST /services` 是整个 agent 唯一的写入口。不限制的话，网络上任何人都能往
你的节点里塞一个假服务，把调用方引到别处去。注销同理——否则别人能把你的服务
从网络上摘掉。

## 节点身份

优先取自 tailnet（`tailscale status --json` 的 `Self`，缓存 60s），本机所有
进程读到同一份，不会各自生成 id 把一台机器裂成几个 Node。

```
node_id   nigVtDS1s521CNTRL    ← tailscale ID，重启不变
name      scott-mac            ← DNSName 前缀，不是 HostName
type      macos                ← 由 tailscale 的 OS 映射
```

> ⚠️ 名字取 **DNSName** 而非 HostName：iOS 设备的 HostName 全是 `localhost`，
> 实测一个 11 节点的 tailnet 里只有 9 个 HostName 唯一。

> ⚠️ **找 tailscale 不能只靠 PATH。** launchd 给的 PATH 只有
> `/usr/bin:/bin:/usr/sbin:/sbin`，systemd 的也好不到哪去，而 homebrew 的
> tailscale 在 `/opt/homebrew/bin`。不处理的话，装成常驻服务后会静默回退到
> 本地身份——同一台机器在前台和服务模式下变成**两个 Node**，而且没人会注意到。
> 所以这里除了 PATH 还会依次试几个已知位置，plist / unit 里也补了 PATH。
> 装在别处用 `DREAMMATE_TAILSCALE_BIN` 指定。

没装 / 没登录 tailscale 时静默回退到本地身份（hostname + 首次生成的 uuid，
存在 `~/.1agents/node.json`），`metadata.identity_source` 如实报告来源。

## 它在架构里的位置

node 注册与探活是从 Control Plane 里**领出来**的——原本设想中 Control Plane
的其余职责（Task、Agent 编排、Execution 账本）降级为平级的普通服务，各自独立
起进程、各自向本机 agent 报备。于是不再有「必须先起 Control Plane」的启动顺序，
任何一个服务挂掉也不会让整个控制面消失。

协议定义见 [`@1agents/dreammate-network`](https://github.com/scottzx/dreammate-network)（L0）。

# DreamMate DSH plugin

Source module for the DeepSeek Harness integration. It is embedded into
`@1agents/dreammate-node` at pack time and is not published on its own.
Activating the plugin reuses a healthy local `dreammate-node`, or starts one
from the same installed package when no node is running. No separate global
install, MCP configuration or daemon command is required.

## Install

From a DSH checkout (Node.js >=22.19):

```sh
pnpm dsh plugin --profile web remove @1agents/dsh-dreammate-node
pnpm dsh plugin --profile web add @1agents/dreammate-node
pnpm dsh web
```

Restart an already running DSH after installation. Use `desktop` instead of `web`
for that profile; omit `pnpm` when using an installed `dsh` executable.
Remove the old `@1agents/dsh-dreammate-node` bundle first. Do not enable both.
The plugin id stays `dreammate-node`. Custom rows must name `@1agents/dreammate-node`,
the package root, not a subpath.
`@1agents/dreammate-node` declares `dsh.bundle.patch` and registers the Host plugin.
Installing it does not start a service by itself. The package `postinstall` can
install bundled skill guides; see [automatic skill installation](../../README.md#npm-安装时自动安装对应-skill).

Ask the DSH Agent to find devices/services, inspect a method, then call it:

> 查看 DreamMate 网络中有哪些设备，查找转写服务，读取它的方法契约。

The embedded plugin registers the package's exported tools, except `dreammate_access`. Tool search, skill search and
versioned skill reads sit alongside discovery, inspection, invocation and lifecycle
tools. Their original JSON schemas and descriptions are used. Public-access tokens stay
on the loopback control port and the `dreammate-node access` command; a DSH tool cannot
enable public access or reveal the token.
Results retain the complete MCP envelope as JSON, including structured data and
non-text blocks; MCP business errors also become DSH tool failures. Calls pass
through the normal DSH tool policy pipeline. Native ACP sessions execute their
own Agent tools and do not automatically gain these DSH tools.

Tool and skill discovery use bounded results and load full method contracts or
skill resources only when requested. Optional local embeddings use separately
prepared model services. See the [gateway discovery guide](../../README.md#智能体怎么发现和调用)
and [local embeddings](../../docs/local-embeddings.md). Update an older DSH profile's
dependency and lockfile together; an already running external node must be checked
and upgraded separately. This documentation update does not publish a package or
change a running deployment.

This plugin lets DSH consume the capability network. It does not publish DSH
sessions as a remotely callable service.

## Lifecycle and configuration

The `dreammate-node` row in the profile's `cordis.patch.yml` accepts:

```yaml
- id: dreammate-node
  config:
    serviceMode: auto
    serviceUrl: http://127.0.0.1:36908
    serviceHost: 0.0.0.0
    serviceStartupTimeoutMs: 15000
    serviceShutdownTimeoutMs: 5000
```

`auto` checks `/health` and requires `service: node-agent`, `status: ok`. Only
connection refusal permits startup. Authentication errors, foreign listeners,
invalid health responses and timeouts fail initialization. Auto startup applies
only to plain HTTP root URLs on `127.0.0.1`, `localhost` or `[::1]`. Other addresses
and `serviceMode: external` never start a local process; connectivity is checked
when a tool is called. URLs may not include credentials, queries or fragments.

The managed node listens on `0.0.0.0:36908`, matching the normal dreammate-node
daemon so other LAN/Tailnet nodes can discover it. Set `serviceHost: 127.0.0.1`
for local-only access. IPv6 loopback URLs default to `::`. The service uses the
existing machine identity, registry and local service rediscovery; it does not
install launchd/systemd services or alter DSH source. Use matching address families
for `serviceUrl` and `serviceHost`.

A node started by this plugin enforces the same public-access rule as `dreammate-node`:
loopback and trusted zones are admitted, and everyone else is refused until public
access is enabled. It also listens on `127.0.0.1:36910` for that switch when the port
is free. An existing access listener is left alone, and releasing the plugin stops
only the listener it opened. An already running external node keeps whatever access
plane its own process started.

Concurrent instances in one Host share a process lease. Disposal releases tools
and stops only the child started by this plugin, after its last lease is released.
An existing node is never stopped. The child also exits on parent IPC loss. For a
node shared by multiple independent DSH processes, run a persistent external
`dreammate-node install`; stopping an owning DSH process would otherwise affect
the other consumers. Child crashes surface as gateway failures; reload the plugin
to start a replacement. Calls are never automatically replayed. Cancellation is
checked before dispatch and after settlement; already dispatched gateway work
uses its own timeouts and may still complete remotely.

## Tailnet trust adapter (`yima-tailnet-trust`)

The bundle also ships `yima-tailnet-trust.mjs`, a loader adapter beside
`cordis.patch.yml`. It keeps the contract of the standalone dsh-config profile
extension of the same name: it trusts exactly one Tailscale DNS `host:port`
authority in the DSH Connection carrier, so the Yima phone/browser entry can
reach DSH through Tailscale Serve, which preserves the Host header.

The `yima-tailnet-trust` row ships `disabled: true` with an empty authority. A
profile enables it and replaces the config wholesale with its real authority:

```yaml
- id: yima-tailnet-trust
  disabled: false
  config:
    authority: "scott-mac.tailfb4720.ts.net:3080"
```

The adapter refuses anything but an exact lowercase `*.ts.net` authority —
normally `host:port`, as the preserved Host header arrives; a bare host is also
accepted and matches the port-443 entry. No scheme, userinfo, path, query or
fragment passes. It withdraws the trust again when the row is disposed, and
never removes an authority that was already trusted before the row activated.

## Shared loopback adapter (`yima-shared-loopback`)

The bundle also ships `yima-shared-loopback.mjs` beside `cordis.patch.yml`. It
opens a fixed loopback HTTP listener (`127.0.0.1` or `::1`) backed by the
desktop profile's own web server so Tailscale Serve can proxy the phone and
browser without starting a second `dsh web` process.

The `yima-shared-loopback` row ships `disabled: true`. A profile enables it and
sets its loopback port:

```yaml
- id: yima-shared-loopback
  disabled: false
  config:
    host: 127.0.0.1
    port: 3466
```

By default, remote traffic arriving on this loopback listener gets low-bandwidth
slimming on `/api/remote.mux` (`session/follow`, `session/observeEvent`) and
`POST /api/session/page` / `/api/session/events`: user and assistant message
blocks stay intact, tool calls keep only their tool name, tool outputs/meta and
redundant replay streams are omitted, WebSocket deflate level is raised to 6,
and the heartbeat interval is widened to 15s. The initial history window is
clamped to 200 messages and asks for at least 50 messages across two turns, so
a phone keeps a readable slice of a long conversation without letting one
session ship its whole history in a single frame. Measured on the six longest
sessions of a real profile, the first frame stays between 30 KB and 187 KB on
the wire. Set `slim: false` in `config` to disable slimming and fall back to
transparent passthrough. The local Electron desktop UI never traverses this
listener and stays 100% untouched.

The first-frame list endpoints are slimmed on the same entry:
`POST /api/session/list` drops the per-row projection keys the remote list view
never renders (the live control stream re-supplies them when a session is
opened), and `POST /api/commands/list` drops the prose of every descriptor and
is cached for 30s, so a reconnect storm — the client re-pulls the whole command
table for every session key on every reconnect — costs no upstream work.

Because the DSH web server only emits gzip, this entry re-encodes its own
responses with brotli when the client accepts it, and keeps the immutable
client bundles (`/assets/`, `/plugins/`) brotli-compressed in memory. Measured
against the live desktop server, the plugin client bundle drops from 1600.5 KB
(gzip) to 1164.0 KB and the session list from 117.5 KB to 72.4 KB.

New knobs (all inside `config.slim`): `slimSessionList`, `slimCommandList`,
`dropSessionListValues`, `maxCommandDescriptionChars`, `maxCommandHintChars`,
`commandListCacheTtlMs`, `httpCompression` (`auto` | `gzip` | `brotli` |
`none`), `brotliQuality`, `compressAssets`, `assetCacheTtlMs`.

## Development

```sh
cd packages/dsh-plugin
pnpm install --frozen-lockfile
pnpm test
DSH_CHECKOUT=/absolute/path/DSH pnpm test
```

The optional checkout runs integration tests against real built DSH Cordis and
tool services. Lifecycle tests use ephemeral ports; the node's test mode disables
registry persistence.
This directory is private source. Packing it does not produce the DSH install
target. From the repository root, `npm run build` copies these files into
`vendor/dsh` and the published package is `@1agents/dreammate-node`.
The plugin ships plain JavaScript and needs no DSH runtime dependencies beyond
the Host-provided `tools` service.

Remove with `pnpm dsh plugin --profile web remove @1agents/dreammate-node`
and restart DSH. Existing identity and service registrations are retained.


## 0.4.0

Targets DreamMate Node ^0.18.0. Node can open a temporary cloudflared Quick Tunnel with
`dreammate-node tunnel`; this plugin does not register that command or expose the tunnel.

## 0.3.0

Targets DreamMate Node ^0.17.0. Managed gateways enforce public access and start the
loopback access control port when it is free. `dreammate_access` is not registered as
a DSH tool. Existing running local nodes remain externally owned.

## Releases

`@1agents/dsh-dreammate-node` stopped receiving releases at 0.4.0. Later DSH
installs use `@1agents/dreammate-node`. One npm publish carries the gateway,
MCP tools and this adapter. Plugin-only changes ship with the node version.

## 0.2.0 dependency transition

Targets DreamMate Node ^0.15.0 / Network 0.5. Existing running local nodes remain externally owned: releasing the DSH plugin does not stop them. Update the profile dependency and lockfile together. The plugin does not install or launch separate embedding workers.

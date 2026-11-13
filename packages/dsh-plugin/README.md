# @1agents/dsh-dreammate-node

DreamMate Network tools for DeepSeek Harness. Activating the plugin reuses a healthy
local `dreammate-node`, or starts the installed dependency when no node is running.
No separate global install, MCP configuration or daemon command is required.

## Install

From a DSH checkout (tested with DSH 0.1.7-rc.2, Node.js >=22.19):

```sh
pnpm dsh plugin --profile web add @1agents/dsh-dreammate-node
pnpm dsh web
```

Restart an already running DSH after installation. Use `desktop` instead of `web`
for that profile; omit `pnpm` when using an installed `dsh` executable.
The package's `dsh.bundle.patch` registers the Host plugin automatically.
The plugin defines no install-time scripts, and installing it starts no services.
Its `dreammate-node` dependency can install bundled skill guides through npm
`postinstall`; see [automatic skill installation](../../README.md#npm-安装时自动安装对应-skill).

Ask the DSH Agent to find devices/services, inspect a method, then call it:

> 查看 DreamMate 网络中有哪些设备，查找转写服务，读取它的方法契约。

The current source package depends on `@1agents/dreammate-node ^0.18.0` and registers
the dependency's exported tools, except `dreammate_access`. Tool search, skill search and
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

## Development

```sh
cd packages/dsh-plugin
pnpm install --frozen-lockfile
pnpm test
DSH_CHECKOUT=/absolute/path/DSH pnpm test
pnpm pack
```

The optional checkout runs integration tests against real built DSH Cordis and
tool services. Lifecycle tests use ephemeral ports; the node's test mode disables
registry persistence.
The package ships plain JavaScript and needs no consumer build scripts or DSH
runtime dependencies beyond the Host-provided `tools` service.

Remove with `pnpm dsh plugin --profile web remove @1agents/dsh-dreammate-node`
and restart DSH. Existing identity and service registrations are retained.


## 0.4.0

Targets DreamMate Node ^0.18.0. Node can open a temporary cloudflared Quick Tunnel with
`dreammate-node tunnel`; this plugin does not register that command or expose the tunnel.

## 0.3.0

Targets DreamMate Node ^0.17.0. Managed gateways enforce public access and start the
loopback access control port when it is free. `dreammate_access` is not registered as
a DSH tool. Existing running local nodes remain externally owned.

## Releases

This package keeps its own version numbers. What tracks DreamMate Node is the
dependency's major and minor: `^0.18.0` accepts `0.18.x` and not `0.19.0`.
Pushing `v0.18.0` publishes Node and, in the same workflow, this package when its
version is not on npm yet. A Node patch such as `0.18.1` does not publish the plugin.
The plugin version does not jump to `0.18.0` just to match Node.

## 0.2.0 dependency transition

Targets DreamMate Node ^0.15.0 / Network 0.5. Existing running local nodes remain externally owned: releasing the DSH plugin does not stop them. Update the profile dependency and lockfile together. The plugin does not install or launch separate embedding workers.

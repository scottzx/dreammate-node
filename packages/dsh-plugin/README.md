# @1agents/dsh-dreammate-node

DreamMate Network tools for DeepSeek Harness. Activating the plugin reuses a healthy
local `dreammate-node`, or starts the installed dependency when no node is running.
No separate global install, MCP configuration or daemon command is required.

## Install

From your DSH checkout (tested with DSH 0.1.7-rc.2, Node.js >=22.19):

```sh
pnpm dsh plugin --profile web add @1agents/dsh-dreammate-node
pnpm dsh web
```

Restart an already running DSH after installation. Use `desktop` instead of `web`
for that profile; omit `pnpm` when using an installed `dsh` executable.
The package's `dsh.bundle.patch` registers the Host plugin automatically.
Installing the package alone starts no processes and runs no install scripts.

Ask the DSH Agent to find devices/services, inspect a method, then call it:

> 查看 DreamMate 网络中有哪些设备，查找转写服务，读取它的方法契约。

The current plugin depends on `@1agents/dreammate-node ~0.7.1` and exposes seven tools:
`dreammate_list_nodes`, `dreammate_list_services`, `dreammate_list_capabilities` (compatibility alias),
`dreammate_inspect`, `dreammate_invoke`, `dreammate_download_skill`, and
`dreammate_manage_service`. Their original JSON schemas and descriptions are used.
Results retain the complete MCP envelope as JSON, including structured data and
non-text blocks; MCP business errors also become DSH tool failures. Calls pass
through the normal DSH tool policy pipeline. Native ACP sessions execute their
own Agent tools and do not automatically gain these DSH tools.

The gateway source in this repository adds `dreammate_search_tools`, bounded
directory results and optional local embeddings. These changes are available
through the built gateway's CLI/MCP; this plugin will gain them only after its
gateway dependency and lockfile are upgraded. This change does not upgrade or
publish the plugin. See the [gateway discovery guide](../../README.md#智能体怎么发现和调用)
and [local embeddings](../../docs/local-embeddings.md) for the source implementation.

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

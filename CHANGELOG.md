# Changelog

## 0.22.3 — 2026-11-26

- Remove the package `postinstall` (`node scripts/install-skills.mjs --postinstall`). pnpm 11 treats an unapproved build script as a failed install, which made every new version fail with `ERR_PNPM_IGNORED_BUILDS` until its exact `allowBuilds` key was approved — and on failure the plugin manager rolled the dependency back to the previous version. The package now has no install-time scripts, so upgrades need no `allowBuilds` entry and never trip that check. Skill guides are installed explicitly with `dreammate-node skills install` (or `npm run skills:install` from a source checkout); the old `--postinstall` flag and the `DREAMMATE_SKIP_SKILLS` opt-out are gone.
- Update the READMEs, CLI help comment and the skill-install tests to match; the manifest test now asserts that no install-time script exists.

## 0.22.2 — 2026-11-26

- Fix the DSH browser client bundle failing to register on reload. `vendor/dsh/client.js` declared `const STYLE` at the top level of a classic script; a top-level lexical declaration stays in the page's global environment, so DSH's second execution of the bundle (its HMR rebuild path) threw `SyntaxError: Identifier 'STYLE' has already been declared` before reaching `window.__ModuleLoader__.load`. The host reported that as `client-modules: could not load "@1agents/dreammate-node": … loaded without registering "@1agents/dreammate-node" via __ModuleLoader__.load`, and the plugin's row-config panels stayed unsynchronised in the page while the server-side enable state was unchanged. Move every declaration into the factory closure, so the bundle is free of top-level bindings and re-executes cleanly.
- Guard the regression in the package's own test suite: the embedded browser bundle must declare nothing at the top level and must register its factory on every execution.

## 0.22.1 — 2026-11-26

- Harden the shared loopback adapter (`yima-shared-loopback.mjs`) so remote traffic cannot stall the shared desktop host event loop: move brotli/gzip/gunzip compression off the main thread onto libuv worker threads and remove the redundant raw-snapshot `JSON.stringify` in `session/follow` stats logging.
- Eliminate 5-second HTTP keep-alive half-close races (`ECONNRESET` / 502) by raising `keepAliveTimeout` / `headersTimeout` to `65s / 66s` on both the loopback listener and the shared upstream DSH HTTP server (restoring upstream values on dispose), using non-pooled loopback requests with 30s timeout and client-abort cleanup for internal proxy hops.
- Tighten loopback cache and protocol boundaries: enforce `connection.admit(req)` before serving cached `/api/commands/list` entries, include negotiated encoding in cache keys with `Vary: Accept-Encoding`, honor `If-None-Match` 304 and `Cache-Control: no-store` on static assets, format IPv6 loopback authorities with brackets (`[::1]:port`), and guard WebSocket peer release against double invocation.
- Tighten default `slim.minTurns` from `2` to `1` in both `yima-shared-loopback.mjs` and the DSH row-config panel (`client.js`) to keep ultra-long multi-step turns lean on remote links.

## 0.22.0 — 2026-11-25

- Widen the remote history window: the initial follow frame now asks for at least 50 messages across two turns, with a 200-message cap, so a phone keeps a readable slice of a long conversation. Measured on the six longest sessions of a real profile, the first frame lands between 30 KB and 187 KB on the wire. Tool outputs stay dropped — the widening only buys message text, never the payloads that made the old frames large.
- Slim the remote first-frame list endpoints on the shared loopback entry: `POST /api/session/list` drops the per-row projection keys the remote list view never renders (measured 117.5 KB → 80.8 KB gzip, titles and session ids unchanged across all 1050 rows), and `POST /api/commands/list` drops descriptor prose and is cached for 30s so a reconnect storm costs no upstream work.
- Re-encode proxied responses with brotli when the client accepts it (the DSH web server only emits gzip) and keep the immutable client bundles (`/assets/`, `/plugins/`) brotli-compressed in memory. Measured against the live desktop server: plugin client bundle 1600.5 KB → 1164.0 KB, session list 117.5 KB → 72.4 KB.
- Keep the new behaviour off the desktop path: the local Electron UI never traverses this listener, and `slim: false` still falls back to transparent passthrough.

## 0.21.0 — 2026-11-25

- Export `@1agents/dreammate-node/yima-tailnet-trust` and `@1agents/dreammate-node/yima-shared-loopback` as clean package subpaths and reference them in `vendor/dsh/cordis.patch.yml` so DSH displays clean module specifiers instead of local `file://` URLs.
- Ship `vendor/dsh/client.js` (via `exports["./client"].default`, keeping Node ESM `exports["./client"].node` / `.import` on `dist/src/client.js`) and host `dreammateRowConfig` RPC to provide per-row `plugins.row.config` configuration panels and summaries for `dreammate-node`, `yima-tailnet-trust`, and `yima-shared-loopback` directly inside DSH's Plugins page.

## 0.20.0 — 2026-11-25

- Ship `yima-shared-loopback.mjs` inside the embedded DSH plugin (`vendor/dsh`) as the disabled `yima-shared-loopback` row beside `yima-tailnet-trust`. A desktop profile enables it with a loopback `host` and `port` so Tailscale Serve can share the desktop session writer without starting a second `dsh web`.
- Slim `/api/remote.mux` (`session/follow`, `session/observeEvent`) and `POST /api/session/page` / `/api/session/events` payloads on the shared loopback entry by default for low-bandwidth remote links: keeps user and assistant message blocks intact, keeps only tool call names, omits tool result outputs/meta and redundant stream replay payloads, raises WebSocket deflate compression to level 6, and widens heartbeat interval to 15s (set `slim: false` to disable).

## 0.19.0 — 2026-11-14

- Embed the DeepSeek Harness plugin into `@1agents/dreammate-node`. Install or upgrade that one package; `@1agents/dsh-dreammate-node` is no longer published.
- Keep the plugin id `dreammate-node`. Remove the old bundle before adding `@1agents/dreammate-node`, and point custom rows at the package root.
- Ship `yima-tailnet-trust.mjs` inside the embedded DSH plugin as the disabled `yima-tailnet-trust` row. A profile enables it with one exact Tailscale `host:port` authority to trust the Yima tailnet entry.

## 0.18.0 — 2026-11-13

- Add optional `cloudflared` and `dreammate-node tunnel` to open a temporary Quick Tunnel to a loopback origin. The default target is the HTTP MCP listener at `127.0.0.1:8787`. The command does not start MCP or enable gateway public access, and the hostname dies with the process.

## 0.17.0 — 2026-11-13

- Add a loopback-only Streamable HTTP MCP transport. It requires a bearer token, never exposes the access-control tool, and can publish an allowlisted tool catalog.
- Add loopback-only public access control on port 36910, with `dreammate-node access` to enable, disable, rotate and show the token. Public access is off by default.
- Treat a verified public token as the owner: it can see `sharing: local` services. Trusted-zone peers without a token only see `sharing: network`. Registration, source management and `local_only` methods stay on the loopback socket.
- Ignore client-supplied forwarding headers unless the immediate peer is a configured trusted proxy, so a reverse proxy cannot present public traffic as loopback.
- Restore numeric parameter types that MCP hosts stringify, using the method schema.

## 0.16.0 — 2026-10-23

- Add read-only local device model, OS name/version, architecture, hostname and interface IP/netmask/MAC information through `/device`, manifest metadata and the local node entry.
- Include basic device information in MCP/CLI node listings when the gateway advertises support, while preserving older gateway compatibility and existing health semantics.
- Keep collection local and cached; do not add peer probing, route/neighbor checks, LAN classification or grouping.

## 0.15.1 — 2026-10-22

- Preserve the full effective search budget for a primary on-demand model with a valid cold-start advertisement instead of cutting it to 70% for an unused backup. Keep explicit total deadlines and early-failure fallback, expose per-attempt budgets and elapsed time, and reload retrieval code with resident MCP handlers.
- Keep macOS Skill Manager catalog and health requests responsive with Interactive scheduling, avoiding discovery timeouts before semantic skill retrieval can begin.
- Keep gateway requests responsive during identity refreshes: share concurrent Tailscale lookups, cache topology snapshots for five seconds, and bound all CLI candidates by one total deadline with hard child cleanup. Derive identity and peers from the same snapshot and retain the canonical identity when status is temporarily unavailable.
- Run the macOS HTTP gateway as an Interactive launchd job so background CPU and I/O throttling cannot delay startup, discovery responses or request deadlines.

## 0.13.0 — 2026-10-18

- Route text embeddings to Qwen and media embeddings to optional offline EmbeddingGemma 2 through one local supervisor; use an explicit multimodal target for text queries against media indexes and preserve separate vector profiles.
- Serialize requests from both models in one FIFO queue, confirm the old worker has exited before switching, and unload idle workers after 60 seconds by default; status checks do not extend standby and the idle deadline can be changed without restarting.
- Add Gemma text, image/video encoding, comparison, prewarm and status methods with local media boundaries, optional modality selection and an MPS memory limit; keep Qwen as the automatic tool-search provider.
- Advertise bounded cold-start budgets for on-demand providers while preserving explicit search timeouts, compatible vector caches and bounded provider fallback.
- Verify managed launchd activation remains present after bootstrap and wait for old jobs to retire before replacement, retaining ownership checks and rollback.
- Preserve validated skill-catalog pages across slow or failed later reads, compress skill and embedding responses when requested, deduplicate replicated summary vectors and serve cached Qwen documents without waiting for unrelated inference.

## 0.12.0 — 2026-10-18

- Separate MCP connections from gateway sharing with persistent `local` / `network` scopes, defaulting existing sources to `network`; change scopes without reconnecting and enforce them on discovery, schemas, invocation and service subroutes.
- Support the same independent sharing scope for ordinary registered services, including skill-provider and embedding routes; recheck access after request-body reads so a revoked network call cannot reach the upstream.
- Load owner-readable private MCP configurations in CLI/Stdio processes, route their tools through the reserved `@client` target, and keep selected credentials out of shared gateway catalogs and tool parameters.
- Extract `@1agents/skill-manager` into an independent package and HTTP service with versioned skill reads, shared/project discovery, source management and user-service lifecycle commands; retain Node compatibility routes through the registered provider.
- Manage on-demand local embedding workers with idle shutdown, persistent vector caches, configurable provider priority and macOS service commands while keeping health checks and advertisements independent of model loading.
- Recover from encoder spawn failures without leaving a duplicate worker, and clean up private MCP subprocesses when the host closes during initialization while preserving buffered client input.
- Verify both packages through isolated tarball installations and gateway/provider integration tests, and publish Skill Manager independently from its own release tag.

## 0.10.0 — 2026-10-17

- Add persistent custom MCP sources from pasted JSON, files or stdin, supporting local stdio and remote Streamable HTTP / SSE, automatic paginated discovery, reconnection and loopback-only management commands and APIs.
- Refresh existing OAuth grants automatically, persist rotated credentials in an owner-readable file, and keep source credentials out of public service metadata.
- Discover connected Activepieces action catalogs automatically and support a vendor-neutral catalog declaration for other meta-tool servers; search child actions directly and load their schemas only on inspection or first invocation.
- Generate stable names scoped by source and toolset, preserve original names as aliases, and return candidates for ambiguous short names instead of choosing an unrelated tool.
- Route child action calls through the existing gateway with schema validation and explicit connection selection when several accounts are available, preserving MCP results without automatically replaying calls.
- Fix selected-method inspection returning only a summary, report schema loading explicitly, and support reloading resident stdio handlers without replacing the client connection or replaying in-flight requests.
- Verify the live GitHub child-tool search, paginated read calls and lazy parameter inspection through DreamMate MCP.

## 0.9.2 — 2026-10-10

- Default CPU document inference to one item per batch and expose `--batch-size` on the model launcher to bound indexing allocations on devices with limited memory.

## 0.9.1 — 2026-10-10

- Keep offline model health responses available during CPU encoding so registration refreshes and agent probes do not misclassify a busy provider as down.

## 0.9.0 — 2026-10-10

- Search concrete tool methods across known nodes by default, returning at most 15 summaries within a 12000-character JSON budget; keep explicit node/service filters and paginated inspection.
- Balance related service groups without letting method counts or cross-node replicas occupy every leading result; retain exact method matches and strong candidates from additional groups.
- Add an offline Qwen3 adapter and reproducible retrieval checks; prepared weights remain local and are never downloaded by search.
- Remove Gemma runtime/download support and provider selection; retain historical evaluation results.
- Advertise ready embedding providers through the local node agent, refresh registration every 15 seconds, and deregister on normal shutdown with the new `scripts/local-embeddings/serve.mjs` launcher.
- Discover providers from the scanned node scope, choose stable primary/backup candidates, and share one default 5-second semantic deadline across at most two attempts; isolate versions and encoding profiles without mixing vector spaces.
- Proxy `POST /services/:id/embed` only to the registered loopback encoder on that same node. Explicit model URLs remain pinned; no visible ready provider returns bounded lexical results with `no_provider`, preserving partial discovery evidence.

## 0.8.1 — 2026-09-29

- Bound CLI lifetime with a referenced command deadline, flush output before exit, and return visible JSON errors; prevent DNS work from keeping a completed one-shot command alive.
- Bound each service scan including response bodies, retain partial results, and prefer cached IPv4 for a node's own HTTP hostname while preserving TLS and proxy URLs.
- Support direct IP/URL targets without a default gateway and dedicated address-book subcommand help.
- Reject unsupported iSH daemon installation and check the Linux user service manager before writing files; clarify HTTP health reporting and iSH troubleshooting in the bundled guide.

## 0.8.0 — 2026-09-29

- Add portable node address-book export/import for iSH: persistent manual cache, offline node listing, direct alias routing and explicit live-discovery override without background refresh.
- Bundle iSH and normal-terminal skill variants; install the matching guide during npm postinstall with environment detection, manual overrides and protection for user-edited skills.
- Add `dreammate-node cli` for one-shot remote discovery, inspection, invocation and service management without a local daemon, identity or registry.
- Share tool execution with MCP, preserving structured results, error flags and non-retry behavior; document gateway configuration and iSH runtime requirements.

## 0.7.2 — 2026-09-29

- Report partial network discovery with per-node scan diagnostics, including degraded topology.
- Resolve known node names through their registered Tailscale IP addresses.
- Preserve MCP error flags, structured results, multimodal content and metadata.
- Distinguish upstream business errors from gateway transport failures and timeouts.
- Expose network, gateway and service health separately.
- Track method availability and deployment-specific unsupported capabilities.
- Add the Plane bridge deployment, its regression tests and the verified Pages capability profile.
- Preserve UTF-8 request bodies when characters span HTTP chunks.

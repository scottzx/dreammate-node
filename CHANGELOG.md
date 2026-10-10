# Changelog

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

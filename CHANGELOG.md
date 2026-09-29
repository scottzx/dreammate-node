# Changelog

## 0.7.2 — 2026-09-29

- Report partial network discovery with per-node scan diagnostics, including degraded topology.
- Resolve known node names through their registered Tailscale IP addresses.
- Preserve MCP error flags, structured results, multimodal content and metadata.
- Distinguish upstream business errors from gateway transport failures and timeouts.
- Expose network, gateway and service health separately.
- Track method availability and deployment-specific unsupported capabilities.
- Add the Plane bridge deployment, its regression tests and the verified Pages capability profile.
- Preserve UTF-8 request bodies when characters span HTTP chunks.

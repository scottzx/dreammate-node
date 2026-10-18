# Package identity and deployment governance

`projects.json` separates canonical projects, aliases, repositories and packages. The audit date/version is an observation, NOT a latest tag, compatibility guarantee, or running deployment. Unknown repositories and maintenance status remain unknown. Private implementation packages and platform binaries are not separate products.

## Read-only audit

```sh
node scripts/audit-dependencies.mjs --root /path/to/consumer --json
node scripts/audit-dependencies.mjs --root /path/to/consumer --json --check
```

Without `--check`, the command emits the observations even when drift exists. With `--check`, a failed validation exits 1 and an unsupported package manager exits 2. Input/command errors always exit 2. It never installs, deduplicates, rewrites locks, starts services, or reads auth configuration.

The audit uses npm itself to validate ranges, compares root/workspace declarations with lockfile metadata, hashes both files, and lists actual first-party installed manifest paths. Multiple compatible versions are permitted. Running process and active DSH profile are explicitly NOT VERIFIED. pnpm/yarn are detected rather than incorrectly audited using npm; use their existing native frozen-lock workflows. In particular, 1acp remains a pnpm workspace.

## Release gate

1. Edit code/declarations, update the owning lockfile, and run unit/contract tests in an isolated worktree.
2. For npm consumers, run `npm ci --ignore-scripts` in staging (not a live service directory), then invoke the required build/test scripts explicitly. Review any necessary dependency install hooks separately.
3. `npm pack` and install the resulting tarball into an empty staging consumer. Verify CLI, exports, DSH patch/client assets, service registration and actual downstream calls. A source symlink passing tests is not a package acceptance test.
4. Record a deployment receipt with explicit package versions, manifest/lock hashes, source commits, supported protocol versions, package paths and validation outputs. Do not infer runtime identity from installed files.
5. Publish only after acceptance. Roll out a pinned DSH profile combination, record the restarted process/version and reachability separately, and retain the previous profile/lock/tarballs for rollback.

Never force ^0.4 dependencies to 0.14 using overrides merely to remove duplicates. Do not require a monorepo migration or a new package manager. Keep code/library versions, wire protocols, SQLite schema versions and embedding profiles independently versioned.

Use `deployment-receipt.example.json` as a staging receipt. Unknown values remain null and runtime.verified remains false until a running process is independently inspected. A successful npm audit is not wire-protocol or model compatibility evidence.

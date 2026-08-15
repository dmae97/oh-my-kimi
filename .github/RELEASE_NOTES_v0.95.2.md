# OMK v0.95.2

OMK v0.95.2 is a patch release published to npm as `open-multi-agent-kit@0.95.2`, in lockstep with `omk-ai`, `omk-agent-core`, `omk-tui`, and `omk-adaptorch-wpl`. Prebuilt binaries are attached to the GitHub release.

## Highlights

| Area | What changed |
| --- | --- |
| macOS startup | Replay-ledger process identity now uses bounded BSD `ps -o lstart=` output, fixing fail-closed AgentSession startup on Darwin while preserving Linux `/proc` behavior |
| Session bash | OS sandbox enforcement is now the default; macOS `sandbox-exec` and Linux `bwrap` restrict writes and network, and missing backends fail closed |
| MCP status | Connected MCP servers are checked with protocol pings; dead processes are marked failed and retried on a bounded cadence |
| Interactive TUI | Added editor affordance hints, elapsed working status, width-safe scroll indicators, transient notices, and opt-in footer system metrics |
| Context runtime | Improved compact context metadata, secret-safe cache persistence, content-addressed reuse, and repository-scoped reasoning-router feedback |

## macOS replay-lock fix

Darwin process identity no longer depends on Linux-only `/proc`. OMK parses bounded `ps -o lstart=` output into a stable per-process token and treats missing, malformed, or failed probe results conservatively. This resolves the startup failure reported in [#34](https://github.com/dmae97/omk/issues/34).

## Sandbox behavior

Built-in local session bash now defaults to `enforce`. Use `OMK_BASH_SANDBOX=audit` only for the explicit unwrapped compatibility path, or `OMK_BASH_SANDBOX=off` to disable the preflight. Custom tools and injected remote bash operations remain outside this built-in boundary.

## Install

```bash
npm install -g open-multi-agent-kit@0.95.2 --ignore-scripts
omk --version
```

## Verification

- Monorepo formatting, lint, type, release-surface, documentation, and browser-smoke checks
- Workspace build
- Node 22 full workspace test run
- Coding-agent: 4,472 passed, 54 skipped
- TUI: 700 passed

## Migration and rollback

No configuration migration is required. Hosts without a supported local sandbox backend must explicitly select `audit` or `off` if they still need local session bash. Roll back with:

```bash
npm install -g open-multi-agent-kit@0.95.1 --ignore-scripts
```

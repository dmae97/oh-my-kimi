# OMK v0.94.0

OMK v0.94.0 is a feature release published to npm as `open-multi-agent-kit@0.94.0` (lockstep with `omk-ai`, `omk-agent-core`, `omk-tui`, and `omk-adaptorch-wpl`) with prebuilt binaries attached to the GitHub release.

## Highlights

| Area | What changed |
| --- | --- |
| Verified bash default-on | When a session has a replay ledger, LLM-callable `bash` and interactive/RPC `executeBash` bind through `executeVerifiedBash` (`executor: "bash-tool"`, receipts under `<sessionFile>.evidence`). Opt out with `OMK_VERIFIED_BASH=0`. Receipts now bind the git toplevel plus a capped dirty set via `resolveSessionWorkspaceScope()`. |
| Default bash sandbox (audit) | Session bash carries a default `audit`-mode sandbox preflight (workspace-write rooted at the session cwd). Spawns stay unwrapped, but every decision lands in the replay ledger as a `sandbox_audit` event. `OMK_BASH_SANDBOX=enforce` activates the OS backend (macOS `sandbox-exec` / Linux `bwrap`) and fails closed when unavailable; `=0` disables. Runtime promotion via `session.setBashSandboxMode(...)`. |
| Diagnostics tool | New default-active `diagnostics` tool runs the project's own checkers (`tsc --noEmit`, `pyright`/`ruff`, `go vet`, `cargo check`), normalizes to `SEVERITY path:line:col message`, fail-softs missing checkers as `skipped`, caps at 50 items with a 5 s TTL cache. SDK exports: `createDiagnosticsTool`, `createDiagnosticsToolDefinition`. |
| Skill-catalog cache | Persistent per-dir fingerprint cache at `<agentDir>/cache/skill-catalog-v1.json` skips SKILL.md reads on unchanged trees. Writes are atomic; corrupt cache degrades to a miss. Disabled under VITEST unless opted in. |
| Service extractions | `SessionBashRuntime`, `SessionBashService`, and `SessionCompactionService` pulled out of `AgentSession` with thin one-line wrappers; no intended behavior change. |
| API registry singleton | `omk-ai` provider registry is process-wide (`globalThis`-anchored) so symlinked workspace dist copies and vite-node inlined copies share one map. |
| Hermetic tests | `test/setup-env.ts` scrubs machine-level `OMK_*` and provider credential variables before every worker (`LIVE_E2E=1` keeps keys for intentional live runs). |

## Install

```bash
npm install -g open-multi-agent-kit --ignore-scripts
omk --version   # 0.94.0
```

## Verification boundary

`tsgo --noEmit` is clean across the workspace and `npm run check` (biome, pinned-deps, vendored-skills, ts-imports, release-consistency, readme-releases, doc-links, release-surface, shrinkwrap, browser-smoke) passes. Focused suites for diagnostics, sandbox default policy, session-bash-runtime, verified-bash-runtime/adapter, skills-catalog-cache, and skills are green. Live-provider e2e tests (OAuth-gated) and other operating systems remain outside this release's verification boundary.

## Migration and rollback

- Verified bash and sandbox audit are default-on when a replay ledger exists. Set `OMK_VERIFIED_BASH=0` and/or `OMK_BASH_SANDBOX=0` to restore the previous unverified/un-sandboxed path.
- Sessions that pin their own tool list do not auto-activate `diagnostics`; new sessions get it by default and can opt out via `activeToolNames` / `excludedToolNames`.
- Roll back with `npm install -g open-multi-agent-kit@0.93.0 --ignore-scripts`.

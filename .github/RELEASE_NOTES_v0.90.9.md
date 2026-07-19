# OMK v0.90.9

OMK v0.90.9 is a runtime-hardening patch release, published to npm as `open-multi-agent-kit@0.90.9` (lockstep with `omk-ai`, `omk-agent-core`, and `omk-tui`) with prebuilt binaries attached to the GitHub release.

## Highlights

| Area | What changed |
| --- | --- |
| Tool turns | Every emitted tool call closes with exactly one terminal result across normal, blocked, aborted, timed-out, failed, and resume paths. Missing-result repair is idempotent; duplicate or orphan results fail closed. |
| Agent loop | The deterministic resource-claim DAG scheduler (`dag-v2`) preserves source-order result artifacts. Unknown, `bash`, and unclaimed extension tools remain exclusive; `waves-v1` remains the compatibility rollback path. |
| Evidence | Execution-bound evidence receipts bind normalized local command outcomes, workspace/artifact fingerprints, redacted output digests, and replay-ledger state. This optional executor does not make the built-in CLI or `AgentSession` bash paths verified. |
| Context and sessions | Compaction is transactional behind closed tool turns, revision compare-and-swap, and stale-summary discard. Typed termination, incomplete-run recovery, and `omk session doctor` provide bounded, dry-run-first repair. |
| Provider diagnostics | `omk provider doctor` reports sanitized Level 0–2 diagnostics for native, custom OpenAI-compatible, and local-proxy origins. |

## Install

```bash
npm install -g open-multi-agent-kit --ignore-scripts
omk --version   # 0.90.9
```

## Verification boundary

Build/check and the keyless workspace suite passed; the four publishable packages were packed and installed in isolated npm and Bun consumers; the Linux x64 Bun binary/archive and all three local CLI forms reported `0.90.9`; core and Node package subpath imports passed. Live-provider tests and other operating systems remain outside this release's verification boundary.

## Migration and rollback

Validate the `dag-v2` default against representative workloads; use `waves-v1` or `OMK_TOOL_SCHEDULER=waves-v1` for rollback. Start session recovery with `omk session doctor --session <path|id> --repair --dry-run`, and start provider inspection with `omk provider doctor <provider-id> --level 0`.

## Compatibility

The workspace package version is `0.90.9`. This release makes no new certification for package, CLI, config, session, RPC, or SDK compatibility; validate existing integrations against your installation.

# OMK v0.90.9 local freeze

OMK v0.90.9 is a locally frozen, unpublished workspace snapshot. It documents implemented runtime-hardening surfaces; it is not an npm or GitHub release, and it does not certify a public release.

## Highlights

| Area | Local-freeze note |
| --- | --- |
| Tool turns | Every emitted tool call closes with exactly one terminal result across normal, blocked, aborted, timed-out, failed, and resume paths. Missing-result repair is idempotent; duplicate or orphan results fail closed. |
| Agent loop | The deterministic resource-claim DAG scheduler preserves source-order result artifacts. Unknown, `bash`, and unclaimed extension tools remain exclusive; `waves-v1` remains the compatibility rollback path. |
| Evidence | Execution-bound evidence binds normalized local command outcomes, workspace/artifact fingerprints, redacted output digests, and replay-ledger state. This optional executor does not make the built-in CLI or `AgentSession` bash paths verified. |
| Context and sessions | Compaction is transactional behind closed tool turns, revision compare-and-swap, and stale-summary discard. Typed termination, incomplete-run recovery, and `omk session doctor` provide bounded, dry-run-first repair. |
| Provider diagnostics | `omk provider doctor` reports sanitized Level 0–2 diagnostics for native, custom OpenAI-compatible, and local-proxy origins. |

## Local verification and release boundary

Verification recorded for this freeze is local and bounded to implemented surfaces: build/check and the keyless workspace suite passed; four publishable packages were packed and installed in isolated npm and Bun consumers; the Linux x64 Bun binary/archive and all three local CLI forms reported `0.90.9`; core and Node package subpath imports passed. Live-provider tests and other operating systems remain unverified. No npm publication, GitHub release, push, tag, dist-tag, or trusted-publisher mutation was performed; those actions remain blocked pending authoritative WORM release infrastructure.

## Migration and rollback

Validate the local `dag-v2` default against representative workloads; use `waves-v1` or `OMK_TOOL_SCHEDULER=waves-v1` for rollback. Start session recovery with `omk session doctor --session <path|id> --repair --dry-run`, and start provider inspection with `omk provider doctor <provider-id> --level 0`.

## Compatibility

The workspace package version is `0.90.9`. This local freeze makes no new public certification for package, CLI, config, session, RPC, or SDK compatibility; validate existing integrations against the local workspace.

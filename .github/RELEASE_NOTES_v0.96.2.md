# OMK v0.96.2

OMK v0.96.2 adds resource-aware scheduling, internal workload-sharding components, and a terminal resize fix.

## Highlights

- **Resource-aware runs** — host snapshots, admission decisions, generation-safe tool-cap leases, weighted FIFO permits, `omk doctor resources`, and `/resource`.
- **Workload-sharding components** — internal Vitest, Jest, workspace, and Go planners plus a journaled executor that emits aggregate `workload_shard_result.v1` evidence. Automatic command sharding is not enabled.
- **Subagent lane controls** — an internal launcher enforces the parent's admission width and shares its permit pool; live child-launch wiring is not part of this release.
- **Prompt settlement** — settled runs emit `prompt_settled` after `agent_end`. Completion sound remains opt-in and TUI-only.
- **Local observations** — resource journals record bounded health and lifecycle facts without raw host measurements.
- **Qwen Token Plan usage** — the status rail reads the seven-day plan window through the official QwenCloud management CLI.
- **Terminal redraws** — resize redraws repaint only the visible tail, preventing duplicated scrollback lines.
- **Default npm installs** — the published CLI no longer invokes development-only workspace-linking hooks whose scripts are not shipped.

## Compatibility and safety

- `resourceGovernor.mode: "observe"` is the default and records decisions without changing scheduling. Both `"observe"` and `"off"` preserve v0.96.1 scheduling behavior.
- The termination classifier recognizes resource-pressure causes as retryable. Only CPU pressure can qualify for automatic retry, and live resource gates currently return bounded block results rather than emitting those termination causes.
- The internal sharding executor quarantines corrupt journals, refuses recovery from them, and skips passed shards on resume.
- Qwen quota discovery uses `qwencloud usage summary --format json`, passes only non-secret process context to the child CLI, and never reads browser cookies. Qwen OAuth accepts model endpoints only on approved HTTPS Qwen/Alibaba origins and excludes token response bodies from errors.

## OMK and AdaptOrch

OMK remains the local, MIT-licensed control plane. Teams evaluating a hosted evidence layer for AI-generated patches can review [AdaptOrch.com](https://adaptorch.com/?utm_source=github&utm_medium=release-notes&utm_campaign=omk#pricing). AdaptOrch's published claim boundary describes this evidence as advisory, not proof of patch correctness.

AdaptOrch is a separate proprietary service and is not bundled with OMK.

See the package changelogs for the complete change list.

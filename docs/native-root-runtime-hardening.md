# Native Root Runtime Hardening

Last updated: 2026-05-24
Current `new-origin/main`: `6305e2b62185c11549f59e2340936769a3027cdd`

## Current State

OMK is now on the right architectural path: OMK is the root orchestrator and Kimi is one provider adapter, with Codex, DeepSeek, OpenCode, CommandCode, and future adapters routed through OMK-owned runtime contracts.

This is still a hardening milestone, not a stable provider-neutral release claim. The current release stop condition is:

- Local `npm run release:check` must pass on the exact release diff.
- GitHub Actions Smoke Test must pass on the exact commit.
- GitHub Actions CI must pass on the exact commit.
- Release evidence must be kept under `.omk/release-evidence/<short-sha>/` or an equivalent run artifact path.

Fresh verification at the time of this update:

- `new-origin/main` points at `6305e2b62185c11549f59e2340936769a3027cdd`.
- GitHub Actions Smoke Test for that commit completed successfully.
- GitHub Actions CI for that commit failed on Windows test jobs, so v1.1.18 publish/tag remains blocked.

For the LaTeX/paper-ready algorithm appendix and acceptance criteria, see
[Native Root Runtime Algorithms](./native-root-runtime-algorithms.md). Treat
that appendix as hardening criteria, not a stable-release proof, until the
exact release diff passes CI, smoke, and local release gates.

## Runtime Safety Contract

Related algorithm appendix:
[Native Root Runtime Algorithms](./native-root-runtime-algorithms.md)
documents the current acceptance criteria for turn construction, capsule
conversion, runtime fallback, Kimi prompt transport, and scoped worker
environment construction.

### Turn risk and capability routing

Related: Algorithm 2.

Native chat turns must be default-safe. A turn should request only the minimum capability needed:

| Turn risk | Typical intent | Capabilities |
|-----------|----------------|--------------|
| `read` | explain, review, summarize, inspect docs | `read` only |
| `write` | edit, fix, implement, refactor | `read`, `write`, `patch` |
| `shell` | run tests, build, execute commands | `read`, `write`, `shell` with approval policy |
| `merge` | publish, release, push, merge, destructive changes | authority provider plus release/security gates |

DeepSeek remains an advisory/read/review lane unless an explicit future contract grants safe write/shell execution. Write/shell tasks should route to Kimi, Codex, or a configured authority provider with the matching approval and sandbox policy.

### Approval and sandbox propagation

Related: Algorithm 2, Algorithm 4, and Algorithm 7.

`--execution ask|auto|never` must flow from chat command parsing into `AgentTask.safety`, runtime routing, and the final adapter invocation.

| OMK execution | Runtime expectation |
|---------------|---------------------|
| `ask` | request approval before write/shell side effects; Codex should not use `never` |
| `auto` | allow only low-risk automatic actions; elevate risky shell/write operations |
| `never` | explicit high-trust/yolo mode only |
| read-only turn | use read-only sandbox where adapter supports it |

### Authority provider resolution

Related: Algorithm 5.

`authority`, `primary`, and `omk` are policies, not executable providers. They must resolve to a concrete provider before bootstrap or routing:

1. `OMK_AUTHORITY_PROVIDER`, if set and healthy.
2. Kimi, when installed/authenticated and compatible with task risk.
3. A configured fallback provider that satisfies the task capability contract.

Unknown or unresolved authority must fail with remediation instead of silently degrading to advisory-only mode.

### Provider health probes

Related: Algorithm 5. Current routing uses available registry, capability, and
evidence metadata; uniform auth/model/quota health remains part of this
hardening backlog.

Provider bootstrap must distinguish:

- `runtimeOk`: binary/API client available.
- `authOk`: authenticated enough to make a real call.
- `modelOk`: selected/default model is supported.
- `quotaOk`: quota/rate-limit known good, known bad, or unknown.

Binary existence alone is not enough. CLI adapters should probe version and auth/session status where possible; API adapters should validate key presence and perform a cheap health/model check when safe.

### Tool-plane diagnostics

Related: Algorithm 4 and Algorithm 7.

MCP, skills, and hooks must not disappear silently. Runtime manifests should include diagnostics for parse/read failures, unknown names, and scope drops. If a task requires runtime MCP, invalid MCP config is a hard failure.

## P0 Backlog

1. Infer native turn risk before building the DAG node; do not default every turn to write/shell.
2. Keep explicit DeepSeek routes read-only/advisory or block write/shell with a clear fallback message.
3. Propagate approval policy and sandbox mode into runtime adapters, especially Codex CLI.
4. Resolve `authority` to a concrete provider during runtime bootstrap.
5. Replace binary-only provider auth checks with structured provider health probes.
6. Keep release evidence current; do not tag/publish while CI is red.

## P1 Backlog

1. Make `/model` either a real live state update or clearly restart-only.
2. Use the provider registry as the source of truth for DeepSeek default models.
3. Remove `cmd` as a CommandCode fallback binary.
4. Emit tool-plane diagnostics for MCP config parse/read failures.
5. Gate Kimi failure stderr previews behind `OMK_DEBUG=1` and redaction.
6. Preserve routing metadata in external CLI adapter `execute(task)` paths.

## P2 Backlog

1. Add configurable non-zero exit behavior for native root-loop turn failures.
2. Move prompt envelopes out of `DagNode.name` into structured payload fields.
3. Validate capability names before prompt/runtime injection.
4. Persist per-turn route artifacts under `.omk/runs/<run-id>/turns/<turn-id>.json`.
5. Link provider routes and evidence gates into graph memory for replay/audit.

## Spec-Kit Acceptance Gates

Any spec-kit plan for native root runtime work should include:

- Safety fields: `risk`, `approvalPolicy`, and `sandbox`.
- Authority fields: requested provider policy and resolved concrete provider.
- Capability fields: MCP, skills, hooks, write, patch, shell, and review.
- Diagnostics: provider health, tool-plane parse failures, capability mismatches, and fallback reasons.
- Evidence: exact commands, local/remote run URLs where available, pass/fail state, and release stop/go decision.

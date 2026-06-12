# /speckit-plan

Generate an OMK-optimized implementation plan.

Output: `specs/[###-feature]/plan.md`

This plan must align with the current OMK runtime surface:

- Agent roles: `explorer`, `planner`, `architect`, `coder`, `reviewer`, `qa`; use extra local roles only when `.omk/agents/root.yaml` or `chat-agent-harness.json` exposes them.
- Skills: reference relevant `.kimi/skills` or `.agents/skills` entrypoints by name; do not paste full skill bodies.
- MCP: prefer project-scoped `omk-project`; all-scope/global MCP is runtime-only and must not leak secrets.
- Harness: if the run has `chat-agent-harness.json`, use it for active skills/MCP/hooks, worker limits, gates, and authority boundaries.
- Safety: classify every phase as `read`, `write`, `shell`, or `merge`; default native chat/read-review work must not require write/shell.
- Authority: resolve `authority`/`primary`/`omk` to a concrete provider before routing; DeepSeek is read/review/advisory unless explicitly reconfigured.
- Approval/sandbox: preserve `ask`/`auto`/`never` and `read-only`/`workspace-write` into runtime adapter metadata.
- Provider health: separate binary/runtime availability from auth/model/quota readiness.
- Tool-plane diagnostics: MCP/skills/hooks parse or resolution failures must be visible, and runtime-required MCP failures are blocking.

This plan includes:
- Agent routing hints for each phase
- Expected project structure
- Quality gate commands
- Complexity check
- Evidence and replay hooks (`omk verify --json`, run artifacts, screenshots when relevant)
- Release evidence hooks for exact-target local gates plus GitHub Smoke Test and GitHub CI when a change is release-bound

The plan is consumed by `tasks-template.md` to generate DAG-ready task lists.

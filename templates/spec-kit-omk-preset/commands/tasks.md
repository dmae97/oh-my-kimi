# /speckit-tasks

Generate an OMK-optimized task list.

Output: `specs/[###-feature]/tasks.md`

Each task includes OMK Execution Metadata:
- `role` — exposed agent role that executes the task
- `deps` — topological dependencies for DAG scheduling
- `files` — expected output files for evidence gates
- `verify` — post-task verification command
- `gate` — evidence gate type (file-exists, command-pass, diff-nonempty, summary-present)
- `risk` — checkpoint trigger (high = D-Mail/checkpoint before execution)
- `approval` — runtime approval policy (`ask`, `auto`, or `never`)
- `sandbox` — execution sandbox (`read-only` or `workspace-write`)
- `provider` — provider policy or concrete adapter lane
- `capabilities` — requested runtime capabilities (`read`, `write`, `shell`, `merge`)
- `diagnostics` — expected diagnostic artifact when MCP/skills/hooks/provider health can fail
- `evidence` — exact run, CI, smoke, or release evidence artifact

Runtime rules:
- Use only roles exposed by `.omk/agents/root.yaml` or `chat-agent-harness.json`.
- Keep Kimi or the resolved authority provider as writer/merger/final authority unless the harness explicitly delegates otherwise.
- Default safe: read/review tasks request read-only capability; write/shell/merge tasks must explicitly request stronger capabilities.
- DeepSeek tasks are read/review/advisory only unless a future harness explicitly grants more authority.
- `--execution ask` must not collapse to provider `never`; carry approval/sandbox metadata into adapter-facing tasks.
- Use `chat-agent-harness.json` for active MCP/skills/hooks and worker limits.
- Do not copy global MCP/skill inventories or secret-like values into tasks.
- For release-bound tasks, require local release gates plus GitHub Smoke Test and GitHub CI on the exact target commit.

This metadata improves `tasks.md` → DAG conversion accuracy and evidence-gated completion.

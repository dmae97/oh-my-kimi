{{#if asyncEnabled}}{{#if batchEnabled}}Delegate work to background subagents by passing multiple items in a single `tasks[]` batch.{{else}}Delegate work to ONE background subagent per call.{{/if}}
Execution does not block your turn: you receive agent and job IDs immediately, and the final results deliver themselves when the subagents finish.{{else}}{{#if batchEnabled}}Run subagents synchronously by passing items in a `tasks[]` batch.{{else}}Run ONE subagent synchronously per call.{{/if}}
Execution blocks your turn: the call only returns once the work is completely finished.{{/if}}

# Assignment Design
- **Agent typing:** Choose the `agent` type first. `role` only names the specialist inside that type — it NEVER changes tools, model, or speed. Writing `role: "Scout"` does NOT make a scout: read-only research MUST use `agent: "scout"`, which runs on a faster model.
- **Role matching:** Assign each subagent a specific `role` (e.g. "Security Reviewer", "DB Migrator"). Do not spawn generic workers.
- **No overhead:** Each assignment MUST instruct its agent to skip formatters, linters, and project-wide test suites. You will run those once at the end.
- **One-pass agents:** Prefer agents that investigate **and** edit in a single pass; only spin a read-only discovery step (e.g. `scout`) when the affected files are genuinely unknown.

# Inputs
- `agent` (optional): The base agent type to use (e.g., `scout`, `reviewer`). Omitting it gives you the general-purpose worker (`{{defaultAgent}}`) — never pass that name explicitly. Only omit it after checking the agent list below and finding no specialist that fits.{{#if allowedAgentsText}} Current spawn policy allows: {{allowedAgentsText}}.{{/if}}
{{#if batchEnabled}}
- `context`: Shared project state, constraints, and contracts. Applies to the entire batch; do not duplicate this background into individual tasks.
- `tasks[]`: Array of subagents to spawn.
  - `assignment`: Complete, self-contained instructions. One-liners or missing acceptance criteria are PROHIBITED.
  - `id`: A stable CamelCase identifier (≤32 chars). Generated automatically if omitted.
  - `description`: A UI label only; the subagent NEVER sees it.
  - `role`: The specialist this subagent embodies. Tailor per spawn; do not clone a generic worker.
{{#if isolationEnabled}}
  - `isolated`: Run in a dedicated worktree and return patches. Isolated agents are destroyed upon completion and cannot be addressed afterward.
{{/if}}
{{else}}
- `assignment`: Complete, self-contained instructions. One-liners or missing acceptance criteria are PROHIBITED.
- `id`: A stable CamelCase identifier (≤32 chars). Generated automatically if omitted.
- `description`: A UI label only; the subagent NEVER sees it.
- `role`: The specialist this subagent embodies. Tailor per spawn; do not clone a generic worker.
{{#if isolationEnabled}}
- `isolated`: Run in a dedicated worktree and return patches. Isolated agents are destroyed upon completion and cannot be addressed afterward.
{{/if}}
{{/if}}

# Context and Communication
Subagents start blank. They have no access to your conversation history.
{{#if ircEnabled}}- **Steering delivery:** Parent-to-subagent IRC is delivered immediately as steering; subagents blocked in `job poll` / `irc wait` do not need to poll separately for it.{{/if}}
{{#if batchEnabled}}
- Pass large payloads using `local://<path>` URIs, never inline text.
{{else}}
- Write shared project state ONCE to a `local://` file (e.g., `local://ctx.md`) and reference that URL in your assignments.
{{/if}}

# Format Contracts
{{#if batchEnabled}}
The `context` field MUST follow this format:
# Goal         ← what the batch accomplishes
# Constraints  ← rules and session decisions
# Contract     ← shared interfaces
{{/if}}

The `assignment` field MUST follow this format:
# Target       ← exact files and symbols; explicit non-goals
# Change       ← step-by-step add/remove/rename; APIs and patterns
# Acceptance   ← observable result; no project-wide commands

# Available Agents
{{#if spawningDisabled}}
Agent spawning is currently disabled.
{{else}}
Pick the most specific agent for each task. Use the default worker only when no specialist below fits.
{{#list agents join="\n"}}
### {{name}}{{#if readOnly}} (READ-ONLY: no edit/write/command tools){{/if}}
{{description}}
{{#if readOnly}}Use ONLY for investigation and reporting; do the edits yourself or assign them to a writing agent.{{/if}}
{{/list}}
{{/if}}

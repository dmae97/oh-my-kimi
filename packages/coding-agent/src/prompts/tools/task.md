{{#if asyncEnabled}}{{#if batchEnabled}}Spawns subagents to work in the background — one per `tasks[]` item; a single spawn is a one-item batch.{{else}}Spawns ONE subagent per call to work in the background.{{/if}}

- Spawning is non-blocking: the call returns immediately with the agent id{{#if batchEnabled}}s{{/if}} and job id{{#if batchEnabled}}s{{/if}}; each result is delivered automatically when that agent yields.
- Parallelism = {{#if batchEnabled}}multiple `tasks[]` items in ONE call. To launch several subagents, you MUST batch them into a single call's `tasks[]` — they share `context` once instead of duplicating it. Separate `task` calls in one message are ONLY for spawns needing a different `agent` type or unrelated `context`{{else}}multiple `task` calls in one assistant message{{/if}}. Concurrency is bounded at {{MAX_CONCURRENCY}} running subagents per session.
- If genuinely blocked on a result, wait with `job poll`; otherwise keep working. `job cancel` terminates a task and **cannot carry a message** — only for stalled/abandoned work.
{{else}}{{#if batchEnabled}}Runs subagents synchronously — one per `tasks[]` item; a single spawn is a one-item batch.{{else}}Runs ONE subagent synchronously per call.{{/if}}

- Spawning is blocking: the call returns only after the agent{{#if batchEnabled}}s{{/if}} finish; results arrive inline.
- Parallelism = {{#if batchEnabled}}multiple `tasks[]` items in ONE call. To launch several subagents, you MUST batch them into a single call's `tasks[]` — they share `context` once instead of duplicating it. Separate `task` calls in one message are ONLY for spawns needing a different `agent` type or unrelated `context`{{else}}multiple `task` calls in one assistant message{{/if}}. Concurrency is bounded at {{MAX_CONCURRENCY}} running subagents per session.
{{/if}}
{{#if ircEnabled}}
- Coordinate with agents via `irc` using their ids. Agents reach you and their siblings live the same way.
{{/if}}

<lifecycle>
- Finished agents stay alive: `idle` first, then `parked` after a TTL.{{#if ircEnabled}} Both remain addressable and revivable: messaging one via `irc` wakes it and runs your message as a follow-up turn. **Prefer messaging an agent that already holds the relevant context over spawning fresh** — check `irc` op:"list" for candidates.{{/if}}
- `history://<id>` is the agent's transcript; `agent://<id>` its latest output artifact.
</lifecycle>

<parameters>
- `agent`: agent type to spawn
{{#if batchEnabled}}
- `context`: shared background prepended to every assignment — goal, constraints, shared contract (see context-fmt); REQUIRED, session-specific only
- `tasks`: tasks to spawn — one subagent per item, all in parallel:
  - `assignment`: complete self-contained instructions; one-liners and missing acceptance criteria are PROHIBITED
  - `id`: stable agent id, CamelCase, ≤32 chars; generated when omitted
  - `description`: UI label only — subagent never sees it
{{#if isolationEnabled}}
  - `isolated`: run this spawn in an isolated env; returns patches. Isolated agents are torn down at completion — not addressable afterwards
{{/if}}
{{else}}
- `id`: stable agent id, CamelCase, ≤32 chars; generated when omitted
- `description`: UI label only — subagent never sees it
- `assignment`: complete self-contained instructions; one-liners and missing acceptance criteria are PROHIBITED
{{#if isolationEnabled}}
- `isolated`: run in isolated env; returns patches. Isolated agents are torn down at completion — not addressable afterwards
{{/if}}
{{/if}}
</parameters>

<rules>
- **Maximize fan-out.** Issue the widest {{#if batchEnabled}}`tasks[]` batch{{else}}set of parallel `task` calls{{/if}} the work decomposes into. NEVER serialize work that could run concurrently.
- **Subagents do not verify, lint, or format.** Every assignment MUST instruct the subagent to skip all gates, formatters, and project-wide build/test/lint. You run them once at the end across the union of changed files.
- No globs, no "update all", no package-wide scope. Fan out.
- NEVER slow down or serialize because tasks might overlap on some files. Agents resolve collisions among themselves in real time.
- Subagents have no conversation history. Every fact, file path, and direction they need MUST be explicit in {{#if batchEnabled}}`context` or the item's `assignment`{{else}}the `assignment`{{/if}}.
{{#if batchEnabled}}
- **Shared background** lives in `context` once — never duplicated across assignments. Pass large payloads via `local://<path>` URIs, not inline.
{{else}}
- **Shared background**: write it ONCE to a `local://` file (e.g. `local://ctx.md`) and reference that path in each assignment. Pass large payloads via `local://<path>` URIs, not inline.
{{/if}}
- Prefer agents that investigate **and** edit in one pass; only spin a read-only discovery step when affected files are genuinely unknown.
- **Read-only agents**: Agents tagged READ-ONLY (e.g. `explore`) have no edit/write/command tools. NEVER hand them an assignment that requires changing files or running commands. Use them to investigate and report back; do the edits yourself or delegate to a writing agent (`task`, `oracle`, `designer`).
- **No reasoning offload**: NEVER offload reasoning, analysis, design, or decision-making to `quick_task` or `explore` — they run minimal-effort / small models for mechanical lookups and data collection only. Keep judgment and synthesis in your own context; delegate hard thinking to `task`, `plan`, or `oracle`.
</rules>

<parallelization>
{{#if ircEnabled}}
Test: can task B run correctly without seeing A's output? If no, sequence A → B — **unless** B can reasonably ask A for the missing piece over `irc`. Live coordination beats a serial waterfall when the contract is small and easy to describe in a DM.
Still sequence when one task produces a large, evolving contract (generated types, schema migration, core module API) the other consumes wholesale — IRC round-trips do not replace a finished artifact.
Parallel when tasks touch disjoint files, are independent refactors/tests, or only need occasional clarification that can be resolved peer-to-peer.
{{else}}
Test: can task B run correctly without seeing A's output? If no, sequence A → B.
Sequential when one task produces a contract (types, API, schema, core module) the other consumes.
Parallel when tasks touch disjoint files or are independent refactors/tests.
{{/if}}
{{#if ircEnabled}}Sequenced follow-ups SHOULD message the agent that produced the prerequisite — it already holds the context.{{/if}}
</parallelization>

{{#if batchEnabled}}
<context-fmt>
# Goal         ← one sentence: what the batch accomplishes
# Constraints  ← MUST/NEVER rules and session decisions
# Contract     ← exact types/signatures if tasks share an interface
</context-fmt>
{{/if}}

<assignment-fmt>
# Target       ← exact files and symbols; explicit non-goals
# Change       ← step-by-step add/remove/rename; APIs and patterns
# Acceptance   ← observable result; no project-wide commands
</assignment-fmt>

<agents>
{{#if spawningDisabled}}
Agent spawning is disabled for this context.
{{else}}
{{#list agents join="\n"}}
# {{name}}{{#if readOnly}} — READ-ONLY (no edit/write/exec tools){{/if}}
{{description}}
{{/list}}
{{/if}}
</agents>

Spawns ONE subagent per call to work in the background, or resumes an existing one.

- Spawning is non-blocking: the call returns immediately with the agent id and a job id; the result is delivered automatically when the agent yields.
- Parallelism = multiple `task` calls in one assistant message. Concurrency is bounded at {{MAX_CONCURRENCY}} running subagents per session.
- If genuinely blocked on a result, wait with `job poll`; otherwise keep working. `job cancel` terminates a task and **cannot carry a message** — only for stalled/abandoned work.
{{#if ircEnabled}}
- Coordinate with running agents via `irc` using their ids. Agents reach you and their siblings live the same way.
{{/if}}

<lifecycle>
- Finished agents stay alive: `idle` first, then `parked` after a TTL — both remain addressable and revivable.
- `resume: "<id>"` revives an idle/parked agent and runs a follow-up assignment in its existing session. **Prefer resuming an agent that already holds the relevant context over spawning fresh**{{#if ircEnabled}} — check `irc` op:"list" for candidates{{/if}}.
- `history://<id>` is the agent's transcript; `agent://<id>` its latest output artifact.
</lifecycle>

<parameters>
- `agent`: agent type to spawn; omit when `resume` is set
- `resume`: existing agent id — continue that agent instead of spawning (cannot combine with `agent` or `isolated`)
- `id`: stable agent id, CamelCase, ≤32 chars; generated when omitted
- `description`: UI label only — subagent never sees it
- `assignment`: complete self-contained instructions; one-liners and missing acceptance criteria are PROHIBITED
{{#if customSchemaEnabled}}- `schema`: JTD schema for expected structured output (do not put format rules in assignments){{/if}}
{{#if isolationEnabled}}- `isolated`: run in isolated env; returns patches. Isolated agents are NOT resumable{{/if}}
</parameters>

<rules>
- **Maximize fan-out.** Issue the widest set of parallel `task` calls the work decomposes into. NEVER serialize work that could run concurrently.
- **Subagents do not verify, lint, or format.** Every assignment MUST instruct the subagent to skip all gates, formatters, and project-wide build/test/lint. You run them once at the end across the union of changed files.
- No globs, no "update all", no package-wide scope. Fan out.
- NEVER slow down or serialize because tasks might overlap on some files. Agents resolve collisions among themselves in real time.
- Subagents have no conversation history. Every fact, file path, and direction they need MUST be explicit in the `assignment`.
- **Shared background**: write it ONCE to a `local://` file (e.g. `local://ctx.md`) and reference that path in each assignment. Pass large payloads via `local://<path>` URIs, not inline.
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
Sequenced follow-ups SHOULD `resume` the agent that produced the prerequisite — it already holds the context.
</parallelization>

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

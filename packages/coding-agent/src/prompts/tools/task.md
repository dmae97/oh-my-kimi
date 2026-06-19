{{#if asyncEnabled}}{{#if batchEnabled}}Spawns subagents in the background — one per `tasks[]` item; single spawn = one-item batch.{{else}}Spawns ONE subagent per call in the background.{{/if}}

- Non-blocking: returns agent id{{#if batchEnabled}}s{{/if}} + job id{{#if batchEnabled}}s{{/if}} immediately; each result auto-delivered on yield.
- Parallelism = {{#if batchEnabled}}multiple `tasks[]` items in ONE call. MUST batch into one `tasks[]` (share `context` once). Separate `task` calls ONLY for a different `agent` type or unrelated `context`{{else}}multiple `task` calls in one assistant message{{/if}}.
- Blocked on a result? `job poll`; else keep working. `job cancel` kills a task, **cannot carry a message** — only for stalled/abandoned work.
{{else}}{{#if batchEnabled}}Runs subagents synchronously — one per `tasks[]` item; single spawn = one-item batch.{{else}}Runs ONE subagent synchronously per call.{{/if}}

- Blocking: returns only after the agent{{#if batchEnabled}}s{{/if}} finish; results arrive inline.
- Parallelism = {{#if batchEnabled}}multiple `tasks[]` items in ONE call. MUST batch into one `tasks[]` (share `context` once). Separate `task` calls ONLY for a different `agent` type or unrelated `context`{{else}}multiple `task` calls in one assistant message{{/if}}.
{{/if}}
{{#if ircEnabled}}
- Coordinate via `irc` by agent id; agents reach you + siblings live.
{{/if}}

<parameters>
- `agent`: agent type to spawn
{{#if batchEnabled}}
- `context`: background prepended to every assignment — goal, constraints, contract (see context-fmt); REQUIRED, session-specific only
- `tasks`: one subagent per item, all in parallel:
  - `assignment`: complete self-contained instructions; one-liners / missing acceptance criteria PROHIBITED
  - `id`: stable agent id, CamelCase, ≤32 chars; auto when omitted
  - `description`: UI label only — subagent never sees it
  - `role`: specialist identity (e.g. "Auth-flow security reviewer") — sets system-prompt persona + roster name
{{#if isolationEnabled}}
  - `isolated`: run spawn in isolated env; returns patches. Torn down at completion — not addressable after
{{/if}}
{{else}}
- `id`: stable agent id, CamelCase, ≤32 chars; auto when omitted
- `description`: UI label only — subagent never sees it
- `role`: specialist identity (e.g. "Auth-flow security reviewer") — sets system-prompt persona + roster name
- `assignment`: complete self-contained instructions; one-liners / missing acceptance criteria PROHIBITED
{{#if isolationEnabled}}
- `isolated`: run in isolated env; returns patches. Torn down at completion — not addressable after
{{/if}}
{{/if}}
</parameters>

<rules>
- **Maximize fan-out.** Widest {{#if batchEnabled}}`tasks[]` batch{{else}}set of parallel `task` calls{{/if}} the work decomposes into. NEVER serialize parallelizable work.
- **Subagents do not verify, lint, or format.** Each assignment MUST tell the subagent: skip all gates, formatters, project-wide build/test/lint. You run them once at the end across changed files.
- No globs, no "update all", no package-wide scope. Fan out.
- **Tailor every spawn with a `role`.** A named specialist (e.g. "Parser edge-case tester", "SSE backpressure specialist") beats a generic `task`/`quick_task` worker; decompose into specialists, never clones. Role-less spawn is the exception.
- NEVER serialize over possible file overlap. Agents self-resolve collisions in real time.
- Subagents have no conversation history. Every fact, file path, direction MUST be explicit in {{#if batchEnabled}}`context` or the item's `assignment`{{else}}the `assignment`{{/if}}.
{{#if batchEnabled}}
- **Shared background** in `context` once, never per assignment. Large payloads via `local://<path>` URIs, not inline.
{{else}}
- **Shared background**: write ONCE to a `local://` file (e.g. `local://ctx.md`), reference it in each assignment. Large payloads via `local://<path>` URIs, not inline.
{{/if}}
- Prefer agents that investigate **and** edit in one pass; spin a read-only discovery step only when affected files unknown.
- **Read-only agents** (e.g. `explore`): no edit/write/command tools. NEVER assign them file changes or commands. Use to investigate + report; delegate edits to a writing agent (`task`/`oracle`/`designer`) or do them yourself.
- **No reasoning offload**: NEVER route reasoning, analysis, design, or decisions to `quick_task`/`explore` — minimal-effort / small models for mechanical lookups + data collection only. Keep judgment + synthesis in your own context; delegate hard thinking to `task`/`plan`/`oracle`.
</rules>

<parallelization>
{{#if ircEnabled}}
Test: can B run without A's output? No → sequence A → B — **unless** B can ask A over `irc`. Live coordination beats a waterfall when the contract is small + DM-able.
Still sequence when a task produces a large evolving contract (generated types, schema migration, core module API) consumed wholesale — IRC round-trips don't replace a finished artifact.
Parallel when tasks touch disjoint files, are independent refactors/tests, or need only occasional peer clarification.
{{else}}
Test: can B run without A's output? No → sequence A → B.
Sequential when one task produces a contract (types, API, schema, core module) the other consumes.
Parallel when tasks touch disjoint files or are independent refactors/tests.
{{/if}}
{{#if ircEnabled}}Sequenced follow-ups SHOULD message the prerequisite's producer — it holds the context.{{/if}}
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

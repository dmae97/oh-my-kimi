Launches subagents to parallelize workflows.

{{#if asyncEnabled}}
- Results delivered automatically when complete.
- Tool result lists assigned task ids (e.g. `AuthLoader`) — those are live agent ids.
{{#if ircEnabled}}
- Coordinate running tasks via `irc` using those ids. `job cancel` terminates task, **cannot carry message** — only for stalled/abandoned work.
- If genuinely blocked on completion, wait with `job poll`; otherwise keep working.
{{else}}
- If genuinely blocked on completion, wait with `job poll`; otherwise keep working.
- Use `job list` to snapshot manager state; `cancel: [id]` only to actually stop stuck task.
{{/if}}
{{/if}}

{{#if ircEnabled}}
Subagents have no conversation history, but can reach you and siblings live via `irc` tool. Front-load every fact, file path, direction they need in {{#if contextEnabled}}`context` or `assignment`{{else}}each `assignment`{{/if}}.
{{else}}
Subagents have no conversation history. Every fact, file path, direction they need MUST be explicit in {{#if contextEnabled}}`context` or `assignment`{{else}}each `assignment`{{/if}}.
{{/if}}

<parameters>
- `agent`: agent type for all tasks
- `tasks`: tasks to execute in parallel
 - `.id`: CamelCase, ≤32 chars
 - `.description`: UI label only — subagent never sees it
 - `.assignment`: complete self-contained instructions; one-liners and missing acceptance criteria PROHIBITED
{{#if contextEnabled}}- `context`: shared background prepended to every assignment; session-specific only{{/if}}
{{#if customSchemaEnabled}}- `schema`: JTD schema for expected structured output (format rules stay out of assignments){{/if}}
{{#if isolationEnabled}}- `isolated`: run isolated env; use when tasks edit overlapping files{{/if}}
</parameters>

<rules>
- Maximize batch width. Spawn widest parallel set work decomposes into. NEVER spawn single-task batch for divisible work, or defer work could have been concurrent.
- NEVER assign tasks run project-wide build/test/lint. Caller verifies after batch.
- **Subagents do not verify, lint, or format.** Every assignment MUST instruct subagent skip all gates and formatters. Run them once at end across union of changed files — avoids redundant runs and racing formatter passes.
- No globs, no "update all", no package-wide scope. Fan out.
- Do not concern yourself with how agents might overlap on certain actions. NEVER use as excuse to go slower: they can resolve collisions real-time with harness facilities.
- Pass large payloads via `local://<path>` URIs, not inline. {{#if contextEnabled}} (other than context){{/if}}
{{#if contextEnabled}}- Put shared constraints in `context` once; NEVER duplicate across assignments.{{/if}}
- Prefer agents that investigate **and** edit in one pass; only spin read-only discovery step when affected files genuinely unknown.
- **Read-only agents**: Agents tagged READ-ONLY (e.g. `explore`) have no edit/write/command tools. NEVER hand them assignment requiring file changes or commands — they cannot do it, turn wasted. Use them investigate and report back; do edits yourself or delegate to writing agent (`task`, `oracle`, `designer`).
- **No reasoning offload**: NEVER offload reasoning, analysis, design, or decision-making to `quick_task` or `explore` — they run minimal-effort / small models for mechanical lookups and data collection only. Keep judgment and synthesis in own context; delegate hard thinking to `task`, `plan`, or `oracle`.
</rules>

<parallelization>
{{#if ircEnabled}}
Test: can task B run correctly without seeing A's output? If no, sequence A → B — **unless** B can reasonably ask A for missing piece over `irc`. Live coordination beats serial waterfall when contract small and easy to describe in DM.
Still sequence when one task produces large evolving contract (generated types, schema migration, core module API) other consumes wholesale — IRC round-trips do not replace finished artifact.
Parallel when tasks touch disjoint files, are independent refactors/tests, or only Need occasional clarification resolved peer-to-peer.
{{else}}
Test: can task B run correctly without seeing A's output? If no, sequence A → B.
Sequential when one task produces contract (types, API, schema, core module) other consumes.
Parallel when tasks touch disjoint files or independent refactors/tests.
{{/if}}
</parallelization>

{{#if contextEnabled}}
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
Agent spawning disabled for this context.
{{else}}
{{#list agents join="\n"}}
# {{name}}{{#if readOnly}} — READ-ONLY (no edit/write/exec tools){{/if}}
{{description}}
{{/list}}
{{/if}}
</agents>

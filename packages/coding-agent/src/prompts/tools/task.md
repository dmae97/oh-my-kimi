Launches subagents to parallelize workflows.

{{#if asyncEnabled}}
- Results are delivered automatically when complete.
- If genuinely blocked on task completion, wait with `job` using `poll`; otherwise continue with another task when possible.
- You can also read the `jobs://` URI for manager state and `jobs://<id>` for detail only when inspection is useful.
{{/if}}

{{#if ircEnabled}}
Subagents have no conversation history, but they can reach you and their siblings live via the `irc` tool. Front-load every fact, file path, and direction they need in {{#if contextEnabled}}`context` or `assignment`{{else}}each `assignment`{{/if}}.
{{else}}
Subagents have no conversation history. Every fact, file path, and direction they need **MUST** be explicit in {{#if contextEnabled}}`context` or `assignment`{{else}}each `assignment`{{/if}}.
{{/if}}

<parameters>
- `agent`: agent type for all tasks
- `tasks`: tasks to execute in parallel
 - `.id`: CamelCase, ≤32 chars
 - `.description`: UI label only — subagent never sees it
 - `.assignment`: complete self-contained instructions; one-liners and missing acceptance criteria are PROHIBITED
{{#if contextEnabled}}- `context`: shared background prepended to every assignment; session-specific only{{/if}}
{{#if customSchemaEnabled}}- `schema`: JTD schema for expected structured output (do not put format rules in assignments){{/if}}
{{#if isolationEnabled}}- `isolated`: run in isolated env; use when tasks edit overlapping files{{/if}}
</parameters>

<rules>
- **MUST NOT** assign tasks to run project-wide build/test/lint. Caller verifies after the batch.
- **Subagents do not verify, lint, or format.** Every assignment **MUST** instruct the subagent to skip all gates and formatters. You run them once at the end across the union of changed files — avoids redundant runs and racing formatter passes.
{{#if ircEnabled}}
- Each task: ≤3–5 explicit files. Overlapping file sets are tolerable when peers can coordinate via `irc`, but still fan out to a cluster when the scopes are cleanly separable.
- No globs, no "update all", no package-wide scope.
{{else}}
- Each task: ≤3–5 explicit files. No globs, no "update all", no package-wide scope. Fan out to a cluster instead.
{{/if}}
- Pass large payloads via `local://<path>` URIs, not inline.
{{#if contextEnabled}}- Put shared constraints in `context` once; do not duplicate across assignments.{{/if}}
- Prefer agents that investigate **and** edit in one pass; only spin a read-only discovery step when affected files are genuinely unknown.
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
</parallelization>

{{#if contextEnabled}}
<context-fmt>
# Goal         ← one sentence: what the batch accomplishes
# Constraints  ← **MUST**/**MUST NOT** rules and session decisions
# Contract     ← exact types/signatures if tasks share an interface
</context-fmt>
{{/if}}

<assignment-fmt>
# Target       ← exact files and symbols; explicit non-goals
# Change       ← step-by-step add/remove/rename; APIs and patterns
# Acceptance   ← observable result; no project-wide commands
</assignment-fmt>

<agents>
{{#list agents join="\n"}}
# {{name}}
{{description}}
{{/list}}
</agents>

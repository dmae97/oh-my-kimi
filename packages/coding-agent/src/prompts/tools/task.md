Launches subagents to parallelize workflows.

{{#if asyncEnabled}}
- `read jobs://` for state, `read jobs://<id>` for detail.
- Use `job` (with `poll`) to wait. **MUST NOT** poll `read jobs://` in a loop.
{{/if}}

Subagents have no access to your conversation history. Every fact, file path, and decision they need **MUST** be explicit in {{#if contextEnabled}}`context` or `assignment`{{else}}each `assignment`{{/if}}.

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
- Each task: ≤3–5 explicit files. No globs, no "update all", no package-wide scope. Fan out to a cluster instead.
- Pass large payloads via `local://<path>` URIs, not inline.
{{#if contextEnabled}}- Put shared constraints in `context` once; do not duplicate across assignments.{{/if}}
- Prefer agents that investigate **and** edit in one pass; only spin a read-only discovery step when affected files are genuinely unknown.
</rules>

<parallelization>
Test: can task B run correctly without seeing A's output? If no, sequence A → B.
Sequential when one task produces a contract (types, API, schema, core module) the other consumes.
Parallel when tasks touch disjoint files or are independent refactors/tests.
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

Launches subagents to parallelize workflows.

{{#if asyncEnabled}}
- Use `read jobs://` to inspect state; `read jobs://<job_id>` for detail.
- Use the `poll` tool to wait until completion. You **MUST NOT** poll `read jobs://` in a loop.
{{/if}}

{{#if defaultMode}}
Current input mode: `default`. Shared `context` and custom task-call `schema` are available.
{{/if}}
{{#if schemaFreeMode}}
Current input mode: `schema-free`. Shared `context` is available; custom task-call `schema` is disabled. For structured output, rely on the agent definition or inherited session schema.
{{/if}}
{{#if independentMode}}
Current input mode: `independent`. Shared `context` and custom `schema` are both disabled. Every assignment must stand on its own.
{{/if}}

{{#if contextEnabled}}
Subagents lack your conversation history. Every decision, file content, and user requirement they need **MUST** be explicit in `context` or `assignment`.
{{else}}
Subagents lack your conversation history. Every decision, file content, and user requirement they need **MUST** be explicit in each task `assignment`.
{{/if}}

<parameters>
- `agent`: Agent type for all tasks.
  - `.id`: CamelCase, max 32 chars
  - `.description`: UI display only — subagent never sees it
  - `.assignment`: Complete self-contained instructions. One-liners PROHIBITED; missing acceptance criteria = too vague.
{{#if contextEnabled}}
- `context`: Shared background prepended to every assignment. Session-specific info only.
{{/if}}
{{#if customSchemaEnabled}}
- `schema`: JSON-encoded JTD schema for expected output. Format lives here — **MUST NOT** be duplicated in assignments.
{{/if}}
- `tasks`: Tasks to execute in parallel.
{{#if isolationEnabled}}
- `isolated`: Run in isolated environment; returns patches. Use when tasks edit overlapping files.
{{/if}}
</parameters>

<critical>
{{#if contextEnabled}}
- **MUST NOT** duplicate shared constraints across assignments — put them in `context` once.
{{else}}
- Every `assignment` must repeat any constraints, reference paths, and acceptance criteria it needs — there is no shared `context` field.
{{/if}}
- **MUST NOT** tell tasks to run project-wide build/test/lint. Parallel agents share the working tree; each task edits, stops. Caller verifies after all complete.
- For large payloads (traces, JSON blobs), write to `local://<path>` and pass the path in {{#if contextEnabled}}`context`{{else}}the relevant `assignment`{{/if}}.
- Prefer `task` agents that investigate **and** edit in one pass. Launch a dedicated read-only discovery step only when affected files are genuinely unknown.
</critical>

<scope>
Each task: **at most 3–5 files**. Globs, "update all", or package-wide scope = too broad. Enumerate files explicitly and fan out to a cluster of agents.
</scope>

<parallelization>
**Test:** Can task B produce correct output without seeing A's result? Yes → parallel. No → sequential.

|Sequential first|Then|Reason|
|---|---|---|
|Types/interfaces|Consumers|Need contract|
|API exports|Callers|Need signatures|
|Core module|Dependents|Import dependency|
|Schema/migration|App logic|Schema dependency|

**Safe to parallelize:** independent modules, isolated file-scoped refactors, tests for existing code.
</parallelization>

<templates>
{{#if contextEnabled}}
**context:**
```
## Goal         ← one sentence: what the batch accomplishes
## Non-goals    ← what tasks must not touch
## Constraints  ← MUST/MUST NOT rules and session decisions
## API Contract ← exact types/signatures if tasks share an interface (omit if N/A)
## Acceptance   ← definition of done; build/lint runs AFTER all tasks complete
```
{{else}}
No shared `context` field exists in this mode. Fold goal, non-goals, constraints, and acceptance criteria into each `assignment`.
{{/if}}
**assignment:**
```
## Target       ← exact file paths; named symbols; explicit non-goals
## Change       ← step-by-step what to add/remove/rename; patterns/APIs to use
## Edge Cases   ← tricky inputs; existing behavior that must survive
## Acceptance   ← observable result proving the task is done; no project-wide commands
```
</templates>

<checklist>
Before invoking:
{{#if contextEnabled}}
- `context` contains only session-specific info
{{else}}
- Every `assignment` includes its own goal, constraints, and acceptance criteria (no shared context)
{{/if}}
- Every `assignment` follows the template; no one-liners; edge cases covered
- Tasks are truly parallel — you can articulate why none depends on another's output
- File paths are explicit; no globs
{{#if customSchemaEnabled}}
- `schema` is set if you expect structured output
{{else}}
- Do not pass a custom task-call `schema` in this mode
{{/if}}
</checklist>

{{#if contextEnabled}}
<example label="Rename exported symbol + update all call sites">
Two tasks with non-overlapping file sets — demonstrates scope partitioning.

<context>
## Goal
Rename `parseConfig` → `loadConfig` in `src/config/parser.ts` and all callers.
## Non-goals
No behavior or signature changes; rename only.
## Acceptance (global)
Caller runs `bun check:ts` after both tasks complete. Tasks must NOT run it.
</context>
<tasks>
  <task name="RenameExport">
    <assignment>
## Target
- `src/config/parser.ts`: function `parseConfig`
- If `src/config/index.ts` re-exports it, update the re-export
- Non-goals: do not touch callers or tests

## Change
- Rename `parseConfig` → `loadConfig` (declaration + any JSDoc references)

## Edge Cases
- Rename all overload signatures if overloaded
- Internal helpers like `_parseConfigValue` are different symbols — leave untouched
- Do not add a backwards-compat alias

## Acceptance
- `parseConfig` no longer appears as a top-level export in `parser.ts`
    </assignment>
  </task>
  <task name="UpdateCallers">
    <assignment>
## Target
- `src/cli/init.ts`, `src/server/bootstrap.ts`, `src/worker/index.ts`
- Non-goals: do not touch `src/config/parser.ts` or `src/config/index.ts`

## Change
- Replace `import { parseConfig }` → `import { loadConfig }`
- Replace every call site `parseConfig(` → `loadConfig(`
- For `import * as cfg` users, update `cfg.parseConfig` property access

## Edge Cases
- String literals containing "parseConfig" (logs, comments) are documentation — leave them
- If a file re-exports to an external package boundary, keep the old name via `export { loadConfig as parseConfig }` with a `// TODO: remove after next major` comment

## Acceptance
- No bare `parseConfig` identifier remains in the three target files
    </assignment>
  </task>
</tasks>
</example>
{{/if}}

{{#list agents join="\n"}}
### Agent: {{name}}
**Tools:** {{default (join tools ", ") "All"}}
{{description}}
{{/list}}

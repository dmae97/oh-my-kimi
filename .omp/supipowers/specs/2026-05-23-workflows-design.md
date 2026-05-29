# Workflows Design

**Status:** Draft for review
**Date:** 2026-05-23
**Owner:** coding-agent

## Goal

Introduce a new user-authored extensibility surface — **workflows** — that lets users write deterministic TypeScript pipelines which orchestrate one or many spawned agent subsessions. Workflows are invoked from the OMP TUI via `/wf:<slug>` slash commands, run in the background, and report progress + final output back to the user without ever touching the parent session's transcript.

The controller is hand-written TypeScript; LLMs do the per-step work inside spawned subsessions. This fills the gap between LLM-driven `task` tool fan-out (the LLM coordinates) and skills/file slash commands (single-shot prompt expansion).

## Non-goals

- Not a replacement for skills, extensions, custom commands, or file slash commands. Each of those keeps its current role.
- Not a YAML/DSL pipeline language. Workflows are TS; the manifest is metadata only.
- Not a marketplace publishing format. v1 is local-only (`.omp/workflows/`). Marketplace integration is future work.
- Not a way to drive the parent session. Workflows never inject into the parent transcript and never feed the parent LLM context for v1.
- Not a long-running daemon. A workflow runs to completion and exits; no scheduling, no cron, no retry-on-restart.
- Not a permission/sandbox model beyond clean-room spawn defaults. Workflows run with the same OS privileges as OMP itself.

## Current implementation baseline

The repo currently has no workflow runtime. The implementation must compose with the surfaces that already exist instead of introducing parallel paths:

- `createAgentSession(...)` already discovers context files, prompt templates, file slash commands, skills, rules, custom TS commands, custom tools, MCP, and extensions during session bootstrap. It has no workflow option today, and custom tool discovery currently runs unconditionally after built-in tool creation.
- `AgentSession` already stores prompt templates, file slash commands, custom TS commands, skills, and skill warnings. Workflow state should be added in the same style: session-owned read-only arrays plus explicit refresh setters.
- `InputController` sends user input through built-in slash commands before `/skill:*` handling. `parseSlashCommand(...)` treats `:` as a separator, so `/wf:<slug>` must not be implemented as a normal built-in `/wf` command unless that built-in owns workflow invocation too.
- `refreshSlashCommandState(...)` currently refreshes file-based slash commands; `/move` calls it after `resetCapabilities()`. Workflow refresh must hook into that path and update `session.workflows`, runner registry, panel diagnostics, and autocomplete together.
- `ExtensionUiController` already exposes `notify(...)` and `setStatus(...)` over the extension UI context. Workflows should reuse those render paths instead of adding a second notification/status system.
- `getSessionSlashCommands(...)` is the central dynamic-command listing for interactive UI, ACP, RPC, print, and child task sessions; workflow-sourced command entries belong there.


## Concepts

- **Workflow** — a directory under `.omp/workflows/<slug>/` containing a `workflow.yml` manifest and a TS entry module. Discovered during session bootstrap and refreshed on `/move`.
- **Run request** — a user invocation of `/wf:<slug> [args]`. A request becomes a row only after slug lookup, arg validation, and concurrency admission succeed.
- **Run row** — the TUI-visible record for an accepted request. Has a unique run id, status (`queued`, `starting`, `running`, `completed`, `failed`, or `cancelled`), start/end timestamps, current step, AbortSignal, and an optional output file path once execution starts.
- **Spawn** — a single child `AgentSession` started by a workflow via `pi.spawn(...)`. Spawns are in-memory (no on-disk session pollution), clean-room (no extensions/MCP/LSP/workflows by default), and run to completion before returning.
- **Panel** — the `/wf` TUI view that lists active and recent runs plus discovery diagnostics.

## Filesystem layout

### Workflow directory

```
.omp/workflows/<slug>/
├── workflow.yml          # required: manifest
├── workflow.ts           # required: entry module (configurable via manifest.entry)
└── skills/               # optional: workflow-local skill bundle
    └── <skill-name>/
        └── SKILL.md
```

### Discovery roots and precedence

- **Project**: `<cwd>/.omp/workflows/`
- **User**: `~/.omp/agent/workflows/` (via `getAgentDir()`)
- **Precedence on slug collision**: project wins; user-level workflow is marked shadowed (mirrors the existing native slash-command precedence model in `src/discovery/builtin.ts`).

### Run output storage

- Per-run output file: `<cwd>/.omp/workflow-runs/<ISO-timestamp>-<slug>-<runId-prefix>.md` for runs that reach execution start.
  - Timestamp format: `YYYY-MM-DDTHHmmss` (filesystem-safe; no colons).
  - `<runId-prefix>` is the first 6 chars of the run's ULID so concurrent runs of the same slug get distinct files.
  - Created after module load/default-export validation, immediately before `WorkflowAPI` construction and user code execution. It is not created for queued runs cancelled before execution or for runs that fail while loading/validating the module.
  - The header contains slug, runId, args, started-at, and source path. Body is appended by `pi.log(...)`. Footer is written at run finalization per the "Final summary semantics" table — that table is the single source of truth for footer content and notification level.

- Convention: project-local so users can `read` outputs naturally and ignore the directory via `.gitignore`.

## Manifest schema (`workflow.yml`)

```yaml
slug: audit                            # required, matches /^[a-z][a-z0-9-]*$/
name: "Security & Dep Audit"           # required
description: "Run security and dep audits in parallel and report" # required
entry: workflow.ts                     # optional, default "workflow.ts"
args:                                  # optional, drives autocomplete + parsing
  - name: target
    description: "path to audit"
    required: true
  - name: depth
    description: "scan depth"
    required: false
concurrency: parallel                  # optional, "parallel" | "queue" | "reject"; default "parallel"
```

### Field rules

- `slug` — required. Regex `^[a-z][a-z0-9-]*$`. Used in `/wf:<slug>`. Must be unique within a single discovery root.
- `name` — required. Non-empty string. Displayed in autocomplete and the `/wf` panel.
- `description` — required. Non-empty string. Shown next to the slug in autocomplete and in the panel.
- `entry` — optional. Path to the entry module relative to the workflow directory. Default `workflow.ts`. Must resolve to an existing `.ts` or `.js` file at load time.
- `args` — optional. Array of positional argument descriptors:
  - `name` — required. Identifier (`^[a-z][a-z0-9_]*$`). Becomes a key on `pi.args`.
  - `description` — required.
  - `required` — optional boolean. Default `false`.
  - Missing required args at invocation time → run fails with `MissingArgError` before any user code runs.
- `concurrency` — optional. One of:
  - `parallel` (default) — concurrent runs of the same slug are allowed.
  - `queue` — second invocation waits for the first to finish; queued runs visible in the panel as `queued`.
  - `reject` — second invocation fails immediately with a notification; nothing is queued.

### Validation

- Manifest parsed with `Bun.YAML` (or `js-yaml` if needed) and validated with a Zod schema at workflow load time.
- Invalid manifests are skipped with a logged warning; the workflow does not register.
- Validation runs at every `discoverWorkflows(...)` call. The lifecycle is:
  - Once during `createAgentSession(...)` bootstrap unless `CreateAgentSessionOptions.workflows` is supplied explicitly.
  - Again on `/move`: `CommandController.handleMoveCommand(...)` already calls `resetCapabilities()` and `refreshSlashCommandState(newCwd)`; that refresh path must also call `refreshWorkflowState(newCwd)` so `session.workflows`, runner registry, panel diagnostics, and autocomplete are replaced from one discovery result.
  - Per `discoverWorkflows(...)` call is **not** the same as per-invocation; invoking `/wf:<slug>` does not re-read manifests.


## `WorkflowAPI` surface

The factory exported by `workflow.ts` receives a single `pi: WorkflowAPI` argument:

```ts
export default async function audit(pi: WorkflowAPI): Promise<void> {
  // ...orchestration...
}
```

### Type signature

```ts
export interface WorkflowAPI {
  // Identity & lifecycle
  readonly slug: string;
  readonly runId: string;
  readonly cwd: string;
  readonly args: ParsedArgs;
  readonly argv: readonly string[];
  readonly signal: AbortSignal;

  // Injected modules
  readonly logger: Logger;            // `Logger` = `typeof logger` from `@oh-my-pi/pi-utils`; imported top-level in `types.ts`
  readonly zod: ZodLib;               // `ZodLib` = `typeof zodModule` from `zod/v4`; imported top-level in `types.ts`
  readonly pi: PiCodingAgentExports;  // type alias re-exporting the SDK's namespace; imported top-level in `types.ts`


  // Skill catalog (workflow-local merged over global; workflow-local wins)
  readonly skills: ReadonlyMap<string, Skill>;

  // Core orchestration
  spawn(opts: SpawnOptions): Promise<SpawnResult>;

  // Progress / panel
  step<T>(label: string, fn: () => Promise<T>): Promise<T>;

  // Per-run output file
  log(markdown: string): Promise<void>;

  // Final result. See "Final summary semantics" below for missing/multiple-call rules.
  return(summary: string): void;


  // User interaction (queued; defers when parent is mid-stream)
  readonly ui: WorkflowUIContext;

  // Shell
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
}

export interface SpawnOptions {
  prompt: string;
  model?: Model | string;            // Model: re-export of `@oh-my-pi/pi-ai`'s Model; string accepted as model id and resolved via the parent ModelRegistry
  tools?: string[];                  // built-in tool allowlist; undefined = default builtin set
  skills?: (string | Skill)[];       // names resolved against pi.skills; Skill is re-exported from this module (originally `Skill` from `src/extensibility/skills`)
  outputSchema?: ZodTypeAny;         // ZodTypeAny from `zod/v4`; when present, requireYieldTool=true and structured result is populated
  cwd?: string;                      // default: pi.cwd
  signal?: AbortSignal;              // chained with pi.signal
  label?: string;                    // shown in panel; default "spawn"
}

export interface SpawnResult<T = unknown> {
  text: string;                      // final assistant text (concatenated text_delta events)
  structured?: T;                    // populated when outputSchema was provided and yield tool was called
  transcript: string;                // full assistant transcript including thinking, sanitized markdown
  tokens: { input: number; output: number };
  ms: number;                        // wall-clock duration
  modelId: string;
  spawnId: string;
}

export interface WorkflowUIContext {
  confirm(title: string, message: string): Promise<boolean>;
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(text: string, level?: "info" | "warning" | "error"): void;
}

export type ParsedArgs = Readonly<Record<string, string | undefined>>;

// Boundary types come from existing modules, re-exported from
// `@oh-my-pi/pi-coding-agent` for ergonomic workflow authoring:
//   Model         -> `@oh-my-pi/pi-ai`
//   Skill         -> `src/extensibility/skills` (already exported via SDK)
//   ExecOptions   -> `src/exec/exec` (already exported via SDK)
//   ExecResult    -> `src/exec/exec` (already exported via SDK)
//   ZodTypeAny    -> `zod/v4`
```

### Argument parsing

- Invocation: `/wf:<slug> <arg1> <arg2> ...`
- Splitting uses the existing `parseCommandArgs(text)` helper (quote-aware, no escaping).
- Positional tokens map to `manifest.args` in declared order: token `i` → `args[i].name`.
- Excess positional tokens go into `pi.argv` (unparsed full token list); `pi.args` only contains declared names.
- Named flags (`--foo=bar`) are **out of scope for v1** — `args` is positional-only. Workflow authors who need flags can parse `pi.argv` themselves.

### Spawn defaults (clean room with opt-in)

When `pi.spawn(opts)` calls `createAgentSession(...)`, it sets the following derived options:

| Option | Value | Rationale |
|--------|-------|-----------|
| `sessionManager` | `SessionManager.inMemory(opts.cwd ?? pi.cwd)` | No on-disk session pollution. |
| `cwd` | `opts.cwd ?? pi.cwd` | Inherit unless explicitly overridden. |
| `authStorage` | inherited from parent | Subagents share creds with parent. |
| `modelRegistry` | inherited from parent | Subagents share model availability. |
| `model` | `opts.model` resolved via the parent registry, else parent active model | Avoid child settings/model discovery drift. |
| `settings` | `Settings.isolated({ "async.enabled": false, "bash.autoBackground.enabled": false, "tools.approvalMode": "yolo" })` | No project/user settings leak in; child sessions are non-interactive and must not leave background work behind. |
| `disableExtensionDiscovery` | `true` | No extensions or custom TS commands on subagents. |
| `enableCustomToolDiscovery` | `false` | Disables the current unconditional `discoverAndLoadCustomTools(...)` path in `sdk.ts`; inline `customTools: []` alone is not enough today. |
| `enableMCP` | `false` | No MCP on subagents. |
| `enableLsp` | `false` | No LSP on subagents. |
| `skills` | resolved from `opts.skills` (default `[]`) | Opt-in skill injection — explicit empty array suppresses default skill discovery. |
| `rules` | `[]` | Explicit empty array suppresses default rule discovery. |
| `contextFiles` | `[]` | Explicit empty array suppresses AGENTS.md/context-file discovery. |
| `promptTemplates` | `[]` | Explicit empty array suppresses prompt-template discovery. |
| `slashCommands` | `[]` | Explicit empty array suppresses file-slash-command discovery. |
| `customTools` | `[]` | Explicit empty array; no user-supplied custom tools. |
| `workflows` | `[]` | Child sessions do not see workflows themselves; no recursive `/wf:` from inside a spawned agent. |
| `toolNames` | `opts.tools` (default: full built-in set) | Allowlist explicit; default = whatever `createTools(toolSession, undefined)` yields. |
| `outputSchema` | `opts.outputSchema` | Pass through to subagent yield. |
| `requireYieldTool` | `!!opts.outputSchema` | Structured output requires yield. |
| `taskDepth` | `(parent.taskDepth ?? 0) + 1` | Nested-subagent depth tracking. |
| `parentTaskPrefix` | `wf:<slug>:<runId>` | Artifact namespacing for IRC/local://. |
| `hasUI` | `false` | Subagents are non-interactive. |

These defaults are deliberately stricter than the current `task/executor.ts` subagent path. Workflows reuse the in-memory session pattern and shared auth/model registry, but every discovery channel must be closed explicitly because workflow authors are writing deterministic orchestration code, not asking the parent LLM to coordinate an ambient project-aware subagent.

### SDK changes required to support clean-room spawn

The `createAgentSession` option surface needs two additions to support `pi.spawn` and top-level workflow discovery:

1. `enableCustomToolDiscovery?: boolean` (default `true` to preserve existing behavior). When `false`, the SDK skips the unconditional `discoverAndLoadCustomTools(...)` call in `src/sdk.ts` and proceeds with only the inline `options.customTools` array.
2. `workflows?: WorkflowSpec[]` (default: `discoverWorkflows({ cwd, agentDir })`). Supplying an explicit array skips workflow discovery and records no workflow warnings. `AgentSessionConfig` also gets `workflowWarnings?: WorkflowWarning[]`; `createAgentSession(...)` passes warnings from default discovery, while explicit `workflows` uses an empty warning list. `AgentSession` exposes `readonly workflows`, `readonly workflowWarnings`, and `setWorkflows(workflows, warnings)` so `/move` can atomically refresh the registry and diagnostics.

These are additive options; existing callers behave unchanged. Workflow-launched subagents always pass `workflows: []` so they do not expose recursive workflow commands.

### Skill resolution for `pi.spawn({ skills })`

1. `string` entries are looked up in `pi.skills` (workflow-local merged over globally-discovered skills).
2. `Skill` object entries are used verbatim (escape hatch).
3. Unknown string name → throws `UnknownSkillError(name)` synchronously before the spawn starts. (Loud failure beats silent skip.)

### UI queueing model

Workflows run background-detached, but `ui.confirm/select/input` are blocking operations that need the user's attention. The UI controller exposes a single FIFO queue for workflow UI prompts:

- If the parent session is **idle**, the prompt opens immediately as a modal selector/dialog (reusing the existing extension-UI machinery in `extension-ui-controller.ts`).
- If the parent session is **streaming**, the prompt is queued. A status-line badge (`wf:<slug> waiting on input`) is shown. The prompt opens as soon as the parent becomes idle.
- The user can cancel a pending prompt via the panel (treated as `undefined`/`false` return).
- `ui.notify` is fire-and-forget; it never queues.

## Discovery & loading

### `discoverWorkflows(options?)`

Public SDK helper:

```ts
export interface WorkflowDiscoveryResult {
  workflows: WorkflowSpec[];
  warnings: WorkflowWarning[];
}

function discoverWorkflows(options?: {
  cwd?: string;
  agentDir?: string;
}): Promise<WorkflowDiscoveryResult>;
```

- Scans `<cwd>/.omp/workflows/*/workflow.yml` and `<agentDir>/workflows/*/workflow.yml`.
- For each manifest:
  1. Parse YAML.
  2. Validate against Zod schema.
  3. Resolve `entry` path; verify file exists.
  4. Scan `<workflow-dir>/skills/` for workflow-local skills via `scanSkillsFromDir(...)` (existing helper).
  5. Produce a `WorkflowSpec` record. Module loading is **deferred** until the workflow is invoked.
- Project entries are added before user entries; collisions resolve project-first with user marked `shadowed: true`.
- Errors per-workflow are collected in `warnings`; the rest of the load continues.
- **Shadowed handling**: shadowed workflows are excluded from autocomplete, the `/wf:<slug>` dispatcher (slug lookup ignores them), and the active rows of the `/wf` panel. They remain in `discoverWorkflows()` output and the panel's "Shadowed" diagnostic section so users can see the collision; they are not invokable.


```ts
export interface WorkflowSpec {
  slug: string;
  name: string;
  description: string;
  manifestPath: string;
  entryPath: string;          // absolute, resolved
  source: "project" | "user";
  manifest: WorkflowManifest;
  localSkills: Skill[];       // pre-scanned at discovery time
  shadowed?: boolean;
}

export interface WorkflowWarning {
  path: string;
  source: "project" | "user";
  reason: string;
  code:
    | "invalid-yaml"
    | "schema"
    | "missing-entry"
    | "slug-regex"
    | "duplicate-slug"
    | "shadowed";
}
```

### Module loading

- Workflow modules are imported on first invocation via dynamic `await import(entryPath)` and cached by `entryPath`. This matches the established loader pattern in `src/extensibility/custom-commands/loader.ts` and `src/extensibility/extensions/loader.ts`, which is the documented mechanism for loading user-authored TS modules from arbitrary filesystem paths. The root `AGENTS.md` "no inline imports" rule applies to OMP source files; module loaders that exist specifically to import user code are the explicit exception (custom commands, extensions, hooks).
- Expected export: default function `(pi: WorkflowAPI) => unknown | Promise<unknown>`.
- Missing default export, non-function default, or import error → accepted row is marked `failed`, `ui.notify(..., "error")` is dispatched, and no output file is created.
- The `WorkflowAPI`, `WorkflowSpec`, `WorkflowManifest`, `SpawnOptions`, `SpawnResult`, and `WorkflowUIContext` interfaces are declared in `src/extensibility/workflows/types.ts` using top-level `import type { ... }` statements for every boundary type (`Model`, `Skill`, `ExecOptions`, `ExecResult`, the `Logger` alias, the `ZodLib` alias, the `PiCodingAgentExports` alias). The `typeof import("...")` shorthand in this design doc is illustrative only and must not appear in the implementation.


### Capability system integration

- **Out of scope for v1.** Workflows do not go through `loadCapability(...)`. A standalone discovery function is sufficient given the two well-defined search roots.
- Future: a `workflowCapability` could be added so claude/codex/plugin providers can ship workflows. Not blocked by the current design.

## Run lifecycle

### Trigger and invocation ownership

Workflow dispatch is owned by a new `WorkflowController`; `InputController` only detects candidate text and delegates.

`/wf:<slug> [args]` and exact `/wf` are checked after built-in slash commands return `false` and before `/skill:*`, shell, Python, streaming, or normal prompt handling. **Do not add `/wf` to `BUILTIN_SLASH_COMMAND_REGISTRY` for v1**: `parseSlashCommand(...)` treats `:` as a separator, so a built-in `wf` entry would consume `/wf:<slug>` before the workflow-specific parser sees the slug.

Accepted dispatch clears the editor and records history. Rejected dispatch restores/leaves the editor text so the user can fix the invocation.

| Phase | Owner | Responsibility | Row/output behavior |
|-------|-------|----------------|---------------------|
| Panel command | `WorkflowController` | Exact `/wf` toggles the workflow panel | No run row/output |
| Parse workflow invocation | `WorkflowController` | Detect `/wf:<slug>`, split slug from raw arg string | Unknown slug falls through to normal slash-command behavior |
| Validate request | `WorkflowRunner` | Ignore shadowed specs, parse positional args, check required args, enforce `reject` policy | Failure notifies error; no run row/output |
| Accept request | `WorkflowRunner` | Allocate runId, create row, apply concurrency policy | `parallel`/idle `queue` rows become `starting`; blocked `queue` rows stay `queued` with no output path |
| Start execution | `WorkflowRunner` | Dynamic import, default-export validation, output file creation, `pi` construction | Load/export failure marks the row `failed`, notifies error, and creates no output file |
| Run/finalize | `WorkflowRunner` | Execute factory, update steps/status, write footer, dispatch final notification, cleanup | Output footer follows "Final summary semantics" |

### Steps inside the runner

These steps run in order for a request that has passed validation:

1. **Run row allocation.** Generate a ULID, create a `WorkflowRunRow` with `status: "queued"` or `status: "starting"`, `outputPath: undefined`, and the parsed args/argv.
2. **Queue wait** (`concurrency: queue` only). While another run of the same slug is active, the row stays `queued`. Cancelling here sets `cancelled` and still produces no output file.
3. **Module load.** Cached dynamic import of `entryPath`. On failure → row `failed`, error notification, no output file.
4. **Default-export validation.** Confirm the module exports a default function. On failure → row `failed`, error notification, no output file.
5. **Output file creation.** Create parent dir `<cwd>/.omp/workflow-runs/` if missing. Create the markdown file with a header (slug, runId, args, started-at, source path) and attach `outputPath` to the row.
6. **`pi` construction.** Build the `WorkflowAPI` bound to this run's `runId`, `signal` (per-run `AbortController`), `args`, `cwd`, merged skills map, parent's auth/model registry, and the output writer.
7. **Status update.** Set the row to `running`; re-render the footer indicator from the active run set.
8. **Execute.** `await factory(pi)`.
9. **Finalize.** Resolve the final summary (see "Final summary semantics"), then write the footer to the output file and dispatch `ui.notify(...)` with the resolved summary and matching level.
10. **Terminal row update.** Set status to `completed`, `failed`, or `cancelled`; record `endedAt`.
11. **Cleanup.** Dispose any child `AgentSession`s still alive (`signal.abort()` cascades), close the output writer, and start the next queued run for the slug if present.

### Final summary semantics

`pi.return(summary)` is optional. The runner resolves the final summary at finalization time using this single rule:

| State | Resolved summary | Notification level | Footer content |
|-------|-------------------|--------------------|----------------|
| Factory resolves normally, `pi.return` called once | `summary` argument | `info` | `summary` |
| Factory resolves normally, `pi.return` called multiple times | Last call wins; previous values discarded (`pi.logger.warn` records the overwrite) | `info` | Last `summary` |
| Factory resolves normally, `pi.return` never called | `"Workflow completed."` | `info` | `"Workflow completed."` |
| Factory throws (after any number of `pi.return` calls) | `"Workflow failed: <error.message>"` | `error` | `"Workflow failed: <error.message>"` followed by the full stack trace; then an "Intended summary" section containing the most recent `pi.return` value (if any) |
| AbortSignal triggered (cancellation) | `"Workflow cancelled."` | `info` | `"Workflow cancelled."` + the most recent `pi.return` summary (if any) recorded under "Intended summary" |

The runner is the single owner of finalization; user code cannot prevent footer writing or notification dispatch.


### Cancellation

- Per-run `AbortController` is the single source of cancellation truth.
- User triggers via panel (`c` key on a row) or via `OMP` shutdown.
- `pi.signal` exposes the controller's signal to workflow code.
- `pi.spawn(...)` chains `opts.signal` with `pi.signal` so child agent sessions abort.
- `pi.exec(...)` honors `pi.signal` via the existing `execCommand` signal plumbing.
- On OMP session shutdown (`session_shutdown` event), all active runs are aborted and given a 5-second grace period to finalize their output file before the process exits.

### Concurrency policy enforcement

- `parallel` (default) — new accepted request starts immediately.
- `queue` — if an active run of the same slug exists, the new accepted request is parked with `status: "queued"` and no `outputPath`. When the active run reaches `completed`/`failed`/`cancelled`, the next queued row transitions to `starting`.
- `reject` — if an active run of the same slug exists, validation fails immediately with `ui.notify(..., "error")`; no row/output is created.
- **Queued-run cancellation**: a queued run that is cancelled before it starts is removed from the queue, gets status `cancelled`, and produces **no output file**. Its row records the cancelled status without an output path.

## TUI integration

### `/wf` and `/wf:<slug>` autocomplete

- The autocomplete list gets a static `SlashCommand` entry `{ name: "wf", description: "Open workflows panel" }` from `WorkflowController`; it is not a built-in slash command.
- Each non-shadowed `WorkflowSpec` produces a `SlashCommand` entry of shape `{ name: "wf:<slug>", description: manifest.description, argumentHint?, getArgumentCompletions?, getInlineHint? }` where:
  - `name` is the literal `"wf:<slug>"` (no leading `/`; the autocomplete pipeline prefixes the slash itself).
  - `description` is `manifest.description`.
  - `argumentHint` is built from the manifest's declared args, e.g. `"<target> [depth]"`, when `args` is present.
  - `getInlineHint(argumentText)` produces ghost text from the next undeclared `args[i].description` based on how many tokens have been typed; null after all declared args are consumed.
  - `getArgumentCompletions` is **omitted** in v1 (no value completion — manifest only describes names, not value sets).
- Initial entries are projected from `session.workflows` when `InteractiveMode` is constructed. On `/move`, `refreshWorkflowState(newCwd)` re-runs discovery and rebuilds these entries alongside file slash command refresh.

- The capability-side `SlashCommandInfo` type (`src/extensibility/slash-commands.ts`) is extended to add `"workflow"` to its `SlashCommandSource` union so the Extensions dashboard and any other capability consumers can identify workflow-sourced entries when listing them. The `location` field reuses the existing `"user" | "project"` values.

### Status widget (footer)

- Reuses the existing `setStatus(key, text)` channel from `extension-ui-controller.ts`.
- Key: `workflows`.
- Text format when ≥1 active run: `wf:<slug-1> ● <step-or-step-count>` joined by ` · ` for multiple runs, truncated to terminal width.
- Cleared when no active runs.

### `/wf` panel

- Triggered by exact `/wf` through `WorkflowController` (not the built-in slash-command registry).
- Implemented as a TUI overlay component (`packages/coding-agent/src/modes/components/workflow-panel.ts`) similar to existing dialog components.
- Columns: slug · status · step · elapsed · started-at.
- Rows are sorted: active runs first, then queued, then completed/failed/cancelled by `endedAt` desc.
- **Diagnostics section** (rendered below the run table when present): one row per warning from the last `discoverWorkflows()` call (invalid YAML, schema failures, missing entry, regex mismatches, slug collisions). Each row shows source path + reason. Diagnostics are read-only.
- Key bindings:
  - `↑/↓` — navigate
  - `Enter` — open the run's output file in `read` mode (reuses existing `read` pipeline; output path is shown)
  - `c` — cancel selected active or queued run (no-op for terminal-status rows)
  - `Esc` — close panel

### Notifications

- On run completion, the runner calls `ui.notify(summary, level)`:
  - `info` level for `completed`
  - `error` level for `failed` (summary becomes "Workflow failed: <error.message>")
  - `info` level for `cancelled`
- Notifications surface through the parent session's existing notification channel (no special path).

## Integration points (code-level)

### New files

- `packages/coding-agent/src/extensibility/workflows/types.ts` — `WorkflowAPI`, `WorkflowManifest`, `WorkflowSpec`, `WorkflowWarning`, `WorkflowDiscoveryResult`, `SpawnOptions`, `SpawnResult`, `WorkflowUIContext`, error classes.
- `packages/coding-agent/src/extensibility/workflows/manifest.ts` — Zod schema + `parseManifest(yaml: string): WorkflowManifest`.
- `packages/coding-agent/src/extensibility/workflows/loader.ts` — `discoverWorkflows(...)` + module-import cache.
- `packages/coding-agent/src/extensibility/workflows/runner.ts` — `WorkflowRunner` class (one instance per active OMP session); owns run rows, queueing, execution lifecycle, status widget updates, and finalization.
- `packages/coding-agent/src/extensibility/workflows/spawn.ts` — `createSpawn(...)` that builds a child `createAgentSession` per the spawn defaults table and accumulates `SpawnResult`.
- `packages/coding-agent/src/extensibility/workflows/output-writer.ts` — markdown writer for `.omp/workflow-runs/<ISO-timestamp>-<slug>-<runId-prefix>.md`.
- `packages/coding-agent/src/extensibility/workflows/index.ts` — barrel re-exports.
- `packages/coding-agent/src/modes/components/workflow-panel.ts` — `/wf` TUI panel component.
- `packages/coding-agent/src/modes/controllers/workflow-controller.ts` — interactive-mode glue: owns exact `/wf`, `/wf:<slug>`, workflow autocomplete projection, panel toggle/cancel/open-output actions, and workflow discovery refresh.

### Modified files

- `packages/coding-agent/src/sdk.ts` — export `discoverWorkflows` and workflow types; add `workflows?: WorkflowSpec[]` and `enableCustomToolDiscovery?: boolean` to `CreateAgentSessionOptions`; default-discover workflows during bootstrap; pass workflows + warnings into `AgentSession`; gate the existing `discoverAndLoadCustomTools(...)` block on `enableCustomToolDiscovery !== false`.
- `packages/coding-agent/src/session/agent-session.ts` — add workflow fields to `AgentSessionConfig`; expose `session.workflows`, `session.workflowWarnings`, and `setWorkflows(workflows, warnings)` (parallels `setSlashCommands(...)` and existing read-only command/skill getters).
- `packages/coding-agent/src/modes/types.ts` — add workflow-controller entry points needed by `InputController` and command refresh (`handleWorkflowCommand`, `refreshWorkflowState`, and panel toggles as needed).
- `packages/coding-agent/src/modes/controllers/input-controller.ts` — add `#invokeWorkflowCommand(text)` parallel to `#invokeSkillCommand(text)`; delegate exact `/wf` and `/wf:<slug>` after built-in slash commands return `false` and before skill/shell/Python/streaming handling.
- `packages/coding-agent/src/modes/interactive-mode.ts` — instantiate `WorkflowController`; project `session.workflows` into `#pendingSlashCommands`; call `refreshWorkflowState(...)` from `refreshSlashCommandState(...)` so `/move` replaces workflow registry + diagnostics + autocomplete with the new cwd's result.
- `packages/coding-agent/src/modes/controllers/extension-ui-controller.ts` — no new render API; workflow controller reuses existing `setHookStatus(...)` and `showHookNotify(...)` paths.
- `packages/coding-agent/src/extensibility/slash-commands.ts` — extend the `SlashCommandSource` union to include `"workflow"` so capability consumers can identify workflow-sourced entries.
- `packages/coding-agent/src/extensibility/extensions/get-commands-handler.ts` — extend `CommandsCapableSession` with `workflows: ReadonlyArray<WorkflowSpec>` and append a fourth emission loop that produces `{ name: "wf:<slug>", description, source: "workflow", location: spec.source, path: spec.entryPath }` for each non-shadowed workflow.

### Things that do NOT change

- `AgentSession` execution flow — workflows go around it; the parent session's turn machinery, prompt pipeline, and tool registry behavior are unchanged. AgentSession only gains workflow registry/diagnostic storage for listing, autocomplete, and `/move` refresh.
- Tool registry — workflows do not register tools (they spawn subagents that use the existing tool set).
- Settings schema — no new global settings for v1. (Future: `workflows.enabled`, `workflows.allowedSources`.)
- Slash command capability system — no new provider in v1.

## Error handling

Error surfaces are grouped by the earliest surface that exists:

- **Discovery-time** (`discoverWorkflows()` runs during session bootstrap or `/move`): no `pi`, no run. Errors are logged via `@oh-my-pi/pi-utils`'s top-level `logger`, returned in the `warnings` array, stored on `session.workflowWarnings`, and surfaced in the `/wf` panel diagnostics section.
- **Validation-time** (user typed `/wf:<slug>` but the request was not accepted): no row/output. Errors surface through the parent session's existing `ui.notify(..., "error")` path via `ExtensionUiController`; editor text is left/restored so the user can fix it.
- **Start-time** (request accepted and row exists, but no output file yet): module import/default-export failures mark the row `failed`, notify an error, and do not create an output file.
- **Run-time** (output file exists and `pi` has been constructed): errors flow through the runner's finalization path (output file footer + `ui.notify`) per "Final summary semantics".

### Discovery-time errors (no `pi`, no run)

| Scenario | Behavior |
|----------|----------|
| Invalid YAML in `workflow.yml` | Skip workflow; `logger.warn` from `@oh-my-pi/pi-utils`; entry added to `discoverWorkflows()` warnings; surfaced as a row in the `/wf` panel diagnostics section |
| Manifest fails Zod validation | Skip workflow; `logger.warn` with the field-level error; added to warnings |
| `entry` file missing | Skip workflow; `logger.warn` referencing the entry path; added to warnings |
| Slug regex mismatch | Skip workflow; `logger.warn`; added to warnings |
| Slug collision project↔user | Project wins; user spec marked `shadowed: true`, excluded from invocation/autocomplete/getCommands, and listed in diagnostics |
| Slug collision within one root | First-found wins; second `logger.warn`; added to warnings |

### Validation/start-time errors (no `pi`; output file absent)

| Scenario | Owner | Behavior |
|----------|-------|----------|
| Missing required arg | `WorkflowRunner` | `ui.notify(..., "error")`; no row/output |
| `concurrency: reject` while active | `WorkflowRunner` | `ui.notify(..., "error")`; no row/output |
| Module load failure (dynamic `import(entryPath)` throws) | `WorkflowRunner` | Existing row marked `failed`; `ui.notify(..., "error")`; no output file |
| Missing/invalid default export | `WorkflowRunner` | Existing row marked `failed`; `ui.notify(..., "error")`; no output file |

### Run-time errors (`pi` exists; run row + output file already exist)

These errors happen after `pi` is constructed and the run has started. They flow through the runner's finalization per "Final summary semantics".

| Scenario | Behavior |
|----------|----------|
| Workflow factory throws | Run marked `failed`; footer per "Final summary semantics" (failure row); `failed` notification |
| `pi.spawn` throws | Propagates to workflow code unless caught; uncaught → run marked `failed` |
| Unknown skill name in `pi.spawn({ skills })` | `UnknownSkillError(name)` thrown synchronously from `pi.spawn`; spawn does not start; workflow may catch |
| AbortSignal triggered mid-run | Run marked `cancelled`; in-flight `pi.spawn` children abort; footer per "Final summary semantics" (cancellation row); `info` notification |
| OMP shutdown with active runs | All runs receive `signal.abort()`; 5-second grace for finalization; process exits regardless |

## Testing approach

Per `AGENTS.md`'s "Testing Guidance":

- **Manifest validation** — Zod schema unit tests for required fields, regex, defaults, optional shape. One test per invariant.
- **Discovery** — fixture directories under `tmp/`; assert ordered project→user precedence, shadowed flag on collision, warnings for invalid manifests, and no invocation entries for shadowed workflows.
- **Session bootstrap/refresh** — `createAgentSession` default discovery stores workflows + warnings; explicit `workflows: []` skips discovery; `/move` refresh replaces `session.workflows`, `session.workflowWarnings`, runner registry, panel diagnostics, and autocomplete together.
- **Command parsing** — exact `/wf` opens the panel; `/wf:<slug>` invokes the workflow parser; unknown `/wf:<slug>` falls through like any unknown slash command; no `BUILTIN_SLASH_COMMAND_REGISTRY` entry steals colon parsing.
- **Argument parsing** — positional mapping, missing-required failure path, excess tokens in `pi.argv`.
- **Spawn defaults** — invoke `pi.spawn` with a mocked `createAgentSession`; assert exact option payload (clean-room defaults + `enableCustomToolDiscovery: false` + `workflows: []` + skill injection).
- **Skill resolution** — string names resolve, unknown names throw, Skill objects pass through.
- **Concurrency policies** — `parallel` lets two runs start, `queue` parks the second until the first finishes and creates no output while queued, `reject` notifies + does nothing.
- **Cancellation propagation** — abort the per-run controller; assert child spawns receive abort and run finalizes with `cancelled`.
- **Output writer** — file is created only after module/default-export validation, with a header (slug, runId, args, started-at, source path); `pi.log` appends to the body; finalization writes the footer. Test queued cancellation and module-load failure produce no output file.

- **UI queueing** — `ui.confirm` defers when parent is streaming and opens when idle.

End-to-end smoke (manual or scripted in a single test file):
- A fixture workflow `tests/fixtures/workflows/echo` whose entry calls `pi.spawn({ prompt: "say hi" })` with a stubbed model; verify the run completes, output file contains the expected content, status widget cleared.

## Open questions resolved during design

- **Capability provider for workflows** — deferred. v1 uses a standalone discovery function.
- **`pi.parentSession`** — deferred. No identified v1 use case.
- **Named flags (`--foo=bar`) in arg parsing** — deferred to v2.
- **Cross-machine workflow sharing / marketplace** — deferred. v1 is local-only.
- **Workflow-local custom tools / prompt templates** — deferred. v1 supports only workflow-local skills.

## Acceptance criteria

1. `discoverWorkflows()` returns all manifests under `<cwd>/.omp/workflows/` and `~/.omp/agent/workflows/` with the documented precedence, shadowing, and warnings.
2. Session bootstrap stores discovered workflows and warnings on `AgentSession`; explicit `workflows: []` suppresses workflow discovery for clean-room children.
3. Invoking `/wf:<slug>` from interactive mode:
   - Validates required args and surfaces missing-arg errors as `ui.notify(..., "error")`.
   - Honors the manifest's `concurrency` policy.
   - Runs accepted workflows in the background; the parent session remains responsive.
4. Exact `/wf` opens a panel listing active/recent runs and diagnostics with the documented columns and key bindings.
5. `/move <path>` refreshes workflows for the new cwd and updates session state, runner registry, panel diagnostics, and autocomplete from one discovery result.
6. `pi.spawn(...)`:
   - Uses an in-memory session.
   - Applies the clean-room defaults table, including `enableCustomToolDiscovery: false` and `workflows: []`.
   - Injects skills resolved by name.
   - Honors `pi.signal` and chains it with any `opts.signal`.
   - Returns `{ text, structured?, transcript, tokens, ms, modelId, spawnId }`.
7. `pi.step(label, fn)` updates the footer indicator and the panel row's `step` field.
8. The output file `<cwd>/.omp/workflow-runs/<ISO-timestamp>-<slug>-<runId-prefix>.md` is created only after module/default-export validation, with the documented header; `pi.log(markdown)` appends to the body; finalization writes the footer.
9. Queued cancellation and module/default-export failures produce no output file while still surfacing visible panel/notification state.
10. `pi.return(summary)` records the summary; the runner uses it (per "Final summary semantics") to compose the footer and the notification body. The runner owns finalization; user code cannot prevent footer writing or notification dispatch.
11. Cancellation via the panel aborts the run and any in-flight `pi.spawn` children within 5 seconds.
12. OMP shutdown signals all active runs and lets them finalize within 5 seconds.
13. Workflow load failures are isolated: one bad manifest or module does not prevent other workflows from loading or running.

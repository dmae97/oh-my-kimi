# task

> Spawn subagents to work in the background — one per call, or a `tasks[]` batch per call (`task.batch`, default on).

## Source
- Entry: `packages/coding-agent/src/task/index.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/task.md`
- Key collaborators:
  - `packages/coding-agent/src/task/types.ts` — dynamic schema, progress/result types, output caps.
  - `packages/coding-agent/src/task/discovery.ts` — discover project/user/plugin/bundled agents.
  - `packages/coding-agent/src/task/agents.ts` — bundled agent definitions and frontmatter parsing.
  - `packages/coding-agent/src/task/executor.ts` — create child sessions, run subagents, collect output, hand finished sessions to the lifecycle manager.
  - `packages/coding-agent/src/registry/agent-lifecycle.ts` — idle-TTL parking and revival of finished subagents.
  - `packages/coding-agent/src/registry/agent-registry.ts` — process-global agent directory (`running | idle | parked | aborted`).
  - `packages/coding-agent/src/async/job-manager.ts` — background job registration, progress, and result delivery.
  - `packages/coding-agent/src/task/parallel.ts` — `Semaphore` used for the session-scoped concurrency bound.
  - `packages/coding-agent/src/task/isolation-backend.ts` — isolation backend resolution and platform fallback.
  - `packages/coding-agent/src/task/worktree.ts` — worktree / FUSE / ProjFS setup, patch capture, branch merge.
  - `packages/coding-agent/src/task/output-manager.ts` — session-scoped `agent://` id allocation.
  - `packages/coding-agent/src/task/name-generator.ts` — default AdjectiveNoun agent ids.
  - `packages/coding-agent/src/internal-urls/agent-protocol.ts` — resolve `agent://<id>` to saved subagent output.
  - `packages/coding-agent/src/internal-urls/history-protocol.ts` — resolve `history://<id>` to a concise transcript.
  - `packages/coding-agent/src/tools/index.ts` — tool registration and recursion-depth gating.
  - `packages/coding-agent/src/sdk.ts` — child-session router/tool wiring and per-subagent `AgentOutputManager`.
  - `docs/task-agent-discovery.md` — deeper discovery and precedence notes.

## Inputs

The wire schema is shape-swapped by `task.batch` (default on). One unit of work is the task item `{ id?, description?, assignment, isolated? }` (`isolated` only when `task.isolation.mode` is not `none`):

- **Batch shape** (`task.batch` on): `{ agent, context, tasks: item[] }` — one subagent per item, all spawned in parallel as independent background jobs. `context` is **required** shared background rendered into every spawned subagent's system prompt (`CONTEXT` section); `isolated` is per item.
- **Flat shape** (`task.batch` off): `{ agent, ...item }` — exactly one spawn per call. Shared background goes into a `local://` file (e.g. `local://ctx.md`) that each assignment references; subagents share the parent's `local://` root.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `agent` | `string` | Yes | Agent type to spawn (both shapes). |
| `context` | `string` | Yes (batch) | Shared background prepended to every spawn of the call via the subagent system prompt. Rejected when `task.batch` is off. |
| `tasks` | `array` | Yes (batch) | One task item per subagent. Provided ids must be unique within the call (case-insensitive). Rejected when `task.batch` is off. |
| `id` | `string` | No | Stable agent id, schema max length 48. Defaults to a generated AdjectiveNoun name. Uniquified per session by `AgentOutputManager`. Item field in batch shape, top-level in flat shape. |
| `description` | `string` | No | UI label only; the subagent never sees it. Item field in batch shape, top-level in flat shape. |
| `assignment` | `string` | Yes | The work — complete, self-contained instructions. Empty-after-trim is rejected. Item field in batch shape, top-level in flat shape. |
| `isolated` | `boolean` | No | Run in an isolated workspace and return patches. Exists only when `task.isolation.mode` is not `none`; per item in batch shape, top-level in flat shape. Isolated agents are torn down at completion — not revivable. |

Runtime stays permissive: the flat form is accepted even while `task.batch` is on (internal callers such as the commit flow's `analyze_files`, and stale transcripts). The model only ever sees one shape.

There is no per-call `schema` parameter. Structured output comes from the agent definition's `output` frontmatter, the inherited parent session schema, or — for ad-hoc workflows — the eval bridge's `agent(prompt, schema)`.

## Outputs

The tool returns one text block plus `details: TaskToolDetails`.

Immediate (async) response — the normal case:
- `content`: `` Spawned agent `<id>` (job `<jobId>`). The result will be delivered when it yields. ... `` plus a coordination hint (`irc` DM when enabled, otherwise `job`). A batch call instead returns `` Spawned N background agents using <agent>. ... `` with a per-agent `- `<id>` (job `<jobId>`)` listing.
- `details`: `{ projectAgentsDir: null, results: [], totalDurationMs: 0, progress: [<seeded AgentProgress per spawn>], async: { state: "running", jobId, type: "task" } }`. A batch call keeps one shared `progress[]` snapshot; `async.jobId` is the first started job and `async.state` aggregates ("running" until every job settles, "failed" if any spawn failed).
- Live progress keeps streaming into the same tool block via `onUpdate(...)`; each final result arrives later as an async-result injection into the parent conversation. The delivery text appends a follow-up hint: `` <id> is now idle — message it via `irc` to follow up; transcript at history://<id> `` (aborted variant points at the transcript only).

Settled (sync-fallback or job-body) response:
- `content`: summary rendered from `packages/coding-agent/src/prompts/tools/task-summary.md` with a preview capped at 5000 chars; `agent://<id>` holds the full output. A sync batch concatenates the per-spawn summaries.
- `details.results`: one `SingleResult` per spawn; `usage`, `outputPaths` populated (aggregated across spawns for a sync batch).

`SingleResult` includes:
- identity: `index`, `id`, `agent`, `agentSource`, `description`, optional `assignment`
- status: `exitCode`, optional `error`, optional `aborted`, optional `abortReason`, optional `retryFailure`
- output: `output`, `stderr`, `truncated`, `durationMs`, `tokens`, `requests`, optional `contextTokens`/`contextWindow`
- artifact metadata: `outputPath?`, `patchPath?`, `branchName?`, `nestedPatches?`, `outputMeta?`
- extracted tool data: `extractedToolData?` from registered subprocess tool handlers such as `yield` and `report_finding`

Artifacts and side channels:
- Every subagent with an artifacts dir writes `<id>.md`; `agent://<id>` resolves to that file.
- If the output file is JSON, `agent://<id>/<path>` and `agent://<id>?q=<query>` perform JSON extraction.
- Each subagent gets `<id>.jsonl` session history when the parent persists artifacts; `history://<id>` renders it as a concise transcript (works for live and parked agents).
- Isolated patch mode writes `<id>.patch` before merge.

## Flow
1. `TaskTool.create(...)` discovers agents once per cwd through a process-level memo (`discoverAgentsForCreate`) to render the dynamic prompt description.
2. `execute(...)` repairs raw params (`repairTaskParams`), then validates: `schema` is always rejected; `tasks`/`context` are rejected unless `task.batch` is on; batch calls need a non-empty `tasks` (per-item assignments, unique provided ids), a non-empty shared `context`, and no top-level `assignment`; flat calls need `assignment`. The call is then normalized into its spawn list (`resolveSpawnItems`).
3. Sync fallback only when the session has no `AsyncJobManager` (orphaned host) or the selected agent definition declares `blocking: true`; the call then runs `#executeSync(...)` inline under the session-scoped semaphore.
4. Otherwise execution is always async:
   - agent ids are allocated up front via `AgentOutputManager.allocate(item.id || generateTaskName())`, one per spawn;
   - one `type: "task"` job per spawn is registered with `session.asyncJobManager` (`id` = agent id, `queued: true`, `ownerId` = caller agent id) and the tool returns immediately;
   - each job body acquires the session-scoped `Semaphore` (one per `TaskTool` instance, sized from `task.maxConcurrency` at first use), marks the job running, runs `#executeSync(...)` with that spawn's params, and reports progress through the shared `buildAsyncDetails`/`onUpdate`;
   - a failed or aborted run throws `TaskJobError` so the job lands `failed`, but the agent itself stays registered and interrogable.
5. `#executeSync(...)` runs the spawn path (`#runSpawn`), which rediscovers agents from disk, so runtime resolution can differ from the create-time description.
6. It resolves the requested agent, rejects unknown or settings-disabled agents, and enforces parent spawn policy plus `PI_BLOCKED_AGENT` self-recursion prevention.
7. Output schema priority: agent frontmatter `output` → inherited parent session schema (the call itself never carries one).
8. Plan mode swaps in an `effectiveAgent` with a read-only tool subset and plan-mode prompt; `runSubprocess(...)` receives the effective agent.
9. If `isolated`, it requires a git repo (`getRepoRoot(...)` / `captureBaseline(...)`) and resolves the backend through isolation-backend resolution with platform fallback.
10. Artifacts dir comes from the parent session file when available, otherwise a temp dir. When the session is executing an approved plan, the plan reference is handed to the subagent.
11. Non-isolated spawns call `runSubprocess(...)` directly with parent cwd; isolated spawns run inside the isolation workspace, then commit to a branch (`mergeMode === "branch"`) or capture a patch, and always clean up the workspace.
12. `runSubprocess(...)` creates a child agent session with an isolated settings snapshot (forcing `async.enabled = false` and `bash.autoBackground.enabled = false` — subagents are internally synchronous), child `agentId` equal to the allocated id, child internal URL router/`AgentOutputManager`, output schema, the shared `context` (batch calls) in the system prompt's `CONTEXT` section, and the IRC peer roster in the system prompt.
13. Child tool availability: explicit `agent.tools` if provided; auto-add `task` when the agent has `spawns` and depth allows; strip `task` at `task.maxRecursionDepth`; expand `exec` to `eval` + `bash`; strip parent-owned `todo`.
14. The child must finish through the hidden `yield` tool; up to 3 reminder prompts, the last forcing `toolChoice = yield` when supported. `finalizeSubprocessOutput(...)` reconciles raw text, `yield` payloads, structured schemas, `report_finding` data, and abort states.
15. End-of-run lifecycle (keep-alive, in `runSubprocess`'s finalizer):
    - hard abort (caller signal / wall-clock / budget) → registry status `aborted`, session disposed — terminal;
    - isolated run → status `parked` without a reviver (workspace is merged + cleaned, so the session is not revivable; transcript stays readable via `history://`), then session disposed and detached;
    - everything else (success and failure alike) → status `idle` with the live session attached, and `AgentLifecycleManager.global().adopt(id, { idleTtlMs, revive })` arms the park timer. The reviver reopens the session JSONL (park closed the writer, so the single-writer lock is taken cleanly).
16. Lifecycle thereafter: `idle` agents are parked after `task.agentIdleTtlMs` (session disposed; `AgentRef` + session file retained); messaging (`irc`) or the Agent Hub revives them back to `idle`. `"Main"` is never parked.

## Modes / Variants
- Execution mode
  - Always-async background job — default; spawns go through `AsyncJobManager`.
  - Sync inline fallback — only when no job manager exists or the agent definition has `blocking: true`.
- Batch mode (`task.batch`, default on)
  - on — `{ agent, context, tasks[] }`: one independent background job per item, required `context` shared across the call's spawns, `isolated` per item. Lifecycle, revival, and concurrency semantics are identical to N parallel single calls.
  - off — single spawn per call; `tasks`/`context` are rejected and removed from the schema.
- Isolation backend: `none`, `worktree`, `fuse-overlay`, `fuse-projfs`.
- Isolation merge strategy: patch mode (capture/apply root patches) or branch mode (commit to `omp/task/<id>`, cherry-pick into parent).
- Agent source precedence: project custom agents, then user custom agents, then bundled agents (`explore`, `plan`, `designer`, `reviewer`, `task`, `quick_task`, `librarian`, `oracle`).

## Side Effects
- Filesystem
  - Writes `<id>.jsonl` and `<id>.md` under the session artifacts dir or a temp task dir; isolated patch mode writes `<id>.patch`.
  - Creates/removes worktrees or overlay mount directories; branch mode creates temporary worktrees and task branches.
- Network
  - Child sessions may use whichever networked tools/models their active tool set permits.
  - MCP proxy tools can call existing parent MCP connections with a 60_000 ms timeout.
- Subprocesses / native bindings
  - `fuse-overlayfs` and `fusermount`/`fusermount3` for FUSE isolation; ProjFS native bindings on Windows.
  - Git operations for baseline capture, patch apply, worktrees, branches, stash, cherry-pick, commits.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Creates child `AgentSession` instances with isolated settings snapshots; finished sessions stay registered in the process-global `AgentRegistry` as `idle`/`parked` until process teardown or explicit release.
  - Registers one async job per call in `session.asyncJobManager`; completion is injected into the parent as an async-result message.
  - Arms idle-TTL timers in `AgentLifecycleManager` (unref'd; they never hold the process open).
  - Emits `task:subagent:event`, `task:subagent:progress`, and `task:subagent:lifecycle` on the parent event bus.
  - Allocates session-scoped output ids through `AgentOutputManager` so `agent://` stays unique across invocations.
  - Shares the parent `local://` root and `ArtifactManager` with subagents.
- Background work / cancellation
  - `job cancel` (or parent tool-call abort) cancels the job; a hard-aborted run lands `aborted` and is torn down.
  - Missing-`yield` recovery sends up to three internal reminder prompts to the child session.

## Limits & Caps
- Concurrency: one session-scoped `Semaphore` sized from `task.maxConcurrency` at first use (later setting changes do not resize it) bounds concurrent subagents across parallel `task` calls — both async job bodies and the sync fallback acquire it.
- Idle TTL: `task.agentIdleTtlMs`, default `420_000` ms (7 min); `<= 0` disables parking and keeps idle sessions live until exit.
- Per-subagent output truncation: `MAX_OUTPUT_BYTES = 500_000` and `MAX_OUTPUT_LINES = 5000` in `packages/coding-agent/src/task/types.ts` (overridable via `PI_TASK_MAX_OUTPUT_BYTES` / `PI_TASK_MAX_OUTPUT_LINES`). Full raw output is still written to `<id>.md`.
- Progress coalescing: `PROGRESS_COALESCE_MS = 150`; recent-output tail: `RECENT_OUTPUT_TAIL_BYTES = 8 * 1024` (last 8 non-empty lines).
- Missing-`yield` reminder retries: `MAX_YIELD_RETRIES = 3`; MCP proxy timeout: `MCP_CALL_TIMEOUT_MS = 60_000` — both in `packages/coding-agent/src/task/executor.ts`.
- Agent id schema cap: `id` `maxLength: 48` in `packages/coding-agent/src/task/types.ts`. Prompt text says ids should be `≤32` chars; this mismatch is real.
- Soft request budget (`task.softRequestBudget`) and wall clock (`task.maxRuntimeMs`) apply to every spawn.
- Recursion depth gate: `task.maxRecursionDepth`; `packages/coding-agent/src/tools/index.ts` hides the `task` tool at or beyond the limit, and `runSubprocess(...)` also strips child `task` access at max depth.
- Final inline summary preview uses `fullOutputThreshold = 5000` chars in `packages/coding-agent/src/task/index.ts`; `agent://<id>` points to the full artifact.

## Errors
- Parameter validation failures are returned as normal tool text with empty `results`:
  - `schema` (never accepted)
  - `tasks` / `context` while `task.batch` is disabled
  - missing/empty `agent`
  - batch calls: missing/empty `tasks`, an item without `assignment`, duplicate provided ids, missing shared `context`, top-level `assignment` alongside `tasks`
  - flat calls: missing/empty `assignment`
  - unknown or settings-disabled agent, spawn-policy denial, requesting `isolated` while isolation mode is `none`
- Isolated execution without a git repo returns `Isolated task execution requires a git repository. ...`; backend resolution can hard-error (ProjFS init) or warn and fall back to `worktree`.
- Job registration failure returns `Failed to start background task job(s): ...`; a batch that schedules only some jobs reports the failed ids in the immediate text and keeps the started ones running.
- Child failures surface as `SingleResult.exitCode = 1` with `stderr`/`error` populated; the async job is marked failed but the delivery text still carries the output plus a follow-up/transcript hint.
- If the child omits `yield`, `finalizeSubprocessOutput(...)` injects warnings such as `SYSTEM WARNING: Subagent exited without calling yield tool after 3 reminders.`
- `agent://<id>` resolution errors are model-visible when another tool reads them: no session, no artifacts dir, missing id, conflicting extraction syntax, or invalid JSON for extraction.

## Notes
- Parallelism is parallel `task` calls in one assistant message — or, with `task.batch`, a `tasks[]` batch in one call; either way the session-scoped semaphore bounds the fan-out and each spawn is an independent background job.
- Shared background convention without batch mode: write it once to a `local://` file and reference that path in each assignment — subagents share the parent's `local://` root. With `task.batch`, the required `context` parameter carries the shared background directly into each spawn's system prompt.
- Prefer messaging an existing agent (`irc`) over a fresh spawn for follow-up work: it already holds the relevant context. `irc` op:"list" shows idle/parked candidates; messaging a parked agent revives it. `history://<id>` shows what an agent has done.
- `irc` availability is derived, not configured (`isIrcEnabled` in `packages/coding-agent/src/tools/irc.ts`): it exists exactly when there is someone to message — the session can spawn subagents, or it is a subagent itself. Messaging is the only follow-up path to a finished subagent, so task without irc would strand idle agents.
- Subagents are internally synchronous: the executor forces `async.enabled = false` and `bash.autoBackground.enabled = false` in the child settings snapshot, so there are no fire-and-forget grandchildren.
- Agent discovery precedence is first-wins by exact name: project dirs before user dirs within a source family, plugin agent dirs after config dirs, bundled agents last. Create-time discovery is memoized per cwd for the prompt description; execution-time discovery stays fresh.
- Child sessions do not inherit conversation history. Built-in carry-over is the workspace tree/skills/context files, the shared `local://` root, and the approved-plan reference when one exists.
- When the parent passes `mcpManager`, child sessions disable standalone MCP discovery and get proxy tools that reuse parent connections.
- Branch-mode merge temporarily stashes the parent repo before cherry-picking; a stash-pop conflict is treated as merge failure and leaves recovery state behind. Patch mode only applies the combined root patch when `git.patch.canApplyText(...)` succeeds; failures leave the `.patch` artifact for manual handling.
- Nested git repos are diffed independently inside isolated workspaces and merged separately with `applyNestedPatches(...)`.
- `agent://` ids are name-based (`Task` first, `Task-2`/`Task-3` only when the name repeats, nested like `Parent.Child`) by `AgentOutputManager`; this is what prevents artifact collisions across repeated or nested invocations.

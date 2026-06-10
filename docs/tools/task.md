# task

> Spawn one subagent per call to work in the background, or resume an existing one.

## Source
- Entry: `packages/coding-agent/src/task/index.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/task.md`
- Key collaborators:
  - `packages/coding-agent/src/task/types.ts` — dynamic schema, progress/result types, output caps.
  - `packages/coding-agent/src/task/discovery.ts` — discover project/user/plugin/bundled agents.
  - `packages/coding-agent/src/task/agents.ts` — bundled agent definitions and frontmatter parsing.
  - `packages/coding-agent/src/task/executor.ts` — create child sessions, run/resume subagents, collect output, hand finished sessions to the lifecycle manager.
  - `packages/coding-agent/src/registry/agent-lifecycle.ts` — idle-TTL parking and revival of finished subagents.
  - `packages/coding-agent/src/registry/agent-registry.ts` — process-global agent directory (`running | idle | parked | aborted`).
  - `packages/coding-agent/src/async/job-manager.ts` — background job registration, progress, and result delivery.
  - `packages/coding-agent/src/task/parallel.ts` — `Semaphore` used for the session-scoped concurrency bound.
  - `packages/coding-agent/src/task/isolation-backend.ts` — isolation backend resolution and platform fallback.
  - `packages/coding-agent/src/task/worktree.ts` — worktree / FUSE / ProjFS setup, patch capture, branch merge.
  - `packages/coding-agent/src/task/output-manager.ts` — session-scoped `agent://` id allocation.
  - `packages/coding-agent/src/task/name-generator.ts` — default AdjectiveNoun agent ids.
  - `packages/coding-agent/src/task/simple-mode.ts` — `default` / `schema-free` / `independent` schema gating.
  - `packages/coding-agent/src/internal-urls/agent-protocol.ts` — resolve `agent://<id>` to saved subagent output.
  - `packages/coding-agent/src/internal-urls/history-protocol.ts` — resolve `history://<id>` to a concise transcript.
  - `packages/coding-agent/src/tools/index.ts` — tool registration and recursion-depth gating.
  - `packages/coding-agent/src/sdk.ts` — child-session router/tool wiring and per-subagent `AgentOutputManager`.
  - `docs/task-agent-discovery.md` — deeper discovery and precedence notes.

## Inputs

One call spawns (or resumes) exactly one subagent. There is no batch parameter and no shared `context` parameter — shared background goes into a `local://` file (e.g. `local://ctx.md`) that each assignment references; subagents share the parent's `local://` root.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `agent` | `string` | Conditional | Agent type to spawn. Required unless `resume` is set; providing both is a validation error. |
| `resume` | `string` | Conditional | Existing agent id — revive the agent if parked and run a follow-up assignment in its existing session. Cannot be combined with `agent` or `isolated`. |
| `id` | `string` | No | Stable agent id, schema max length 48. Defaults to a generated AdjectiveNoun name. Uniquified per session by `AgentOutputManager`. |
| `description` | `string` | No | UI label only; the subagent never sees it. |
| `assignment` | `string` | Yes | The work — complete, self-contained instructions. Empty-after-trim is rejected. |
| `schema` | `string` | No | JSON-encoded JTD schema for the expected `yield` payload. Field exists only when `task.simple = "default"`. |
| `isolated` | `boolean` | No | Run in an isolated workspace and return patches. Field exists only when `task.isolation.mode` is not `none`. Isolated agents are NOT resumable. |

Simple-mode gating (`task.simple`, one axis): `default` accepts the per-call `schema` override; `schema-free` and `independent` reject it (`validateTaskModeParams(...)`). `independent` additionally renders the subagent user prompt with the independent-mode flag. Agent frontmatter and inherited session schemas work in every mode.

## Outputs

The tool returns one text block plus `details: TaskToolDetails`.

Immediate (async) response — the normal case:
- `content`: `` Spawned agent `<id>` (job `<jobId>`). The result will be delivered when it yields. ... `` (or `Resumed agent ...`), plus a coordination hint (`irc` DM when enabled, otherwise `job`).
- `details`: `{ projectAgentsDir: null, results: [], totalDurationMs: 0, progress: [<seeded AgentProgress>], async: { state: "running", jobId, type: "task" } }`.
- Live progress keeps streaming into the same tool block via `onUpdate(...)`; the final result arrives later as an async-result injection into the parent conversation. The delivery text appends a resume hint: `` <id> is now idle — task(resume:"<id>") to continue it, transcript at history://<id> `` (aborted variant points at the transcript only).

Settled (sync-fallback or job-body) response:
- `content`: summary rendered from `packages/coding-agent/src/prompts/tools/task-summary.md` with a preview capped at 5000 chars; `agent://<id>` holds the full output.
- `details.results`: at most one `SingleResult`; `usage`, `outputPaths` populated.

`SingleResult` includes:
- identity: `index`, `id`, `agent`, `agentSource`, `description`, optional `assignment`
- status: `exitCode`, optional `error`, optional `aborted`, optional `abortReason`, optional `retryFailure`
- output: `output`, `stderr`, `truncated`, `durationMs`, `tokens`, `requests`, optional `contextTokens`/`contextWindow`
- artifact metadata: `outputPath?`, `patchPath?`, `branchName?`, `nestedPatches?`, `outputMeta?`
- extracted tool data: `extractedToolData?` from registered subprocess tool handlers such as `yield` and `report_finding`

Artifacts and side channels:
- Every subagent with an artifacts dir writes `<id>.md`; `agent://<id>` resolves to that file. Resumes overwrite it per assignment.
- If the output file is JSON, `agent://<id>/<path>` and `agent://<id>?q=<query>` perform JSON extraction.
- Each subagent gets `<id>.jsonl` session history when the parent persists artifacts; `history://<id>` renders it as a concise transcript (works for live and parked agents).
- Isolated patch mode writes `<id>.patch` before merge.

## Flow
1. `TaskTool.create(...)` discovers agents once per cwd through a process-level memo (`discoverAgentsForCreate`) to render the dynamic prompt description.
2. `execute(...)` repairs raw params (`repairTaskParams`), then validates: schema gating per `task.simple`, `agent` XOR `resume`, `resume` excludes `isolated`, non-empty `assignment`.
3. Sync fallback only when the session has no `AsyncJobManager` (orphaned host) or the selected agent definition declares `blocking: true`; the call then runs `#executeSync(...)` inline under the session-scoped semaphore.
4. Otherwise execution is always async:
   - the agent id is resolved up front — `resume` must name a registered agent (else `ToolError` pointing at `irc` op:"list" and `history://<id>`); spawns allocate via `AgentOutputManager.allocate(params.id || generateTaskName())`;
   - one `type: "task"` job is registered with `session.asyncJobManager` (`id` = agent id, `queued: true`, `ownerId` = caller agent id) and the tool returns immediately;
   - the job body acquires the session-scoped `Semaphore` (one per `TaskTool` instance, sized from `task.maxConcurrency` at first use), marks the job running, runs `#executeSync(...)`, and reports progress through `buildAsyncDetails`/`onUpdate`;
   - a failed or aborted run throws `TaskJobError` so the job lands `failed`, but the agent itself stays registered and interrogable.
5. `#executeSync(...)` dispatches: `resume` → `#executeResume(...)`, else `#runSpawn(...)`.
6. Resume path (`#executeResume`):
   - `AgentLifecycleManager.global().ensureLive(resumeId)` returns the live session, reviving a parked one from its session JSONL; unknown ids or parked-without-reviver throw a `ToolError`;
   - `resumeSubprocess(...)` in `packages/coding-agent/src/task/executor.ts` injects the rendered follow-up through the session's normal prompt path and drives it through the same monitor/yield/finalize pipeline as a spawn;
   - the session is never disposed here — registry status settles back to `idle` (even on failure/abort) and the lifecycle manager re-arms the idle TTL.
7. Spawn path (`#runSpawn`) rediscovers agents from disk, so runtime resolution can differ from the create-time description.
8. It resolves the requested agent, rejects unknown or settings-disabled agents, and enforces parent spawn policy plus `PI_BLOCKED_AGENT` self-recursion prevention.
9. Output schema priority: task call `schema` (when `task.simple` allows) → agent frontmatter `output` → inherited parent session schema.
10. Plan mode swaps in an `effectiveAgent` with a read-only tool subset and plan-mode prompt; `runSubprocess(...)` receives the effective agent.
11. If `isolated`, it requires a git repo (`getRepoRoot(...)` / `captureBaseline(...)`) and resolves the backend through isolation-backend resolution with platform fallback.
12. Artifacts dir comes from the parent session file when available, otherwise a temp dir. When the session is executing an approved plan, the plan reference is handed to the subagent.
13. Non-isolated spawns call `runSubprocess(...)` directly with parent cwd; isolated spawns run inside the isolation workspace, then commit to a branch (`mergeMode === "branch"`) or capture a patch, and always clean up the workspace.
14. `runSubprocess(...)` creates a child agent session with an isolated settings snapshot (forcing `async.enabled = false` and `bash.autoBackground.enabled = false` — subagents are internally synchronous), child `agentId` equal to the allocated id, child internal URL router/`AgentOutputManager`, output schema, and the IRC peer roster in the system prompt.
15. Child tool availability: explicit `agent.tools` if provided; auto-add `task` when the agent has `spawns` and depth allows; strip `task` at `task.maxRecursionDepth`; expand `exec` to `eval` + `bash`; strip parent-owned `todo`.
16. The child must finish through the hidden `yield` tool; up to 3 reminder prompts, the last forcing `toolChoice = yield` when supported. `finalizeSubprocessOutput(...)` reconciles raw text, `yield` payloads, structured schemas, `report_finding` data, and abort states.
17. End-of-run lifecycle (keep-alive, in `runSubprocess`'s finalizer):
    - hard abort (caller signal / wall-clock / budget) → registry status `aborted`, session disposed — terminal;
    - isolated run → status `parked` without a reviver (workspace is merged + cleaned, so the session is not resumable; transcript stays readable via `history://`), then session disposed and detached;
    - everything else (success and failure alike) → status `idle` with the live session attached, and `AgentLifecycleManager.global().adopt(id, { idleTtlMs, revive })` arms the park timer. The reviver reopens the session JSONL (park closed the writer, so the single-writer lock is taken cleanly).
18. Lifecycle thereafter: `idle` agents are parked after `task.agentIdleTtlMs` (session disposed; `AgentRef` + session file retained); messaging (`irc`), `task(resume:)`, or the Agent Hub revives them back to `idle`. `"Main"` is never parked.

## Modes / Variants
- Execution mode
  - Always-async background job — default; spawn and resume both go through `AsyncJobManager`.
  - Sync inline fallback — only when no job manager exists or the agent definition has `blocking: true`.
- Spawn vs resume
  - `agent: "<type>"` — fresh subagent with a new (or caller-provided) id.
  - `resume: "<id>"` — follow-up assignment in an existing session; revives a parked agent first. Transcript accretes; `agent://<id>` is overwritten per assignment.
- Simple mode (`task.simple`)
  - `default` — accepts per-call `schema`.
  - `schema-free` / `independent` — reject `schema`; `independent` also flags the subagent user prompt as independent-mode.
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
  - Allocates session-scoped output ids through `AgentOutputManager` so `agent://` stays unique across invocations and resumes.
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
- Soft request budget (`task.softRequestBudget`) and wall clock (`task.maxRuntimeMs`) apply to spawns and resumes alike.
- Recursion depth gate: `task.maxRecursionDepth`; `packages/coding-agent/src/tools/index.ts` hides the `task` tool at or beyond the limit, and `runSubprocess(...)` also strips child `task` access at max depth.
- Final inline summary preview uses `fullOutputThreshold = 5000` chars in `packages/coding-agent/src/task/index.ts`; `agent://<id>` points to the full artifact.

## Errors
- Parameter validation failures are returned as normal tool text with empty `results`:
  - `schema` outside `task.simple = "default"`
  - both or neither of `agent` / `resume`
  - `resume` combined with `isolated`
  - missing/empty `assignment`
  - unknown or settings-disabled agent, spawn-policy denial, requesting `isolated` while isolation mode is `none`
- `resume` of an id not in the registry throws a `ToolError` naming `irc` op:"list" and `history://<id>`.
- `ensureLive(...)` failures (agent parked without a reviver — e.g. an isolated run — or torn down) surface as `` Cannot resume "<id>": ... `` `ToolError`s.
- Isolated execution without a git repo returns `Isolated task execution requires a git repository. ...`; backend resolution can hard-error (ProjFS init) or warn and fall back to `worktree`.
- Job registration failure returns `Failed to start background task job: ...`.
- Child failures surface as `SingleResult.exitCode = 1` with `stderr`/`error` populated; the async job is marked failed but the delivery text still carries the output plus a resume/transcript hint.
- If the child omits `yield`, `finalizeSubprocessOutput(...)` injects warnings such as `SYSTEM WARNING: Subagent exited without calling yield tool after 3 reminders.`
- `agent://<id>` resolution errors are model-visible when another tool reads them: no session, no artifacts dir, missing id, conflicting extraction syntax, or invalid JSON for extraction.

## Notes
- Parallelism is parallel `task` calls in one assistant message; the session-scoped semaphore bounds the fan-out. There is no batch array.
- Shared background convention: write it once to a `local://` file and reference that path in each assignment — subagents share the parent's `local://` root. This replaces the removed `context` parameter.
- Prefer `resume` over a fresh spawn for follow-up work: the resumed agent already holds the relevant context. `irc` op:"list" shows idle/parked candidates; `history://<id>` shows what an agent has done.
- Subagents are internally synchronous: the executor forces `async.enabled = false` and `bash.autoBackground.enabled = false` in the child settings snapshot, so there are no fire-and-forget grandchildren.
- Agent discovery precedence is first-wins by exact name: project dirs before user dirs within a source family, plugin agent dirs after config dirs, bundled agents last. Create-time discovery is memoized per cwd for the prompt description; execution-time discovery stays fresh.
- Child sessions do not inherit conversation history. Built-in carry-over is the workspace tree/skills/context files, the shared `local://` root, and the approved-plan reference when one exists.
- When the parent passes `mcpManager`, child sessions disable standalone MCP discovery and get proxy tools that reuse parent connections.
- Branch-mode merge temporarily stashes the parent repo before cherry-picking; a stash-pop conflict is treated as merge failure and leaves recovery state behind. Patch mode only applies the combined root patch when `git.patch.canApplyText(...)` succeeds; failures leave the `.patch` artifact for manual handling.
- Nested git repos are diffed independently inside isolated workspaces and merged separately with `applyNestedPatches(...)`.
- `agent://` ids are name-based (`Task` first, `Task-2`/`Task-3` only when the name repeats, nested like `Parent.Child`) by `AgentOutputManager`; this is what prevents artifact collisions across repeated or nested invocations.

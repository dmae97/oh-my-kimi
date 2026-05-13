---
name: orchestrate
description: Drive a multi-phase task to completion via parallel subagents
---

# Task

$@

---

# Orchestration Contract

You are the **orchestrator** for the task above. Read it once, then execute under the rules below. The contract overrides any default tendency to yield early, narrate, or do work yourself.

<role>
You decompose, dispatch, verify, and iterate. You do **not** edit code. Every file mutation goes through a `task` subagent. Your tool budget is: reading for planning, `task` for dispatch, verification (`bun check`, `bun test`, `recipe`, `lsp diagnostics`), git via `bash`, and `todo_write` for tracking.
</role>

<rules>
1. **Do not yield until everything is closed.** A phase finishing is *not* a yield point — launch the next phase in the same turn. Stop only when every requested item is verifiably done, or you hit a concrete [blocked] state that genuinely requires the user.
2. **Enumerate the full surface before dispatching.** If the task references audits, plans, checklists, phase lists, or file lists, expand them into a flat set of items in `todo_write`. "Most of them" or "the important ones" is failure. Re-read the source documents — do not work from memory.
3. **Parallelize maximally.** Every set of edits with disjoint file scope MUST ship as one `task` batch. Serialize only when one subagent produces a contract (types, schema, shared module) the next consumes — and state the dependency when you do.
4. **Each `task` assignment is self-contained.** Subagents have no shared context. Spell out: target files (≤3–5 explicit paths, no globs), the change with APIs and patterns, edge cases, and observable acceptance criteria. Do not assume they read the same plan you did.
5. **Verify after every phase before launching the next.** Run the appropriate gate: `bun check` for types, package-scoped `bun test` for behavior, `lsp diagnostics` for changed files. If a phase introduced breakage, dispatch fix-up subagents *before* moving on. Never declare a phase done on a red tree.
6. **Commit policy.** If the task asks for commits or the repo workflow expects them, commit after each green phase with a focused message. Never commit a red tree. Never commit work the user did not ask to commit.
7. **Respawn, do not absorb.** If a subagent returns incomplete or wrong work, spawn a corrective subagent with the specific gap — do not silently fix it yourself.
8. **No scope creep, no scope shrink.** Do not add work the user did not ask for. Do not relabel unfinished items as "follow-up", "v1", or "MVP" to imply completion.
9. **Subagents do not verify, lint, or format.** Every `task` assignment MUST instruct the subagent to skip all gates and formatters. Their job is the edit only. You — the orchestrator — run verification and formatting **once** at the end of the phase across the union of changed files. Avoids redundant runs and racing formatter passes.
</rules>

<workflow>
1. **Ingest.** Read every referenced file (audits, plans, prior agent output, current branch state). Run `git status` to see uncommitted changes.
2. **Plan.** Materialize the full work surface in `todo_write` as ordered phases. Within each phase, list the parallelizable units.
3. **Dispatch phase.** Launch all parallel `task` subagents in one call. Wait for the batch.
4. **Verify phase.** Run the gates. On failure, dispatch fix-up subagents and re-verify. Do not advance with a red gate.
5. **Commit phase** (if applicable). Focused message naming the phase.
6. **Advance.** Mark the phase done in `todo_write`, immediately start the next phase. No summary message between phases — keep going.
7. **Final verification.** When the last phase is green, run the full gate set once more and confirm every `todo_write` item is closed. Then yield with a terse status, not a recap.
</workflow>

<anti-patterns>
- Editing files yourself "because it's faster".
- Yielding after phase 1 with "ready to continue?".
- Dispatching one subagent at a time when five could run in parallel.
- Skipping `bun check` between phases because "the change looked safe".
- Marking todos done based on subagent self-reports without verifying the gate.
- Summarizing progress in chat instead of advancing to the next phase.
</anti-patterns>

---
description: "Final prompt-settlement sound for completed, failed, and aborted interactive runs"
---

# Feature Specification: Terminal Settlement Notification

**Specification ID**: `016-terminal-settlement-notification`
**Created**: 2026-08-27
**Status**: Implemented in the current working tree; unreleased
**Constitution**: [specs/constitution.md](../constitution.md)
**Input**: User description: "모두 마치거나 에이전트가 멈췄을 때 알림음"
**OMK Preset**: `omk`

## CLI Harness Target Impact

**Classification**: advance

| Dimension | Baseline | Acceptance target | Regression floor | Verification command | Evidence artifact |
| --- | --- | --- | --- | --- | --- |
| Operator awareness | `v0.97.0`: sound disabled by default; aborted outcome suppressed | Interactive TTY notifies for completed runs after the duration floor and immediately for failed/aborted runs | `0` terminal outcomes silently excluded when their outcome switch is enabled | `npm --prefix packages/coding-agent test -- test/completion-sound.test.ts test/prompt-settlement.test.ts test/suite/agent-session-retry-events.test.ts` | `packages/coding-agent/test/completion-sound.test.ts` |
| Lifecycle correctness | `prompt_settled` exists and is exactly once | Sound consumes only final `prompt_settled`; current provider/tool/continuation paths drain, and current subagents remain inside their tool call | `0` sounds from intermediate `agent_end` or retry events; at most `1` playback per `promptRunId` | same focused test command | prompt-settlement and completion-sound tests |
| Safety and latency | Opt-in fixed-argv backends | Default-on keeps fixed argv, TUI/TTY-only surface, CI/headless exclusion, fire-and-forget execution | `0` user-controlled argv fields; `0` prompt outcome changes from sound failure | `npm --prefix packages/coding-agent test -- test/completion-sound.test.ts` | candidate-chain and failure tests |

## Problem

OMK already emits `prompt_settled` after the complete top-level run, but the
sound consumer is disabled unless configured and unconditionally suppresses
`aborted`. Operators therefore receive no terminal signal in the default TUI
when a long task completes, fails, or is explicitly stopped.

Playing on `agent_end` is not a valid fix: provider retries, compaction retries,
durable-goal continuation, queued messages, tools, shards, or child agents may
still be active. The final settlement boundary must remain authoritative.

## Goal

Enable terminal sound by default for interactive TTY sessions and cover all
three final outcomes without introducing intermediate, headless, blocking, or
security-sensitive playback.

## Requirements

### Requirement 1 - Final-boundary-only notification (Priority: P1)

**What**: Continue consuming only `prompt_settled`. Never subscribe sound to
`agent_end`, individual tool completion, child completion, retry, or
continuation events.

**Acceptance**:
1. Active provider, tool, shard, child, or continuation counters block the pure settlement reducer.
2. Current subagents complete inside their tool call; future direct lane/shard activation must wire the reserved counters first.
3. One `promptRunId` plays at most once.
4. Sound failure cannot change, reject, or delay the prompt outcome.

### Requirement 2 - Default terminal outcome policy (Priority: P1)

**What**: Resolve completion-sound settings to `enabled=true`, `onSuccess=true`,
`onFailure=true`, and `onAbort=true` when omitted.

**Acceptance**:
1. A completed prompt plays only when `durationMs >= minDurationMs` (default 5000).
2. Final typed termination maps `user_abort`/`provider_abort` to `aborted`, every non-completed terminal failure to `failed`, and successful termination to `completed` even when the lower-level agent call resolves normally.
3. Failed and aborted/stopped outcomes bypass the success duration floor.
4. `onSuccess`, `onFailure`, and `onAbort` independently disable their outcome.
5. `OMK_COMPLETION_SOUND=0` remains a one-process master opt-out; `=1` enables.

### Requirement 3 - Surface and process safety (Priority: P1)

**What**: Preserve the current backend and surface boundaries.

**Acceptance**:
1. Only interactive TUI + TTY + non-CI surfaces are eligible.
2. RPC, JSON, print mode, CI, and non-TTY sessions play zero sounds.
3. Backends use fixed absolute executable and argv values with `shell:false`.
4. Spawn inherits neither `PATH` nor credential variables and uses the OS temporary directory as cwd.
5. WSL uses terminal BEL instead of resolving Windows executables through `PATH`.
6. Spawn timeout, fallback, and errors remain diagnostic-only.

### Requirement 4 - Documentation and rollback (Priority: P2)

**What**: Document defaults, the new `onAbort` setting, outcome-specific duration
behavior, and the final-settlement invariant.

**Acceptance**:
1. `settings.md`, `environment-variables.md`, package README, changelog, and the
   runtime algorithm map agree.
2. Rollback requires no code change: set
   `notifications.completionSound.enabled=false` or `OMK_COMPLETION_SOUND=0`.
3. Per-outcome rollback uses `onSuccess`, `onFailure`, or `onAbort`.

## Expected Files

- `packages/coding-agent/src/core/completion-sound.ts`
- `packages/coding-agent/src/core/completion-sound-io.ts`
- `packages/coding-agent/src/core/prompt-settlement.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/settings-manager.ts`
- `packages/coding-agent/test/completion-sound.test.ts`
- `packages/coding-agent/test/suite/agent-session-retry-events.test.ts`
- `packages/coding-agent/docs/settings.md`
- `packages/coding-agent/docs/environment-variables.md`
- `packages/coding-agent/docs/runtime-algorithms.md`
- `packages/coding-agent/README.md`
- `packages/coding-agent/CHANGELOG.md`
- `specs/README.md`
- `specs/016-terminal-settlement-notification/spec.md`

## Verification Commands

- `npm --prefix packages/coding-agent test -- test/completion-sound.test.ts test/prompt-settlement.test.ts test/suite/agent-session-retry-events.test.ts`
- `npm run check:doc-links`
- `npm run check:constitution`
- `npm run check:feature-claims`
- `npm run check:readme-releases`
- `git diff --check`

## Non-Goals

- Playing sound for every tool, child, shard, retry, or `agent_end`
- Adding desktop notifications, custom user sound paths, or user-controlled argv
- Enabling sound in headless/automation surfaces
- Treating a sound as correctness or evidence
- Wiring currently internal live-lane or automatic-sharding mechanisms
- Committing, publishing, or deploying

## Assumptions

- `v0.97.0` is the released baseline; this implementation remains Worktree-only
  until a later release.
- The existing dirty working tree is preserved.
- `prompt_settled` remains the only final UX lifecycle signal.

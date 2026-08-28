---
description: "Command-safety hardening, prompt attachments, and resilience failover for compaction"
---

# Feature Specification: Command-Safety Hardening, Prompt Attachments, and Compaction Quota Failover

**Feature Branch**: `013-command-safety-attachment-resilience`
**Created**: 2026-08-23
**Status**: Released in `v0.97.0`
**Constitution**: [specs/constitution.md](../constitution.md) (governs evidence separation, safety floor)
**Input**: User description: "현재 omk 개선된 버전으로 docs들 최신화, spec-kit들 최신화 — 커맨드 치환 하드닝·프롬프트 첨부·컴팩션 쿼타 페일오버 주기 문서화"
**OMK Preset**: `omk` (DAG-optimized, parallel-agent ready)

## Problem

Three gaps shipped in quick succession without a governing spec:

1. The bash command-safety classifier returned on the first risk signal, so a
   destructive body inside a command substitution (`echo $(rm -rf ~)`,
   `git stash \`mkfs.ext4 /dev/sda\``,`diff <(safe) <(evil)`) inherited the
   benign outer verdict.
2. Clipboard image paste wrote an unbounded temp file per paste
   (`omk-clipboard-*` in `os.tmpdir()`) with no preview, no lifecycle, and no
   retry story when the turn failed before sending.
3. Compaction summarization failed fast on quota/billing exhaustion even when
   authenticated failover candidates were configured — same-model retries are
   useless until the provider cycle resets, but another provider could still
   save the run.

## Goal

Close all three gaps behind one bounded cycle: quote-aware recursive command-substitution
classification merged by severity, an in-memory attachment store with
acceptance-gated release, quota-aware compaction failover with an explicit
non-retryable termination cause, and upstream-unavailable classification that
rotates to a sibling provider route of the same model family before the
cross-model chain.

## Agent-Oriented Requirements

### Requirement 1 - Recursive command-substitution classification (Priority: P1)

**Agent**: coder
**Skills**: programming, ast-grep, review-work
**Evidence Gate**: file-exists + command-pass
**Risk**: medium

**What**: Extract `$()`, backtick, and process-substitution (`<()`, `>()`) bodies with
quote-aware paren/backtick matching; recurse into nested bodies up to depth 6;
merge every verdict by severity rank instead of returning on first hit so the
worst signal wins.

**Verify**: `npx vitest --run test/command-safety.test.ts`

**Acceptance**:
1. `packages/coding-agent/src/core/command-safety.ts` exports `extractCommandSubstitutions`
2. Substitution bodies inside single quotes never expand; double-quoted bodies classify
3. Unmatched delimiters terminate extraction without throwing

### Requirement 2 - Unified YOLO opt-out across every gate caller (Priority: P2)

**Agent**: coder
**Skills**: programming, security-review
**Evidence Gate**: file-exists + command-pass
**Risk**: high

**What**: Evaluate `OMK_YOLO` / `OMK_COMMAND_SAFETY=0` / `OMK_DISABLE_COMMAND_SAFETY`
once in `isCommandSafetyDisabled()` inside the shared gate decision engine so the
gate extension, RPC headless bash floor, and bash tool safety floor share one
contract instead of three ad-hoc env reads.

**Verify**: `npx vitest --run test/command-safety-gate.test.ts test/rpc-bash-command-safety.test.ts`

**Acceptance**:
1. `packages/coding-agent/src/core/extensions/builtin/command-safety-gate.ts` owns the env contract
2. YOLO short-circuits before classification: no prompts, no denials, headless floor included

### Requirement 3 - Prompt image attachments with acceptance-gated lifecycle (Priority: P1)

**Agent**: coder
**Skills**: programming, omk-typescript-strict
**Evidence Gate**: file-exists + command-pass
**Risk**: medium

**What**: Store pasted/dragged images in a bounded in-memory attachment store,
render preview chips above the editor, materialize image content only at send
time, and release attachments exactly when their prompt is accepted — keeping
them attached for retry when preflight or model failure precedes acceptance.

**Verify**: `npx vitest --run test/prompt-attachment.test.ts test/attachment-strip-width.test.ts test/interactive-mode-startup-input.test.ts`

**Acceptance**:
1. `packages/coding-agent/src/core/prompt-attachment.ts` and `attachment-store.ts` exist with bounded stores
2. `packages/coding-agent/src/modes/interactive/components/attachment-strip.ts` renders chips from draft ids
3. No per-paste temp file is written to `os.tmpdir()`

### Requirement 4 - Compaction quota failover with explicit cause (Priority: P1)

**Agent**: coder
**Skills**: programming, debugging
**Evidence Gate**: file-exists + command-pass
**Risk**: low

**What**: When the summarization model hits a quota-class error, retry the whole
summarization once per authenticated resilience candidate in order, absorbing only
quota-class candidate failures; surface a non-retryable `compaction.quota_exhausted`
termination cause whose next-action names `/model`, `compaction.model`, or reset wait.

**Verify**: `npx vitest --run test/compaction-quota-failover.test.ts test/session-termination.test.ts test/agent-session-termination-runtime.test.ts`

**Acceptance**:
1. `compact()` accepts `failoverModels` and skips the primary model's own route
2. `session-termination.ts` classifies `quota_exhausted` as non-retryable
3. Non-quota candidate failures surface immediately without consuming remaining candidates

## Expected Files

- `packages/coding-agent/src/core/command-safety.ts` — substitution extraction + severity merge
- `packages/coding-agent/src/core/extensions/builtin/command-safety-gate.ts` — unified `isCommandSafetyDisabled`
- `packages/coding-agent/src/core/prompt-attachment.ts`, `attachment-store.ts` — attachment domain + bounded store
- `packages/coding-agent/src/modes/interactive/components/attachment-strip.ts` — editor preview strip
- `packages/coding-agent/src/core/provider-resilience.ts` — upstream-unavailable + route-family helpers
- `packages/coding-agent/src/core/agent-session.ts` — `_maybeRotateModelRoutes`, `_compactionFailoverModels` wiring
- `packages/coding-agent/docs/{provider-resilience,compaction,usage}.md` — user-facing behavior docs
- `packages/coding-agent/test/*.test.ts` — coverage listed per requirement above

## Verification Commands

- `npm run check:doc-links` — documentation link integrity
- `npm run check:release-consistency && npm run check:readme-releases` — release surfaces agree
- `npx biome check packages/coding-agent/src packages/coding-agent/docs` — lint/format
- `npm run check` — full repo gate (biome, pinned deps, constitution tests, tsgo)

## Assumptions

- The feature shipped in the lockstep `v0.97.0` release; its released changelog section is immutable.
- Route-family membership starts as data (`MODEL_ROUTE_FAMILIES`) and grows by catalog change, not runtime inference.
- Attachment stores stay process-local memory; nothing persists to disk between sessions.

---
description: "DAG tasks for GPT-5.6 MoA and Codex ultra repair"
---

# Tasks: GPT-5.6 MoA and Ultra Fix

**Input**: `/specs/011-gpt56-moa-ultra-fix/`
**Prerequisites**: plan.md, spec.md

## Phase 1: Diagnosis and design

- [x] T001 Reproduce Sol/Terra literal `ultra` failure and `xhigh` success
  > role: tester
  > deps: none
  > files: [`.debug-journal.md`]
  > verify: minimal no-session/no-tools Codex calls
  > gate: command-pass
  > risk: medium

- [x] T002 [P] Compare provider, virtual-model, extension, and preset designs
  > role: architect
  > deps: none
  > files: [`specs/011-gpt56-moa-ultra-fix/plan.md`]
  > verify: `test -f specs/011-gpt56-moa-ultra-fix/plan.md`
  > gate: summary-present
  > risk: low

## Phase 2: Red tests

- [x] T003 Add failing CLI help regression
  > role: coder
  > deps: T001
  > files: [`packages/coding-agent/test/args.test.ts`]
  > verify: `cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/args.test.ts`
  > gate: command-pass
  > risk: low

- [x] T004 Add failing MoA/effort/provider tests
  > role: coder
  > deps: T001, T002
  > files: [`packages/ai/test/openai-codex-moa.test.ts`]
  > verify: `cd packages/ai && node ../../node_modules/vitest/dist/cli.js --run test/openai-codex-moa.test.ts`
  > gate: command-pass
  > risk: medium

## Phase 3: Core implementation

- [x] T005 Implement tool-isolated MoA advisers, tool-capable synthesis, bounded requests, fail-fast cancellation, and provider dispatch
  > role: coder
  > deps: T004
  > files: [`packages/ai/src/providers/openai-codex-moa.ts`, `packages/ai/src/providers/openai-codex-responses.ts`]
  > verify: `cd packages/ai && node ../../node_modules/vitest/dist/cli.js --run test/openai-codex-moa.test.ts`
  > gate: command-pass
  > risk: high

- [x] T006 Fix model metadata, generate catalog, and correct CLI help
  > role: coder
  > deps: T003, T004
  > files: [`packages/ai/scripts/generate-models.ts`, `packages/ai/src/models.generated.ts`, `packages/coding-agent/src/cli/args.ts`]
  > verify: focused AI and coding-agent tests
  > gate: command-pass
  > risk: medium

## Phase 4: Docs and verification

- [x] T007 Update Unreleased docs/changelogs and close spec 010 blocker
  > role: reviewer
  > deps: T005, T006
  > files: [`packages/ai/CHANGELOG.md`, `packages/coding-agent/CHANGELOG.md`, `packages/coding-agent/docs/providers.md`, `specs/010-omk-v0906-release-alignment/tasks.md`]
  > verify: released changelog sections unchanged
  > gate: diff-nonempty
  > risk: low

- [x] T008 Run focused tests, standalone pi-extension check, full check, build, and live QA
  > evidence: AI 65/65; coding-agent 100/100; pi 44 files + tsc; root 929 files with release issues `[]`; build passed; live MoA returned `ok` with virtual identity and aggregated usage before the final terminal fail-close hardening; latest direct Sol/Terra/MoA retries were blocked by external `usage_limit_reached` 429
  > role: qa
  > deps: T007
  > files: []
  > verify: `npm run check && npm run build`
  > gate: command-pass
  > risk: high

## Phase 5: Tool-capable MoA and Ultra subagents

- [x] T009 Forward declared tools, tool history, and synthesis tool events through the MoA agent loop
  > files: [`packages/ai/src/providers/openai-codex-moa.ts`, `packages/ai/src/providers/openai-codex-moa-stream-limits.ts`, focused MoA tests]
  > verify: focused MoA suite
  > gate: command-pass
  > risk: high

- [x] T010 Remove subagent count/concurrency/deadline caps only in Ultra and run live QA
  > evidence: focused subagent tests 67/67 across the runtime suite; Ultra smoke completed 9 tasks without deadline metadata; coding-agent 4,326/4,326 passed with bounded test-worker concurrency; live Ultra orchestration exceeded the caller's 840-second harness timer without an extension cutoff and left no child process behind after cancellation
  > files: [`packages/coding-agent/src/core/extensions/types.ts`, `packages/coding-agent/src/core/tools/tool-definition-wrapper.ts`, `packages/coding-agent/examples/extensions/subagent/`]
  > verify: focused subagent tests, full checks/build, live Ultra probes
  > gate: command-pass
  > risk: high

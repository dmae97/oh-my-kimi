---
description: "Add a Codex OAuth GPT-5.6 Sol+Terra MoA virtual model and stop invalid ultra requests"
---

# Feature Specification: GPT-5.6 MoA and Ultra Fix

**Feature Branch**: `main`
**Created**: 2026-07-11
**Status**: Complete
**Input**: User requested a Codex-provider GPT-5.6 MoA mixing Sol and Terra, plus debugging the current `ultra` error.
**OMK Preset**: `omk`

## Runtime Evidence

The live Codex endpoint rejects literal `reasoning.effort="ultra"` for both `gpt-5.6-sol` and
`gpt-5.6-terra` with HTTP 400 and lists `xhigh` as the highest supported value. Toggling only the
effort to `xhigh` makes both models return `ok`. Therefore OMK's current metadata is wrong: the
provider does not expose a literal `ultra` enum.

## Agent-Oriented Requirements

### Requirement 1 - Valid Codex ultra mapping (Priority: P1)

**Agent**: coder
**Skills**: debugging, programming
**MCP**: none
**Evidence Gate**: command-pass
**Risk**: high

**What**: Keep OMK's user-facing `ultra` tier but map GPT-5.6 Codex requests to the backend's
highest valid value, `xhigh`. The CLI help must list every accepted level, including `max` and
`ultra`.
**Verify**: focused request-payload test plus a live no-tools Sol/Terra invocation.

**Acceptance**:
1. Sol/Terra never serialize literal `ultra` or `max` to the Codex backend.
2. `--thinking ultra` no longer returns the observed enum HTTP 400.
3. `omk --help` lists `max, ultra`.

### Requirement 2 - GPT-5.6 MoA virtual model (Priority: P1)

**Agent**: coder / architect
**Skills**: programming, ponytail
**MCP**: none
**Evidence Gate**: command-pass
**Risk**: high

**What**: Add `openai-codex/gpt-5.6-moa` under the existing OAuth provider. For each turn, run Sol
and Terra concurrently without tools, then ask Sol to synthesize their bounded analyses into the single
public stream. The synthesis receives the active tool contract and participates in the normal agent tool loop.
Reuse the existing `openai-codex` credential and transport implementation; do not add a provider,
dependency, or credential path.
**Verify**: mocked SSE tests prove two tool-free adviser requests precede one tool-capable synthesis
request, virtual identity is retained, tool events reach the agent loop, failures/abort terminate coherently,
and usage includes all three calls.

**Acceptance**:
1. `getModel("openai-codex", "gpt-5.6-moa")` exists and supports `ultra` mapped to `xhigh`.
2. Sol and Terra advisers begin before synthesis and receive no tools.
3. Advisers carry no tools or tool transport history; synthesis preserves declared tools and historical tool calls/results, suppresses payload overrides, and forwards tool-call events to the normal agent loop.
4. Adviser failure is strict all-or-nothing and aborts the sibling request; caller abort takes precedence.
5. Final usage/cost and `totalTokens` sum terminal-reported usage from all three requests, including failed and length-capped calls whenever the provider supplies it.
6. Adviser text is exactly capped at 24,000 characters; every delta, partial, and terminal result is bounded, oversized open streams are aborted, and the virtual context window reserves synthesis headroom.
7. Every concrete request preserves the active model's endpoint and headers.
8. Parent session cleanup closes and removes all role-isolated MoA child WebSocket resources.

### Requirement 3 - Release/docs/spec consistency (Priority: P2)

**Agent**: planner / reviewer
**Skills**: omk-agent-ops
**MCP**: none
**Evidence Gate**: file-exists + command-pass
**Risk**: low

**What**: Update Unreleased changelogs and provider documentation. Mark the resolved v0.90.6
alignment check in spec 010 using current passing Biome evidence.
**Verify**: docs mention virtual-model behavior and no released changelog section changes.

### Requirement 4 - Unbounded Ultra subagents (Priority: P1)

**What**: When the current thinking level is `ultra`, remove the subagent extension's task-count,
concurrency, execution-budget, per-attempt, and outer tool-call deadlines. Keep explicit caller abort,
process failure, provider/network behavior, and all non-Ultra limits unchanged.

**Acceptance**:
1. Ultra parallel mode accepts all requested tasks and starts them without an extension concurrency cap.
2. Ultra runs one subprocess attempt per logical task with no timer or deadline metadata.
3. The extension dynamically resolves its outer tool timeout to `0` only in Ultra.
4. Ctrl+C/AbortSignal still terminates and reaps child process trees.
5. Non-Ultra retains max 8 tasks, 4 concurrent processes, predictive sharding, and bounded retries.

## Expected Files

- `packages/ai/src/providers/openai-codex-moa.ts`
- `packages/ai/src/providers/openai-codex-moa-context.ts`
- `packages/ai/src/providers/openai-codex-moa-stream-limits.ts`
- `packages/ai/src/providers/openai-codex-responses.ts`
- `packages/ai/scripts/generate-models.ts`
- `packages/ai/src/models.generated.ts` (generated only)
- `packages/ai/test/openai-codex-response-failures.test.ts`
- `packages/ai/test/openai-codex-terminal-status.test.ts`
- `packages/ai/test/openai-codex-moa.test.ts`},{
- `packages/ai/test/openai-codex-moa-safety.test.ts`
- `packages/ai/test/openai-codex-moa-tool-history.test.ts`
- `packages/ai/test/openai-codex-moa-usage.test.ts`},{
- `packages/ai/test/openai-codex-thinking.test.ts`
- `packages/coding-agent/src/cli/args.ts`
- `packages/coding-agent/test/args.test.ts`
- `packages/coding-agent/src/core/extensions/types.ts`
- `packages/coding-agent/src/core/tools/tool-definition-wrapper.ts`
- `packages/coding-agent/test/tool-definition-wrapper.test.ts`
- `packages/coding-agent/examples/extensions/subagent/index.ts`
- `packages/coding-agent/examples/extensions/subagent/deadline-budget.ts`
- `packages/coding-agent/examples/extensions/subagent/subagent-execution-policy.test.ts`
- `packages/coding-agent/examples/extensions/subagent/subagent-extension-smoke.test.ts`
- `packages/ai/CHANGELOG.md`
- `packages/coding-agent/CHANGELOG.md`
- `packages/coding-agent/docs/providers.md`

## Verification Commands

- `(cd packages/ai && node ../../node_modules/vitest/dist/cli.js --run test/openai-codex-response-failures.test.ts test/openai-codex-terminal-status.test.ts test/openai-codex-moa.test.ts test/openai-codex-moa-safety.test.ts test/openai-codex-moa-tool-history.test.ts test/openai-codex-moa-usage.test.ts test/openai-codex-thinking.test.ts)`
- `(cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/args.test.ts test/tool-definition-wrapper.test.ts examples/extensions/subagent/subagent-execution-policy.test.ts examples/extensions/subagent/subagent-extension-smoke.test.ts)`
- `npm --prefix pi-extensions run check`
- `npm run check`
- `npm run build`
- live no-session MoA tool call plus Ultra subagent execution

## Assumptions

- Codex OAuth already exists locally; no auth artifact is read or copied.
- MoA is strict all-or-nothing and adds latency/cost because it performs three provider calls.
- The synthesizer is Sol; changing synthesizer selection is out of scope until a measured need exists.

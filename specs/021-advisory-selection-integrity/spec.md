---
description: "Completed-response gating and honest evidence attribution for the existing advisory judge"
---

# Advisory Selection Integrity

**Specification ID:** `021-advisory-selection-integrity`

**Created:** 2026-09-05

**Status:** Implemented and scoped-reviewed; included in v0.98.3. No automatic activation.

**Constitution:** [Project constitution](../constitution.md)

## Scope

Apply the audited reliability principles of completed execution, deterministic selection,
missing-evidence disclosure and separation of advice from authority to OMK's existing
`chooseWithAdvisoryJudge` / `createModelAdvisoryJudge` public SDK path.

This is not a copy of a separate service's private implementation. It introduces no Python
runtime, model training, remote orchestration dependency, default CLI judge, automatic retry,
calibrated risk profile, automatic abstention policy, or release authorization.

## CLI Harness Target Impact

**Classification:** advance (bounded reliability/observability contract, not benchmark superiority).

Baseline: `v0.98.1`, repository `60f520f0c103888ef27438ac5058bdfc78b3e409` before this change.
Existing focused tests: 6 passed. The tree already contains unrelated changes; the evidence
record separates full-repository blockers from this slice.

| Dimension | Acceptance target | Regression floor | Verification command | Evidence artifact |
| --- | --- | --- | --- | --- |
| Judge execution validity | Only explicit normal `stop` may supply a usable score response | Non-stop/error/missing metadata never wins by well-formed JSON alone; zero retries | Focused command below | [TDD evidence](evidence.md) |
| Selection attribution | Top-score ties are named as deterministic tie-breaks | Selected ID and caller's explicit deterministic ranks unchanged | Same command; seeded property tests | Same evidence |
| Evidence observability | Original candidate denominator, excluded verdict counts, comparison availability and top-tie count are explicit | No candidate text, secrets, independent-correctness claim or new persistence | Same command | Same evidence |
| Authority and cost | Only parsed deterministic passes can be selected; zero/one eligible skip the judge | No protocol verdict mutation, extra completion, or recovery spend | Existing judge + protocol tests and compiled SDK smoke | Same evidence |

## Required behavior

1. First-party model responses require `stopReason === "stop"`, valid text blocks, no tool calls
   and bounded nonempty text. `length`, `aborted`, `toolUse`, `error`, absent/unknown/non-string
   terminal metadata are rejected with sanitized typed error codes. The wrapper retains the
   established deterministic fallback among eligible candidates, never a semantic pass.
2. A pre-aborted request must not resolve auth or invoke a completion. An abort observed while
   awaiting auth must also prevent the completion. This is local cancellation handling, not a retry.
3. Score equality does not identify a unique model preference. Preserve score ordering and
   explicit `deterministicRank`; a tied top group selects its best deterministic rank and
   reports `reason: judge-tied`, `source: deterministic`. A unique top remains `judge-ranked`.
   Do not replace intentional caller ranks with an invented correctness or content metric.
4. Add optional, readonly decision diagnostics so existing stored/manually constructed decisions
   remain type-compatible. The built-in producer fills them on every return path:
   - candidate counts: submitted, eligible, rejected-fail, rejected-inconclusive;
   - comparison: not-compared, unavailable, invalid, or scored;
   - unique score count, top-score tie count and score margin only for scored matrices;
   - no independent verifier/corroboration or calibrated correctness claim inferred from these counts.
5. Preserve complete matrix validation, forced redaction, bounded requests, no cache retention,
   maximum candidates/criteria and zero model retries. Do not activate a remote bridge or weaken
   any deterministic evaluation, receipt, freshness, sandbox, permission, or release gate.
6. Public SDK integration tests must exercise the real sidecar and model adapter together using
   an injected completion. Synthetic input is sufficient; no API key or paid provider call is needed.

## Verification

```bash
LIVE_E2E=0 node node_modules/vitest/dist/cli.js --run \
  packages/coding-agent/test/advisory-judge.test.ts \
  packages/coding-agent/test/advisory-judge-model.test.ts \
  packages/coding-agent/test/advisory-judge-integrity.test.ts \
  packages/coding-agent/test/advisory-judge-integrity.property.test.ts \
  packages/protocol/test/protocol.test.ts
npm run check
npm run build
```

The root build refreshes the canonical local SDK. It is not publication or a restart of an
already-running session. The default TUI still does not invoke this opt-in API automatically.

## Prior art and exclusions

Public abstract-level lookup (2026-09-05):
[Zheng et al., Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena](https://arxiv.org/abs/2306.05685)
identifies position, verbosity and self-enhancement biases and studies agreement with human
preferences, not executable correctness. Preserve explicit deterministic ranks and disclose
when a score matrix cannot distinguish its best candidates; do not label preference scores as
correctness probabilities. This is a failure-mode reference, not an imported algorithm or a
claim of reproducing the paper's results.

Automatic risk-bounded publish/continue/verify/abstain policies remain out of this slice:
OMK has no calibrated per-task risk evidence or user-approved default response contract here.
A separate service's MC/scalar extraction heuristics do not belong in OMK's complete 0–4 rubric
matrix parser. New ML, molecular-analysis, visualization and deployment mechanisms are not
needed for this TypeScript contract change.

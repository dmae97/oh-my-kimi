# Advisory selection integrity

**Introduced in v0.98.3.** This strengthens the existing explicit SDK
`chooseWithAdvisoryJudge()` and `createModelAdvisoryJudge()` path. It does not add a default
AgentSession/TUI judge, start subagents, or activate the separate AdaptOrch service.

See [SDK usage](sdk.md#advisory-best-of-n-selection), [Run Protocol](run-protocol.md), and
[spec 021](https://github.com/dmae97/omk/blob/v0.98.3/specs/021-advisory-selection-integrity/spec.md).

## Decision path

1. Parse every caller-supplied `EvaluationResult`; admit only semantic `pass` candidates.
2. Keep the caller's unique `deterministicRank`. Zero eligible candidates select nothing;
   one selects that candidate without a judge call.
3. Bound and force-redact the goal, rubric and eligible material before comparing.
4. Honor cancellation before invoking the judge and after awaiting its response.
5. The first-party model adapter requires an explicit normal `stop`, nonempty bounded text
   and no tool calls. Complete JSON with `length`, `aborted`, `toolUse`, `error`, missing or
   unknown completion metadata is not a completed evaluation.
6. Accept only a complete matrix covering exactly the known candidate and criterion IDs.
   Each score is an integer from 0 to 4; criterion weights remain unchanged.
7. Select the highest weighted score. If the top group ties, select its lowest deterministic
   rank, retaining `status: "selected"` but reporting `reason: "judge-tied"` and
   `source: "deterministic"`. A unique top reports `judge-ranked` / `llm-judge`.

A tied top group is not the global fallback: if rank-zero A scores below tied B and C, choose
B or C by their explicit ranks, never A. No content hash, majority vote, or guessed confidence
replaces the caller's ranking policy.

## Missing evidence is not a zero score

The built-in chooser attaches `diagnostics` on every returned decision. The property is optional
in the TypeScript contract so historical or caller-constructed decisions still type-check.

| Field | Meaning |
| --- | --- |
| `submittedCandidates` | Complete validated intake, including non-passes |
| `eligibleCandidates` | Number of deterministic passes |
| `excludedCandidates.fail` | Excluded semantic failures |
| `excludedCandidates.inconclusive` | Excluded unknown/incomplete semantic evaluations |
| `comparison` | `not-compared`, `unavailable`, `invalid`, or `scored` |
| `ranking.distinctScores` | Distinct weighted scores in an accepted matrix |
| `ranking.topScoreTieCount` | Candidates sharing its highest score |
| `ranking.scoreMargin` | Highest score minus second-ranked score, including ties |

`ranking` exists only when `comparison === "scored"`. Skipped, unavailable and invalid
comparisons do not invent a margin of zero. A valid all-zero matrix, by contrast, is scored
and tied. A score or margin is a rubric preference, not a probability of correctness.

Example diagnostics for two passing candidates that tie, with one failure and one unknown:

```json
{
  "submittedCandidates": 4,
  "eligibleCandidates": 2,
  "excludedCandidates": { "fail": 1, "inconclusive": 1 },
  "comparison": "scored",
  "ranking": { "distinctScores": 1, "topScoreTieCount": 2, "scoreMargin": 0 }
}
```

No raw candidate material or provider exception text is added to the decision. Counts do not
establish independent corroboration: duplicate/correlated candidates are not automatically
deduplicated or treated as independent evidence.

## Cancellation and failure

The first-party adapter checks cancellation before authentication, after authentication, and
after completion. A late normal response from a non-cooperative provider cannot become a usable
score after an observed abort. The chooser also checks before and after custom judge callbacks.
It cannot forcibly terminate an arbitrary callback; cancellation cooperation remains the
callback owner's responsibility.

`AdvisoryJudgeModelError("completion-failed")` remains the sanitized adapter error. The chooser
uses its existing `judge-unavailable` deterministic fallback. Malformed matrices use
`judge-response-invalid`. Neither is a failed task or new verification result. An abort fallback
is advice only; it does not authorize the caller to apply a patch after cancellation.

A custom `AdvisoryJudge` still returns raw score JSON. Its author owns provider completion
metadata; only `createModelAdvisoryJudge()` can enforce the first-party message envelope.
There are still no model retries or cache retention. No extra provider call is introduced.

## Authority and activation

`parseEvaluationResult()` checks the record structure, not the truth of its evidence. Supply
trusted, fresh results from `evaluateTask()` and preserve receipt, workspace-freshness, isolation,
permission and release gates. The judge never changes an evaluation, waiver, observation or
`RuntimeDecision`; apply a selected candidate only through the caller's existing controls and
then rerun deterministic verification.

This is a local reliability/observability improvement, not measured general accuracy or a
calibrated publish/abstain policy. MC/scalar answer extraction, automatic continuation and
risk-bound enforcement are deliberately not inserted into the 0–4 rubric contract.

Install `open-multi-agent-kit@0.98.3` or build from the matching source tag.
An already-running process is not hot-patched. Use a new SDK process to load the updated
package; no setting or automatic TUI policy is enabled by this change.

## Offline verification

```bash
LIVE_E2E=0 node node_modules/vitest/dist/cli.js --run \
  packages/coding-agent/test/advisory-judge.test.ts \
  packages/coding-agent/test/advisory-judge-model.test.ts \
  packages/coding-agent/test/advisory-judge-integrity.test.ts \
  packages/coding-agent/test/advisory-judge-integrity.property.test.ts \
  packages/protocol/test/protocol.test.ts
```

These tests use injected completions and synthetic evaluations. They exercise the public SDK
and real model adapter without provider credentials, including non-normal terminal states,
cancellation, weighted ties, full intake accounting and seeded permutation properties.

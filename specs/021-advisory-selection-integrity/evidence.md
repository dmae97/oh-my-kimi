# Advisory selection integrity — evidence

Date: 2026-09-05. Baseline: `v0.98.1` / `60f520f0c103888ef27438ac5058bdfc78b3e409`.
Historical pre-release record: source and tests were worktree-only at this point.
The [v0.98.3 release audit](../../packages/coding-agent/docs/release-audit-0.98.3.md)
supersedes the release/gate status below; the original measurements are retained. This is the first bounded SDK integration
slice, not automatic activation of a judge or a separate service in the default TUI.

## Confirmed mechanisms

- A fixed valid score matrix selected candidate `b` when the first-party completion said
  `length`, `aborted`, `toolUse`, or lacked normal completion evidence. The adapter rejected
  explicit `error` already, but not the other non-normal states. A complete matrix cannot
  establish that its evaluation completed.
- Equal top scores selected by the caller's `deterministicRank` were still attributed to
  `llm-judge` / `judge-ranked`. The selected ID was already deterministic; this is an
  attribution correction, not a new correctness signal or a different ranking algorithm.
- An already-aborted request still invoked a custom judge once; late normal responses were
  accepted after abort. Cancellation now prevents a new call and discards late advice.
- Intake/missingness diagnostics were absent. They now preserve submitted/pass/fail/
  inconclusive counts and omit ranking statistics when nothing was measured.
- Candidate/response permutation invariance already passed before the change. No content
  ordering or recalculated priority replaced the existing caller rank.

## TDD record

| Stage | Actual result |
| --- | --- |
| Existing public SDK judge tests, before edits | 2 files / 6 passed |
| New integrity + property tests, before source edits | 17 failed / 1 passed |
| Late normal response after cancellation | 1 failed; promise resolved score JSON instead of rejecting |
| First implementation + old/protocol regressions | 5 files / 32 passed |
| Custom-judge cancellation gap, before chooser guards | 2 failed; callback called once, late response selected `b` |
| Chooser guards + weighted-rubric regression cases | 5 files / 36 passed |
| Final run after review's opposite-ID/rank regression suggestion | 5 files / 37 passed; whole-repository tsgo exit 0; scoped Biome clean |
| Property tests | Seed 20260905, 100 generated cases each for permutation and pass-gate/intake invariants |

Synthetic fixtures use the public source entrypoint, actual sidecar/model adapter, and an
injected completion. No credential store or live completion is needed. No observation,
evaluation, waiver or runtime decision is created or mutated by selection.

Focused command: see [spec 021 verification](spec.md#verification). The weighted tests include
criterion-specific values: an unweighted implementation would choose a different winner or
misclassify a weighted tie. Permutations preserve selected IDs, scores, diagnostics and request
hashes; zero/one eligible candidate still makes zero judge calls.

## Prior-art check

Fetched abstract: Zheng et al., [Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena](https://arxiv.org/abs/2306.05685).
An isolated read identified position/verbosity/self-enhancement bias and the boundary between
human preference agreement and executable correctness. It supports caution in attribution,
not a claim that this patch reproduces the paper or that completion gating improves accuracy.
Broader selective prediction was considered but not implemented without calibration or a
separately approved response policy. The existing strict rubric matrix is retained.

## Scope discipline

Changed production files:

- `packages/coding-agent/src/core/advisory-judge.ts`
- `packages/coding-agent/src/core/advisory-judge-model.ts`
- `packages/coding-agent/src/core/advisory-judge-types.ts`

No new dependency, private engine import, default policy, retry budget, release version or
service activation. Existing unrelated worktree changes are preserved. Public SDK/protocol
and runtime documentation identify this as opt-in, unreleased work.

## Repository gate observations so far

- Before this task's source changes, `npm run check` stopped at four unrelated Biome errors
  (Meta OAuth imports, Codex turn-metadata test, MCP tools test and session-termination test).
- Scoped Biome checks on the six source/test files pass after formatting.
- Primary LSP on the chooser, model adapter and integration test: 3 clean, no diagnostics.
- Module-size gate reports five unrelated pre-existing dirty modules over their baselines:
  reverse-skill, AI types, model-registry, provider-usage and interactive-mode. The three
  modified production files are not offenders; the chooser is about 242 nonblank/non-comment
  lines and should be split by responsibility before another substantial addition.

These observations do not make the full repository green. No release approval is implied.

## Build and direct runtime checks

- `node_modules/.bin/tsgo --noEmit --pretty false`: exit 0 across the repository.
- `npm run build`: all seven workspaces built, canonical local SDK refreshed; no stale outputs.
- A fresh Node process imported `packages/coding-agent/dist/index.js` and exercised 11 synthetic
  scenarios through the compiled public SDK. Normal `stop` selected `b` via the judge; each
  non-normal/missing case selected deterministic fallback `a`; a tied matrix reported
  `judge-tied` / `deterministic` / tie count 2 / margin 0. A pre-aborted custom judge made
  zero calls. Nine injected completions were used; this was not a live-provider benchmark.
- `npm run check:feature-claims`: pass, four existing README claims still source-backed.
- `npm run check:constitution`: 260 passed / 2 failed. Failures are the unrelated untracked
  context7 skill catalog entry and the five previously noted oversized dirty modules.
- `npm run check:doc-links`: current-index check also flags this new untracked guide and an
  unrelated quickstart/context-files link. With a temporary index containing only HEAD plus
  this slice's six new deliverables, the **unmodified** checker reports only the unrelated
  context-files link; no new guide/spec link finding. The real index was not modified.
- `git diff --check`: clean for the changed existing paths. No version bump, commit, publish,
  global configuration change or forced TUI restart occurred.

## Independent reviews — final scoped PASS

| Lane | Observed result |
| --- | --- |
| Goal/constraints | PASS (HIGH); independently reran 36 tests and compiled SDK smoke |
| QA | PASS; 111/111 independent compiled-SDK scenarios, 36/36 focused tests; observed network/credential-file/write attempts all 0 |
| Code quality/performance | PASS; bounded O(N) diagnostic overhead at N≤8, weighted score/tie correctness; suggested opposite-ID/rank regression added and passed |
| Security | PASS; 29 focused tests plus 39 independent security cases; no scoped blocker |
| Context/style | Initial FAIL on two wording issues → corrected → focused re-review PASS |

The context review correctly narrowed completion-metadata enforcement to the first-party
model adapter (custom judges own that boundary), and replaced a broad spend statement with
"no added completion calls or retries". The runtime-algorithms paragraph now states both.
All five lanes reached a terminal scoped verdict. The extra test added after the reviews
addresses the code review's sole LOW suggestion; production code did not change after build.
The final 37-test run and whole-repository typecheck both passed.

Final `npm run check` still exits 1 at the same four unrelated Biome errors and eleven
informational findings seen before implementation. No baseline was widened and no unrelated
file was reformatted to make this slice appear green. The new guide/spec/test files remain
unstaged; the temporary candidate-index link check did not alter the real index.

**Delivery boundary:** the canonical local SDK is built and usable through explicit callers.
There is no automatic judge, calibrated risk enforcement, full algorithm promotion, TUI
hot-patch, version bump, commit or publication. All review and verification results above
apply to this bounded SDK slice, not release readiness.

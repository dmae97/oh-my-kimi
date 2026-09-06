# OMK v0.98.3

This patch brings the v0.98.2 release lineage back into the algorithm branch, strengthens
explicit advisory selection, and aligns evidence-library documentation and package metadata.

## Highlights

- **Honest advisory selection:** the first-party model judge accepts only a normal `stop`.
  Truncated, aborted or missing completion metadata cannot supply scores even when the JSON
  parses. Cancellation suppresses new judge work and discards late advice. Highest-score
  ties keep caller priority and report `judge-tied` / `deterministic` rather than a unique
  model preference. Intake diagnostics distinguish non-passes and unmeasured comparisons.
- **Workspace-scope completeness:** the session SDK reports capped, excluded and unavailable
  scope instead of implying that every dirty file was fingerprinted.
- **Lifecycle reliability:** observer fan-out delivers every listener before reporting errors;
  operation settlement and public rejection share the same primary failure code. The
  callback-safe `requestAbort()` and `runWhenIdle()` APIs preserve explicit operation ownership.
- **Evidence primitives:** `omk-protocol` exports Claim Closure Graph v1 evaluation and blocking
  cuts; `omk-adaptorch-wpl` exports proof/VERA vocabulary projections. Canonical digests,
  operation traces and Effect Journal V2 remain internal agent primitives, not a new default
  execution or recovery authority.

## Compatibility and boundaries

- All seven public npm packages move together to **0.98.3**. No API is intentionally removed.
- Advisory decision diagnostics are additive/optional for historical records. Consumers that
  exhaustively match reason codes should handle the new `judge-tied` reason. Normal-stop
  enforcement intentionally tightens which first-party judge responses are usable.
- No default TUI judge, remote AdaptOrch activation, automatic continuation, calibrated
  publish/abstain policy, or release authorization is introduced.
- Existing uncommitted provider, UI, context-init, reverse-skill and private research work was
  not swept into this release. The previously committed evidence primitives and reviewed
  advisory SDK changes are the new algorithm scope.
- Model catalogs are not regenerated during release. Existing package locks and the CLI
  shrinkwrap are synchronized to the release versions.
- Publishing remains in GitHub CI, using the existing environment-scoped granular npm token.
  OIDC trusted publishing and Sigstore provenance are **not enabled** for this release.

## Verification

The tagged workflow rebuilds binaries and all workspaces, runs `npm run check` and the full
keyless workspace tests, checks committed artifacts, then publishes the seven npm packages
before creating the GitHub Release. Local release evidence and package inventory are recorded
in [the release audit](../packages/coding-agent/docs/release-audit-0.98.3.md).

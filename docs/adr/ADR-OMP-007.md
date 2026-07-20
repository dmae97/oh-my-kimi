# ADR-OMP-007: G3 verification PASS, owner-checkout main state acknowledgment, and R1 publication decision (disabled)

- **Status:** ACCEPTED
- **Date:** 2026-07-21
- **Decision authority:** `operator:user` via exact request `REQ-OMP-G3-R1-001` (items 1–4 answered: G3 approved; docs commit approved; F1 disposition (a); R1 (a) publication stays disabled)
- **Prior decisions:** [ADR-OMP-003](ADR-OMP-003.md), [ADR-OMP-005](ADR-OMP-005.md), [ADR-OMP-006](ADR-OMP-006.md)
- **Evidence:** [G3 verification](evidence/omp-g3-verification.json)

## Decision

1. **G3 is PASS.** All seven required gates (regression, security, package, license, race, rollback, clean-diff) passed with fresh 2026-07-21 evidence against the exact I1 unit (`cbaa4d0722` + `368fada47f`, candidate `b6e75dbbc545c815786ecc15d155a332c21cad2b`). Regression used a matched-pair baseline: the 18 failing LLM-e2e tests fail identically at S0 (`360d5036b5`) with `401 authentication_error`, so zero OMP-attributable regression exists. Rollback was rehearsed in a disposable worktree: reverting the two I1 commits restores the S0 tree byte-exactly.
2. **G3 ownership is satisfied by substitution lanes.** The dispatched independent-reviewer and compliance-auditor agent lanes timed out at 180s; per the omk-loop recovery ladder the coordinator (which did not author I1) executed both reviews root-sequentially. Reports: `/tmp/omk-loop-omp/review-omk-reviewer.md`, `/tmp/omk-loop-omp/review-compliance.md` (verdicts PASS/PASS). The operator accepts this substitution for G3 only.
3. **F1 owner-checkout main state is acknowledged as-is.** The operator acknowledges that owner-checkout `main` and isolated branch `yu/omp-migrate-39c95e5e` both tip at `bf9a941a32`, i.e. the I1 unit is reachable from owner-checkout main. No remediation (no reset, no rewrite) is performed. This is a documentation/state-drift acknowledgment, not a merge approval: the roadmap's "owner-checkout main merge excluded" boundary is satisfied in substance because **no publication exists** — local `main` is 13,716 commits ahead of `origin/main` and nothing was pushed. Any future push remains gated by R1.
4. **R1 is DECIDED: publication remains disabled.** The operator decided (2026-07-21) to keep publication, release, tags, pushing of any branch, and the fork PR route disabled. The OMP migration roadmap is thereby terminally decided for every phase: S0 ACCEPTED, U1 SUPERSEDED, G0 REOPENED, G1/H1 PASS, G2 ACCEPTED, I1 COMPLETE, G3 PASS, R1 DECIDED (no publication). Reopening publication requires a fresh explicit operator decision.

## Boundaries preserved

- `OMK_OMP_SEAMS` stays default-off; the loader has zero call sites in active source; hashline stays proposal-only; OMK's single serialized write path stays authoritative.
- No tool behavior, registry, mutation queue, manifest, or lockfile changed; vendor tree remains inert and excluded from workspaces and biome.
- This ADR grants no authority for: publication, release, tags, upstream PR, hashline write path, E1 extraction, or runtime wiring of the loader. Each requires a separate future ADR.

## Rollback

Reverting this decision: revert this ADR's docs commit and the two I1 commits (`cbaa4d0722`, `368fada47f`) with first-parent semantics; the rehearsed revert restores the S0 tree byte-exactly. G1/H1 evidence remains valid for the unchanged candidate identity.

# ADR-OMP-006: Approve the bounded I1 integration unit at the coding-agent boundary

- **Status:** ACCEPTED — scope-bounded
- **Date:** 2026-07-20
- **Decision authority:** `operator:user` via `AUTH-LOCAL-QUAL-DECISION-20260720-01`, conditional on the recorded G1/H1 PASS
- **Qualified source:** candidate `b6e75dbbc545c815786ecc15d155a332c21cad2b` (ADR-OMP-005)
- **Qualification evidence:** [omp-g1-h1-qualification.json](evidence/omp-g1-h1-qualification.json)
- **Prior decisions:** [ADR-OMP-003](ADR-OMP-003.md), [ADR-OMP-005](ADR-OMP-005.md)

## Approved integration unit (I1)

All changes occur only on the isolated candidate branch `yu/omp-migrate-39c95e5e` in two bounded commits:

1. **Vendor source refresh.** Update exactly the ten qualified candidate paths under `vendor/oh-my-pi/` so the vendored tree equals the qualified candidate tree `296cfdbb83bbb7db30248864938cd7f456e2b8f5`. No other vendor path changes.
2. **Flag-gated pure-seam loader.** Add a bounded module plus focused tests under `packages/coding-agent/`:
   - a structural loader that dynamically imports the three vendored seams (`pure/read`, `pure/search`, `hashline proposal`) by explicit file URL with runtime shape validation;
   - disabled by default; enabled only when `OMK_OMP_SEAMS=1`;
   - no change to existing tool behavior, tool registry, session, renderer, mutation queue, manifests, lockfiles, or workspaces;
   - hashline output remains proposal-only data; no write path is added.

## Constraints

- Existing read/grep/edit contracts and the single realpath-serialized write queue remain authoritative and untouched.
- No `any`, unsafe assertion, or non-erasable syntax in new OMK code; Biome and package type checks must pass.
- New tests must prove: loader disabled by default; loader loads and validates the vendored seams on the current Node lane; existing focused tool tests still pass.
- Publication and release stay disabled; the npm package allowlist must keep excluding `vendor/`.

## Rollback

Revert the two I1 commits to return to the S0 import state; ADR-OMP-005 rollback then applies. No dual write path exists at any point, so rollback is a pure Git revert plus test rerun.

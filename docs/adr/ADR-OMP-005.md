# ADR-OMP-005: Local-candidate qualification strategy (supersedes the upstream-acceptance U1 gate)

- **Status:** ACCEPTED
- **Date:** 2026-07-20
- **Decision authority:** `operator:user` via exact request `AUTH-LOCAL-QUAL-DECISION-20260720-01`
- **Prior decisions:** [ADR-OMP-002](ADR-OMP-002.md), [ADR-OMP-003](ADR-OMP-003.md), [ADR-OMP-004](ADR-OMP-004.md)
- **Evidence:** [G0 candidate inventory](evidence/omp-g0-candidate.json); [G1/H1 qualification](evidence/omp-g1-h1-qualification.json)

## Decision

The operator supersedes the requirement, recorded in ADR-OMP-004 and the roadmap U1 row, that can1357 upstream must accept the seams in a named commit before intake. The qualification and integration source identity is now the exact local candidate:

- Commit `b6e75dbbc545c815786ecc15d155a332c21cad2b`, tree `296cfdbb83bbb7db30248864938cd7f456e2b8f5`, parent `39c95e5e29b1c8b082059f57421ce445c3dffdd4`
- Durably retained at private ref `refs/omp/candidates/b6e75dbbc545c815786ecc15d155a332c21cad2b`

Under this decision:

1. **G0 is REOPENED** for this exact candidate identity only. Any identity drift closes it.
2. **Disposable G1/H1 qualification is authorized** on plain Node 22.19.0 and 24.13.0 with direct source imports and no bundler, loader workaround, or polyfill.
3. **A bounded I1 integration unit is authorized after G1 and H1 pass**, under the separate G2 record (ADR-OMP-006).
4. **Upstream contribution becomes optional parallel work.** The existing fork `dmae97/oh-my-pi` and prepared PR draft may still be used; can1357 acceptance is no longer a gate for local integration.
5. **Publication, release, tags, and owner-checkout main mutation remain excluded** and require separate explicit authority.

## Rationale

The candidate's three seams are complete, source-bound, authority-free, and were implemented for exactly this repository lineage. The only remaining U1 blocker was an external acceptance event outside local control with an unbounded timeline. The operator holds decision authority for this repository and accepted the bounded local strategy; upstream alignment remains available without gating local progress.

## Boundaries preserved

- ADR-OMP-002's prohibition on bridges, polyfills, partial bridges, hand reimplementations, and unapproved extraction stays in force; qualification used direct unchanged source imports only.
- Hashline stays proposal-only at integration until a separately reviewed source-validation write path exists.
- OMK's single serialized write path stays authoritative.
- All qualification gates re-run for any changed candidate identity.

## Rollback

Reverting this decision restores ADR-OMP-004's draft state: stop qualification/integration, keep S0 inert, and revert any I1 commits with first-parent semantics. The private candidate ref may then be deleted only under separate explicit authority.

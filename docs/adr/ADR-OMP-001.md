# ADR-OMP-001: OMP disposable topology feasibility proof

- **Status:** Recorded; migration gate terminated before owner-checkout integration
- **Date:** 2026-07-19
- **Evidence:** [topology report](evidence/omp-topology-report.json)

## Context

The exact OMP pin under review is `9fd6e97113f5ed3a847e66d346970efdf8afcad9`. This ADR records only the disposable topology rehearsal; it does not authorize source migration or owner-checkout changes.

## Decision

The disposable rehearsal proved that topology is feasible with the following exact values:

- expected and observed merge base: `15d5120b6a5dc757355b99d20d8d1885143d0865`
- pin tree: `df1f9a55e2e65cb0f5d29287ab1393bb0abd026a`
- private pin ref: `refs/omp/pins/9fd6e97113f5ed3a847e66d346970efdf8afcad9`
- materialization prefix: `vendor/oh-my-pi`
- prefixed tree: `df1f9a55e2e65cb0f5d29287ab1393bb0abd026a`

The rehearsal used a full-history clone, fetched no tags, and configured the push URL as `DISABLED`. It rehearsed replacement from old pin `546dce76384eec112125505740acf5515fa03daf` to the exact current pin: the old ancestry marker and prefix were materialized, the current ancestry marker was written, and the prefix was replaced exactly. A second current-pin rematerialization was idempotent. The disposable worktree was clean.

## Consequences

Topology feasibility is not approval to migrate. The downstream pure gate terminated; therefore no OMP ancestry refs, vendor refs, vendor source, or OMP-derived source were added to the owner checkout. No owner checkout mutation or publication mutation occurred. This ADR makes no claim of a public release, source integration, or product integration.

The recorded topology evidence remains available only as a prerequisite should the pure gate be reopened and pass.

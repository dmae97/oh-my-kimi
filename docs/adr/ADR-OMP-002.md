# ADR-OMP-002: Terminate the OMP pure-source migration gate

- **Status:** TERMINATED
- **Date:** 2026-07-19
- **Evidence:** [pure probe report](evidence/omp-pure-probes.json); [source inventory](evidence/omp-pure-source-inventory.json); `agent://41-AuditOmpHashlineApply`
- **Topology prerequisite:** [ADR-OMP-001](ADR-OMP-001.md)

## Decision

The OMP pure-source migration gate is **TERMINATED**. Its three minimum operations are conjunctive: `read`, `search`, and `hashline-apply` must each have an approved, source-bound pure closure that runs unchanged in the mandatory Node >=22.19 lane. Passing topology feasibility does not satisfy this gate.

`read` and `search` expose effectful tools and renderers as their importable runtime surface. Their candidate planning and presentation helpers are private; neither operation exposes an approved pure seam accepting immutable inputs and OMK-supplied results. Importing the available modules brings filesystem, native, TUI, session, network, or related authority into the closure.

For hashline-apply, the relevant operation is parsing an untrusted patch string to proposed edits and `expectedLineHashes[]`, without a read or mutation. The exact source exports `Patch.parse`, `Patch.parseSingle`, `PatchSection.parse`, `parsePatch`, and `parsePatchStreaming`. `Patch.parse` is filesystem-free and preserves a single section's `fileHash`; a Bun-built tree-shaken Node bundle was observed to parse successfully. Those observations do not satisfy the approved seam: OMP `Edit` anchors contain line numbers only, not per-anchor expected hashes. Raw Node v22.22.3 direct import of `input.ts` also fails because its extensionless TypeScript imports are unresolved. Its source closure imports `format.ts`, which contains `Bun.hash.xxHash32`; tree-shaking that dependency away is unapproved mechanical extraction, lacking an exact source-range/AST identity, deterministic generator and output hash, upstream license proof, zero-semantic-edit proof, and a pre-approval ADR. `computeFileHash` is supporting evidence, not the minimum operation itself.

No workaround, polyfill, partial bridge, mechanical extraction, vendor import, or product integration is approved. In particular, no hand reimplementation or compatibility substitution may stand in for the missing closures.

## Consequences

Migration terminates before owner-checkout integration. Do not add OMP ancestry or vendor refs, OMP vendor source, an OMP bridge, a compatibility firewall, or product integration. This ADR makes no claim of public release or source integration.

## Conditions to reopen

Reopen the gate only when all of the following are demonstrated for the exact reviewed source revision:

1. `read`, `search`, and `hashline-apply` each expose an approved, source-bound public pure seam; candidate helpers may not remain private.
2. Every seam runs unchanged in Node >=22.19 without Bun, native, filesystem, process, network, browser, session, TUI, or edit authority.
3. The hashline-apply seam returns proposed edits and `expectedLineHashes[]` from an untrusted patch string without a read or mutation. A future mechanical extraction is acceptable only with exact source-range/AST identity, a deterministic generator and output hash, upstream license proof, zero semantic edits, and prior ADR approval; it may not rely on a workaround, polyfill, partial bridge, or hand reimplementation.
4. Reproducible probe evidence proves all three operations together, and an explicit ADR approves any extraction or integration before the owner checkout changes.

# ADR-OMP-008: I2 — flag-gated wiring of read/grep tools to the OMP pure seams, with benchmark evidence

- **Status:** ACCEPTED
- **Date:** 2026-07-21
- **Decision authority:** `operator:user` via direct instruction "진행시켜" (proceed with I2 wiring + benchmark; publication remains excluded per [ADR-OMP-007](ADR-OMP-007.md))
- **Prior decisions:** [ADR-OMP-005](ADR-OMP-005.md), [ADR-OMP-006](ADR-OMP-006.md), [ADR-OMP-007](ADR-OMP-007.md)
- **Evidence:** [I2 benchmark](evidence/omp-i2-benchmark.json); regression log `/tmp/omk-loop-omp/t7-i2-regression.log`

## Decision

1. **I2 wiring is implemented and accepted.** When `OMK_OMP_SEAMS=1`, the `read` tool (text branch) and the `grep` tool (context=0) delegate request validation and output presentation to the vendored OMP pure seams via a memoized typed facade (`packages/coding-agent/src/core/tools/omp-seam-runtime.ts`). The host keeps path resolution, read-policy checks, all file I/O, and ripgrep execution. When the flag is off (default), behavior is byte-identical to the pre-I2 implementation.
2. **Scope boundaries of the wiring:** image reads are untouched (the seam has no image concept); `grep` with `context>0` keeps the OMK formatter (the seam has no context rendering); search presentation is supplied without source/line digests; read presentation is supplied with the whole-source digest and per-window-line digests (`hashProposalSource`/`hashProposalLine`) so output lines carry `N@sha256:<digest>|` anchors for future source-bound editing. Hashline stays proposal-only; no write path is added.
3. **Verification:** `tsgo --noEmit` clean for all touched files (the only repo typecheck errors are the pre-existing, unrelated `k2p7` model-rename WIP in `packages/ai`). 11 new tests (`test/omp-seam-wiring.test.ts`, `test/omp-seams-perf.test.ts`) pass. Full coding-agent suite: 4047 pass / 18 fail of 4065 — the identical 4 LLM-e2e files failing with `401 authentication_error` as the pre-I2 baseline and as S0; zero wiring-attributable regression.
4. **Benchmark verdict (recorded, not a gate):** on Node v22.22.3, 2000-line read fixture, 100 iterations — flag-off mean **1.07 ms**, flag-on mean **88.96 ms** (p95 100.2 ms). Grep corpus (20 files, ~86 matches), 30 iterations — flag-off mean **10.34 ms**, flag-on mean **11.97 ms** (+16%). **The OMP seam is not faster**: the read overhead is the price of 2,001 WebCrypto SHA-256 digests (hashline provenance anchors), and grep is near-parity. The seam's value is deterministic source-bound presentation, not speed. Claims of OMP performance advantage remain unevidenced.

## Boundaries preserved

- Publication, release, tags, and branch pushes remain disabled (ADR-OMP-007 R1). No vendor source was modified. No manifest, lockfile, registry, mutation-queue, or workflow change. Flag stays default-off; no session or AgentHarness coupling. The memoized facade caches only the seam module reference, never per-request data.

## Rollback

Revert the I2 commit (`omp-seam-runtime.ts`, `read.ts`/`grep.ts` wiring, two test files, this ADR, benchmark evidence, roadmap rows). The flag-off path is untouched by construction, so revert restores prior behavior exactly; the ADR-OMP-007 rehearsed I1 rollback remains valid underneath.

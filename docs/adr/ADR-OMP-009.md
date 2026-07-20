# ADR-OMP-009: OMP seams enabled by default (opt-out via `OMK_OMP_SEAMS=0`)

- **Status:** ACCEPTED
- **Date:** 2026-07-21
- **Decision authority:** `operator:user` via direct instruction "ㄴㄴ 걍 기본값으로 해" (make the seams the default), given with the ADR-OMP-008 benchmark data (read 1.07→88.96 ms mean) visible.
- **Prior decisions:** [ADR-OMP-006](ADR-OMP-006.md), [ADR-OMP-007](ADR-OMP-007.md), [ADR-OMP-008](ADR-OMP-008.md)
- **Evidence:** regression log `/tmp/omk-loop-omp/t7-i3-defaulton.log`; [I2 benchmark](evidence/omp-i2-benchmark.json)

## Decision

1. **The OMP pure seams are now the default for `read` (text) and `grep` (context=0).** `isOmpSeamsEnabled` returns true unless `OMK_OMP_SEAMS === "0"`; the env var becomes an opt-out, not an opt-in. This supersedes the default-off boundary recorded in ADR-OMP-006 (I1 GO criteria), ADR-OMP-007 (boundaries preserved), and ADR-OMP-008 (flag-off byte-identical guarantee) — those records now describe the **opt-out** path.
2. **The opt-out path is byte-identical and test-pinned.** With `OMK_OMP_SEAMS=0`, read/grep behavior is exactly the pre-seam implementation; `test/tools.test.ts` pins this path explicitly, and `test/omp-seam-wiring.test.ts` covers both modes.
3. **The operator accepts the recorded costs as the default experience:** read output carries `N@sha256:<digest>|` anchors and a source-digest header at ~89 ms per 2,000-line read (2,001 WebCrypto SHA-256 digests); grep presentation is grouped by file at ~+16% latency; `grep context>0` keeps the legacy formatter; beyond-EOF reads render a seam marker instead of throwing; read truncation notices become seam markers (`[+N more lines]`).
4. **Boundaries unchanged:** hashline stays proposal-only (no write path); no vendor modification; no manifest/lockfile/registry/queue change; publication remains disabled (ADR-OMP-007 R1); image reads untouched.

## Rationale

The seam's value (deterministic source-bound presentation, hash anchors for future source-bound editing) only materializes when it is the default path; an opt-in flag leaves the migration inert in practice. The operator reviewed the benchmark cost and chose default-on with a byte-identical opt-out as the rollback lane.

## Rollback

Immediate: set `OMK_OMP_SEAMS=0` (per-session, zero code change). Full: revert this ADR's commit; the flag flips back to opt-in (`=1`) and the ADR-OMP-008 state is restored. The rehearsed I1 rollback (ADR-OMP-007) remains valid underneath.

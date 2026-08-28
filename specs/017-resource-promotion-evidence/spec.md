---
description: "Bounded local resource-observation report required before adaptive-default promotion"
---

# Feature Specification: Resource Promotion Evidence Report

**Specification ID**: `017-resource-promotion-evidence`
**Created**: 2026-08-27
**Status**: Implemented in the current working tree; adaptive promotion remains blocked
**Constitution**: [specs/constitution.md](../constitution.md)
**Input**: Remaining v0.98.x harness advancement: gather evidence before promoting `resourceGovernor.mode`
**OMK Preset**: `omk`

## CLI Harness Target Impact

**Classification**: advance

| Dimension | Baseline | Acceptance target | Regression floor | Verification command | Evidence artifact |
| --- | --- | --- | --- | --- | --- |
| Resource-policy observability | `v0.97.0`: per-run local journals, no aggregate | `omk doctor resources --report [--json]` reports pressure/action counts, would-throttle count, reason coverage, probe health, and sample floor | No raw host values, paths, prompt/run IDs, decision IDs, digests, or command field in aggregate output | `npm --prefix packages/coding-agent test -- test/resource-doctor-cli.test.ts test/resource-observation-report.test.ts test/resource-observation-journal.test.ts` | focused tests |
| Promotion safety | Roadmap requires at least 30 observations plus human review | Report states `minimumSampleSize=30`, `minimumSampleMet`, and `humanReviewRequired=true` | Report never changes governor mode or declares promotion readiness | same focused test command | JSON report schema |
| Bounded execution | No aggregate scan | At most 5,000 directory entries, 500 regular journal files, 2 MiB and 10,000 records per file; malformed or capped input becomes diagnostics/truncation | No symlink following, unbounded file read, network, or provider call | same focused test command | collector tests |

## Problem

`observe` mode records per-run admission decisions, but maintainers cannot review
the distribution without opening many local JSONL files. Promoting `adaptive`
without an aggregate would replace the roadmap's evidence gate with intuition.

## Goal

Add a local, identifier-free aggregation command that measures whether the
minimum sample exists and exposes the evidence needed for human false-positive
review. The command is an observation surface, not promotion authority.

## Requirements

### Requirement 1 - Bounded aggregate (Priority: P1)

**Acceptance**:
1. Scan only `.omk/runs/*/resource-observations.jsonl` regular files.
2. Cap scans at 500 files and 2 MiB per file; report truncation.
3. Count pressure (`normal`, `constrained`, `critical`) and actions
   (`allow`, `throttle`, `defer-heavy`).
4. Count would-throttle decisions and `resource.probe.partial`/`timeout` reasons.
5. Track reason-qualified records separately; legacy records without reasons do not satisfy the sample floor.
6. Malformed lines/facts and every directory/file/record cap increment diagnostics or truncation and never throw.
7. Open regular files with no-follow semantics, enforce size on the descriptor read, and revalidate identity/size.

### Requirement 2 - Privacy boundary (Priority: P1)

**Acceptance**:
1. Aggregate output contains counts and booleans only.
2. Output contains no cwd, path, prompt/run ID, decision ID, snapshot digest,
   command field, hostname, username, or raw capacity value.
3. The command performs no network or provider call.

### Requirement 3 - CLI surface (Priority: P1)

**Acceptance**:
1. `omk doctor resources --report` prints a concise human report.
2. `omk doctor resources --report --json` prints schema version 1.
3. Report mode does not probe the current host.
4. Existing `omk doctor resources [--json]` behavior remains unchanged.

### Requirement 4 - No automatic promotion (Priority: P1)

**Acceptance**:
1. `DEFAULT_RESOURCE_GOVERNOR_MODE` remains `observe`.
2. Thirty reason-qualified records set only `minimumSampleMet=true`; incomplete reason coverage remains visible.
3. `humanReviewRequired` is always true.
4. Adaptive-default promotion requires a separate spec with reviewed
   false-positive evidence and platform fixtures.

## Expected Files

- `packages/coding-agent/src/core/resource-observation-report.ts`
- `packages/coding-agent/src/core/resource-observation-journal.ts`
- `packages/coding-agent/src/commands/resource-doctor-cli.ts`
- `packages/coding-agent/test/resource-observation-report.test.ts`
- `packages/coding-agent/test/resource-observation-journal.test.ts`
- `packages/coding-agent/test/resource-doctor-cli.test.ts`
- `packages/coding-agent/src/cli/help.ts`
- `packages/coding-agent/docs/settings.md`
- `packages/coding-agent/docs/runtime-algorithms.md`
- `packages/coding-agent/README.md`
- `packages/coding-agent/CHANGELOG.md`
- `specs/README.md`

## Verification Commands

- `npm --prefix packages/coding-agent test -- test/resource-doctor-cli.test.ts test/resource-observation-report.test.ts test/resource-observation-journal.test.ts`
- `npm run check:module-size`
- `npm run check:doc-links`
- `npm run check:constitution`
- `npm run check:feature-claims`
- `git diff --check`

## Non-Goals

- Changing the default governor mode
- Uploading or publishing local resource observations
- Inferring false positives without human review
- Recording raw host capacity or identities
- Auto-wiring live subagent lanes or workload sharding

## Assumptions

- Existing journals are local and may be missing or malformed.
- The current working tree remains unreleased.
- Observation count is necessary but insufficient for promotion.

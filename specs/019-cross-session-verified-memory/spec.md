---
description: "Spec-first, evidence-linked, workspace-local memory with fail-closed admission and data-only injection"
---

# Feature Specification: Cross-Session Verified Memory

**Specification ID**: `019-cross-session-verified-memory`
**Created**: 2026-08-27
**Status**: Proposed and implementation-blocked pending admission/evaluation fixtures
**Constitution**: [specs/constitution.md](../constitution.md)
**Input**: Remaining v0.99 memory advancement from the current OMK algorithm roadmap
**OMK Preset**: `omk`

## CLI Harness Target Impact

**Classification**: advance

| Dimension | Baseline | Acceptance target | Regression floor | Planned verification command | Evidence artifact |
| --- | --- | --- | --- | --- | --- |
| Evidence recall | No cross-session verified-memory path | Preregistered public/synthetic fixture recall improves over no-memory baseline | No task-success regression; confidence interval and minimum effect frozen before runs | `npm --prefix packages/coding-agent test -- test/verified-memory-*.test.ts` | sanitized fixture report |
| Admission precision | No admission gate | Accept/abstain/escalate gate; no execution-success-only admission | `0` unlinked model self-claims admitted; target precision and sample size fixed in implementation spec amendment | same planned test command | admission report |
| Security | No retrieval channel | Retrieved memory is provenance-tagged data in Context Budget V2 only | `0` instruction-position injections; InjecMEM probes rejected | `npm --prefix packages/coding-agent test -- test/verified-memory-security.test.ts` | adversarial fixtures |
| Reproducibility | No memory policy | Fixed-seed, repeated-run, shuffled-order evaluation with versioned policy provenance | No single-run or default-order promotion | planned evaluation script plus tests | replayable evaluation manifest |

## Prior-Art Decision

Eight arXiv abstracts were fetched and read in isolated lanes on 2026-08-27.
The selected architecture combines:

- cognitive typing from the agent-memory survey
  ([arXiv:2602.06052](https://arxiv.org/abs/2602.06052));
- lifecycle and scope boundaries from Oracle Agent Memory
  ([arXiv:2607.13157](https://arxiv.org/abs/2607.13157));
- raw evidence pointers from HERO
  ([arXiv:2608.22310](https://arxiv.org/abs/2608.22310));
- accept/abstain/escalate admission discipline and its wild-stream transfer
  warning from AdmitOR ([arXiv:2608.15565](https://arxiv.org/abs/2608.15565));
- memory-injection threat modeling from InjecMEM
  ([arXiv:2608.23471](https://arxiv.org/abs/2608.23471)); and
- repeated-run/task-order evaluation from the self-improvement fragility study
  ([arXiv:2608.18066](https://arxiv.org/abs/2608.18066)).

EARM-style learned reranking is not selected for the first implementation:
learned estimates add a new promotion and staleness surface before basic
admission safety is proven.

## Record Contract

A future `VerifiedMemoryRecord` must contain only bounded fields:

- schema and policy version;
- opaque memory ID;
- workspace scope ID (opaque digest, never raw path);
- cognitive type: `episodic | semantic | procedural`;
- bounded statement treated as untrusted data;
- source-span references and source-content digests;
- evidence receipt or protocol `Observation` references;
- admission verdict/provenance;
- creation, freshness, expiry, and invalidation state; and
- redaction-policy identifier.

Model narration, raw prompts, credentials, host identity, and unrestricted tool
output are forbidden record fields.

## Lifecycle

```text
candidate
  -> evidence validation
  -> accept | abstain | escalate
  -> admitted
  -> retrieved as Context Budget V2 data
  -> fresh | stale | invalidated | expired
  -> revised or removed through an append-only transition
```

No state transition mutates prior evidence. Revisions append a new version and
invalidate the old one.

## Requirements

### Requirement 1 - Evidence-linked admission (Priority: P1)

1. Admit only records tied to a valid receipt or `Observation` plus source spans.
2. Execution success alone never admits memory.
3. Uncertain evidence returns `abstain`; conflicting/high-risk evidence returns
   `escalate` and requires explicit human action.
4. Missing, malformed, stale, cross-workspace, or redaction-failing evidence
   fails closed.

### Requirement 2 - Scope and staleness (Priority: P1)

1. Store under the workspace, not global user memory, in the first release.
2. Store only opaque workspace identity; never raw absolute paths.
3. Source digest changes invalidate linked records and cached relevance values.
4. Expired or invalidated records cannot enter a prompt.
5. User/agent/thread scope expansion requires a separate reviewed migration.

### Requirement 3 - Data-only retrieval (Priority: P1)

1. Inject memory only as a normal Context Budget V2 item with provenance tags.
2. Memory competes on token density and may be omitted; no bypass channel.
3. Retrieved records are delimited as untrusted data, never merged into system,
   user-authority, skill, or instruction positions.
4. Anchor-plus-command InjecMEM fixtures must be rejected or rendered inert.

### Requirement 4 - Evidence access (Priority: P1)

1. A compacted statement always retains pointers to immutable raw source spans.
2. Retrieval exposes source evidence, not only rewritten memory prose.
3. A digest detects mismatch but is not represented as proof of runner honesty.
4. Source deletion or mismatch yields stale/invalidated, not silent fallback.

### Requirement 5 - Promotion evaluation (Priority: P1)

Before implementation can become default:

1. Freeze public/synthetic task manifest, model/provider configuration, budget,
   tool permissions, seeds, run count, shuffled orders, confidence rule, and
   minimum effect.
2. Measure end-task success, evidence recall, poisoned-admission rate, latency,
   and token cost.
3. Require gains to survive repeated runs and task-order permutations.
4. Preserve every candidate/admission/retrieval policy version in the evidence
   manifest.
5. A calibration result that fails on the wild holdout blocks promotion.

## Planned Files

- `packages/coding-agent/src/core/verified-memory-types.ts`
- `packages/coding-agent/src/core/verified-memory-admission.ts`
- `packages/coding-agent/src/core/verified-memory-store.ts`
- `packages/coding-agent/src/core/verified-memory-retrieval.ts`
- `packages/coding-agent/test/verified-memory-admission.test.ts`
- `packages/coding-agent/test/verified-memory-security.test.ts`
- `packages/coding-agent/test/verified-memory-staleness.test.ts`
- `packages/coding-agent/test/verified-memory-retrieval.test.ts`
- `packages/coding-agent/docs/verified-memory.md`

## Non-Goals

- Implementing memory in this documentation cycle
- Global or cross-repository memory
- Online learned reranking or automatic policy updates
- Storing raw conversations or model chain-of-thought
- Treating retrieved memory as user or system authority
- Vendor database dependency
- Using memory outcomes as SOTA proof

## Unblock Conditions

Implementation starts only after:

1. synthetic/public evidence and InjecMEM-style fixture sets exist;
2. admission precision, sample size, confidence rule, and minimum effect are
   preregistered in an amendment;
3. storage ownership, retention, and deletion policy receive security review; and
4. Context Budget V2 data-only rendering has a negative instruction-injection test.

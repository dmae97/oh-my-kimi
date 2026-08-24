---
description: "OMK Implementation Plan template with current agent routing and evidence gates"
---

# Implementation Plan: [FEATURE]

**Branch**: `[###-feature-name]` | **Date**: [DATE] | **Spec**: [link]
**OMK Preset**: `omk`

## Summary

[One-paragraph summary of approach]

## Harness Evidence Plan

Carry every non-`not applicable` metric from the specification into an executable comparison. Preserve paired conditions; do not combine measurements produced by different methods.

| Metric | Baseline | Target | Regression floor | Command | Artifact |
| --- | --- | --- | --- | --- | --- |
| [dimension] | [version/evidence] | [measurable target] | [minimum] | `[exact command]` | `[path]` |

For `not applicable`, state the reason and remove the placeholder row.

For comparative rows, freeze before execution: named cohort and inclusion rule; immutable model/provider/configuration and environment identities; task manifest; seeds and randomized/interleaved run order; budget and stop policy; tool permissions; confidence interval, significance threshold, minimum effect, and statistical test. Apply the evidence-privacy rules in `packages/coding-agent/docs/metrics.md`.

## Runtime Inventory

- **Harness**: [Path to `.omk/runs/<runId>/chat-agent-harness.json` if present, else "not present"]
- **MCP Scope**: [project | all | none]
- **Skills**: [Relevant skill names only]
- **Authority**: The user retains final authority. The root coordinator is the default writer/merger unless the live harness delegates a narrower task within scope.

## Agent Routing

<!--
  Use roles exposed by .omk/agents/root.yaml or chat-agent-harness.json.
  Match phase names to tasks.md phases for automatic routing.
-->

| Phase | Primary Role | Secondary Roles | Evidence Gate |
|-------|--------------|-----------------|---------------|
| Bootstrap | explorer | qa | file-exists |
| Design | architect | planner | file-exists |
| Core | coder | reviewer | command-pass |
| QA | qa | reviewer | command-pass |
| Integration | reviewer | qa | command-pass |

## Project Structure

```text
src/
├── models/         # Data models (Phase 3)
├── services/       # Business logic (Phase 3)
├── routes/         # API / CLI / UI (Phase 3)
└── contracts.ts    # Types and interfaces (Phase 2)

tests/
├── unit/           # Unit tests (Phase 4)
├── integration/    # Integration tests (Phase 4)
└── contract/       # Contract tests (Phase 4)

.omk/runs/{runId}/
├── chat-agent-harness.json  # Active inventory/gates when chat agent mode is used
├── plan.md                 # This file
├── explore-summary.md      # Phase 1 output
├── security-review.md      # Phase 4 output when security review is needed
└── merge-summary.md        # Phase 5 output
```

## Complexity Check

| Concern | Decision | Rationale |
|---------|----------|-----------|
| New dependencies | [List or "none"] | [Why needed] |
| Breaking changes | [Yes/No] | [Migration plan if yes] |
| Parallel tasks | [Count] | [Which phases can run in parallel] |
| MCP/secret exposure | [None/Scoped] | [How secrets stay out of artifacts] |

## Quality Gates

- **YAML**: `npm run yaml:check` — template/config syntax
- **Lint**: `npm run lint` — static analysis
- **TypeCheck**: `npm run check` — TypeScript check
- **Secrets**: `npm run secret:scan` — no secret leakage
- **Build**: `npm run build:clean` — clean dist build
- **Tests**: `npm test` — project test harness
- **Evidence**: `omk verify --json` or run-specific evidence command when available

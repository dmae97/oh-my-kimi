# /speckit-plan

Generate `specs/[###-feature]/plan.md` from the active feature specification.

## Required inputs

Read these before planning:

- `specs/constitution.md`
- the active `spec.md`
- `packages/coding-agent/docs/metrics.md` for any harness-affecting work
- the live OMK runtime inventory when routing agents, skills, MCP, or hooks

## Harness evidence contract

Carry every non-`not applicable` harness metric into the plan. For comparative work, freeze the named cohort, model and provider configuration, task manifest, seeds and run order, budget and stop policy, tool permissions, environment identity, statistical confidence rule, regression floor, exact command, and evidence artifact before execution. Use paired, randomized or interleaved runs when temporal drift can bias results.

Do not convert feature counts, test counts, self-scores, or roadmap projections into leadership claims. Keep private benchmark inputs local and follow the evidence-privacy rules in `metrics.md`.

## Authority and output

The user retains final authority. The root coordinator is the default writer and merger unless the live harness delegates a narrower task within the user's scope. Use only capabilities exposed by the live runtime. Produce a concise plan with file ownership, dependencies, quality gates, rollback, and the completed Harness Evidence Plan table.

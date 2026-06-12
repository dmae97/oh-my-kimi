---
description: "OMK Implementation Plan template with current agent routing and evidence gates"
---

# Implementation Plan: [FEATURE]

**Branch**: `[###-feature-name]` | **Date**: [DATE] | **Spec**: [link]
**OMK Preset**: `omk`

## Summary

[One-paragraph summary of approach]

## Runtime Inventory

- **Harness**: [Path to `.omk/runs/<runId>/chat-agent-harness.json` if present, else "not present"]
- **MCP Scope**: [project | all | none]
- **Skills**: [Relevant skill names only]
- **Authority**: Kimi is final writer/merger unless harness says otherwise.
- **Safety Default**: [read-only by default | workspace-write required | shell required | merge required]
- **Approval Policy**: [ask | auto | never]
- **Sandbox**: [read-only | workspace-write]
- **Provider Policy**: [authority | kimi | codex | deepseek | auto | other concrete provider]
- **Release Evidence**: [not release-bound | exact commit + local gates + GitHub Smoke + GitHub CI]

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
| Provider health | [runtime/auth/model/quota status] | [How unavailable providers are blocked or remediated] |
| Approval/sandbox propagation | [Preserved/Not applicable] | [How adapter metadata keeps user execution policy] |
| Tool-plane diagnostics | [Required/Optional] | [MCP/skills/hooks failure handling] |
| Release evidence | [Required/Not release-bound] | [Exact commit local and GitHub gates] |

## Quality Gates

- **YAML**: `npm run yaml:check` — template/config syntax
- **Lint**: `npm run lint` — static analysis
- **TypeCheck**: `npm run check` — TypeScript check
- **Secrets**: `npm run secret:scan` — no secret leakage
- **Build**: `npm run build:clean` — clean dist build
- **Tests**: `npm test` — project test harness
- **Evidence**: `omk verify --json` or run-specific evidence command when available
- **Release**: `npm run release:check` plus GitHub Smoke Test and GitHub CI on the exact target commit when release-bound

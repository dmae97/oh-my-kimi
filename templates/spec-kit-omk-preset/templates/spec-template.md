---
description: "OMK Feature Specification template with agent-oriented requirements"
---

# Feature Specification: [FEATURE NAME]

**Feature Branch**: `[###-feature-name]`
**Created**: [DATE]
**Status**: Draft
**Input**: User description: "$ARGUMENTS"
**OMK Preset**: `omk` (DAG-optimized, parallel-agent ready)

## Agent-Oriented Requirements

<!--
  Write requirements as tasks an agent can execute.
  Each requirement should be verifiable by an evidence gate.
  Use roles exposed by .omk/agents/root.yaml or chat-agent-harness.json.
-->

## Safety, Authority, and Evidence Contract

<!--
  Required for OMK runtime/orchestration work.
  Keep these fields explicit so DAG conversion can build least-privilege AgentTask values.
-->

- **Risk**: read / write / shell / merge
- **Approval Policy**: ask / auto / never
- **Sandbox**: read-only / workspace-write
- **Provider Policy**: auto / kimi / codex / deepseek / authority
- **Resolved Authority**: [Concrete provider when Provider Policy is authority]
- **Capability Scope**: MCP servers, skills, hooks, write, patch, shell, review
- **Diagnostics**: provider health, capability mismatch, MCP parse failures, fallback reasons
- **Evidence**: command output path, run artifact path, CI/Smoke URL when available

### Requirement 1 - [Brief Title] (Priority: P1)

**Agent**: coder / architect
**Skills**: [Relevant skill names, e.g. omk-typescript-strict, omk-security-review]
**MCP**: [omk-project or specific configured server, if needed]
**Evidence Gate**: file-exists + command-pass
**Risk**: read / write / shell / merge
**Approval Policy**: ask / auto / never
**Sandbox**: read-only / workspace-write

**What**: [Describe what the agent should build]
**Verify**: [How OMK checks completion — exact command or file path]

**Acceptance**:
1. File `src/.../xxx.ts` exists and exports `yyy`
2. Running `npm test -- --match xxx` passes
3. Running `npm run lint` reports no errors in new files

---

### Requirement 2 - [Brief Title] (Priority: P2)

**Agent**: coder
**Skills**: [Relevant skill names]
**Evidence Gate**: command-pass
**Risk**: low

**What**: [Describe]
**Verify**: [How OMK checks]

---

## Expected Files

<!--
  List all files the agent is expected to create or modify.
  OMK uses these for evidence gates.
-->

- `src/[module]/[file].ts` — [purpose]
- `test/[module].test.mjs` — [test coverage]
- `docs/[feature].md` — [documentation]

## Verification Commands

<!--
  Keep commands fast, deterministic, and safe for agents.
-->

- `npm run yaml:check` — YAML/template validation
- `npm run lint` — static analysis
- `npm run check` — TypeScript check
- `npm run secret:scan` — no secret leakage
- `npm run build:clean` — clean build
- `npm test` — test harness
- `omk verify --json` — evidence summary when available
- GitHub Actions CI/Smoke URL — required for release claims

## Assumptions

- [Assumption about environment]
- [Assumption about existing code]
- [Assumption about MCP/skills scope]

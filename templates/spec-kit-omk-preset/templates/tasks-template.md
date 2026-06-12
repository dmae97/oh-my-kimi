---
description: "OMK Task list template with execution metadata for DAG conversion"
---

# Tasks: [FEATURE NAME]

**Input**: Design documents from `/specs/[###-feature-name]/`
**Prerequisites**: plan.md (required), spec.md (required)
**Output**: OMK DAG-ready task list with execution metadata

## Format

Each task MUST include OMK Execution Metadata:

```txt
- [ ] T001 [P] Description with exact file paths in `backticks`
  > role: [explorer | planner | architect | coder | reviewer | qa]
  > deps: [comma-separated task IDs, or 'none']
  > files: [`expected/file/path.ts`, `test/file.test.mjs`]
  > verify: `npm test` or `npm run check`
  > gate: [file-exists | command-pass | diff-nonempty | summary-present]
  > risk: [low | medium | high]
  > approval: [ask | auto | never]
  > sandbox: [read-only | workspace-write]
  > provider: [authority | kimi | codex | deepseek | auto | concrete provider]
  > capabilities: [read | write | shell | merge]
  > diagnostics: [none | `.omk/runs/{runId}/tool-plane.json` | provider health artifact]
  > evidence: [run artifact, CI URL, smoke URL, release log, or none]
```

### Legend
- **[P]**: Can run in parallel (different files, no dependencies)
- **role**: OMK agent role exposed by `.omk/agents/root.yaml` or `chat-agent-harness.json`
- **deps**: Explicit dependencies. OMK scheduler uses these for topological ordering.
- **files**: Expected output files. OMK evidence gate checks these after execution.
- **verify**: Command to run after task completion. OMK runs this as a command-pass gate.
- **gate**: Evidence gate type that proves task completion.
- **risk**: If high, OMK adds a D-Mail/checkpoint before this task.
- **approval**: User execution policy that must reach the runtime adapter.
- **sandbox**: Runtime sandbox boundary; read/review tasks should stay read-only.
- **provider**: Provider policy or concrete lane. `authority` must resolve before execution.
- **capabilities**: Requested runtime capabilities; do not request write/shell for read-only work.
- **diagnostics**: Artifact expected when provider health, MCP, skills, or hooks can fail.
- **evidence**: Exact proof of completion, including local gates and GitHub gates for release-bound work.

---

## Phase 1: Bootstrap

**Purpose**: Project scaffolding and agent context loading

- [ ] T001 [P] Load project context, current harness, and existing codebase structure
  > role: explorer
  > deps: none
  > files: [`.omk/runs/{runId}/explore-summary.md`]
  > verify: `test -f .omk/runs/{runId}/explore-summary.md`
  > gate: file-exists
  > risk: low
  > approval: ask
  > sandbox: read-only
  > provider: authority
  > capabilities: read
  > diagnostics: none
  > evidence: `.omk/runs/{runId}/explore-summary.md`

- [ ] T002 [P] Verify toolchain scripts and runtime scopes
  > role: qa
  > deps: none
  > files: [`.omk/runs/{runId}/toolchain-summary.md`]
  > verify: `npm run yaml:check && npm run check`
  > gate: command-pass
  > risk: low
  > approval: ask
  > sandbox: workspace-write
  > provider: authority
  > capabilities: read, shell
  > diagnostics: `.omk/runs/{runId}/toolchain-summary.md`
  > evidence: local command output

---

## Phase 2: Design & Planning

**Purpose**: Architecture decisions before any code change

- [ ] T003 Produce implementation plan with file-level breakdown
  > role: planner
  > deps: T001
  > files: [`.omk/runs/{runId}/plan.md`]
  > verify: `grep -c "## Phase" .omk/runs/{runId}/plan.md`
  > gate: file-exists
  > risk: low
  > approval: ask
  > sandbox: read-only
  > provider: authority
  > capabilities: read
  > diagnostics: none
  > evidence: `.omk/runs/{runId}/plan.md`

- [ ] T004 Define public API contracts and types
  > role: architect
  > deps: T003
  > files: [`src/contracts.ts`]
  > verify: `npm run check`
  > gate: file-exists
  > risk: medium
  > approval: ask
  > sandbox: workspace-write
  > provider: authority
  > capabilities: write
  > diagnostics: provider health artifact
  > evidence: `src/contracts.ts`

---

## Phase 3: Core Implementation

**Purpose**: Build the feature slice by slice

- [ ] T005 [P] Implement domain models and data layer
  > role: coder
  > deps: T004
  > files: [`src/models/*.ts`, `src/repositories/*.ts`]
  > verify: `npm test -- --match models`
  > gate: command-pass
  > risk: medium
  > approval: ask
  > sandbox: workspace-write
  > provider: authority
  > capabilities: write
  > diagnostics: provider health artifact
  > evidence: local test output

- [ ] T006 [P] Implement service / business logic layer
  > role: coder
  > deps: T005
  > files: [`src/services/*.ts`]
  > verify: `npm test -- --match services`
  > gate: command-pass
  > risk: medium
  > approval: ask
  > sandbox: workspace-write
  > provider: authority
  > capabilities: write
  > diagnostics: provider health artifact
  > evidence: local test output

- [ ] T007 Implement API / CLI / UI presentation layer
  > role: coder
  > deps: T006
  > files: [`src/routes/*.ts`, `src/commands/*.ts`]
  > verify: `npm run lint && npm run check`
  > gate: command-pass
  > risk: high
  > approval: ask
  > sandbox: workspace-write
  > provider: authority
  > capabilities: write
  > diagnostics: provider health artifact
  > evidence: local command output

---

## Phase 4: Quality Assurance

**Purpose**: Parallel verification pipeline

- [ ] T008 [P] Write or update regression tests for all new modules
  > role: coder
  > deps: T005, T006, T007
  > files: [`test/**/*.test.mjs`]
  > verify: `npm test -- --match [feature]`
  > gate: command-pass
  > risk: low
  > approval: ask
  > sandbox: workspace-write
  > provider: authority
  > capabilities: write
  > diagnostics: none
  > evidence: local test output

- [ ] T009 [P] Run static analysis, type checking, and secret scan
  > role: qa
  > deps: T007
  > files: []
  > verify: `npm run lint && npm run secret:scan && npm run check`
  > gate: command-pass
  > risk: low
  > approval: ask
  > sandbox: workspace-write
  > provider: authority
  > capabilities: read, shell
  > diagnostics: `.omk/runs/{runId}/tool-plane.json`
  > evidence: local command output

- [ ] T010 Review security and trust-boundary impact
  > role: reviewer
  > deps: T007
  > files: [`.omk/runs/{runId}/security-review.md`]
  > verify: `grep -Ei "risk|vuln|exposure|secret|none" .omk/runs/{runId}/security-review.md`
  > gate: file-exists
  > risk: high
  > approval: ask
  > sandbox: read-only
  > provider: deepseek
  > capabilities: read
  > diagnostics: none
  > evidence: `.omk/runs/{runId}/security-review.md`

---

## Phase 5: Integration & Delivery

**Purpose**: Merge-ready validation

- [ ] T011 Run full quality gate and evidence verification
  > role: qa
  > deps: T008, T009, T010
  > files: []
  > verify: `npm run build:clean && npm test`
  > gate: command-pass
  > risk: medium
  > approval: ask
  > sandbox: workspace-write
  > provider: authority
  > capabilities: read, shell
  > diagnostics: provider health artifact
  > evidence: local command output

- [ ] T012 Produce merge summary and evidence handoff
  > role: reviewer
  > deps: T011
  > files: [`.omk/runs/{runId}/merge-summary.md`]
  > verify: `grep -c "## Summary" .omk/runs/{runId}/merge-summary.md`
  > gate: file-exists
  > risk: low
  > approval: ask
  > sandbox: read-only
  > provider: authority
  > capabilities: read
  > diagnostics: none
  > evidence: `.omk/runs/{runId}/merge-summary.md`

- [ ] T013 [P] If release-bound, capture exact-commit release evidence
  > role: qa
  > deps: T011
  > files: [`.omk/release-evidence/{shortSha}/summary.md`]
  > verify: `npm run release:check`
  > gate: command-pass
  > risk: high
  > approval: ask
  > sandbox: workspace-write
  > provider: authority
  > capabilities: read, shell
  > diagnostics: provider health artifact
  > evidence: `npm run release:check`, GitHub Smoke Test URL, GitHub CI URL for the exact target commit

---

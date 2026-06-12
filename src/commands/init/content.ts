export const OKABE_AGENT_YAML = `version: 1
agent:
  extend: default
  name: omk-okabe-base
  # Kimi requires an explicit non-empty tools list for custom --agent-file configs.
  # Keep the full OMK native tool surface, including Agent for parallel subagents
  # and SendDMail for Okabe checkpoints; MCP/skills/hooks are injected by runtime config.
  tools:
    - "kimi_cli.tools.agent:Agent"
    - "kimi_cli.tools.ask_user:AskUserQuestion"
    - "kimi_cli.tools.todo:SetTodoList"
    - "kimi_cli.tools.shell:Shell"
    - "kimi_cli.tools.file:ReadFile"
    - "kimi_cli.tools.file:ReadMediaFile"
    - "kimi_cli.tools.file:Glob"
    - "kimi_cli.tools.file:Grep"
    - "kimi_cli.tools.file:WriteFile"
    - "kimi_cli.tools.file:StrReplaceFile"
    - "kimi_cli.tools.web:SearchWeb"
    - "kimi_cli.tools.web:FetchURL"
    - "kimi_cli.tools.plan.enter:EnterPlanMode"
    - "kimi_cli.tools.plan:ExitPlanMode"
    - "kimi_cli.tools.background:TaskList"
    - "kimi_cli.tools.background:TaskOutput"
    - "kimi_cli.tools.background:TaskStop"
    - "kimi_cli.tools.dmail:SendDMail"
  system_prompt_args:
    OMK_MCP_ENABLED: "true"
    OMK_SKILLS_ENABLED: "true"
    OMK_HOOKS_ENABLED: "true"
`;

export const ROOT_AGENT_YAML = `version: 1
agent:
  extend: ./okabe.yaml  # Inherits OMK adapter tools plus scoped MCP/skills/hooks flags
  name: omk-root
  system_prompt_path: ../prompts/root.md
  system_prompt_args:
    OMK_ROLE: "root-coordinator"
    OMK_MCP_ENABLED: "true"
    OMK_SKILLS_ENABLED: "true"
    OMK_HOOKS_ENABLED: "true"
  subagents:
    explorer:
      path: ./roles/explorer.yaml
      description: "Read-only repository exploration and context mapping with scoped MCP, skills, and hooks access when enabled by runtime scope"
    explore:
      path: ./roles/explorer.yaml
      description: "Alias for explorer; kept for compatibility with older OMK instructions"
    planner:
      path: ./roles/planner.yaml
      description: "Architecture, refactor, migration, and implementation planning with scoped MCP, skills, and hooks access when enabled by runtime scope"
    plan:
      path: ./roles/planner.yaml
      description: "Alias for planner; kept for compatibility with older OMK instructions"
    router:
      path: ./roles/router.yaml
      description: "Task routing, skill/MCP/hook fit, context budgeting, and parallel/sequential lane decisions with scoped MCP, skills, and hooks access when enabled by runtime scope"
    architect:
      path: ./roles/architect.yaml
      description: "Read-only architecture and migration design with scoped MCP, skills, and hooks access when enabled by runtime scope"
    coder:
      path: ./roles/coder.yaml
      description: "Scoped implementation in the current project with scoped MCP, skills, and hooks access when enabled by runtime scope"
    reviewer:
      path: ./roles/reviewer.yaml
      description: "Adversarial code review and risk detection with scoped MCP, skills, and hooks access when enabled by runtime scope"
    security:
      path: ./roles/security.yaml
      description: "Security, secret, permission, and trust-boundary review with scoped MCP, skills, and hooks access when enabled by runtime scope"
    qa:
      path: ./roles/qa.yaml
      description: "Run and analyze lint, typecheck, test, and build results with scoped MCP, skills, and hooks access when enabled by runtime scope"
    tester:
      path: ./roles/tester.yaml
      description: "Focused regression and edge-case testing with scoped MCP, skills, and hooks access when enabled by runtime scope"
    researcher:
      path: ./roles/researcher.yaml
      description: "Reference-backed research and external documentation checks with scoped MCP, skills, and hooks access when enabled by runtime scope"
    integrator:
      path: ./roles/integrator.yaml
      description: "Merge coordination and final synthesis with scoped MCP, skills, and hooks access when enabled by runtime scope"
    aggregator:
      path: ./roles/aggregator.yaml
      description: "Parallel-lane result aggregation with scoped MCP, skills, and hooks access when enabled by runtime scope"
    interviewer:
      path: ./roles/interviewer.yaml
      description: "Requirement clarification and acceptance criteria discovery with scoped MCP, skills, and hooks access when enabled by runtime scope"
    ontology:
      path: ./roles/ontology.yaml
      description: "Project graph memory and ontology curation with scoped MCP, skills, and hooks access when enabled by runtime scope"
    vision-debugger:
      path: ./roles/vision-debugger.yaml
      description: "Screenshot and multimodal debugging with scoped MCP, skills, and hooks access when enabled by runtime scope"
`;

export const ROLE_YAMLS: Record<string, string> = {
  interviewer: `version: 1
agent:
  extend: ../okabe.yaml  # Inherits unrestricted default Kimi tools plus MCP/skills/hooks flags
  name: omk-interviewer
  system_prompt_args:
    OMK_ROLE: "interviewer"
    OMK_MCP_ENABLED: "true"
    OMK_SKILLS_ENABLED: "true"
    OMK_HOOKS_ENABLED: "true"
  exclude_tools:
    - "kimi_cli.tools.file:WriteFile"
    - "kimi_cli.tools.file:StrReplaceFile"
    - "kimi_cli.tools.shell:Shell"
`,
  architect: `version: 1
agent:
  extend: ../okabe.yaml  # Inherits unrestricted default Kimi tools plus MCP/skills/hooks flags
  name: omk-architect
  system_prompt_args:
    OMK_ROLE: "architect"
    OMK_MCP_ENABLED: "true"
    OMK_SKILLS_ENABLED: "true"
    OMK_HOOKS_ENABLED: "true"
  exclude_tools:
    - "kimi_cli.tools.file:WriteFile"
    - "kimi_cli.tools.file:StrReplaceFile"
    - "kimi_cli.tools.shell:Shell"
`,
  planner: `version: 1
agent:
  extend: ../okabe.yaml  # Inherits unrestricted default Kimi tools plus MCP/skills/hooks flags
  name: omk-planner
  system_prompt_args:
    OMK_ROLE: "planner"
    OMK_MCP_ENABLED: "true"
    OMK_SKILLS_ENABLED: "true"
    OMK_HOOKS_ENABLED: "true"
  exclude_tools:
    - "kimi_cli.tools.file:WriteFile"
    - "kimi_cli.tools.file:StrReplaceFile"
    - "kimi_cli.tools.shell:Shell"
`,
  router: `version: 1
agent:
  extend: ../okabe.yaml  # Inherits unrestricted default Kimi tools plus MCP/skills/hooks flags
  name: omk-router
  system_prompt_args:
    OMK_ROLE: "router"
    OMK_MCP_ENABLED: "true"
    OMK_SKILLS_ENABLED: "true"
    OMK_HOOKS_ENABLED: "true"
  exclude_tools:
    - "kimi_cli.tools.file:WriteFile"
    - "kimi_cli.tools.file:StrReplaceFile"
    - "kimi_cli.tools.shell:Shell"
`,
  explorer: `version: 1
agent:
  extend: ../okabe.yaml  # Inherits unrestricted default Kimi tools plus MCP/skills/hooks flags
  name: omk-explorer
  system_prompt_args:
    OMK_ROLE: "explorer"
    OMK_MCP_ENABLED: "true"
    OMK_SKILLS_ENABLED: "true"
    OMK_HOOKS_ENABLED: "true"
  exclude_tools:
    - "kimi_cli.tools.file:WriteFile"
    - "kimi_cli.tools.file:StrReplaceFile"
    - "kimi_cli.tools.shell:Shell"
`,
  coder: `version: 1
agent:
  extend: ../okabe.yaml  # Inherits unrestricted default Kimi tools plus MCP/skills/hooks flags
  name: omk-coder
  system_prompt_args:
    OMK_ROLE: "coder"
    OMK_MCP_ENABLED: "true"
    OMK_SKILLS_ENABLED: "true"
    OMK_HOOKS_ENABLED: "true"
`,
  reviewer: `version: 1
agent:
  extend: ../okabe.yaml  # Inherits unrestricted default Kimi tools plus MCP/skills/hooks flags
  name: omk-reviewer
  system_prompt_args:
    OMK_ROLE: "reviewer"
    OMK_MCP_ENABLED: "true"
    OMK_SKILLS_ENABLED: "true"
    OMK_HOOKS_ENABLED: "true"
  exclude_tools:
    - "kimi_cli.tools.file:WriteFile"
    - "kimi_cli.tools.file:StrReplaceFile"
    - "kimi_cli.tools.shell:Shell"
`,
  security: `version: 1
agent:
  extend: ../okabe.yaml  # Inherits unrestricted default Kimi tools plus MCP/skills/hooks flags
  name: omk-security
  system_prompt_args:
    OMK_ROLE: "security"
    OMK_MCP_ENABLED: "true"
    OMK_SKILLS_ENABLED: "true"
    OMK_HOOKS_ENABLED: "true"
  exclude_tools:
    - "kimi_cli.tools.file:WriteFile"
    - "kimi_cli.tools.file:StrReplaceFile"
`,
  qa: `version: 1
agent:
  extend: ../okabe.yaml  # Inherits unrestricted default Kimi tools plus MCP/skills/hooks flags
  name: omk-qa
  system_prompt_args:
    OMK_ROLE: "qa"
    OMK_MCP_ENABLED: "true"
    OMK_SKILLS_ENABLED: "true"
    OMK_HOOKS_ENABLED: "true"
  exclude_tools:
    - "kimi_cli.tools.file:WriteFile"
    - "kimi_cli.tools.file:StrReplaceFile"
`,
  tester: `version: 1
agent:
  extend: ../okabe.yaml  # Inherits unrestricted default Kimi tools plus MCP/skills/hooks flags
  name: omk-tester
  system_prompt_args:
    OMK_ROLE: "tester"
    OMK_MCP_ENABLED: "true"
    OMK_SKILLS_ENABLED: "true"
    OMK_HOOKS_ENABLED: "true"
  exclude_tools:
    - "kimi_cli.tools.file:WriteFile"
    - "kimi_cli.tools.file:StrReplaceFile"
`,
  integrator: `version: 1
agent:
  extend: ../okabe.yaml  # Inherits unrestricted default Kimi tools plus MCP/skills/hooks flags
  name: omk-integrator
  system_prompt_args:
    OMK_ROLE: "integrator"
    OMK_MCP_ENABLED: "true"
    OMK_SKILLS_ENABLED: "true"
    OMK_HOOKS_ENABLED: "true"
  exclude_tools:
    - "kimi_cli.tools.file:WriteFile"
    - "kimi_cli.tools.file:StrReplaceFile"
    - "kimi_cli.tools.shell:Shell"
`,
  aggregator: `version: 1
agent:
  extend: ../okabe.yaml  # Inherits unrestricted default Kimi tools plus MCP/skills/hooks flags
  name: omk-aggregator
  system_prompt_args:
    OMK_ROLE: "aggregator"
    OMK_MCP_ENABLED: "true"
    OMK_SKILLS_ENABLED: "true"
    OMK_HOOKS_ENABLED: "true"
  exclude_tools:
    - "kimi_cli.tools.file:WriteFile"
    - "kimi_cli.tools.file:StrReplaceFile"
    - "kimi_cli.tools.shell:Shell"
`,
  researcher: `version: 1
agent:
  extend: ../okabe.yaml  # Inherits unrestricted default Kimi tools plus MCP/skills/hooks flags
  name: omk-researcher
  system_prompt_args:
    OMK_ROLE: "researcher"
    OMK_MCP_ENABLED: "true"
    OMK_SKILLS_ENABLED: "true"
    OMK_HOOKS_ENABLED: "true"
  exclude_tools:
    - "kimi_cli.tools.file:WriteFile"
    - "kimi_cli.tools.file:StrReplaceFile"
    - "kimi_cli.tools.shell:Shell"
`,
  ontology: `version: 1
agent:
  extend: ../okabe.yaml
  name: omk-ontology
  system_prompt_args:
    OMK_ROLE: "ontology"
    OMK_MCP_ENABLED: "true"
    OMK_SKILLS_ENABLED: "true"
    OMK_HOOKS_ENABLED: "true"
  exclude_tools:
    - "kimi_cli.tools.file:WriteFile"
    - "kimi_cli.tools.file:StrReplaceFile"
    - "kimi_cli.tools.shell:Shell"
`,
  "vision-debugger": `version: 1
agent:
  extend: ../okabe.yaml  # Inherits unrestricted default Kimi tools plus MCP/skills/hooks flags
  name: omk-vision-debugger
  system_prompt_args:
    OMK_ROLE: "vision-debugger"
    OMK_MCP_ENABLED: "true"
    OMK_SKILLS_ENABLED: "true"
    OMK_HOOKS_ENABLED: "true"
  exclude_tools:
    - "kimi_cli.tools.file:WriteFile"
    - "kimi_cli.tools.file:StrReplaceFile"
`,
};

export function getDesignMd(version: string): string {
  return `---
title: "Design System"
description: "Project visual identity and design system"
version: "${version}"
---

# DESIGN.md

## Overview

Project visual identity and design system.

## Colors

- Primary: #111827
- Accent: #7C3AED
- Success: #059669
- Warning: #D97706
- Danger: #DC2626

## Typography

- Inter, system-ui

## Rules

- Use tokens before inventing new values.
- Keep components compact and status-aware.
`;
}

export const GEMINI_MD = `# GEMINI.md

@./AGENTS.md
@./DESIGN.md

Use AGENTS.md as the canonical project instruction source, including current OMK skills, MCP, agents, and harness policy.
Use DESIGN.md as the canonical visual identity source.
Do not duplicate runtime inventories; follow AGENTS.md and \`chat-agent-harness.json\` when present.
`;

export const CLAUDE_MD = `# CLAUDE.md

@./AGENTS.md
@./DESIGN.md

Use AGENTS.md as the canonical project instruction source, including current OMK skills, MCP, agents, and harness policy.
Use DESIGN.md for UI/frontend work.
Do not duplicate runtime inventories; follow AGENTS.md and \`chat-agent-harness.json\` when present.
`;

export const ROADMAP_MD = `# Roadmap

Current source version: v1.1.18
Last updated: 2026-05-24

## Current runtime stance

OMK is the root orchestrator. Kimi is the default authority-capable provider adapter, not the whole runtime. Codex, DeepSeek, OpenCode, CommandCode, OpenRouter, Qwen, Gemini, and Claude run as adapter lanes only when provider health, capability, approval, sandbox, and harness policy match the task.

- \`omk run\`, \`omk parallel\`, chat harnesses, and DAG replay expose provider routing and evidence-gated lanes.
- \`omk provider\` / \`omk deepseek\` manage provider enablement, key setup, availability checks, and fallback readiness.
- DeepSeek is read/review/advisory by default; it must not receive write/shell authority from native chat defaults.
- The resolved authority provider remains the writer, merger, and final synthesis lane for write/shell/merge work.
- \`omk graph view\` generates an HTML view from local graph memory.
- \`omk goal\` has a persisted lifecycle, continue loop, generated plan/evidence criteria, and verification flow.

## v1.2 — Hardening the current surface

### P0: native runtime safety hardening

- Remaining: native chat turn capabilities must be intent-based: read-only by default, write only for edits, shell only for explicit command/build/test work, merge only for merge/release operations.
- Remaining: \`--execution ask|auto|never\` and sandbox mode must propagate into runtime adapter metadata; provider adapters must not silently collapse ask into never.
- Remaining: \`authority\`, \`primary\`, and \`omk\` provider policy must resolve to a concrete provider before bootstrap/router execution.
- Remaining: CLI provider bootstrap must distinguish runtime/binary availability from auth/model/quota readiness.
- Remaining: MCP, skills, hooks, and tool-plane parse or resolution failures must surface as diagnostics; runtime-required MCP failures should hard fail.

### P0: release and contract gates

- Done: YAML validation now runs in local \`verify\` plus CI/smoke workflows.
- Done: package dry-pack, package audit, tarball smoke, native safety build, and release matrix gates were re-verified against v1.1.17 artifacts.
- Done: provider/deepseek and screenshot JSON command contracts gained hermetic regression tests.
- Done: current AGENTS/init templates and packaged workflow skills were aligned with the active skills/MCP/agents/harness surface, including all generated agent MCP/skills/hooks flags and parallel subagent orchestration guidance.
- Remaining: lock broader provider fallback metadata with tests for rate limit, timeout, and authority fallback variants.
- Remaining: define minimum machine-readable CLI envelopes for the rest of the automation-critical commands.
- Remaining: release/tag only after local gates, native safety packaging, package audit, smoke-pack, tarball install smoke, GitHub Smoke Test, and GitHub CI pass on the exact target commit.

### P1: observability and diagnostics

- Done: provider route/fallback counts are now emitted in run summaries/reports and summary terminal output.
- Done: invalid MCP JSON is reported as a visible diagnostic without leaking secret-like config values.
- Done: \`omk mcp doctor --json\` exposes structured server status, command resolution, timeout, permission, and config-source fields.
- Expand JSON output for graph, DAG, summary, and workflow commands where CI or agents consume results.
- Link graph nodes back to runs, goals, providers, and evidence so \`omk graph view\` becomes audit evidence, not only visualization.

### P2: execution depth and planner quality

- Deepen \`omk team\` runtime reporting: worker state, pane/session health, artifacts, and verification handoff.
- Done: replace the \`omk goal plan\` stub with a planner that emits steps, acceptance criteria, risks, and evidence gates.
- Add provider-quality gates before broader non-primary-provider worker pools.
- Keep primary-provider execution as the safe fallback path for every run.

## Later tracks

### Provider routing maturity

- Keep the resolved authority provider as the writer, merger, and final synthesis runtime.
- Use provider hints for explorer, reviewer, QA, planner, and documentation roles only when preflight is healthy and task risk is low.
- Record provider attempts, route confidence, fallback reason, and final authority in run evidence.

### Graph and memory maturity

- Materialize provider routes, fallback events, goals, evidence gates, and run artifacts in the local graph/Kuzu ontology.
- Keep \`omk graph view\` local-first and safe for private repositories.

### Historical milestones

| Version | Focus |
|---------|-------|
| v0.1 | init / doctor / chat, P0 skills, AGENTS.md / DESIGN.md generation, quality gate hooks |
| v0.2 | wire controller, HUD, run state, worker logs |
| v0.3 | worktree team, merge queue, reviewer / QA / integrator agents |
| v0.4 | Google DESIGN.md integration, Stitch skills installer, screenshot UI review, Spec Kit planning + DAG execution, agent registry, project index, run summary |
| v0.5 | MCP project server, plugin pack, CI agent mode |
| v1.1.6 | provider/deepseek commands, provider policy flags, graph view, goal lifecycle, expanded run history and update JSON |
| v1.1.9 | chat harness manifest, capability DAG lanes, Rust native safety loader, Windows clipboard screenshot bridge, release native matrix |
| v1.1.12 | Replay system, skill assigner, decision trace coverage, evidence gates, and repair policy |
| v1.1.13 | Bundled MCP server entrypoints, ACP/host transport groundwork, deployment-ready package metadata |
| v1.1.14 | Current harness docs, external-inspired workflow skills, and release-safe public wording |
| v1.1.15 | Isolated HOME MCP shell-profile hotfix and persistent fetch MCP entrypoint |
| v1.1.16 | Deterministic IntentFrame/ActionAtom orchestration, chat schema preflight, MCP duplicate policy, agent capability propagation, and doctor/init/pack smoke fixes |
| v1.1.17 | Full generated-agent MCP/skills/hooks enablement, parallel subagent orchestration emphasis, and v1.1.17 release docs |
`;

export const SECURITY_MD = `# Security Policy

## Reporting Vulnerabilities

Please report security issues via GitHub Issues with the \`security\` label.

## Built-in Protections

open_multi-agent_kit includes scoped default hooks to block destructive commands and secret leakage when the active runtime/harness enables them.

## Native Runtime Safety Gates

- Native chat turns should be read-only by default; write, shell, and merge capabilities must be requested only when task intent requires them.
- \`--execution ask|auto|never\` and sandbox policy must propagate through routing into runtime adapters.
- \`authority\`, \`primary\`, and \`omk\` provider policies must resolve to a concrete provider before execution.
- DeepSeek and other advisory providers are read/review/advisory by default and must not silently receive write/shell authority.
- Provider bootstrap must distinguish binary/runtime availability from auth, model, and quota readiness.
- Provider failure previews must be gated behind debug mode and redacted before terminal or artifact output.
- MCP, skills, hooks, and tool-plane parse/resolution failures must surface as diagnostics; runtime-required MCP failures should block execution.

## MCP and Harness Secret Handling

- Fresh init writes project-local \`omk-project\` MCP only; user/global MCP and skills are runtime-only unless explicitly imported by a trusted local user.
- Never print, commit, or summarize MCP \`env\`, headers, tokens, or provider keys.
- Treat \`chat-agent-harness.json\` as private run metadata: use it for inventory/gates, but do not paste large inventories or secret-like values into prompts, memory, or reports.
- Prefer sanitized \`omk mcp doctor --json\`, \`omk verify --json\`, test summaries, and secret scans as shareable evidence.

## Child Runtime Isolation

OMK currently provides environment hardening for child runtimes.

By default, child runtimes do not inherit the full parent process environment.
OMK passes an allowlisted environment and drops common secret-bearing variables
such as cloud provider credentials, GitHub/NPM tokens, SSH agent sockets,
Kubernetes config, and dotenv/env-file references.

This is not a full OS-level sandbox. Filesystem, process, and network isolation
are future hardening work and must not be assumed unless explicitly provided by
the selected runtime or host environment.

Current security claims:

- OMK prevents ambient secret leakage into child runtimes by default.
- OMK sanitizes child runtime environments.
- OMK routes tasks according to declared runtime capabilities.
- OMK forces approval for write-capable Codex workspace runs.
- OMK exposes sandbox intent/profile metadata for future enforcement.

Non-claims:

- OMK does not fully sandbox child CLIs.
- OMK does not prevent all filesystem access outside the workspace.
- OMK does not prevent network exfiltration.
- OMK does not enforce OS-level process isolation.

## Best Practices

- Review hooks before running in production repositories.
- Use \`--print\` mode only in disposable worktrees.
- Never commit secrets into agent memory files.
`;

export const ROOT_PROMPT_MD = `# open_multi-agent_kit Root Agent

You are the OMK root orchestrator for open_multi-agent_kit — a provider-neutral orchestration layer that turns OMK into a bounded coding team.

You must operate as a provider-neutral OMK coding orchestrator with scoped MCP, skills, and hooks enabled for every generated root/role agent when the active runtime scope allows them.

## Loaded Project Instructions

\${KIMI_AGENTS_MD}

## Loaded Skills

\${KIMI_SKILLS}

## Global Rules

- Apply AGENTS.md silently.
- Do not repeat boilerplate.
- Use SetTodoList for multi-step tasks.
- Use Agent tool for non-trivial tasks. All 15 role agents (explorer, planner, router, architect, coder, reviewer, security, qa, tester, researcher, integrator, aggregator, interviewer, ontology, vision-debugger) are available with MCP, skills, and hooks capability flags.
- Use skills when relevant.
- Use MCP tools when configured and useful. All subagents inherit scoped MCP server inventory, skills, and hooks when enabled by runtime scope. Do not hesitate to invoke available capabilities.
- Treat project-local ontology graph memory as mandatory when the omk-project MCP exposes memory tools.
- Recall relevant project memory before work, write durable findings through omk_write_memory, and use omk_memory_mindmap/omk_graph_query for graph recall.
- Prefer plan-first execution.
- Prefer small, reviewable diffs.
- Verify before completion.
- Never claim tests passed unless they were run.

## Active Harness and Resource Inventory

- If a run contains chat-agent-harness.json, read it for the full MCP/skills/hooks inventory, virtual DAG, authority boundaries, worker limits, and gate list.
- Treat compact prompt resource counts as summaries only.
- Default runtime scope is project MCP/skills; all-scope may read user ~/.kimi resources at runtime without copying personal files.
- Do not paste huge global MCP/skill inventories or secret-bearing env/header values into prompts, memory, or final reports.

## OMK Context Tools

- Root and generated role agents inherit an Okabe-compatible base while OMK scopes MCP, skills, and hooks per active runtime/harness policy.
- Use D-Mail before risky refactors, compaction, or long-running branch points: send a concise future-facing recovery note to the relevant checkpoint.
- Use OMK-managed subagents for isolated context and parallel work; keep the root context focused on decisions, integration, and verification.
- Prefer /compact or a D-Mail recovery note over dumping large history back into the prompt.

## Required Workflow

For non-trivial tasks:

1. Read project instructions.
2. Create todos.
3. Launch appropriate subagents in parallel when their scopes are independent:
   - explorer for repository discovery
   - planner for architecture/refactor/risky work
   - coder for implementation
   - reviewer or qa for review and gate analysis
   - security for secret/permission/trust-boundary review
   - ontology for graph memory and project knowledge curation
4. Read relevant skills.
5. Use MCP if useful.
6. Implement minimal changes.
7. Run quality gates.
8. Review final diff.
9. Return factual final report.

## Final Report Format

\`\`\`txt
Changed:
Files:
Commands:
Result:
Risk:
\`\`\`
`;

export const HOOK_SCRIPTS: Record<string, string> = {
  "session-context.sh": `#!/usr/bin/env bash
# OMK SessionStart Context — keeps high-value local workflows visible
set -euo pipefail

if ! command -v node &>/dev/null; then
  echo '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"OMK session started. Read project rules, use graph-view for memory relationships, use open-design for localhost design, and verify before final."}}'
  exit 0
fi

node <<'NODE'
const context = [
  'OMK session startup context.',
  '- Read AGENTS.md and .kimi/AGENTS.md before edits; read DESIGN.md before UI/frontend/visual work.',
  '- For local design iteration, use /open-design or omk design open-design --open to launch localhost.',
  '- For memory/risk/file relationships, use /graph-view or omk graph view --open before broad repo edits.',
  '- Treat release, push, publish, and deployment as not done unless the exact command ran and fresh evidence was collected.',
  '- Final reports should list changed files, commands run, pass/fail/not-run status, and remaining risk.',
].join('\\n');

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: context,
  },
}) + '\\n');
NODE
`,
  "awesome-agent-skills-router.sh": `#!/usr/bin/env bash
# Awesome Agent Skills Router — curated OMK hints from VoltAgent/awesome-agent-skills
set -euo pipefail

# This hook is advisory only: no network access, no third-party skill install,
# and no prompt blocking. It maps common awesome-agent-skills domains to the
# already-installed OMK skills/workflows that are safe to consider.
if ! command -v node &>/dev/null; then
  exit 0
fi

INPUT_FILE="$(mktemp)"
trap 'rm -f "$INPUT_FILE"' EXIT
cat > "$INPUT_FILE"

node - "$INPUT_FILE" <<'NODE'
const fs = require('node:fs');
// Static slash markers for non-shell smoke validation:
// /open-design /awesome-design-md /omk-design-md /omk-quality-gate /graph-view /omk-kimi-runtime

function readPayload(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function textFrom(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(textFrom).filter(Boolean).join('\\n');
  }
  if (value && typeof value === 'object') {
    for (const key of ['prompt', 'user_prompt', 'message', 'input', 'text', 'content', 'command_args']) {
      const found = textFrom(value[key]);
      if (found) return found;
    }
  }
  return '';
}

const payload = readPayload(process.argv[2]);
const prompt = textFrom(payload.prompt)
  || textFrom(payload.user_prompt)
  || textFrom(payload.message)
  || textFrom(payload.input)
  || textFrom(payload.command_args)
  || textFrom(payload.tool_input)
  || textFrom(payload);

const normalized = prompt.toLowerCase();
if (normalized.trim().length < 3) {
  process.exit(0);
}

const routes = [
  {
    id: 'design-ui',
    patterns: [
      'design', 'ui', 'ux', 'frontend', 'front-end', 'figma', 'stitch', 'open-design',
      'prototype', 'landing', 'component', 'visual', 'screenshot', 'responsive', 'accessibility',
      'react', 'next.js', 'vite', 'expo', 'react native',
      '디자인', '화면', '프론트', '랜딩', '컴포넌트', '시각', '스크린샷', '반응형', '접근성', '프로토타입',
    ],
    skills: ['open-design', 'awesome-design-md', 'omk-design-md', 'omk-flow-design-to-code', 'omk-multimodal-ui-review', 'react-doctor'],
    note: 'For visual work, read DESIGN.md, reuse tokens, use awesome-design-md references when a named style is requested, and launch localhost with omk design open-design when interactive design is useful.',
  },
  {
    id: 'bugfix-debug',
    patterns: [
      'bug', 'error', 'failed', 'failure', 'traceback', 'exception', 'fix', 'regression', 'broken', 'debug',
      '버그', '에러', '오류', '실패', '고쳐', '수정', '안됨', '안돼', '문제', '디버그',
    ],
    skills: ['omk-flow-bugfix', 'andrej-karpathy-skills', 'matt-pocock-skills', 'omk-quality-gate'],
    note: 'For failures, isolate root cause first, keep the patch small, and rerun the failing command plus the quality gate.',
  },
  {
    id: 'feature-build',
    patterns: [
      'implement', 'build', 'add ', 'create', 'scaffold', 'generate', 'feature', 'new command',
      '구현', '추가', '만들', '생성', '기능', '신규',
    ],
    skills: ['omk-plan-first', 'omk-flow-feature-dev', 'matt-pocock-skills', 'andrej-karpathy-skills', 'omk-quality-gate'],
    note: 'For new capability work, plan the smallest reversible diff and include regression coverage before completion.',
  },
  {
    id: 'review-security',
    patterns: [
      'review', 'audit', 'security', 'vulnerability', 'secret', 'token', 'auth', 'permission', 'xss', 'sql injection', 'ssrf',
      '리뷰', '검토', '보안', '취약', '시크릿', '토큰', '인증', '권한',
    ],
    skills: ['omk-code-review', 'omk-quality-gate'],
    note: 'For security-sensitive work, do not print secrets, review trust boundaries, and run the project secret scan when available.',
  },
  {
    id: 'release-git',
    patterns: [
      'release', 'publish', 'npm', 'version', 'changelog', 'commit', 'pull request', ' pr ', 'pr로', 'push', 'tag',
      '배포', '릴리즈', '버전', '변경로그', '커밋', '푸시',
    ],
    skills: ['omk-flow-release', 'omk-flow-pr-review', 'omk-quality-gate'],
    note: 'For release or PR work, verify build/test/package evidence before reporting publish or PR readiness.',
  },
  {
    id: 'spec-planning',
    patterns: [
      'spec', 'prd', 'requirements', 'acceptance', 'tasks', 'speckit', 'plan', 'architecture',
      '명세', '요구사항', '수락기준', '계획', '아키텍처',
    ],
    skills: ['omk-plan-first', 'speckit-specify', 'speckit-plan', 'speckit-tasks'],
    note: 'For specification work, produce acceptance criteria and a test shape before implementation.',
  },
  {
    id: 'refactor-cleanup',
    patterns: [
      'refactor', 'cleanup', 'simplify', 'deslop', 'debt', 'migration',
      '리팩토', '정리', '단순화', '마이그레이션',
    ],
    skills: ['omk-flow-refactor', 'andrej-karpathy-skills', 'matt-pocock-skills', 'omk-quality-gate'],
    note: 'For refactors, preserve behavior with tests first and avoid unrelated rewrites.',
  },
  {
    id: 'ontology-graph',
    patterns: [
      'ontology', 'graph', 'graph-view', 'node', 'nodes', 'edge', 'edges', 'relationship',
      'memory graph', 'risk map', 'decision graph', 'trace map',
      '온톨로지', '그래프', '노드', '엣지', '관계', '메모리 그래프', '리스크맵', '결정 그래프',
    ],
    skills: ['graph-view', 'omk-kimi-runtime', 'omk-quality-gate'],
    note: 'For graph or memory-relationship work, inspect .omk/memory/graph-state.json with omk graph view --open or /graph-view before changing code.',
  },
  {
    id: 'agent-orchestration',
    patterns: [
      'agent', 'subagent', 'multi-agent', 'orchestration', 'workflow', 'mcp', 'hook', 'hooks', 'skill', 'skills', 'memory',
      '에이전트', '서브에이전트', '워크플로', '훅', '스킬', '메모리',
    ],
    skills: ['omk-task-router', 'omk-project-rules', 'omk-kimi-runtime', 'omk-flow-team-run', 'agentmemory', 'multica', 'andrej-karpathy-skills'],
    note: 'For agent or hook work, keep routing advisory, avoid installing unreviewed external skills, and verify generated config locally.',
  },
  {
    id: 'tests-quality',
    patterns: [
      'test', 'tests', 'qa', 'quality', 'lint', 'typecheck', 'playwright', 'e2e', 'coverage',
      '테스트', '검증', '품질', '타입체크', '커버리지',
    ],
    skills: ['omk-quality-gate'],
    note: 'For validation requests, run the actual project scripts and report exact pass/fail evidence.',
  },
  {
    id: 'docs-research',
    patterns: [
      'docs', 'documentation', 'readme', 'research', 'verify', 'official docs', 'look up',
      '문서', '조사', '검증', '검색', '찾아',
    ],
    skills: ['omk-plan-first', 'omk-quality-gate'],
    note: 'For docs or external references, prefer official/current sources and cite or record what was verified.',
  },
];

const matched = routes.filter((route) => route.patterns.some((pattern) => normalized.includes(pattern)));
if (matched.length === 0) {
  process.exit(0);
}

const skills = [];
for (const route of matched) {
  for (const skill of route.skills) {
    if (!skills.includes(skill)) skills.push(skill);
  }
}

if (!skills.includes('omk-quality-gate')) {
  skills.push('omk-quality-gate');
}

const context = [
  'OMK awesome-agent-skills routing hint (curated from VoltAgent/awesome-agent-skills; advisory only).',
  'Matched domains: ' + matched.map((route) => route.id).join(', '),
  'Prefer installed OMK skills/workflows: ' + skills.map((skill) => '/' + skill).join(', '),
  'Do not auto-install third-party skills from awesome-agent-skills. Review source, license, and security before adoption.',
  ...matched.slice(0, 4).map((route) => route.note),
].join('\\n');

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext: context,
  },
}) + '\\n');
NODE
`,
  "precompact-checkpoint.sh": `#!/usr/bin/env bash
# OMK PreCompact Checkpoint — compact without losing recovery state
set -euo pipefail

if ! command -v node &>/dev/null; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreCompact","additionalContext":"Before compaction: record goal, changed files, verification state, blockers, and next action. Never store secrets."}}'
  exit 0
fi

node <<'NODE'
const context = [
  'OMK pre-compaction checkpoint.',
  '- Preserve current goal, changed files, verification state, blockers, and intended next action.',
  '- If available, write concise notes to .omx/notepad.md or project-local memory; never store secrets.',
  '- After compaction, refresh from the checkpoint before editing or claiming completion.',
].join('\\n');

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreCompact',
    additionalContext: context,
  },
}) + '\\n');
NODE
`,
  "subagent-stop-audit.sh": `#!/usr/bin/env bash
# OMK SubagentStop Audit — leader must verify delegated work
set -euo pipefail

if ! command -v node &>/dev/null; then
  echo '{"hookSpecificOutput":{"hookEventName":"SubagentStop","additionalContext":"Subagent finished. Leader must review changed files, integrate results, and run relevant quality gates before final."}}'
  exit 0
fi

node <<'NODE'
const context = [
  'OMK subagent completion audit.',
  '- Do not claim success from a subagent report alone.',
  '- Review the concrete files changed, reconcile conflicts, and keep unrelated user edits intact.',
  '- Run the relevant quality gates locally and report pass/fail/not-run evidence.',
].join('\\n');

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SubagentStop',
    additionalContext: context,
  },
}) + '\\n');
NODE
`,
  "branch-diff-snapshot.sh": `#!/usr/bin/env bash
# OMK Branch Diff Snapshot — records merge-review metadata without full diff contents
set +e

SNAP_DIR=".omk/runs/_branch-snapshots"
mkdir -p "$SNAP_DIR" >/dev/null 2>&1

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo '{"hookSpecificOutput":{"hookEventName":"SubagentStop","additionalContext":"Branch diff snapshot skipped: not inside a git worktree."}}'
  exit 0
fi

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
commit="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
safe_branch="$(printf '%s' "$branch" | tr -c 'A-Za-z0-9._-' '-')"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
snapshot="$SNAP_DIR/$stamp-$safe_branch.md"

{
  echo "# OMK branch diff snapshot"
  echo
  echo "- branch: $branch"
  echo "- commit: $commit"
  echo "- captured_at: $stamp"
  echo
  echo "## Status"
  git status --short 2>/dev/null || true
  echo
  echo "## Diff stat"
  git diff --stat 2>/dev/null || true
  echo
  echo "## Changed files"
  git diff --name-only 2>/dev/null || true
} > "$snapshot"

printf '{"hookSpecificOutput":{"hookEventName":"SubagentStop","additionalContext":"Branch diff snapshot saved: %s"}}\\n' "$snapshot"
`,
  "pre-shell-guard.sh": `#!/usr/bin/env bash
# PreShellUse Guard — blocks dangerous commands
set -e

# Close security gate if jq/python3 is missing (deny by default)
if command -v python3 &>/dev/null; then
  PY=python3
elif command -v python &>/dev/null; then
  PY=python
else
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"python3 not installed — pre-shell-guard cannot validate commands"}}'
  exit 0
fi

INPUT=$(cat)
DESTRUCTIVE_DECISION=$(INPUT_JSON="$INPUT" "$PY" <<'PY'
import json
import os
import posixpath
import shlex

def decision(reason):
    print(json.dumps({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":reason}}, separators=(",", ":")))

def as_tokens(value):
    if isinstance(value, list):
        return [str(item) for item in value]
    if isinstance(value, str) and value.strip():
        return shlex.split(value, comments=True, posix=True)
    return []

def expand_shell_wrappers(root_tokens):
    result = []
    queue = [root_tokens]
    while queue and len(result) < 8:
        current = queue.pop(0)
        result.append(current)
        for idx, token in enumerate(current):
            if posixpath.basename(token) not in {"bash", "sh", "zsh", "dash"}:
                continue
            j = idx + 1
            while j < len(current):
                opt = current[j]
                if opt == "--":
                    j += 1
                    break
                if opt in {"-c", "-lc"} or (opt.startswith("-") and not opt.startswith("--") and "c" in opt):
                    if j + 1 < len(current):
                        queue.append(as_tokens(current[j + 1]))
                    break
                if opt.startswith("-"):
                    j += 1
                    continue
                break
    return result

def flag_letters(token):
    if token.startswith("--"):
        return set()
    if token.startswith("-"):
        return set(token[1:])
    return set()

def has_rm_rf(tokens, index):
    letters = set()
    for token in tokens[index + 1:]:
        letters.update(flag_letters(token))
        if not token.startswith("-"):
            break
    return "r" in letters and "f" in letters

def has_git_clean_danger(tokens, index):
    rest = tokens[index + 1:]
    if "clean" not in rest:
        return False
    clean_index = rest.index("clean") + index + 1
    letters = set()
    for token in tokens[clean_index + 1:]:
        letters.update(flag_letters(token))
    return {"f", "d", "x"}.issubset(letters)

def has_pipe_to_shell(tokens):
    shell_names = {"bash", "sh", "zsh", "dash"}
    downloaders = {"curl", "wget"}
    for idx, token in enumerate(tokens):
        if token != "|":
            continue
        left = {posixpath.basename(item) for item in tokens[:idx]}
        right = {posixpath.basename(item) for item in tokens[idx + 1:]}
        if left & downloaders and right & shell_names:
            return True
    return False

def is_destructive(tokens):
    normalized = [str(token) for token in tokens]
    for idx, token in enumerate(normalized):
        exe = posixpath.basename(token)
        if exe == "sudo":
            return True
        if exe == "rm" and has_rm_rf(normalized, idx):
            return True
        if exe == "git" and has_git_clean_danger(normalized, idx):
            return True
        if exe == "chmod" and "-R" in normalized[idx + 1:] and "777" in normalized[idx + 1:]:
            return True
        if exe == "docker" and normalized[idx + 1:idx + 3] == ["system", "prune"]:
            return True
        if exe == "kubectl" and "delete" in normalized[idx + 1:]:
            return True
        if exe == "aws" and normalized[idx + 1:idx + 4] == ["s3", "rm", "--recursive"]:
            return True
        if exe.startswith("mkfs") or any(arg.startswith("if=") for arg in normalized[idx + 1:] if exe == "dd"):
            return True
    return has_pipe_to_shell(normalized)

try:
    data = json.loads(os.environ.get("INPUT_JSON", "{}"))
    tool_input = data.get("tool_input", {})
    tokens = as_tokens(tool_input.get("command", "")) + as_tokens(tool_input.get("args", ""))
    for expanded in expand_shell_wrappers(tokens):
        if is_destructive(expanded):
            decision("Potentially destructive command blocked by pre-shell-guard")
            break
except Exception as exc:
    decision("Unable to parse destructive command safely: " + str(exc))
PY
)
if [ -n "$DESTRUCTIVE_DECISION" ]; then
  echo "$DESTRUCTIVE_DECISION"
  exit 0
fi
COMMAND=$(echo "$INPUT" | $PY -c 'import sys,json; d=json.load(sys.stdin); print(d.get("tool_input",{}).get("command",""))')
ARGS=$(echo "$INPUT" | $PY -c 'import sys,json; d=json.load(sys.stdin); print(d.get("tool_input",{}).get("args",""))')

FULL="$COMMAND $ARGS"

# Block list
BLOCKED=(
  "rm -rf /"
  "rm -rf ~"
  "sudo"
  "git push --force"
  "git push -f"
  "git clean -fdx"
  "chmod -R 777"
  "docker system prune"
  "kubectl delete"
  "aws s3 rm --recursive"
  "curl | bash"
  "curl | sh"
  "wget | bash"
  "wget | sh"
  "mkfs"
  "dd if="
  "> /dev/"
  ":(){ :|:& };:"
)

for pattern in "\${BLOCKED[@]}"; do
  if [[ "$FULL" == *"$pattern"* ]]; then
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Potentially destructive command blocked by pre-shell-guard"}}'
    exit 0
  fi
done

# Release/deploy guard. These commands are not destructive like rm -rf, but
# they can publish external state. Parse tokens so common option/shell-wrapper
# variants cannot bypass the guard.
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
INPUT_JSON="$INPUT" SCRIPT_DIR="$SCRIPT_DIR" "$PY" <<'PY'
import json
import os
import posixpath
import shlex
import sys

def respond(permission, reason=None):
    payload = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": permission}}
    if reason:
        payload["hookSpecificOutput"]["permissionDecisionReason"] = reason
    print(json.dumps(payload, separators=(",", ":")))
    sys.exit(0)

def as_tokens(value):
    if isinstance(value, list):
        return [str(item) for item in value]
    if isinstance(value, str) and value.strip():
        return shlex.split(value, comments=True, posix=True)
    return []

def expand_shell_wrappers(root_tokens):
    result = []
    queue = [root_tokens]
    while queue and len(result) < 8:
        current = queue.pop(0)
        result.append(current)
        for idx, token in enumerate(current):
            if posixpath.basename(token) not in {"bash", "sh", "zsh", "dash"}:
                continue
            j = idx + 1
            while j < len(current):
                opt = current[j]
                if opt == "--":
                    j += 1
                    break
                if opt in {"-c", "-lc"} or (opt.startswith("-") and not opt.startswith("--") and "c" in opt):
                    if j + 1 < len(current):
                        try:
                            queue.append(as_tokens(current[j + 1]))
                        except ValueError as exc:
                            respond("deny", f"Unable to parse shell-wrapped release/deploy command safely: {exc}")
                    break
                if opt.startswith("-"):
                    j += 1
                    continue
                break
    return result

def skip_flags(tokens, index):
    value_flags = {
        "-C", "-c", "--config-env", "--git-dir", "--work-tree", "--namespace",
        "--registry", "--userconfig", "--prefix", "--cache", "--filter", "--workspace",
        "--cwd", "--repo", "-R", "--ref", "--field", "-f", "--json", "--jq",
    }
    i = index
    while i < len(tokens):
        token = tokens[i]
        if token == "--":
            return i + 1
        if token in value_flags and i + 1 < len(tokens):
            i += 2
            continue
        if any(token.startswith(prefix + "=") for prefix in value_flags if prefix.startswith("--")):
            i += 1
            continue
        if token.startswith("-"):
            i += 1
            continue
        return i
    return i

def has_token_after(tokens, index, wanted):
    return any(token in wanted for token in tokens[index:])

def is_release_command(tokens):
    i = 0
    while i < len(tokens):
        exe = posixpath.basename(tokens[i])
        if exe == "git":
            command_index = skip_flags(tokens, i + 1)
            if command_index < len(tokens) and tokens[command_index] == "push":
                return True
            i = max(command_index + 1, i + 1)
            continue
        if exe == "npm":
            command_index = skip_flags(tokens, i + 1)
            if command_index < len(tokens) and tokens[command_index] in {"publish", "version"}:
                return True
            if has_token_after(tokens, i + 1, {"publish", "version"}):
                return True
            i += 1
            continue
        if exe == "pnpm":
            if has_token_after(tokens, i + 1, {"publish"}):
                return True
            i += 1
            continue
        if exe == "yarn":
            rest = tokens[i + 1:]
            if "publish" in rest:
                return True
            if len(rest) >= 2 and rest[0] == "npm" and rest[1] == "publish":
                return True
            i += 1
            continue
        if exe == "gh":
            command_index = skip_flags(tokens, i + 1)
            if command_index + 1 < len(tokens):
                pair = (tokens[command_index], tokens[command_index + 1])
                if pair in {("release", "create"), ("workflow", "run")}:
                    return True
            i += 1
            continue
        i += 1
    return False

try:
    data = json.loads(os.environ.get("INPUT_JSON", "{}"))
    tool_input = data.get("tool_input", {})
    tokens = as_tokens(tool_input.get("command", "")) + as_tokens(tool_input.get("args", ""))
except Exception as exc:
    respond("deny", f"Unable to parse release/deploy command safely: {exc}")

if os.environ.get("OMK_ALLOW_RELEASE") == "1":
    respond("allow")

# File-based override for environments where env vars don't propagate to hooks
allow_release_path = os.path.join(os.environ.get("SCRIPT_DIR", ""), ".allow-release")
if os.path.exists(allow_release_path):
    respond("allow")

for expanded in expand_shell_wrappers(tokens):
    if is_release_command(expanded):
        respond("deny", "Release/deploy command blocked by OMK release guard. Re-run with OMK_ALLOW_RELEASE=1 only after an explicit user request and fresh verification evidence.")

respond("allow")
PY
`,
  "worktree-create-guard.sh": `#!/usr/bin/env bash
# OMK Worktree Create Guard — keeps worker lanes under .omk/worktrees by default
set -e

if command -v python3 &>/dev/null; then
  PY=python3
elif command -v python &>/dev/null; then
  PY=python
else
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"python3 not installed — worktree-create-guard cannot validate commands"}}'
  exit 0
fi

INPUT=$(cat)
INPUT_JSON="$INPUT" "$PY" <<'PY'
import json
import os
import posixpath
import shlex
import sys

def respond(permission, reason=None):
    payload = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": permission}}
    if reason:
        payload["hookSpecificOutput"]["permissionDecisionReason"] = reason
    print(json.dumps(payload, separators=(",", ":")))
    sys.exit(0)

def as_tokens(value):
    if isinstance(value, list):
        return [str(item) for item in value]
    if isinstance(value, str) and value.strip():
        return shlex.split(value, comments=True, posix=True)
    return []

try:
    data = json.loads(os.environ.get("INPUT_JSON", "{}"))
except Exception:
    respond("allow")

tool_input = data.get("tool_input", {})
raw_full = f"{tool_input.get('command', '')} {tool_input.get('args', '')}"
try:
    initial_tokens = as_tokens(tool_input.get("command", "")) + as_tokens(tool_input.get("args", ""))
except ValueError as exc:
    if "git" in raw_full and "worktree" in raw_full:
        respond("deny", f"Unable to parse git worktree command safely: {exc}")
    respond("allow")

def canonical_path(path):
    return os.path.realpath(os.path.abspath(path))

def resolve_path(path_arg, base_dir):
    return canonical_path(path_arg if os.path.isabs(path_arg) else os.path.join(base_dir, path_arg))

project_root = canonical_path(os.environ.get("OMK_PROJECT_ROOT") or os.getcwd())
allowed_root = canonical_path(os.path.join(project_root, ".omk", "worktrees"))
options_with_values = {
    "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env",
    "-b", "-B", "--reason", "--lock", "--orphan",
}

def path_within_allowed(path_arg, base_dir):
    base = canonical_path(base_dir)
    actual = resolve_path(path_arg, base)
    try:
        return os.path.commonpath([allowed_root, actual]) == allowed_root
    except ValueError:
        return False

def skip_git_globals(index):
    base_dir = canonical_path(os.getcwd())
    i = index
    while i < len(tokens):
        token = tokens[i]
        if token == "-C" and i + 1 < len(tokens):
            next_dir = tokens[i + 1]
            base_dir = resolve_path(next_dir, base_dir)
            i += 2
        elif token.startswith("-C") and len(token) > 2:
            next_dir = token[2:]
            base_dir = resolve_path(next_dir, base_dir)
            i += 1
        elif token in {"-c", "--git-dir", "--work-tree", "--namespace", "--config-env"} and i + 1 < len(tokens):
            i += 2
        elif token.startswith(("--git-dir=", "--work-tree=", "--namespace=", "--config-env=")):
            i += 1
        elif token == "--":
            i += 1
            break
        elif token.startswith("-"):
            i += 1
        else:
            break
    return i, base_dir

def find_worktree_path(index):
    i = index
    while i < len(tokens):
        token = tokens[i]
        if token == "--":
            i += 1
            break
        if token in options_with_values and i + 1 < len(tokens):
            i += 2
            continue
        if any(token.startswith(prefix) for prefix in ("--reason=", "--orphan=")):
            i += 1
            continue
        if token.startswith("-"):
            i += 1
            continue
        return token
    return tokens[i] if i < len(tokens) else None

def expand_shell_wrappers(root_tokens):
    result = []
    queue = [root_tokens]
    while queue and len(result) < 8:
        current = queue.pop(0)
        result.append(current)
        for idx, token in enumerate(current):
            if posixpath.basename(token) not in {"bash", "sh", "zsh", "dash"}:
                continue
            j = idx + 1
            while j < len(current):
                opt = current[j]
                if opt == "--":
                    j += 1
                    break
                if opt in {"-c", "-lc"} or (opt.startswith("-") and not opt.startswith("--") and "c" in opt):
                    if j + 1 < len(current):
                        try:
                            queue.append(as_tokens(current[j + 1]))
                        except ValueError as exc:
                            if "git" in current[j + 1] and "worktree" in current[j + 1]:
                                respond("deny", f"Unable to parse shell-wrapped git worktree command safely: {exc}")
                    break
                if opt.startswith("-"):
                    j += 1
                    continue
                break
    return result

for tokens in expand_shell_wrappers(initial_tokens):
    i = 0
    while i < len(tokens):
        if posixpath.basename(tokens[i]) != "git":
            i += 1
            continue
        command_index, base_dir = skip_git_globals(i + 1)
        if command_index + 1 >= len(tokens) or tokens[command_index] != "worktree":
            i += 1
            continue
        action = tokens[command_index + 1]
        if action in {"remove", "prune"} and os.environ.get("OMK_ALLOW_WORKTREE_DELETE") != "1":
            respond("deny", "Worktree delete/prune blocked unless OMK_ALLOW_WORKTREE_DELETE=1 is set after review.")
        if action == "add" and os.environ.get("OMK_ALLOW_EXTERNAL_WORKTREE") != "1":
            path_arg = find_worktree_path(command_index + 2)
            if not path_arg or not path_within_allowed(path_arg, base_dir):
                respond("deny", "Worktree lanes must be created under .omk/worktrees/ unless OMK_ALLOW_EXTERNAL_WORKTREE=1 is set.")
        i = command_index + 2

respond("allow")
PY
`,
  "protect-secrets.sh": `#!/usr/bin/env bash
# Secret/environment variable protection
set -e

# Close security gate if jq/python3 is missing (deny by default)
if command -v python3 &>/dev/null; then
  PY=python3
elif command -v python &>/dev/null; then
  PY=python
else
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"python3 not installed — protect-secrets cannot validate files"}}'
  exit 0
fi

INPUT=$(cat)
OMK_HOOK_INPUT="$INPUT" "$PY" - <<'PY'
import json
import os
import re

def respond(decision, reason=None):
    payload = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": decision}}
    if reason:
        payload["hookSpecificOutput"]["permissionDecisionReason"] = reason
    print(json.dumps(payload, separators=(",", ":")))

try:
    data = json.loads(os.environ.get("OMK_HOOK_INPUT", "{}") or "{}")
except Exception:
    respond("deny", "Invalid hook input")
    raise SystemExit(0)

tool_input = data.get("tool_input", {})
if not isinstance(tool_input, dict):
    respond("allow")
    raise SystemExit(0)

def walk(value, key=""):
    if isinstance(value, str):
        yield key, value
    elif isinstance(value, dict):
        for child_key, child_value in value.items():
            yield from walk(child_value, str(child_key))
    elif isinstance(value, list):
        for child_value in value:
            yield from walk(child_value, key)

SENSITIVE_PATHS = (".env", ".pem", ".key", "id_rsa", "id_ed25519", "credentials", "service-account", ".p12", ".pfx", ".keystore")
SECRET_PATTERN = re.compile(r"(password|secret|api_key|auth|bearer|token|private_key|aws_access_key_id|aws_secret_access_key|akiai|asiai|ghp_|github_pat|sk-|glpat-|npm_|pypi_|docker_auth|private.?key|BEGIN .* PRIVATE KEY|ssh-rsa|ssh-ed25519)", re.IGNORECASE)

for key, value in walk(tool_input):
    key_lower = key.lower()
    if ("path" in key_lower or "file" in key_lower) and any(marker in value for marker in SENSITIVE_PATHS):
        respond("deny", "Direct modification of sensitive file blocked")
        raise SystemExit(0)

for _, value in walk(tool_input):
    if SECRET_PATTERN.search(value):
        respond("deny", "Potential secret leak detected")
        raise SystemExit(0)

respond("allow")
PY
`,
  "post-format.sh": `#!/usr/bin/env bash
# Auto-format after save (single file target)
set -e

if command -v python3 &>/dev/null; then
  PY=python3
elif command -v python &>/dev/null; then
  PY=python
else
  echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","permissionDecision":"allow"}}'
  exit 0
fi

INPUT=$(cat)
FILEPATH=$(echo "$INPUT" | $PY -c 'import sys,json; d=json.load(sys.stdin); print(d.get("tool_input",{}).get("file_path",""))')

if [ -z "$FILEPATH" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","permissionDecision":"allow"}}'
  exit 0
fi

# Detect project root and run formatter (target file only)
if [ -f "package.json" ] && [ -f "$FILEPATH" ]; then
  npx prettier --write "$FILEPATH" >/dev/null 2>&1 || true
fi

if [ -f "Cargo.toml" ] && [ -f "$FILEPATH" ]; then
  rustfmt "$FILEPATH" >/dev/null 2>&1 || true
fi

echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","permissionDecision":"allow"}}'
`,
  "typecheck-after-edit.sh": `#!/usr/bin/env bash
# TypeScript product preset: run project typecheck after TS edits when available.
set +e

if command -v python3 &>/dev/null; then
  PY=python3
elif command -v python &>/dev/null; then
  PY=python
else
  echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","permissionDecision":"allow"}}'
  exit 0
fi

INPUT=$(cat)
FILEPATH=$(echo "$INPUT" | $PY -c 'import sys,json; d=json.load(sys.stdin); print(d.get("tool_input",{}).get("file_path",""))')

case "$FILEPATH" in
  *.ts|*.tsx|*.mts|*.cts) ;;
  *) echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","permissionDecision":"allow"}}'; exit 0 ;;
esac

if [ ! -f "package.json" ] || ! command -v npm &>/dev/null; then
  echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","permissionDecision":"allow"}}'
  exit 0
fi

node -e "const p=require('./package.json'); process.exit(p.scripts && p.scripts.check ? 0 : 1)" >/dev/null 2>&1
if [ $? -ne 0 ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","permissionDecision":"allow"}}'
  exit 0
fi

TMP=$(mktemp)
npm run check >"$TMP" 2>&1
STATUS=$?
if [ $STATUS -eq 0 ]; then
  rm -f "$TMP"
  echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","permissionDecision":"allow"}}'
  exit 0
fi

tail -n 40 "$TMP" | $PY -c 'import json,sys; print(json.dumps({"hookSpecificOutput":{"hookEventName":"PostToolUse","permissionDecision":"allow","additionalContext":"Typecheck failed after edit. Inspect npm run check output:\\n"+sys.stdin.read()}}))'
rm -f "$TMP"
`,
  "eslint-after-edit.sh": `#!/usr/bin/env bash
# TypeScript product preset: run project lint after JS/TS edits when available.
set +e

if command -v python3 &>/dev/null; then
  PY=python3
elif command -v python &>/dev/null; then
  PY=python
else
  echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","permissionDecision":"allow"}}'
  exit 0
fi

INPUT=$(cat)
FILEPATH=$(echo "$INPUT" | $PY -c 'import sys,json; d=json.load(sys.stdin); print(d.get("tool_input",{}).get("file_path",""))')

case "$FILEPATH" in
  *.js|*.jsx|*.mjs|*.cjs|*.ts|*.tsx|*.mts|*.cts) ;;
  *) echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","permissionDecision":"allow"}}'; exit 0 ;;
esac

if [ ! -f "package.json" ] || ! command -v npm &>/dev/null; then
  echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","permissionDecision":"allow"}}'
  exit 0
fi

node -e "const p=require('./package.json'); process.exit(p.scripts && p.scripts.lint ? 0 : 1)" >/dev/null 2>&1
if [ $? -ne 0 ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","permissionDecision":"allow"}}'
  exit 0
fi

TMP=$(mktemp)
npm run lint >"$TMP" 2>&1
STATUS=$?
if [ $STATUS -eq 0 ]; then
  rm -f "$TMP"
  echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","permissionDecision":"allow"}}'
  exit 0
fi

tail -n 40 "$TMP" | $PY -c 'import json,sys; print(json.dumps({"hookSpecificOutput":{"hookEventName":"PostToolUse","permissionDecision":"allow","additionalContext":"ESLint failed after edit. Inspect npm run lint output:\\n"+sys.stdin.read()}}))'
rm -f "$TMP"
`,
  "stop-verify.sh": `#!/usr/bin/env bash
# Final verification on Stop
set -euo pipefail

if ! command -v node &>/dev/null; then
  echo '{"hookSpecificOutput":{"hookEventName":"Stop","permissionDecision":"allow","additionalContext":"Before final: list changed files, commands run, passed, failed, not run, and remaining risk. Do not claim deploy/publish unless verified."}}'
  exit 0
fi

node <<'NODE'
const context = [
  'OMK final response checklist.',
  '- Changed files: list authored files and note any ignored local runtime files refreshed.',
  '- Commands run: include exact verification commands and pass/fail/not-run status.',
  '- Deployment status: do not claim push, release, npm publish, or production deploy unless that command actually ran and evidence was read.',
  '- Remaining risk: state known gaps instead of saying complete without evidence.',
].join('\\n');

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'Stop',
    permissionDecision: 'allow',
    additionalContext: context,
  },
}) + '\\n');
NODE
`,
  "release-check-before-stop.sh": `#!/usr/bin/env bash
# OMK Release Guard — final checklist reminder for release/security work
set +e

if ! command -v node &>/dev/null; then
  echo '{"hookSpecificOutput":{"hookEventName":"Stop","permissionDecision":"allow","additionalContext":"OMK release guard: verify secret scan, security review, quality gate, changelog/PR evidence, and do not publish/deploy without exact command evidence."}}'
  exit 0
fi

node <<'NODE'
const { execSync } = require('node:child_process');

function shell(command) {
  try {
    return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  } catch {
    return '';
  }
}

const changed = [
  shell('git diff --name-only HEAD 2>/dev/null'),
  shell('git diff --cached --name-only 2>/dev/null'),
  shell('git ls-files --others --exclude-standard 2>/dev/null'),
].filter(Boolean).join('\\n');

const releaseTouched = /(^|\\n)(package\\.json|package-lock\\.json|pnpm-lock\\.yaml|yarn\\.lock|CHANGELOG\\.md|SECURITY\\.md|\\.npmrc|\\.github\\/workflows\\/release\\.ya?ml)(\\n|$)/.test(changed);
const context = releaseTouched
  ? 'OMK release guard: release/security files changed. Before final or publish, collect secret scan, security review, quality gate, npm audit summary, changelog/PR evidence, and do not publish/deploy without explicit user request.'
  : 'OMK release guard: no release file changes detected. Still do not claim push, release, npm publish, or production deploy without exact command evidence.';

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'Stop',
    permissionDecision: 'allow',
    additionalContext: context,
  },
}) + '\\n');
NODE
`,
  "npm-audit-summary.sh": `#!/usr/bin/env bash
# OMK Release Guard — optional npm audit summary for release gates
set +e

if [ ! -f "package.json" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"Stop","permissionDecision":"allow","additionalContext":"OMK npm audit summary: skipped because package.json is absent."}}'
  exit 0
fi

if [ "$OMK_RUN_NPM_AUDIT_SUMMARY" != "1" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"Stop","permissionDecision":"allow","additionalContext":"OMK npm audit summary: not run automatically. For release/security claims, run npm audit or set OMK_RUN_NPM_AUDIT_SUMMARY=1 and capture the result."}}'
  exit 0
fi

if ! command -v npm &>/dev/null || ! command -v node &>/dev/null; then
  echo '{"hookSpecificOutput":{"hookEventName":"Stop","permissionDecision":"allow","additionalContext":"OMK npm audit summary: skipped because npm or node is unavailable."}}'
  exit 0
fi

TMP="$(mktemp)"
npm audit --audit-level=high --omit=dev --json > "$TMP" 2>&1
STATUS=$?

node - "$TMP" "$STATUS" <<'NODE'
const fs = require('node:fs');
const filePath = process.argv[2];
const status = Number(process.argv[3] || 0);
let raw = '';
try {
  raw = fs.readFileSync(filePath, 'utf8');
} catch {}

let context;
try {
  const parsed = JSON.parse(raw);
  const total = parsed.metadata?.vulnerabilities?.total ?? 'unknown';
  const high = parsed.metadata?.vulnerabilities?.high ?? 'unknown';
  const critical = parsed.metadata?.vulnerabilities?.critical ?? 'unknown';
  context = status === 0
    ? 'OMK npm audit summary: passed for high+ prod dependencies. total=' + total + ', high=' + high + ', critical=' + critical + '.'
    : 'OMK npm audit summary: attention required. total=' + total + ', high=' + high + ', critical=' + critical + '. Inspect npm audit output before release.';
} catch {
  context = status === 0
    ? 'OMK npm audit summary: command completed but JSON could not be parsed.'
    : 'OMK npm audit summary: npm audit failed or returned non-JSON output; inspect command output before release.';
}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'Stop',
    permissionDecision: 'allow',
    additionalContext: context,
  },
}) + '\\n');
NODE
rm -f "$TMP"
`,
  "post-init-mcp.sh": `#!/usr/bin/env bash
# Post-init MCP validation — non-blocking health check after omk init
set -uo pipefail

LOG_DIR=".omk/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/mcp-init-check.json"

# Run doctor silently and capture JSON output if available
if command -v omk &>/dev/null; then
  omk mcp doctor --json 2>/dev/null > "$LOG_FILE" || true
else
  echo '{"note":"omk not in PATH during hook execution"}' > "$LOG_FILE"
fi
`,
};

export const KIMI_CONFIG_TOML = `# open_multi-agent_kit generated Kimi adapter config
# Lifecycle hook settings

[[hooks]]
event = "SessionStart"
command = ".omk/hooks/session-context.sh"
timeout = 5

[[hooks]]
event = "UserPromptSubmit"
command = ".omk/hooks/awesome-agent-skills-router.sh"
timeout = 5

[[hooks]]
event = "PreCompact"
command = ".omk/hooks/precompact-checkpoint.sh"
timeout = 5

[[hooks]]
event = "SubagentStop"
command = ".omk/hooks/subagent-stop-audit.sh"
timeout = 5

[[hooks]]
event = "SubagentStop"
command = ".omk/hooks/branch-diff-snapshot.sh"
timeout = 10

[[hooks]]
event = "PreToolUse"
matcher = "Shell"
command = ".omk/hooks/pre-shell-guard.sh"
timeout = 5

[[hooks]]
event = "PreToolUse"
matcher = "Shell"
command = ".omk/hooks/worktree-create-guard.sh"
timeout = 5

[[hooks]]
event = "PreToolUse"
matcher = "WriteFile|StrReplaceFile"
command = ".omk/hooks/protect-secrets.sh"
timeout = 5

[[hooks]]
event = "PostToolUse"
matcher = "WriteFile|StrReplaceFile"
command = ".omk/hooks/post-format.sh"
timeout = 20

[[hooks]]
event = "Stop"
command = ".omk/hooks/stop-verify.sh"
timeout = 30

[[hooks]]
event = "Stop"
command = ".omk/hooks/release-check-before-stop.sh"
timeout = 10

[[hooks]]
event = "Stop"
command = ".omk/hooks/npm-audit-summary.sh"
timeout = 60
`;

export const MEMORY_FILES: Record<string, string> = {
  "project.md": "# Project Memory\n\nProject-local graph memory is the source of truth; this file is a human-readable mirror.\n\n## Runtime Surfaces\n\n- Follow AGENTS.md and .kimi/AGENTS.md for active agent policy.\n- Use chat-agent-harness.json when present for MCP/skills/hooks inventory, worker limits, authority boundaries, and gates.\n- Keep .omk/memory mirrors free of secrets and private user data.\n",
  "decisions.md": "# Decisions\n\nRecord durable architecture, release, runtime, and safety decisions.\n\nFor each decision, include:\n\n- date and short title\n- affected files or surfaces\n- evidence commands or artifacts\n- rollback or revisit trigger\n\nNever store secrets, raw MCP env, tokens, or private user data.\n",
  "commands.md": "# Frequently Used Commands\n\nCommand mirror maintained alongside the local graph memory.\n\n```bash\nnpm run yaml:check\nnpm run lint\nnpm run secret:scan\nnpm run check\nnpm run build:clean\nnpm test\nnpm run audit:package\nnpm run pack:dry\nomk mcp doctor --json\nomk verify --json\n```\n\nUse targeted `npm test -- --match <pattern>` for focused regression loops before the full gate.\n",
  "risks.md": "# Known Risks\n\n- Do not store secrets, API keys, tokens, credentials, MCP env/header values, or private user data in memory.\n- `--local-user` and all-scope MCP/skills are runtime-only; do not copy global resources unless the user explicitly opts into `--import-user-skills`.\n- `chat-agent-harness.json` can contain private run inventory; summarize counts and gates, not full global inventories.\n- Working trees can contain unrelated edits; inspect `git status --short` before changes and avoid reverting user work.\n- Completion claims require evidence: tests, `omk verify --json`, replay/cockpit artifacts, or an explicit not-run reason.\n",
};

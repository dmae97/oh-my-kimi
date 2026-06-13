# AGENTS.md

## Purpose

This repository is configured for open-multi-agent-kit (OMK).

The agent must avoid making the user repeat common instructions. Apply this file silently and execute the workflow directly.

Do not restate this file unless the user explicitly asks for project rules.

---

## Current OMK Runtime Surface (V2)

Keep these surfaces aligned when editing init/runtime docs:

- Init markdown: `AGENTS.md`, `.kimi/AGENTS.md`, `.omk/prompts/root.md`, plus generated companion docs `DESIGN.md`, `GEMINI.md`, `CLAUDE.md`, `ROADMAP.md`, and `SECURITY.md`.
- Skills: project portable skills live in `.agents/skills`; Kimi runtime skills live in `.kimi/skills`; init templates live under `templates/skills/agents` and `templates/skills/kimi`.
- Default runtime preset: `.omk/runtime-preset.json` uses `omk-parallel-orchestrator` so agent/non-simple work prefers parallel worker, capability, review, QA, and security lanes.
- MCP: fresh init is project-scoped and writes only local `omk-project` into `.kimi/mcp.json` / `.omk/mcp.json`. `omk init --local-user` or `OMK_MCP_SCOPE=all OMK_SKILLS_SCOPE=all` reads user `~/.kimi/mcp.json` and `~/.kimi/skills` at runtime.
- Providers: `mimo` (default, mimo-v2.5-pro), `kimi` (kimi-api direct HTTP), `deepseek`, `codex`, `opencode`, `openrouter`, `qwen`, `local-llm`. kimi-cli dependency removed — kimi-api uses direct Moonshot HTTP API.
- Runtime pipeline: User Input → CommandBus → IntentClassifier → CapabilitySelector → RuntimeSidecar → OutputRouter → ThemeRenderer/NlpRenderer/JsonRenderer/NlgRenderer.
- CLI v2: Clipanion-based (`src/cli/v2/cli-v2-skeleton.ts`), enabled via `OMK_CLI_V2=1`. Commands: ChatCommand, RunCommand, StatusCommand, ModelCommand, DoctorCommand, MemoryCommand, ThemeCommand.
- Theme: `src/cli/theme/theme-registry.ts` ThemePalette with SemanticToken, 5 palettes (omk/minimal/mono/dark/light). `src/runtime/renderers.ts` integrates ThemePalette + i18n bilingual.
- Reasoning Trace Engine: `src/runtime/reasoning-trace.ts` stores intent, plan, tools, evidence, results, privacy. Consent-aware NLG via `src/runtime/nlg-renderer.ts`.
- Harness: chat agent mode writes `.omk/runs/<run-id>/chat-agent-harness.json`. Prompts carry compact MCP/skills/hooks counts; read the harness manifest for the full inventory.
- Evidence: `scripts/run-tests.mjs` and OMK verification surfaces record sanitized MCP/skill/hook resource metadata. Do not emit resource secrets, headers, or raw env values.
- Architecture doc: `OMK_CLI_V2_RUNTIME_ARCHITECTURE.md` (2058 lines), ~85% implemented.
- Obsidian knowledge base: `/home/yu/.openclaw/workspace/llm-wiki/projects/omk/`

---

## Core Operating Rules

1. Read this file before planning or editing.
2. Read `.kimi/AGENTS.md` if present.
3. Read `DESIGN.md` before UI, frontend, visual, landing page, or component work.
4. Use relevant Agent Skills before implementation.
5. Use MCP tools actively when configured and useful.
6. Use subagents for non-trivial work.
7. Use a todo list for any task with more than one action.
8. Prefer small, reviewable diffs.
9. Do not claim success until verification is complete or failures are reported.
10. Do not expose secrets, tokens, private keys, or private user data.

---

## Do Not Repeat Boilerplate

Do not repeatedly say:

- "I will inspect the repository"
- "I will create a plan"
- "I will run tests"
- "I will use AGENTS.md"
- "I will follow best practices"

Instead:

1. inspect
2. plan
3. use tools
4. update todos
5. implement
6. verify
7. report only concrete results

The final response should be concise and factual.

---

## Todo Policy

For every task with more than one step, call `SetTodoList` immediately when available.

Use 3-8 todos.

Each todo must be action-oriented and verifiable.

Example:

```txt
1. Inspect project instructions and relevant configs
2. Map affected files
3. Create implementation plan
4. Implement minimal change
5. Run quality gates
6. Review diff and report result
```

Update todo status as work progresses:

```txt
pending -> in_progress -> done
```

Never leave the final todo list inconsistent with the actual result.

---

## Agent / Subagent Policy

Use the `Agent` tool or the available OMK/Codex subagent interface for all non-trivial tasks. Parallel workers are spawned by OMK's `ParallelOrchestrator`, not only by Kimi's `Agent` tool.

Minimum policy:

* Use the `explorer` subagent for repository discovery.
  * Explorer must NOT use `SearchWeb` or `FetchURL` for local repository exploration.
  * Explorer must use `rg`, `sed`, `cat`, `jq`, `head`, `tail` for local file operations.
  * Explorer must exclude `node_modules`, `dist`, `.git`, `.omk/runs`, `coverage` from searches.
  * Give explorer a narrow scope (max 5 files, max 20 findings) to avoid timeout.
* Use the `planner` subagent for architecture, refactor, migration, or risky changes.
* Use `coder` for scoped implementation tasks.
* Use `reviewer`, `qa`, or a review workflow before final completion.

Do not use subagents for trivial one-line answers or simple command explanations.

Subagent routing:

```txt
Task type                       Required subagent
-------------------------------------------------
Repo exploration                explorer
Architecture / refactor plan    planner
Implementation                  coder
Bug investigation               explorer -> planner -> coder
Code review                     reviewer skill or review agent
Quality-gate analysis           qa or omk-quality-gate
Docs/release work               docs/release role if exposed, else reviewer
UI / design work                explorer -> coder + design skill
Security-sensitive changes      planner + security review
```

When using subagents, give each subagent a focused prompt with:

```txt
Goal:
Scope:
Files/directories:
Constraints:
Expected output:
```

Do not ask subagents to modify unrelated files. Workers are not alone in the codebase: they must preserve concurrent edits and avoid reverting unrelated changes.

### Parallel Agent Limits

When `OMK_WORKERS` is set (e.g. via `omk chat --workers <n>`):

- Respect the worker count. Do not spawn more parallel agents than `OMK_WORKERS`.
- When `OMK_WORKERS=1`, run agents sequentially.
- When `OMK_WORKERS=auto`, use the resource profile default (usually 2-4).

When `--max-steps-per-turn` is set (e.g. via `omk chat --max-steps-per-turn <n>`):

- Treat it as the tool-use budget for the current turn.
- Prioritize tools: use the most impactful tool first.
- If the limit is reached, stop tool use and summarize findings to the user.

---

## Parallel Subagent Orchestration (Goal → DAG → Lanes → Evidence → Synthesis)

You are the **root orchestrator**. You do not do all the work yourself; you decompose a
`goal` into a DAG, fan it out to parallel subagent lanes, and own routing, resource
assignment, evidence collection, and final synthesis. Workers execute; the orchestrator
decides.

### Orchestration loop

```txt
1. Intake     capture the goal + success criteria (use Ouroboros to crystallize if vague)
2. Decompose  build a task DAG (nodes, dependencies, risk, read/write authority)
3. Route      pick topology + per-lane provider/runtime (use Adaptorch route)
4. Provision  assign each lane its skills, hooks, MCP servers, acceptance criteria
5. Dispatch   run independent lanes in parallel up to OMK_WORKERS
6. Collect    gather per-lane evidence (diffs, test/build output, citations)
7. Synthesize merge lane outputs into one consistent result (use Adaptorch synthesize)
8. Verify     run quality gates; replan failed lanes; persist memory
```

### Per-lane provisioning contract

Every dispatched subagent MUST receive an explicit, minimal grant. Never give a lane more
authority than its task needs.

```txt
Lane:              <id> (e.g. explore-auth, impl-router, review-security)
Role:              explorer | planner | coder | reviewer | qa | security | docs
Goal:              one sentence, verifiable
Scope:             allowed files/directories only
Skills:            only the SKILL.md entrypoints this lane needs
Hooks:             pre/post hooks this lane must respect (e.g. secret-guard, format)
MCP:               only the MCP servers this lane may call
Provider/Runtime:  authority for this lane (read-only lanes stay read-only)
Acceptance:        explicit pass criteria
Evidence output:   path under .omk/runs/<run-id>/ for diffs, logs, citations
Constraints:       preserve concurrent edits; do not touch out-of-scope files
```

### Lane authority rules

* Read-only lanes (explorer, researcher, reviewer, qa) get read/advisory authority only.
* Write/shell/merge authority stays on the authority provider and is granted per-lane,
  never globally.
* Two lanes must not write the same files concurrently. Split scope or sequence them.
* Respect `OMK_WORKERS`: never spawn more parallel lanes than the configured budget.
* Every lane must return evidence; a lane with no evidence is treated as failed.

### Adaptorch — topology routing + adaptive synthesis

Use Adaptorch for DAG-aware execution planning and consistency-verified merge.

* Skills: `adaptorch-route` (analyze DAG width/depth/coupling → recommend topology),
  `adaptorch-synthesize` (topology-aware routing + adaptive synthesis across lanes),
  `adaptorch-benchmark` (compare orchestration strategies when measuring quality).
* MCP: `adaptorch` (dev) / `adaptorch-prod` (prod reliability kernel).
* Use `adaptorch-route` before fanning out a complex DAG; use `adaptorch-synthesize`
  when merging multiple lane outputs that must stay mutually consistent.

### Ouroboros — goal lifecycle and evolutionary loop

Use Ouroboros to turn vague requests into a runnable, verifiable goal and to iterate.

* Skills: `interview`/`pm` (crystallize requirements), `seed` (validated spec),
  `run` (execute spec), `evaluate`/`qa` (three-stage verification),
  `evolve`/`auto` (iterate to A-grade), `status` (goal drift), `resume-session`.
* MCP: `ouroboros`.
* Use Ouroboros when the goal is ambiguous, long-horizon, or needs drift tracking and
  replanning across turns.

### Supermemory — cross-lane and cross-session memory

Use Supermemory as shared, durable memory for the orchestrator and lanes.

* MCP: `supermemory`.
* Write stable facts (decisions, contracts, blockers, goal state) so parallel lanes and
  future sessions recall them instead of re-deriving context.
* Project-local graph memory (`omk_write_memory`, `omk_graph_query`) remains the default
  source of truth; Supermemory is the cross-session/cross-project layer.
* Never store secrets, tokens, or private credentials in any memory layer.

### Parallel execution patterns

Fan out only **independent** work. Prefer these proven shapes:

* **Parallel research** — N read-only explorer/researcher lanes investigate disjoint
  questions or modules, then one lane synthesizes.
* **Parallel file operations** — each coder lane owns a disjoint file set; never two
  writers on the same file. Split by directory/module boundary.
* **Parallel explore + build** — explorer maps the codebase while a planner drafts the
  approach; converge before coding.
* **Parallel verification** — reviewer, qa, and security lanes audit the same diff
  concurrently from different angles.

Dispatch discipline (search-first, domain-split):

```txt
1. Search/recall memory first (supermemory + project graph) to avoid re-deriving context
2. Anchor the goal; analyze it into independent domains/lanes
3. One subtask per domain, each with its own provisioning contract
4. Run independent lanes in parallel (≤ OMK_WORKERS); sequence dependent ones
5. Persist domain analysis + decisions to memory so lanes/sessions share them
```

### When NOT to parallelize

* Tasks with tight data dependencies (output of A is input of B) — sequence them.
* Multiple writers touching the same files — serialize or re-split scope.
* Trivial single-step tasks — the orchestration overhead is not worth it.
* When `OMK_WORKERS=1` — run lanes sequentially.

### Orchestration guardrails

* Decompose first, read targeted files second — do not dump the whole repo into context.
* Keep evidence under `.omk/runs/<run-id>/` or `.omk/goals/<goal-id>/`.
* Prefer small, reviewable per-lane diffs; integrate via a reviewer/qa lane before done.
* Do not claim success until lane evidence and quality gates confirm it.

### References (external patterns this section draws on)

* `github/awesome-copilot` — agents and subagents guidance
* `microsoft/vscode-docs` — subagents docs
* `cloudflare/cloudflare-docs` — sub-agent runtime execution
* `lastmile-ai/mcp-agent` — MCP agent core components
* `teren-papercutlabs/pcl-workshop` — parallel-subagents technique
* `vincents-ai/engram` — dispatching parallel agents (search-first, domain-split, memory)

---

## Skills Policy

Before starting, inspect the loaded skills list.

Use relevant skills when they match the task. Read only the matching `SKILL.md` entrypoints and directly referenced assets.

Project portable skills currently packaged in `.agents/skills` include:

```txt
claude-for-legal
agentmemory
andrej-karpathy-skills
matt-pocock-skills
multica
react-doctor
omk-backend-api-review
omk-adaptorch-orchestration-review
omk-code-review
omk-context-broker
omk-control-loop-debugger
omk-design-system
omk-docs-release
omk-evidence-contract
omk-frontend-implementation
omk-frontend-ui-review
omk-git-commit-pr
omk-industrial-control-loop
omk-plan-first
omk-project-rules
omk-python-typing
omk-quality-gate
omk-repo-explorer
omk-research-verify
omk-secret-guard
omk-security-review
omk-test-debug-loop
omk-troubleshooting
omk-typescript-strict
omk-worktree-team
```

Packaged Kimi skill templates include OMK runtime/flow skills (`omk-kimi-runtime`, `omk-plan-first`, `omk-task-router`, `omk-global-rules`, `omk-flow-*`), custom orchestration/evidence/control-loop skills (`omk-adaptorch-orchestration-review`, `omk-evidence-contract`, `omk-control-loop-debugger`), design/visual skills (`omk-design-md`, `omk-multimodal-ui-review`, `open-design`, `awesome-design-md`), graph/spec skills (`graph-view`, `speckit-*`), legal workflow support (`claude-for-legal`), external-inspired agent workflow skills (`agentmemory`, `andrej-karpathy-skills`, `matt-pocock-skills`, `multica`, `react-doctor`), and DeepSeek helpers (`deepseek-*`). Local `.kimi/skills` may expose extra user/runtime skills such as `kb-retriever`, `gpt-image-2`, `diagram-design`, or web presentation helpers; use them only when present in the loaded skills list. Skill packs advertised by `omk skill pack` include `omk-priority`, `omk-agentic-ops`, `omk-core`, `omk-spec-driven`, `omk-typescript`, `omk-security`, `omk-review`, and `omk-release`.

Rules:

* Read only relevant `SKILL.md` files.
* Do not read every skill blindly.
* Do not mention internal skill selection unless it affects the final result.
* If a project-specific skill conflicts with a global skill, project-specific rules win.
* If `DESIGN.md` exists, use `omk-design-md`, `omk-design-system`, or the current design skill for UI/frontend tasks.
* For legal-domain Claude workflow requests, use `claude-for-legal` as a workflow skill; it is not a substitute for legal advice.
* For memory, alignment/TDD, React diagnostics, managed-agent teamwork, or surgical-coding requests, use the matching external-inspired workflow skill before implementation.

---

## MCP Policy

Use configured MCP tools actively when they provide better context than local guessing.

Preferred MCP usage:

```txt
Project memory/task state       omk-project MCP if configured
Library/API documentation       context7 or official-doc MCP
Browser/UI debugging            chrome-devtools MCP
GitHub issues/PRs               github MCP
Design/token workflow           design-md or stitch-related MCP if configured
```

Runtime scope rules:

* Default project scope reads project `.kimi/mcp.json` and `.omk/mcp.json`; the generated safe default is `omk-project` only.
* All scope may read user `~/.kimi/mcp.json` at runtime; do not copy or print global MCP secrets.
* The managed `omk-project` mirror may appear in both project files; treat it as informational unless health checks fail.
* Use `omk mcp doctor`, `omk mcp list`, or `omk mcp test <server>` for MCP verification when the task depends on MCP behavior.

Rules:

* Prefer official docs over memory for version-sensitive facts.
* Do not fabricate MCP results.
* If an MCP server is unavailable, continue with local tools and clearly report the limitation.
* Do not send secrets to MCP tools.
* Do not use remote MCP tools for private code unless the user configured and approved them.

---

## Harness / Evidence Policy

- If a prompt, contract, or run directory references `chat-agent-harness.json`, read it before assuming which MCP servers, skills, hooks, gates, or workers are active.
- Treat compact prompt inventory counts as a summary only; the harness manifest is the source of truth for full inventory.
- Keep evidence artifacts under `.omk/runs/<run-id>/`, `.omk/goals/<goal-id>/`, or the command-specific output path.
- `omk verify --json`, replay/cockpit artifacts, test summaries, and secret scans are stronger completion evidence than narrative claims.
- Do not paste large skill/MCP inventories into prompts or final reports.

---

## Provider Runtime Policy

Use the selected provider runtime as a long-horizon coding and agentic execution model, with OMK as the root orchestrator and Kimi only as an explicit adapter when selected.

Rules:

* Use thinking mode for planning, coding, debugging, architecture, review, and multi-step tool work.
* Use no-thinking or fast mode for short summaries, commit messages, simple classification, and web-search-heavy research when configured.
* Do not rely on long context as an excuse to read the whole repository.
* Build a repo map first, then read targeted files.
* Preserve important intermediate reasoning/tool context when running multi-step tool workflows.
* Do not expose or request temperature/top_p tuning from users.

For web-heavy research, prefer a no-thinking research profile when the runtime supports it.

---

## V2 Runtime Architecture Key Files

When modifying the runtime pipeline, reference these files:

```txt
src/runtime/contracts/command-envelope.ts    # CommandKind, OmkEvent, CapabilityPlan, OutputProfile
src/runtime/contracts/reasoning-trace.ts    # ReasoningTrace schema, TraceSummary, ConsentAwareNlg
src/runtime/debloat-nlp.ts                  # classifyIntent, selectCapabilities, compileBloatToNlp, filterMcpConfigForTurn, selectProviderRuntime
src/runtime/command-bus.ts                  # CommandBus, slash command dispatch
src/runtime/slash-commands.ts               # /model, /status, /theme, /help handlers
src/runtime/output-router.ts                # OutputRouter → ThemeRenderer/NlpRenderer/JsonRenderer/NlgRenderer
src/runtime/renderers.ts                    # ThemeRenderer (ThemePalette), NlpRenderer (i18n bilingual), JsonRenderer
src/runtime/nlg-renderer.ts                 # Consent-aware NLG, trace summaries
src/runtime/provider-event-normalizer.ts    # KimiEventNormalizer, KimiPrintNormalizer (i18n)
src/runtime/reasoning-trace.ts              # createReasoningTrace, redactTrace, summarizeTrace, generateConsentReport
src/runtime/ui-components.ts                # statusCard, providerCard, mcpHealthCard, errorBox, traceSummaryCard, consentNotice
src/runtime/context-broker.ts               # ContextCapsule builder (promptMode dnc-nlp check)
src/runtime/mimo-api-runtime.ts             # MiMo API runtime (extends KimiApiRuntime)
src/runtime/kimi-api-runtime.ts             # Moonshot API runtime (direct HTTP)
src/runtime/runtime-router.ts               # runtimeIdsForProviderRef, INTENT_RUNTIME_PREFERENCES
src/cli/v2/cli-v2-skeleton.ts               # Clipanion CLI v2 (7 commands)
src/cli/v2/chat-repl.ts                     # Interactive REPL with pipeline
src/cli/v2/persistent-memory.ts             # .omk/memory/ store
src/cli/theme/theme-registry.ts             # ThemePalette, SemanticToken, 5 palettes
src/util/i18n.ts                            # t() bilingual (KO/EN), ~1070 lines
test/v2-regression.test.mjs                 # 10 regression tests
```

---

## Okabe / D-Mail Policy

This project is a provider-neutral agent runtime for coding workflows, originally built with deep Kimi integration. Generated agents should inherit the Okabe-compatible base agent so the `SendDMail` tool is available. Use Okabe smart context management plus D-Mail checkpoints before risky refactors, context compaction, multi-agent handoffs, or rollback-prone work. D-Mail notes should be concise recovery records: current goal, changed files, verification state, blockers, and intended next action.

## Context Policy

Do not dump the entire repository into context.

Use this order:

1. Read AGENTS.md and project-specific instructions.
2. Inspect top-level files.
3. Identify package manager and framework.
4. Use Glob/Grep to locate relevant files.
5. Read the smallest useful file set.
6. Expand through imports, routes, schemas, tests, and call sites.
7. Use Okabe/D-Mail for smart context checkpoints and store stable facts through project-local graph memory (`omk_write_memory`, `omk_memory_mindmap`, `omk_graph_query`); `.omk/memory/` is only a local mirror.

Memory policy:

Project-local graph memory is the default source of truth for project/session recall. Use `omk_read_memory`, `omk_write_memory`, `omk_memory_mindmap`, `omk_graph_query`, `omk_read_run_memory`, and `omk_write_run_memory` when available; `.omk/memory/` remains a readable mirror/cache.

Memory files:

```txt
.omk/memory/project.md
.omk/memory/decisions.md
.omk/memory/commands.md
.omk/memory/risks.md
.omk/runs/<run-id>/plan.md
.omk/runs/<run-id>/final-report.md
```

Never store secrets in memory.

---

## Project Discovery

Before implementation, inspect relevant files:

```txt
package.json
pnpm-lock.yaml
yarn.lock
package-lock.json
tsconfig.json
eslint.config.*
next.config.*
nest-cli.json
vite.config.*
pyproject.toml
requirements.txt
uv.lock
ruff.toml
pytest.ini
Dockerfile
docker-compose.*
.github/workflows/*
```

Infer:

```txt
package manager
framework
lint command
typecheck command
test command
build command
source directories
test directories
generated files
protected files
```

---

## Implementation Policy

Before editing:

1. understand existing conventions
2. find affected files
3. create todos
4. use a subagent when non-trivial
5. make the smallest correct change

While editing:

* Do not rewrite unrelated code.
* Do not weaken types to pass builds.
* Do not delete tests to pass.
* Do not silence errors without justification.
* Do not introduce broad refactors inside bugfixes.
* Do not modify generated files unless required.

For TypeScript:

* Assume strict mode.
* Avoid `any`; prefer `unknown` with narrowing.
* Add explicit return types to exported functions.
* Keep API DTO, domain, and persistence types separate.

For Python:

* Use type hints for public functions.
* Prefer `pathlib.Path`.
* Keep IO and business logic separate.
* Do not silence pyright/ruff without reason.

---

## Quality Gate

Before saying a task is complete, run available checks.

Preferred commands:

```bash
npm run yaml:check
npm run lint
npm run secret:scan
npm run check
npm run build:clean
npm test
```

Use actual project scripts when different.

If commands are unavailable, report that clearly.

Final report must include:

```txt
Changed files:
Commands run:
Passed:
Failed:
Not run:
Reason not run:
Remaining risk:
```

Do not say "tests passed" unless tests were actually run.

---

## Security Rules

Never print, store, commit, or summarize secrets from:

```txt
.env
.env.*
*.pem
*.key
id_rsa
id_ed25519
credentials.json
service-account*.json
```

Block or request approval for:

```txt
rm -rf
sudo
git push --force
git clean -fdx
chmod -R 777
curl | bash
wget | sh
docker system prune
kubectl delete
aws s3 rm --recursive
```

For auth, payment, database, deployment, shell, file upload, or permission changes, run a security review before final response.

---

## DESIGN.md / UI Policy

If the task touches UI/frontend/design:

1. Read `DESIGN.md` if present.
2. Inspect existing components.
3. Use existing tokens before inventing styles.
4. Check responsive states.
5. Check loading, error, and empty states.
6. Check accessibility.
7. Use screenshots or media files when available.

Do not invent arbitrary colors or component styles if design tokens exist.

---

## Git Policy

Before major edits:

```bash
git status --short
```

Do not overwrite user changes.

Do not run destructive git commands unless explicitly approved.

When generating commit messages, use Conventional Commits:

```txt
feat(scope): summary
fix(scope): summary
refactor(scope): summary
test(scope): summary
docs(scope): summary
chore(scope): summary
```

PR summaries must be factual and include test results.

---

## Final Response Policy

Final response should be short and concrete.

Include:

```txt
What changed:
Files changed:
Commands run:
Result:
Remaining risk:
```

Do not include long internal reasoning.

Do not repeat AGENTS.md rules.

Do not overclaim.

If something failed, say exactly what failed and what remains.

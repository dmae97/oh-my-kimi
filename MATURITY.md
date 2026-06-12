# OMK Command Maturity Matrix

Last updated: 2026-05-24
Current source version: v1.1.18

| Level | Meaning |
|-------|---------|
| **Stable** | Intended for normal local use. CLI surface is documented and should avoid breaking changes without migration notes. |
| **Alpha** | Working implementation exists, but contracts, JSON output, diagnostics, or edge cases still need hardening. |
| **Experimental** | Early workflow surface. Behavior may change; use with review and explicit verification. |

## Stable

| Command | Notes |
|---------|-------|
| `omk init` | Project scaffold for AGENTS.md, DESIGN.md, and local `.omk/` state. |
| `omk doctor` | Runtime/toolchain/project diagnostics. Supports `--json` for CI-style consumption. |
| `omk chat` | Interactive chat coordinator with startup status/HUD preview and run-scoped harness manifest generation. The Kimi-default path is stable; native provider-neutral routing remains gated by the hardening items below. |
| `omk hud` | Execution status and local system usage HUD. |
| `omk cockpit` | Sidecar cockpit for run state, TODOs, and ETA. |
| `omk plan` | Plan-only execution entrypoint. |
| `omk mode` | Switch local execution presets. |
| `omk runs` / `omk history` | Run history lookup with filters, stats, insights, export, watch, and `--json`. |
| `omk index` / `omk index-show` | Project index generation and display for context reduction. |
| `omk lsp` | Bundled TypeScript LSP launcher/config output. |
| `omk design` | DESIGN.md management and Google design.md bridge commands. |
| `omk google` | Google ecosystem integration commands. |
| `omk update` | Check or run OMK update flow. Supports `--json`. |
| `omk star` | Convenience command for the GitHub repository. |

## Alpha

| Command | Notes |
|---------|-------|
| `omk run` | DAG-based long-running execution. Supports `--provider auto\|kimi`; provider metadata exists but needs stronger release-gate coverage. |
| `omk parallel` | Parallel agent execution with worker/reviewer flow, live views, approval policy, and provider policy. |
| `omk review` | Code/security review of current changes; `--ci` remains the automation path. |
| `omk summary` / `omk summary-show` | Run summary/report generation and terminal display. |
| `omk sync` | Asset sync with dry-run/diff/rollback support; manifest-backed rollback coverage is still incomplete for some global assets. |
| `omk verify` | Evidence gate verification for runs. Supports `--json`. |
| `omk goal` | Codex-style goal create/list/show/run/verify/close/block/continue with generated plan/evidence criteria. |
| `omk provider` / `omk deepseek` / `omk deepseekset` | DeepSeek availability, enable/disable, API-key setup, and provider-neutral opportunistic routing with Kimi as the most mature adapter. JSON exists for provider doctor and state changes. |
| `omk graph view` | Generates HTML from `.omk/memory/graph-state.json`; useful now, but ontology coverage and run-linking are still maturing. |
| `omk mcp` | Project/global MCP list, doctor, test, serve, add/remove/install/sync-global with structured diagnostics and explicit project/global scope handling. |
| `omk dag` | Spec DAG validation/show/replay/from-spec. Replay supports provider policy. |
| `omk screenshot` | Clipboard screenshot store/list/clean utility with JSON on subcommands. |
| `omk snip` | Local snippet save/get/list/search/delete utility. |
| `omk replay` | Replay prior run command sequences and decision traces for inspection or re-execution. |
| `omk inspect` | Deep inspection of a specific run: artifacts, decisions, provider routes, and evidence gates. |
| `omk diff-runs` | Compare two runs: file changes, decision divergence, provider routing, and evidence deltas. |

## Experimental

| Command | Notes |
|---------|-------|
| `omk team` | tmux-based multi-agent team execution. Needs deeper execution-state reporting before stable use. |
| `omk merge` | Worktree diff collection/reviewer scoring/patch application; dry-run first. |
| `omk feature` / `omk bugfix` / `omk refactor` | Preset workflows over planning/execution paths; still subject to run/parallel maturity. |
| `omk specify` / `omk spec` | GitHub Spec Kit bridge and local spec helpers. |
| `omk agent` | Agent role listing/show/create/doctor/verify. |
| `omk skill` | Skill pack listing/install/sync. |
| `omk cron` | Scheduled job management. Treat as local automation preview until lifecycle/error reporting is hardened. |
| `omk research` | Core runtime web research wrapper; depends on Kimi tool availability. |
| `omk open-design-agent` | Local Open Design CLI bridge. |

## Automation Contract Status

| Area | Current state | Next hardening |
|------|---------------|----------------|
| JSON output | Present on `doctor`, `runs/history`, `update`, `verify`, `goal` read/verify commands, provider commands, and screenshot subcommands; provider/screenshot JSON contracts are now regression-tested. | Expand consistent JSON to MCP diagnostics, graph, DAG, summary, and workflow entrypoints. |
| Provider routing | DeepSeek opportunistic worker routing exists for low-risk/read-heavy paths; Kimi remains the most mature adapter, orchestrator, and fallback; run summaries/reports now include provider attempt and fallback totals. | Add HUD provider route metrics and broader release-gate tests for fallback/metadata contracts. |
| Native runtime safety | OMK owns the root-orchestrator direction, but native chat must still lock turn-risk inference, approval/sandbox propagation, authority resolution, provider health probes, and DeepSeek read-only enforcement before stable provider-neutral claims. | Treat `docs/native-root-runtime-hardening.md` and `.omk/specs/native-orchestrator-phase1/` as the active hardening contract. |
| MCP diagnostics | `mcp list/doctor/test` exist; invalid project/global MCP JSON now fails visibly through diagnostics without exposing config contents. | Add machine-readable MCP JSON and structured failure categories for command resolution, timeout, permission, and server health. |
| Skills and harness templates | `omk skill` exposes current core/TypeScript/review packs, while init templates document project MCP scope, runtime skills, portable `.agents/skills`, and run-scoped harness manifests. | Keep external-inspired skills compact, source-linked, and non-vendored; verify install/sync through `skill-command` tests and package audit. |
| Release docs and site | README, CHANGELOG, MATURITY, ROADMAP, getting-started docs, package audit, and release-gate commands now distinguish the v1.1.18 source target from the latest published v1.1.17 release while documenting alpha/experimental surfaces, parallel subagent orchestration, typed doctor repair plans, startup update prompts, native safety package readiness, current harness templates, packaged workflow skills, and the public project repository at `https://github.com/dmae97/open_multi-agent_kit`. | Treat `npm run release:check`, native safety packaging, tarball install smoke, GitHub Smoke Test, and GitHub CI evidence on the exact commit as the publish/deploy gate before claiming v1.1.18 as released. Current `6305e2b` Smoke is green but CI is red on Windows jobs. |
| Goal planner | Goal lifecycle exists, including continue, generated plan/evidence criteria, and verification. | Expand planner quality scoring and release evidence. |

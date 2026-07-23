# CLAUDE.md

Project-memory file for Claude Code, following Anthropic's official memory convention
(https://docs.claude.com/en/docs/claude-code/memory). Claude Code auto-loads this as project memory.

It deliberately does **not** restate, reconstruct, or reference any Anthropic model system prompt, tool
schema, or safety policy — those are owned by Anthropic and are out of scope for a repo-local memory file.
Behavioral rules live in `AGENTS.md`, not here (see Precedence). This file is a detailed, factual
quick-reference to the OMK runtime and this repo's mechanics.

---

## Precedence (read this first)

Behavioral authority order for OMK sessions:

1. `~/.omk/agent/AGENTS.md` — global OMK operating manual (orchestration, capability routing, safety floor).
2. `/home/yu/omk/AGENTS.md` — this repo's project rules (code style, commands, git, release).
3. This `CLAUDE.md` — Claude Code interoperability + quick reference only. **Not** a second source of
   behavioral truth. If this file and an `AGENTS.md` disagree on behavior, the `AGENTS.md` wins.

Read the relevant `AGENTS.md` before making code changes.

---

## OMK runtime map (what you're operating inside)

- **Core CLI:** `~/.omk/agent/bin/omk` → launcher → built `dist/` of `packages/coding-agent`
  (`~/.omk/agent/lib/omk-canonical-launcher.cjs`, real root `/home/yu/omk`).
- **Default loadout:** `omk-core-verified` preset (`~/.omk/runtime-preset.json`).
- **Capability layers** (all per-session; verify with an `omk_runtime_status`-style tool, never assume):
  - Skills — large retrievable catalog (~700+ configured / ~800+ discovered). Route to the specific one;
    never bulk-load. Roots: `~/.omk/agent/skills`, `.../plugins/lazycodex-omo/skills`, `~/.agents/skills`,
    `anthropics/skills`, `omk-ui/skills`.
  - MCP servers — ~18 (e.g. `adaptorch`, `context7`, `serena`, `understand-anything`, `github`, `fetch`,
    `firecrawl`, `playwright`, `memory`, `supermemory`). Grant per task by need.
  - Hooks — ~16 always-on, fail-closed gates (e.g. `pre-shell-guard`, `protect-secrets`,
    `typecheck-after-edit`, `stop-verify`). Session-wide, not per-lane toggles.
  - Agents — role files in `~/.omk/agent/agents/` for the subagent dispatcher. OMK-native lanes:
    `omk-explorer|planner|coder|reviewer|security|tester`. A large domain catalog also exists — route to it
    only for its domain.
- **Subagent dispatch:** extension at `~/.omk/agent/extensions/subagent/` (single/parallel/chain; 4
  concurrent, 8 total; isolated context per task). Its `index.ts`/`agents.ts` and some `agents/*.md` are
  symlinks into the workspace — if a repo move breaks them they fail silently; verify and repair.
- **Adaptorch:** MVP reliability kernel; its MCP servers + `adaptorch-route`/`adaptorch-synthesize` skills
  ship in the default preset, available from the first prompt (invoking a run still needs its token).

Full orchestration model, lane-grant schema, capability-routing algorithm, and the non-negotiable safety
floor are in `~/.omk/agent/AGENTS.md`.

---

## This repo: open-multi-agent-kit / OMK monorepo

Workspace packages: `omk-ai` (multi-provider LLM API), `omk-agent-core` (agent runtime),
`open-multi-agent-kit` (`packages/coding-agent`, the CLI), `omk-tui` (terminal UI), `omk-adaptorch-wpl`
(experimental, design-stage — not wired into the CLI).

### Build / test / check commands
- Install: `npm install --ignore-scripts`
- Build all: `npm run build`  (do not run unless asked)
- Lint + format + typecheck: `npm run check`  (run after any non-doc code change; full output, no tail; fix
  all errors/warnings/infos before committing; does not run tests)
- Non-e2e tests: `./test.sh` from repo root, or per package:
  `node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`
  (Never run the full vitest suite directly — it activates e2e tests when endpoint/auth env vars are present.)
- Run OMK from source: `./omk-test.sh` (runs `packages/coding-agent/src/cli.ts` via tsx).
- TUI smoke in tmux: `tmux new-session -d -s omk-test -x 80 -y 24; tmux send-keys -t omk-test "./omk-test.sh" Enter`.
- Never run `npm run build` or the full test suite unless the user asks.

### Model catalog note (learned)
Two layers define models, and both can shadow each other:
1. `packages/ai/src/models.generated.ts` — the built catalog. **Never edit it directly**; change
   `packages/ai/scripts/generate-models.ts` then `npm run generate-models` (or `npm run build`).
2. `~/.omk/agent/models.json` — a user overlay that **overrides** the built catalog per provider at runtime.
   If a model's `thinkingLevelMap` (e.g. `xhigh`/`max`) looks wrong in the running app, check this overlay
   first — it wins over the package, and the running Node process must be restarted to pick up either change.

### Code style (summary; full rules in `/home/yu/omk/AGENTS.md`)
- TypeScript strict. Erasable-syntax only (Node strip-only) in `packages/*/src`, `packages/*/test`,
  `packages/coding-agent/examples`: no parameter properties, `enum`, `namespace`/`module`, `import =`/`export =`.
- No `any` unless unavoidable. No inline/dynamic imports — top-level imports only. Inline single-call-site
  single-line helpers. Don't hardcode key checks — add to `DEFAULT_*_KEYBINDINGS`.
- Read files in full before wide-ranging changes. Ask before removing intentional-looking code.

### Git / safety (summary)
- Multiple sessions may share this working tree. Only stage files you changed; use explicit paths; never
  `git add -A`/`.`, `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `--no-verify`, or
  force-push. `packages/ai/src/models.generated.ts` may be included alongside your files.
- Never commit unless the user asks. Treat lockfile/dep changes as reviewed code (`--ignore-scripts`).
- Never infer where to auto-inject API keys or `.env` values. If the user explicitly provides the secret value, variable name, and exact target scope/file in the same request, treat that as authorization and handle it without an extra confirmation prompt. If target details are missing, ask only for the missing field. Write only to the specified untracked local secret target, never echo/read it back, ensure it is gitignored, and never commit it. Process env injection is one-command scoped unless persistent export is explicitly requested.

---

## Prior-content notice

An earlier version of this file claimed to be a "complete verbatim reproduction" of an Anthropic model's
system prompt (~900 lines of purported product info, refusal policy, tool schemas, safety rules). That was
quarantined to `QUARANTINE-20260702/CLAUDE.md.system-prompt-artifact` because it could not be verified
(models reciting their own system prompt is a known confabulation pattern) and, even if partially accurate,
is not OMK's to store. Do not restore it or treat it as authoritative — Claude's real behavior is governed by
Anthropic, not by this file.

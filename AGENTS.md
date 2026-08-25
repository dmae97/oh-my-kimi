# AGENTS.md — OMK monorepo project rules

Rules for any coding agent working in this repository. Scope is this repo only: layout,
commands, code style, git discipline, release, and what may never be published here.

## Precedence

1. The operator's global agent manual, if the machine has one. It is machine-local and
   deliberately not versioned here — see [Publication boundary](#publication-boundary).
2. This file — project rules for `/home/yu/omk`.
3. [`CLAUDE.md`](CLAUDE.md) — Claude Code interoperability and quick reference, not a
   second source of behavioral truth.

[`specs/constitution.md`](specs/constitution.md) outranks all three on release,
versioning, and governance questions.

## Repository map

| Path | Contents |
| --- | --- |
| `packages/ai` | `omk-ai` — multi-provider LLM API |
| `packages/agent` | `omk-agent-core` — agent runtime |
| `packages/coding-agent` | `open-multi-agent-kit` — the CLI, docs, examples |
| `packages/tui` | `omk-tui` — terminal UI |
| `packages/protocol` | `omk-protocol` — wire types |
| `packages/adaptorch-wpl` | `omk-adaptorch-wpl` — reliability kernel component |
| `packages/book-to-skill` | `omk-book-to-skill` |
| `.omk/skills` | project-local skills discovered from a checkout |
| `specs/` | constitution and spec-kit artifacts |
| `scripts/` | release, publish, and repository guards |

## Commands

| Task | Command |
| --- | --- |
| Install | `npm install --ignore-scripts` |
| Lint, format, typecheck, guards | `npm run check` |
| Tests (non-e2e) | `./test.sh` |
| One test file | `node ../../node_modules/vitest/dist/cli.js --run test/x.test.ts` |
| Run the CLI from source | `./omk-test.sh` |
| Build | `npm run build` |

Run `npm run check` after any non-doc change and fix everything it reports; it does not
run tests. Never run the full vitest suite directly — it activates e2e tests when
endpoint or auth environment variables are present. Do not run `npm run build` or the
full suite unless asked.

## Runtime change rule

For coding-agent behavior changes: update `packages/coding-agent/src/**`, update
`packages/coding-agent/docs/**` when commands or workflows change, add or update targeted
tests under `packages/coding-agent/test/**`, run the targeted test, then `npm run check`.
Rebuild only if the change must reach the running TUI, and restart it before checking
interactive slash commands.

## Code style

- TypeScript strict. Erasable syntax only in `packages/*/src`, `packages/*/test`, and
  `packages/coding-agent/examples`: no parameter properties, `enum`, `namespace`/`module`,
  or `import =`/`export =`.
- No `any` unless unavoidable. Top-level imports only — no inline or dynamic imports.
- Inline a single-call-site, single-line helper instead of naming it.
- Never hardcode a key check; add to `DEFAULT_*_KEYBINDINGS`.
- Modules are held to a 250-line pure-LOC ratchet (`scripts/check-module-size.mjs`).
- Read a file in full before a wide-ranging change, and ask before removing code that
  looks intentional.

## Git and safety

- Multiple sessions may share this working tree. Stage only files you changed, by explicit
  path. Never `git add -A`/`.`, `git reset --hard`, `git checkout .`, `git clean -fd`,
  `git stash`, `--no-verify`, or force-push.
- Never commit unless asked. Treat lockfile and dependency changes as reviewed code.
- Never guess where to inject API keys or `.env` values. Write only to the target the user
  named, keep it git-ignored, never echo it back, never commit it.

## Release

All workspace packages share one lockstep version; there are no major releases. A release
is complete only when the tag on `main`, the GitHub Release, and npm `latest` for all
seven public packages agree. Publishing runs in CI. Released changelog sections are
immutable — new work goes under `[Unreleased]`. Details and the full rule set are in
[`specs/constitution.md`](specs/constitution.md).

## Publication boundary

The operator's private agent home (`~/.omk/agent`) holds personal skills, agents, prompts,
patches, session data, and research corpora. None of it belongs in this repository, its
releases, or any npm tarball — not as a copy, a vendored tree, a drifted duplicate, or a
quoted excerpt. A fresh clone must be complete without it.

`scripts/check-private-agent-home.mjs` enforces this on every `npm run check`. If it
fails, remove the material rather than widening the guard.

<!-- OPENWIKI:START -->

## OpenWiki

This repository has a generated `openwiki/` evidence index. It is optional just-in-time context, not required startup reading.

- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->

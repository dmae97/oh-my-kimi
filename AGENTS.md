# AGENTS.md — OMK monorepo project rules

Rules for any coding agent working in this repository. Scope is this repo only: layout,
commands, code style, git discipline, release, and what may never be published here.

## Precedence

1. The operator's global agent manual, if the machine has one. It is machine-local and
   deliberately not versioned here — see [Publication boundary](#publication-boundary).
2. This file — project rules for this checkout.
3. [`CLAUDE.md`](CLAUDE.md) — a Claude Code entry point that imports this file, not a
   second source of behavioral truth.

[`specs/constitution.md`](specs/constitution.md) outranks all three on release,
versioning, and governance questions.

OMK loads the first of `AGENTS.md`/`CLAUDE.md` it finds in a directory, so an OMK session
here reads this file and never sees `CLAUDE.md`; Claude Code reads `CLAUDE.md`, which
imports this file. Behavioral rules belong here: a rule copied into `CLAUDE.md` becomes a
fork only one of the two hosts ever reads.

## Repository map

| Path | Contents |
| --- | --- |
| `packages/coding-agent` | `open-multi-agent-kit` — the `omk` CLI, its docs and examples |
| `packages/ai` | `omk-ai` — multi-provider LLM API |
| `packages/agent` | `omk-agent-core` — agent runtime |
| `packages/tui` | `omk-tui` — terminal UI |
| `packages/protocol` | `omk-protocol` — wire types |
| `packages/adaptorch-wpl` | `omk-adaptorch-wpl` — Work Packet Loop primitives; the CLI's advisory adaptorch bridge is opt-in and default-off |
| `packages/book-to-skill` | `omk-book-to-skill` |
| `packages/initcheck`, `packages/promptguard` | Go modules, outside the npm workspaces and the lockstep version |
| `.omk/skills`, `.omk/extensions`, `.omk/prompts` | project-local skills, extensions, and prompt templates discovered from a checkout — see [`SKILLS.md`](SKILLS.md) |
| `specs/` | constitution and spec-kit artifacts |
| `scripts/` | release, publish, and repository guards |
| `.github/` | CI workflows and per-release notes |

User-facing documentation lives in `packages/coding-agent/docs/`. The root `docs/` tree is
git-ignored working material: never link to it from a tracked file, because such a link
resolves on this disk and breaks in a fresh clone.

## Commands

Node `>=22.19.0`, npm `11.14.1`.

| Task | Command |
| --- | --- |
| Install | `npm install --ignore-scripts` |
| Lint, format, typecheck, guards | `npm run check` |
| Tests (non-e2e) | `./test.sh` |
| One test file | `node ../../node_modules/vitest/dist/cli.js --run test/x.test.ts` |
| Go modules | `go test ./...` inside `packages/initcheck` or `packages/promptguard` |
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

## Generated model catalogs

`packages/ai/src/models.generated.ts` and `image-models.generated.ts` are committed
artifacts. Never hand-edit them: change the generators under `packages/ai/scripts/`, then
run `npm run models:refresh` as its own reviewed change. The generators read live provider
APIs, so a model can disappear from the diff because an endpoint was unreachable rather
than retired — read the diff before committing it. Releases never regenerate them.

A user overlay at `~/.omk/agent/models.json` overrides the built catalog per provider at
runtime. When a model's metadata looks wrong in a running session, check that overlay
first, and restart the process after changing either layer.

## Adding a provider

Follow [`.omk/skills/add-llm-provider.md`](.omk/skills/add-llm-provider.md) in order: core
types, provider module, lazy registration in `register-builtins.ts`, credential detection,
model generation, tests, coding-agent wiring, docs. A new provider must appear in
`packages/ai/test/stream.test.ts` with at least one representative model even when it
reuses an existing API implementation, plus the wider matrix (`tokens`, `abort`, `empty`,
`context-overflow`, `cross-provider-handoff`, and the rest) wherever it applies. Gate
live-credential cases behind `describe.skipIf` on that provider's own environment
variable so a keyless run still passes.

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

This repository can carry a generated `openwiki/` evidence index. It is optional just-in-time context, not required startup reading, and it may be absent — a scheduled workflow regenerates it.

- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.
- Do not treat an `interrupted` corpus as context unless `openwiki/.manual-review.json` binds a review to the current corpus digest; `scripts/check-openwiki.mjs` enforces this.
- Judge wiki freshness by `openwiki/.last-update.json` `gitHead` against current `HEAD`; claims from an older head need re-verification against source before use.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->

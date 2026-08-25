# OMK Project Constitution

## Canonical Runtime Source

The canonical source tree for the installed local OMK launcher is `/home/yu/omk`. The launcher at `/home/yu/.omk/agent/bin/omk` resolves to `/home/yu/omk/packages/coding-agent/dist/cli.js` through `/home/yu/.omk/agent/lib/omk-canonical-launcher.cjs`.

When a change must affect the running OMK TUI, apply it under `/home/yu/omk`, not a separate checkout such as `/home/yu/open-multi-agent-kit`, and rebuild the affected package so `dist/` matches `src/`.

## Owner-Private Agent Home

`/home/yu/.omk/agent` is the owner's private agent home: the personal skills, agents, prompts, patches, session data, and research corpora of `dmae97`. It is machine-local, separately versioned, and MUST NOT reach this repository, its releases, or any published npm tarball — not as a copy, a vendored tree, a drifted duplicate, or a quoted excerpt.

The repository's own `AGENTS.md` carries this project's rules and nothing else. The global operating manual stays at `~/.omk/agent/AGENTS.md` and is never mirrored here; a fresh clone MUST be complete without it.

`scripts/check-private-agent-home.mjs` enforces the boundary on every `npm run check`: declared private artifacts stay git-ignored and untracked, no tracked file carries the private operating-stack signature, and no tracked file duplicates a private agent-home document. Publishable content is authored under `packages/**`, `.omk/skills/**`, `specs/**`, and the root docs. Promoting a private skill to public content is a deliberate port, reviewed for secrets, credentials, and personal paths first.

## CLI Harness Leadership Target

OMK MUST target state-of-the-art quality as a CLI coding-agent harness. This is a product objective, not a current-status claim. The target applies to the harness layer—task completion, cost, latency, context and tool efficiency, orchestration, safety, recovery, reliability, and maintainability—not to base-model quality alone.

Every harness-affecting specification created or materially revised on or after 2026-08-25 MUST classify its impact as `advance`, `preserve`, or `not applicable`. Earlier specs are grandfathered until materially revised. An `advance` specification MUST name a versioned baseline, measurable acceptance target, regression floor, exact verification command, and evidence artifact. A `preserve` specification MUST identify the metrics that cannot regress. A `not applicable` classification MUST explain why.

Comparative evaluation MUST hold the same model, same provider and model configuration, same task and revision, same budget, equivalent tool permissions, and comparable environment constant. Reports MUST freeze the dated, named comparison cohort and statistical confidence rule before execution, then provide reproducible evidence sanitized to the operator's data-authority scope. Self-scores, feature counts, test counts, and roadmap projections do not prove leadership. Public claims such as “state of the art,” “best,” “leading,” or “#1” require that controlled evidence; otherwise use “targets.”

Benchmark artifacts MUST NOT expose secrets, credentials, private prompts, proprietary source, raw tool output, environment values, personal data, or absolute user paths. Public reports use public or synthetic tasks unless the data owner explicitly approves sanitized publication. Raw restricted evidence stays local or in an access-controlled store with declared retention. Path normalization, secret/PII scanning, and human review are mandatory before publication.

The measurement, privacy, and claim protocol is defined in `packages/coding-agent/docs/metrics.md`.

## Runtime Change Rule

For coding-agent TUI behavior changes:

1. Update `packages/coding-agent/src/**` in `/home/yu/omk`.
2. Update user-facing docs under `packages/coding-agent/docs/**` when commands or workflows change.
3. Add or update targeted tests under `packages/coding-agent/test/**`.
4. Run the targeted test.
5. Run `npm run check` from `/home/yu/omk`.
6. If the user requested runtime application, run `npm run build` from `/home/yu/omk` so `packages/coding-agent/dist/**` is refreshed.
7. Restart the OMK TUI before checking interactive slash commands.

## Slash Command UX Rule

Model selection and thinking-level selection are coupled for interactive use. `/model` changes the model and then routes to the thinking selector. `/think` opens the thinking selector directly, and `/think <level>` sets a valid available level without opening the selector.

## Versioning and Release

All workspace packages share one lockstep version; `patch` covers fixes and additions, `minor` covers breaking changes, and there are no major releases. The OMK `0.90.x` line is OMK-native: upstream `badlogic/pi-mono` tags are not release targets and version parity with upstream is not a goal.

A release is complete only when three surfaces agree: the `vX.Y.Z` tag reachable from `main`, the GitHub Release, and npm `latest` for all seven public lockstep packages: `open-multi-agent-kit`, `omk-ai`, `omk-agent-core`, `omk-tui`, `omk-protocol`, `omk-adaptorch-wpl`, and `omk-book-to-skill`. The `omk-adaptorch-wpl` npm package is an open-source OMK runtime component; it is distinct from the proprietary AdaptOrch.com service. Never bump versions past a release tag whose commits are not merged into `main`.

npm publishing runs in CI (`build-binaries.yml`, `publish-npm` job, environment `npm-publish`, OIDC trusted publishing). The publish helper is idempotent: after a failed publish, fix the cause and rerun the tag workflow; never rerun the release script for the same version. Released changelog sections are immutable; new work goes under `[Unreleased]`, and a `/cl` audit precedes every release. Release-facing docs (README badges/links, `.github/RELEASE_NOTES_vX.Y.Z.md`) update in the same cycle as the version bump, guarded by `scripts/check-release-consistency.mjs`.

## Safety and Evidence

Do not read or copy secrets into spec-kit artifacts. Keep evidence to command names, exit status, changed paths, and concise summaries.

## Governance

`specs/constitution.md` and `specs/templates/` are the authored sources of truth. `.speckit/preset/` is the tracked, project-scoped distributable mirror referenced by `.speckit/config.yaml`; CI MUST verify byte parity and the matching preset version. `.specify/` and user-global presets are generated caches, never authority and never required by a clean checkout.

Local cache synchronization MUST flow one way from the tracked project sources. Reject symlinked or non-user-owned targets, write through a temporary file and atomic rename, and verify the content digest. Never reverse-sync generated state. Constitution amendments require corresponding template and constitution-test updates when they change specification obligations.

**Version**: 1.2.0 | **Ratified**: 2026-06-25 | **Last Amended**: 2026-08-25

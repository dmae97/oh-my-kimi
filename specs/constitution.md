# OMK Project Constitution

## Canonical Runtime Source

The canonical source tree for the installed local OMK launcher is `/home/yu/omk`. The launcher at `/home/yu/.omk/agent/bin/omk` resolves to `/home/yu/omk/packages/coding-agent/dist/cli.js` through `/home/yu/.omk/agent/lib/omk-canonical-launcher.cjs`.

When a change must affect the running OMK TUI, apply it under `/home/yu/omk`, not a separate checkout such as `/home/yu/open-multi-agent-kit`, and rebuild the affected package so `dist/` matches `src/`.

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

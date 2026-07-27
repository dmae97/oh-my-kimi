# OMK v0.94.1

OMK v0.94.1 is a patch release published to npm as `open-multi-agent-kit@0.94.1` (lockstep with `omk-ai`, `omk-agent-core`, `omk-tui`, and `omk-adaptorch-wpl`) with prebuilt binaries attached to the GitHub release.

## Highlights

| Area | What changed |
| --- | --- |
| GitHub star nudge | Interactive startup remembers whether this install confirmed a star via global `githubStarred` in `~/.omk/agent/settings.json`. Fresh installs and unstarred operators see a nag banner every launch with the repo link until they star https://github.com/dmae97/omk and run `/star`. `/star reset` brings the nag back. Project settings cannot silence it. |

## Install

```bash
npm install -g open-multi-agent-kit --ignore-scripts
omk --version   # 0.94.1
```

## Verification boundary

Focused star-nudge unit tests pass. `npm run check` (biome, pinned-deps, vendored-skills, ts-imports, release-consistency, readme-releases, doc-links, release-surface, shrinkwrap, browser-smoke) is the release gate. Live-provider e2e tests and other operating systems remain outside this release's verification boundary.

## Migration and rollback

- No breaking behavior change outside the new optional startup banner and `/star` command.
- After starring, run `/star` once so `githubStarred: true` is written globally and the banner stops.
- Roll back with `npm install -g open-multi-agent-kit@0.94.0 --ignore-scripts`.

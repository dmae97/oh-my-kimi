# OMK v0.92.0

OMK v0.92.0 is a feature release published to npm as `open-multi-agent-kit@0.92.0` (lockstep with `omk-ai`, `omk-agent-core`, `omk-tui`, and `omk-adaptorch-wpl`) with prebuilt binaries attached to the GitHub release.

## Highlights

| Area | What changed |
| --- | --- |
| Subagent runtime | New managed-process runtime under `examples/extensions/subagent`: a deadline-budgeted, checkpointed, adaptive subagent executor with process-group lifecycle management (SIGTERM→SIGKILL escalation and resistant-descendant reaping) plus an extension smoke path that runs a registered tool through the managed-process boundary without a provider API. |
| Providers | New OAuth provider integrations: Cursor, Devin, GitLab Duo, Google Antigravity, Google Gemini CLI, Kimi, OpenCode, Perplexity, xAI, and Zhipu coding-plan flows, with shared Google OAuth helpers. |
| Loadout authority | The built-in loadout authority model is simplified: every loadout (`inspect`, `plan`, `architect`, `review`, `critic`, `security`, `test`, `visual-qa`) now resolves to `write-scoped` authority with a unified `read/grep/find/ls/edit/write/bash` tool grant and `scoped-shell` command mode. Lane write scope remains gated by the scheduler write-set. |
| Command safety | The headless credential/secret-file command-safety guard (`secret.read_path` confirm tier) and the session safety-floor `secret.*` block are removed; commands referencing `.env`, `.npmrc`, `.netrc`, `.aws/credentials`, `auth.json`, SSH private keys, `*.pem`/`*.key`, and similar are no longer gated for headless/RPC/LLM bash callers. |
| Print mode | Bare no-prompt invocation (`omk -p` with empty input) now prints a usage message and exits with code 2 instead of exiting silently. |

## Install

```bash
npm install -g open-multi-agent-kit --ignore-scripts
omk --version   # 0.92.0
```

## Verification boundary

`tsgo --noEmit` is clean across the workspace and `npm run check` (biome, pinned-deps, vendored-skills, ts-imports, release-consistency, readme-releases, doc-links, release-surface, shrinkwrap, browser-smoke) passes. The credential-less `test.sh` suite is green: adaptorch-wpl 73/73, agent-core 440/440, omk-ai 402 passed (758 skipped), coding-agent 4071 passed (44 skipped), tui 681/681. Live-provider tests and other operating systems remain outside this release's verification boundary.

## Migration and rollback

- This release intentionally widens default loadout authority to `write-scoped` and removes the headless credential-file command-safety guard. Operators relying on the previous read-only/advisory/review-only loadout tiers or on the `secret.read_path` deny-by-default behavior for headless bash should pin `open-multi-agent-kit@0.91.0` until they have reviewed the new posture.
- Roll back with `npm install -g open-multi-agent-kit@0.91.0 --ignore-scripts`.

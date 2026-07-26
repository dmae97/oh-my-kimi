# OMK v0.93.0

OMK v0.93.0 is a feature release published to npm as `open-multi-agent-kit@0.93.0` (lockstep with `omk-ai`, `omk-agent-core`, `omk-tui`, and `omk-adaptorch-wpl`) with prebuilt binaries attached to the GitHub release.

## Highlights

| Area | What changed |
| --- | --- |
| Upstream Pi 0.82.0 ports | Bash session environment (`PI_SESSION_ID`/`PI_SESSION_FILE`/`PI_PROVIDER`/`PI_MODEL`/`PI_REASONING_LEVEL` for the LLM-callable bash tool), `bash_execution_update` RPC streaming events, summarization resilience (retry with exponential backoff, prompt caching disabled, fresh routing session IDs), and abortable provider retries in `omk-ai` with retry-after fail-fast and transient-error classification. |
| Subagent capabilities | Agent frontmatter may declare `skills`/`mcp`/`hooks` plus `enforceCapabilities: true` to spawn the subprocess with `--no-skills` + resolved `--skill` paths. `parseEnforceFlag` now parses YAML booleans/numbers/strings correctly, the skill-catalog scan skips archived corpus trees (e.g. `system-prompts-leaks`), the MCP allowlist is synced to the live configured server set, and the deterministic capability router gains OMK-native domain profiles. 16 coercion unit tests included (`examples/extensions/subagent/agents.test.ts`). |
| Compaction provenance fix | Persisted compaction envelope validation no longer rejects sessions compacted two or more times. The writer attests the kept-window slice from the previous compaction's `firstKeptEntryId`, but reopen validation required the full parent branch, so every twice-compacted session crashed on open with `Invalid compaction envelope source`. Validation now accepts either exact form (tamper-evidence unchanged); regression tests in `test/session-file-compaction-window.test.ts`. |
| Reasoning router v4 | Router weight calibration tooling (`scripts/reasoning-router/`), Korean-morphology / quoted-speech / inert-weights regression suites, and accuracy updates. |
| TUI | Status sidebar component with MCP roster rendering, control-panel layout/runtime-status updates, and overlay/gutter behavior fixes. |

## Install

```bash
npm install -g open-multi-agent-kit --ignore-scripts
omk --version   # 0.93.0
```

## Verification boundary

`tsgo --noEmit` is clean across the workspace and `npm run check` (biome, pinned-deps, vendored-skills, ts-imports, release-consistency, readme-releases, doc-links, release-surface, shrinkwrap, browser-smoke) passes. The subagent extension suite is green (59/59, 8 files) and the non-live compaction suites pass, including the new window-provenance regression tests. Live-provider e2e tests (OAuth-gated) and other operating systems remain outside this release's verification boundary.

## Migration and rollback

- Sessions that previously failed to open with `Invalid compaction envelope source` open cleanly again; no data migration is required.
- Roll back with `npm install -g open-multi-agent-kit@0.92.0 --ignore-scripts`.

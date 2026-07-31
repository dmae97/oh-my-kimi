# OMK v0.95.0

OMK v0.95.0 is a feature release published to npm as `open-multi-agent-kit@0.95.0`, in lockstep with `omk-ai`, `omk-agent-core`, `omk-tui`, and `omk-adaptorch-wpl`. Prebuilt binaries are attached to the GitHub release.

## Highlights

| Area | What changed |
| --- | --- |
| OAuth accounts | `/login` can add and explicitly select multiple subscription accounts per provider. Refresh, selection, and logout updates remain provider-scoped and file-lock protected. |
| Subscription usage | The status rail shows every configured Codex, Claude, Kimi Code, and GLM/ZAI subscription with independent windows and reset times. Missing windows are not estimated. |
| Passive quota signals | Codex `x-codex-*` and `codex.rate_limits` signals and Claude unified 5-hour/7-day headers merge through a non-blocking observer. Claude's one-token fallback runs only after usage-endpoint throttling, with account-scoped cooldown and timeout controls. |
| Image resilience | Anthropic-bound PNG, JPEG, GIF, and WebP inputs receive a final 1,900 px dimension guard, including clipboard and tool-result paths. |
| Session reliability | Cancelled compaction restores queued input without duplicate messages or a stale compaction notice. |
| Project trust | Persistent startup star prompts and automatic contributor issue/PR closure were removed. READMEs are text-first, obsolete media was removed, and release workflows use immutable Node 24 action revisions. |

## Provider boundaries

- Qwen Model Studio Token Plan is labeled `QWEN TOKEN PLAN` with `console-only quota`; its official usage endpoint requires an Alibaba Cloud console session and is not called with a plan API key.
- Qwen OAuth and Grok remain explicit `quota API unavailable` entries until a verified programmatic quota API exists.
- Authenticated quota calls use fixed HTTPS provider origins. Passive quota callbacks do not delay model streams.
- `/logout` removes all locally stored accounts for the selected provider. Environment variables and custom provider configuration are unchanged.

## Install

```bash
npm install -g open-multi-agent-kit@0.95.0 --ignore-scripts
omk --version
```

## Verification

The release candidate passed:

- clean `npm ci --ignore-scripts`
- full monorepo build and `npm run check`
- full hermetic workspace test suite
- `npm audit --omit=dev --audit-level=moderate` with zero vulnerabilities
- `npm run publish:dry`
- isolated local package install and Linux x64 binary smoke tests
- GitHub CI on the exact pre-release commit

Live-provider tests remain opt-in through `LIVE_E2E=1`; no live provider request is part of the default release gate.

## Migration and rollback

Existing single-account OAuth credentials continue to load without migration steps. A legacy `githubStarred` setting is ignored because interactive startup no longer displays a star prompt.

Roll back with:

```bash
npm install -g open-multi-agent-kit@0.94.1 --ignore-scripts
```

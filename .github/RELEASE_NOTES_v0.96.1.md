# OMK v0.96.1

OMK v0.96.1 is a patch release published in lockstep as `open-multi-agent-kit`, `omk-ai`, `omk-agent-core`, `omk-protocol`, `omk-adaptorch-wpl`, `omk-book-to-skill`, and `omk-tui`.

## Highlights

| Area | What changed |
| --- | --- |
| Harness safeguards | Built-in identical-loop detection, real `AgentMessage` tool-pair repair, model prompt presets, bounded output spill, and cached sandbox backend diagnostics |
| Durable execution | Working-directory durable goals now support checkpointed continuation plus explicit pause, resume, evidence-gated completion, and clear transitions |
| Advisory selection | Best-of-N judging admits deterministic passes only, redacts candidate material, binds material and evaluation digests, and falls back deterministically |
| Session automation | `omk sdk session status\|tail\|inspect\|send` supports scripted inspection and exact-ID writes, rejects ambiguous selectors, respects live ownership, and redacts credential-shaped output |
| Native xAI | Grok 4.6/4.5/4.3 use native `xai` thinking mappings and OAuth-only weekly SuperGrok usage; OAuth requests are locked to the official xAI API origin |
| Public identity | The README now explains Scope → Route → Verify → Replay with a GPT Image 2-generated OMK Girl hero, a slow accessible feature GIF, and a root brand design system |

## Security and correctness

- Truncated read output now goes to a unique `0700` OS temporary directory and an exclusive `0600` file. Source-adjacent paths and symlinks are never used as write destinations.
- Tool-pair repair now recognizes assistant `toolCall` blocks and top-level `role: "toolResult"` messages instead of the legacy Anthropic-shaped `tool_use`/`tool_result` approximation.
- xAI OAuth model rewriting runs after custom provider/model overrides and restores `https://api.x.ai/v1`, preventing bearer-token forwarding to custom origins. `XAI_API_KEY` remains a separate API-billing credential source.
- Advisory request provenance now binds each candidate's parsed `EvaluationResult` digest in addition to its redacted material digest.
- Session CLI output redacts credential-shaped transcript content before human or JSON rendering.
- The transitive development dependency `nanoid` is pinned to 3.3.18, clearing GHSA-2v37-7h3g-55p8 from full and production npm audits.

## Install

```bash
npm install -g open-multi-agent-kit@0.96.1 --ignore-scripts
omk --version
```

## Verification

Local release evidence on 2026-08-20:

- `npm ci --ignore-scripts`, all seven workspace builds, `npm run check`, and `dist/verify-ci.js` passed.
- The complete workspace suite passed twice consecutively: 6,357 tests passed and 819 credential/live-environment tests skipped per run; no failures or unhandled worker errors.
- Go initcheck passed `go vet`, race-enabled shuffled tests, and the Ghidra-debug binary verification.
- `npm run publish:dry` validated every public package; `npm run release:local` packed all seven tarballs, built the Linux x64 binary archive, and installed the packages in isolated npm and Bun environments.
- Packed Node, Bun, and native binary CLIs all reported `0.96.1` and rendered help successfully.
- Full and production-only npm audits both reported zero vulnerabilities.
- GPT Image 2 prompts passed the prompt validator; generated PNG/GIF assets were inspected directly and the README was rendered in headless Chrome at mobile, tablet, and desktop screenshot widths.

## Migration

The retired `grok-oauth-proxy` provider is removed. Use native `xai` OAuth for SuperGrok/X Premium+ subscriptions or `XAI_API_KEY` for xAI API billing. Stale proxy credentials and model entries are ignored or removed from the visible provider surface.

No migration is required for durable goals, advisory judging, session SDK commands, or the README assets; these are additive. Existing session and replay formats remain readable.

## Rollback

```bash
npm install -g open-multi-agent-kit@0.96.0 --ignore-scripts
```

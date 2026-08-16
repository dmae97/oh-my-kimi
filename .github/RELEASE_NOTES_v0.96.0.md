# OMK v0.96.0

OMK v0.96.0 is a minor release published to npm as `open-multi-agent-kit@0.96.0`, in lockstep with `omk-ai`, `omk-agent-core`, `omk-tui`, `omk-adaptorch-wpl`, and the two new packages `omk-protocol` and `omk-book-to-skill`.

## Highlights

| Area | What changed |
| --- | --- |
| Run protocol | New `omk-protocol` package owns the versioned `TaskSpec -> ExecutionAttempt -> Observation -> EvaluationResult -> RuntimeDecision` contract, runtime validators, explicit waivers, and pure reducers |
| Document skills | New optional `omk-book-to-skill` package compiles documents into reusable skills with SHA-256 source and artifact provenance, without adding Python dependencies to OMK core |
| Model catalog | Added GLM-5.3, Gemini 3.7 Flash, and Grok 4.6; thinking-level metadata is now derived from upstream `reasoning_options` instead of per-version hardcoding |
| Provider resilience | Quota and billing-cycle failures classify as `provider.rate_limit` and can fail over to a configured authenticated model before retry |
| Replay integrity | New replay events use versioned RFC 8785 canonical payload hashing; legacy ledgers stay readable and exportable without rewriting |
| Test depth | Deterministically seeded, bounded `fast-check` property suites cover WPL transitions, replay migration and CAS, evidence freshness, subagent topology, run-journal CAS, and timeout races |

## New models

`glm-5.3` is registered for the Z.AI coding-plan endpoints (`zai`, `zai-coding-cn`) and OpenCode Go with a 1M context window and reasoning effort up to `max`. Upstream currently publishes it only on the coding-plan surface, so it is intentionally absent from the plain Z.AI and OpenRouter catalogs.

`gemini-3.7-flash` is registered for `google`, `google-vertex`, `openrouter`, `github-copilot`, `vercel-ai-gateway`, and `opencode`.

`grok-4.6` is registered for `xai`, `openrouter`, `vercel-ai-gateway`, `github-copilot`, and `opencode`.

## Thinking-level correctness

Top thinking tiers are only exposed when a model explicitly maps them, so an unmapped model silently clamps down. Two gaps are fixed:

- The GLM reasoning-effort gate now matches GLM-5.2 **and later** instead of hard-coding 5.2, so future GLM-5.x minor releases inherit `max` thinking without another code change. `glm-5`, `glm-5-turbo`, and `glm-5.1` stay excluded because they do not accept `reasoning_effort`.
- Grok 4.6 exposed no thinking map, so `/thinking xhigh` clamped to `high` on every provider. The generator now reads models.dev `reasoning_options` and maps `xhigh` only for Grok models that advertise it, leaving `grok-4.5` and `grok-4.3` capped at `high`.

## Install

```bash
npm install -g open-multi-agent-kit@0.96.0 --ignore-scripts
omk --version
```

## Verification

- Monorepo formatting, lint, type, release-surface, documentation, and browser-smoke checks
- Workspace build across all seven packages
- `packages/ai`: 463 passed, 770 skipped (credential-gated live-API suites)
- Root `tsgo --noEmit` clean
- Production dependency audit (`npm audit --omit=dev --audit-level=high`): 0 vulnerabilities

## Migration and rollback

No configuration migration is required. `omk-protocol` is additive: the legacy mutable `EvidenceStatus` and `TaskContract` verdict APIs remain compatible but are deprecated. `omk-book-to-skill` is optional and is not installed as part of the core runtime.

Roll back with:

```bash
npm install -g open-multi-agent-kit@0.95.2 --ignore-scripts
```

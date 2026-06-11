# Changelog

## [Unreleased]

### Fixed

- Fixed NVIDIA NIM Qwen turns failing with `400 Validation: Unsupported parameter(s): enable_thinking`. NIM's chat-completions schema is `additionalProperties: false` and exposes thinking via the vLLM convention `chat_template_kwargs.enable_thinking`; `buildOpenAICompat` was sending top-level `enable_thinking` for every `qwen/*` id regardless of host. Registered `nvidia` as a known host (`integrate.api.nvidia.com`) and routed NVIDIA-hosted Qwen models to `thinkingFormat: "qwen-chat-template"` ([#2299](https://github.com/can1357/oh-my-pi/issues/2299)).
- Fixed Moonshot/Kimi native OpenAI-compatible request metadata so Kimi K2 uses `max_tokens` and omits OpenAI-only `store`, restoring first-turn output with `MOONSHOT_API_KEY` ([#2289](https://github.com/can1357/oh-my-pi/issues/2289)).

## [15.11.0] - 2026-06-10

### Fixed

- Fixed `buildModel` so malformed explicit thinking metadata without `efforts` is treated as sparse input and inferred instead of crashing during model resolution ([#2251](https://github.com/can1357/oh-my-pi/issues/2251)).

## [15.10.12] - 2026-06-10

### Added

- Added `grok-composer-2.5-fast` (Cursor "Composer 2.5 Fast") to the xAI Grok OAuth (SuperGrok) catalog: non-reasoning, text-only, 200K context.

### Changed

- Set every xAI Grok OAuth (SuperGrok) curated model's max output tokens to mirror its context window (`grok-build`, `grok-4.3`, `grok-4.20-0309-{reasoning,non-reasoning}`, `grok-4.20-multi-agent-0309`, `grok-composer-2.5-fast`), replacing the `8888` `UNK_MAX_TOKENS` placeholder (and a stale `30000` on three grok-4.x entries). xAI's OAuth `/v1/models` reports no per-request output limit, so the curated catalog now owns `maxTokens` like `contextWindow`, deterministic on both the static-seed and online-overlay paths; the `openai-responses` wire still clamps the actual request to `OPENAI_MAX_OUTPUT_TOKENS` (64k).

### Fixed

- Excluded zero-cost `xai-oauth` subscription entries from the model reference indexes (`buildModelReferenceIndex`, `createReferenceResolver`), so their zero pricing and context-window-sized `maxTokens` cannot outrank paid/public Grok references when resolving custom-provider model identities.

## [15.10.11] - 2026-06-10

### Added

- Added `hostMatchesUrl`, `modelMatchesHost`, and endpoint-shape helpers in the new `hosts` module for consistent provider/baseUrl matching
- `buildModel(spec)` (`build.ts`) is now the single Model constructor: it materializes the fully-resolved compat record and canonical thinking metadata exactly once (compat first, thinking derived from identity + resolved compat), so `Model.compat` is a required, complete `CompatOf<TApi>` (`ResolvedOpenAICompat`/`ResolvedOpenAIResponsesCompat`/`ResolvedAnthropicCompat`) and request-path code reads fields with zero URL parsing and zero per-request allocation. Sparse user/config overrides live on the new `ModelSpec<TApi>` input shape and survive on `Model.compatConfig` for introspection.
- Added `ResolvedAnthropicCompat.supportsSamplingParams` (Opus 4.7+/Fable/Mythos reject `temperature`/`top_p`/`top_k` with a 400), baked at build time from model identity so the request path stops re-parsing model ids.
- Compat detection gained model-time flags so handlers stop sniffing baseUrl: completions `supportsReasoningParams`, `alwaysSendMaxTokens`, `isOpenRouterHost`, `isVercelGatewayHost`, `streamIdleTimeoutMs`, and a precomputed `whenThinking` alternate view (OpenCode `reasoning_content` gating, #1071/#1484); responses `strictResponsesPairing`, `supportsLongPromptCacheRetention`, `supportsReasoningEffort`; anthropic `officialEndpoint`, `requiresToolResultId`, `replayUnsignedThinking`.
- New `@oh-my-pi/pi-catalog` package: the model catalog extracted from `@oh-my-pi/pi-ai`. Owns the bundled `models.json` and its generation pipeline (`scripts/generate-models.ts`), the core model data types (`Model`, `Api`, `ThinkingConfig`, `Effort`, `Usage`, compat interfaces), thinking metadata enrichment and generated policies (`model-thinking.ts`), the SQLite model cache and model manager, per-provider discovery factories (`provider-models/`), the discovery protocol clients (`discovery/`), and the new `CATALOG_PROVIDERS` table — the single source of truth for provider ids, default models, and discovery wiring (`KnownProvider`, `PROVIDER_DESCRIPTORS`, and `DEFAULT_MODEL_PER_PROVIDER` are derived from it).
- New `identity/` module centralizing model-identity concerns that were previously duplicated across packages: family classification and version parsing (`identity/classify.ts`, extracted from pi-ai's `model-thinking` internals), canonical model equivalence with injected reference data (`identity/equivalence.ts`, from coding-agent's `model-equivalence`), proxy/reseller reference lookup (`identity/reference.ts`, from coding-agent's `model-registry`), bracket-affix and id-segment helpers (`identity/id.ts`), a single trailing-marker vocabulary with canonical vs reference flavors (`identity/markers.ts` — `search` stays reference-only so Perplexity's `sonar-pro-search` remains canonical-distinct), and provider priority ordering (`identity/priority.ts`).
- Memoized bundled-reference accessors (`getBundledCanonicalReferenceData` / `getBundledModelReferenceIndex` in `identity/bundled.ts`): one lazy walk of the bundled catalog feeds both canonical equivalence and proxy-reference lookup, so consumers no longer hand-roll the glue.
- `identity/selection.ts`: pure canonical-variant selection (`resolveCanonicalVariant`, `buildCanonicalModelOrder`, `CanonicalVariantPreferences`) extracted from the coding-agent registry — provider rank, then exact-id match, variant source, id length, and candidate order.

### Changed

- Changed OpenAI compatibility detection to use shared host classifiers (`modelMatchesHost`/`hostMatchesUrl`) with normalized matching instead of raw URL substring checks
- Changed `hostMatchesUrl`/`modelMatchesHost` usage in compatibility detection to reduce mismatches across case variants and provider alias hosts
- Provider catalog entries now carry the runtime API-key env fallback as an ordered `envVars` list; `catalogDiscovery.envVars` became an optional generation-time override (only `cursor` and `vercel-ai-gateway` differ) and `PROVIDER_DESCRIPTORS` materializes the resolved list for `generate-models.ts`.
- `Model`'s api parameter now defaults to `Api` instead of `any` (`Model<TApi extends Api = Api>`), so bare `Model` no longer behaves as `Model<any>` at call sites.
- `ThinkingConfig` is now explicit and total: an ordered `efforts` array replaces the `minLevel`/`maxLevel`/`levels` range encoding, and the wire facts are baked alongside it — `effortMap` (anthropic-adaptive 4-tier vs 5-tier scale, shared with the OpenRouter completions remap) and `supportsDisplay` (adaptive `display` field support). Explicit spec thinking owns the capability surface (`mode`/`efforts`/`defaultLevel`) and wins over inference; missing wire facts are backfilled from identity so configs never need to know Anthropic's tier tables. Reasoning models that reject the wire effort param (`compat.supportsReasoningEffort: false` on openai-responses*) are encoded as `thinking: undefined` ("thinks, no control surface") instead of the removed `modelOmitsReasoningEffort` special case. `models.json` was re-baked in the new vocabulary behind a 3196-model behavioral parity gate, and the model cache schema bumped to v4 to invalidate old-shape rows.
- `mapEffortToGoogleThinkingLevel(effort)` is now a static map (model parameter dropped — validation stays at the `requireSupportedEffort` call sites), and `mapEffortToAnthropicAdaptiveEffort` reads the baked `thinking.effortMap` instead of re-classifying the model id per request.
- Generator-only policy code moved out of the runtime bundle into `scripts/generated-policies.ts`: `applyGeneratedModelPolicies` (now policy fixups + thinking re-bake via the shared deriver), `linkOpenAIPromotionTargets`, the Copilot context-window table, minimax/opencode-go compat fixups, and `CLOUDFLARE_FALLBACK_MODEL`. The anthropic id predicates (`hasOpus47ApiRestrictions`, `supportsMidConversationSystemMessages`, `isAnthropicFableOrMythosModel`) moved to `identity/family` for build-time use by the compat/thinking derivers only.

### Fixed

- Fixed Anthropic official-endpoint detection to require strict HTTPS hostname matching so non-official or lookalike URLs are no longer treated as official Anthropic hosts
- Fixed Ollama Cloud dynamic discovery so same-id matches from other providers no longer supply context-window or max-output-token limits for discovered models.
- Wired `@oh-my-pi/pi-catalog` into the release publish package list, tarball install smoke test, and root `bun generate-models` script.
- Fixed `supportsAdaptiveThinkingDisplay` only matching dash-form version ids: dotted ids (`claude-opus-4.7`) now classify through `identity/classify` like every other anthropic predicate, so six bundled dotted Opus 4.7/4.8 entries (github-copilot, vercel-ai-gateway, zenmux) regain adaptive `display` support; bare dated ids (`claude-opus-4-20250514` = Opus 4.0) stay excluded.
- Fixed the OpenRouter anthropic adaptive-effort map misclassifying bare dated Opus ids (`claude-opus-4-20250514` parsed as version 4.20 → wrongly adaptive); the map now derives from the shared classifier and the shared 4-/5-tier tables.

### Removed

- Removed the runtime enrichment layer: `enrichModelThinking` (and its non-enumerable memo-slot cache), `refreshModelThinking`, `modelOmitsReasoningEffort`, and the `model-thinking` re-exports of generator-only policies. Thinking metadata is resolved exactly once inside `buildModel`; runtime helpers (`getSupportedEfforts`, `clampThinkingLevelForModel`, `requireSupportedEffort`, the effort mappers) are pure field reads.

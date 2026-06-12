# Changelog

## [Unreleased]

### Fixed

- Fixed Antigravity `gemini-3.1-pro --thinking high` failing with `Cloud Code Assist API error (400): Request contains an invalid argument.` — the upstream `gemini-3.1-pro-high` deployment rejects every `streamGenerateContent` request on both CCA endpoints while discovery still advertises it. High effort now routes to `gemini-pro-agent` (the same "Gemini 3.1 Pro (High)" model, verified accepting the identical request body), and the model-cache fingerprint version was bumped (`merge-v2` → `merge-v3`) so existing fresh caches refetch discovery and pick up the corrected routing immediately.

## [15.11.7] - 2026-06-12
### Added

- Added effort-tier variant collapsing (`variant-collapse`): providers that expose one logical model as several effort/thinking-suffixed upstream ids (Antigravity CCA `gemini-3.5-flash-extra-low`/`-low`/`gemini-3-flash-agent`, `gemini-3[.1]-pro-low|high`, `claude-*[-thinking]` pairs, `gpt-oss-120b-medium`) collapse into one logical entry carrying per-effort upstream routing in `thinking.effortRouting` (plus `thinking.suppressWhenOff` for Cloud Code Assist ids whose baked server default re-applies when `thinkingConfig` is omitted). Request-time code resolves the outbound id via `resolveWireModelId(model, effort)`; selection, caching, and usage attribution key on the logical id.
- Added the automatic `X`/`X-thinking` pair rule (`deriveThinkingPairFamilies`): any provider's live bare/thinking twin collapses into the bare id, routing thinking-enabled requests to the `-thinking` backing id (trailing or infix token, so `kimi-k2-thinking-turbo` pairs with `kimi-k2-turbo`). Gated on same api and compatible pricing — all-zero cost rows count as unknown, while twins that both carry real, differing prices remain separate SKUs.
- Added `collapseBuiltModelVariants` and wired collapsing at every materialization point — Antigravity discovery, the catalog generator, and the model-manager merge — so stale sources (old static beside collapsed dynamic results, mixed cache rows) converge on logical entries instead of unioning raw tier ids back into the catalog.
- Added `thinking.requiresEffort`, baked for reasoning-only upstreams — Gemini 3.x (levels only, no off), Gemini 2.5 Pro (thinkingBudget floors at 128, rejects 0), OpenAI o-series, MiniMax M2, and thinking-variant SKUs (`*-thinking`/`*-reasoner`/`*-reasoning`, with a negation-aware token grammar so `non-thinking` ids never match). Identity derivation bakes it for new entries and `fillThinkingWireDefaults` backfills explicit/cached metadata; `minimumSupportedEffort` exposes the canonical floor. Pair-collapsed twins drop member flags (their off routes to the bare SKU), while identity re-flags pairs whose logical id is itself mandatory

### Changed

- Changed model display names to drop model-extrinsic decorations: gateway author prefixes (`OpenAI: …`, `Google: …`), `(latest)` alias markers, `(Antigravity)` provider attribution, price tiers (`($$$$)`), and promo/lifecycle tags (`(20% off)`, `(retires …)`). `cleanModelName` is applied in `buildModel` (covers live discovery and stale caches) and as a catalog-generator pass; Antigravity discovery no longer appends `(Antigravity)` to display names. Variant tags that map to distinct wire ids (`(Thinking)`, `(free)`, `(Fast)`, dates, regions) are preserved.
- Changed the `google-antigravity` default model from `gemini-3-pro-high` to `gemini-3.1-pro`
- Changed `gemini-2.5-flash-thinking` handling from discovery-denylist to collapsing into `gemini-2.5-flash` (thinking-enabled requests route to the `-thinking` backing id)
- Bumped the model cache schema to v5 so rows predating effort-tier variant collapsing (raw `-low`/`-high`/`-thinking` member ids) are invalidated

### Fixed

- Fixed catalog generation to apply effort-tier variant collapsing before provider grouping to ensure collapsed model families are consistently materialized without being impacted by in-loop mutation
- Fixed Kimi K2.6 OpenAI-compatible compat metadata to use a 300s stream watchdog floor, covering Fire Pass router ids as well as public `kimi-k2.6` ids so long reasoning starts do not hit the generic first-event timeout ([#2366](https://github.com/can1357/oh-my-pi/issues/2366)).

## [15.11.4] - 2026-06-12

### Fixed

- Fixed MiniMax M2-family and OpenAI gpt-oss model metadata so OpenAI-compatible catalog entries declare only `low|medium|high` thinking efforts. Their upstreams reject `minimal`, `xhigh`, and Fireworks' `minimal → none` wire mapping, so `fireworks/minimax-m2.7` as the smol auto-thinking classifier model 400ed on every turn. OpenAI-compatible provider effort maps (`Groq qwen/qwen3-32b`, DeepSeek-family, OpenRouter Anthropic adaptive, Fireworks `minimal → none`) now bake into `thinking.effortMap` in catalog metadata instead of `buildOpenAICompat`, and request builders read that field directly. Regenerated `models.json` now makes `disableReasoning` choose `low` for those families while leaving GLM-5.x and other Fireworks models on the existing `minimal → none` path ([#2315](https://github.com/can1357/oh-my-pi/issues/2315)).
### Added

- Added `requiresJuiceZeroHack` Responses-API compat flag, resolved by `buildOpenAIResponsesCompat` from GPT-5-family model names and overridable via sparse model `compat` config. Replaces the request-time `model.name.startsWith("gpt-5")` sniff that gated the trailing `# Juice: 0 !important` no-reasoning developer item.

## [15.11.3] - 2026-06-11
### Added

- Added `requestModelId` on `Model` to represent the upstream model id used when a catalog entry is a local variant
- Added synthetic GitHub Copilot long-context model variants with `-1m` suffixes when tiered token pricing is advertised

### Changed

- Changed GitHub Copilot discovery to request `X-GitHub-Api-Version: 2026-06-01` from `api.githubcopilot.com`
- Changed GitHub Copilot discovery to cap base model `contextWindow` to the default token tier and keep long-context access as the separate `-1m` model entry
- Changed Copilot model mapping to omit non-chat `/models` entries and enable image input for models whose capabilities indicate vision support

### Fixed

- Fixed long-context variant pricing to use `billing.token_prices.long_context` rates instead of default model pricing
- Fixed `mapModel` handling in OpenAI-compatible discovery so returning `null` now skips a model entry rather than falling back to defaults
- Fixed model ID precedence so a real upstream Copilot model id is kept when it conflicts with a synthesized `-1m` variant

## [15.11.1] - 2026-06-11

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
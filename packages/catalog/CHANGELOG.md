# Changelog

## [Unreleased]

### Added

- Added GPT-5.6 Luna, Sol, and Terra entries for Amazon Bedrock, Azure, and Cloudflare
- Added KAT-Coder Air/Pro V2.5 entries across Kilo, OpenRouter, NanoGPT, and Vercel
- Added Inkling model entries for Baseten and Vercel AI Gateway
- Added Umans DeepSeek V4 Pro DSpark as an experimental model listing
- Added Claude Opus 4.7 Fast and 4.8 Fast on Vercel AI Gateway
- Added Workers AI GLM-5.2, Muse Spark 1.1, Stealth GPT-5.6 Sol, and nano-gpt-help entries

### Changed

- Added image input and reasoning support to several existing Codeium and Kilo GPT-5.6 models
- Enabled image input and reasoning for Gemini Flash Latest and Grok 4.5
- Renamed many model labels for consistency, including Claude, Grok, DeepSeek, GLM, and Gemi­ni names
- Updated pricing for many existing models, including input, output, and cache cost values
- Updated context window and max token limits for many catalog models across providers
### Fixed

- Fixed Z.AI (GLM) coding-plan token costs all showing as "Free" in `/models`: the `zai` provider descriptor sourced the models.dev `zai-coding-plan` key (all-$0 subscription rates) instead of the `zai` pay-as-you-go key, which carries the real per-token rates for the identical GLM ids ([#5598](https://github.com/can1357/oh-my-pi/issues/5598)).

## [16.5.2] - 2026-07-14

### Fixed

- Fixed OpenCode Zen and Go discovery to replace stale bundled models with each provider's live model catalog.

## [16.5.1] - 2026-07-14

### Fixed

- Fixed reasoning effort mapping for Z.ai GLM-5.2 on the Anthropic messages endpoint to correctly use the two-tier scale (high, max) and emit output_config.effort.
- Fixed an issue where stale cached model limits would override updated static catalog limits after a catalog fingerprint mismatch.
- Fixed Cursor discovery to correctly preserve GetUsableModels max-mode metadata for premium models and invalidate stale cache entries.

## [16.4.3] - 2026-07-11

### Fixed

- Fixed parsing of SAP AI Core Claude model IDs in version-first format (e.g., anthropic--claude-4.8-opus), restoring adaptive thinking metadata and capability gates.
- Fixed GitHub Copilot Business and Enterprise model discovery to correctly preserve vision capabilities instead of downgrading models to text-only.

## [16.4.2] - 2026-07-10

### Fixed

- Fixed OpenAI Codex model discovery to include the Codex version header alongside the client_version query parameter.

## [16.4.1] - 2026-07-10

### Added

- Added GPT-5.6 Luna, Sol, and Terra models
- Added perplexity-academic-researcher model

### Changed

- Updated context windows for multiple GPT-5.6 models
- Increased max tokens for several models
- Updated cache write costs for GPT-5.6 variants
- Reduced pricing for select models

### Removed

- Removed the generated GPT-5.6 pro-reasoning aliases (`gpt-5.6-{luna,sol,terra}-pro`) from the `openai-codex` subscription provider — pro reasoning is not offered on subscriptions; the `openai` API-key aliases remain

## [16.4.0] - 2026-07-10

### Breaking Changes

- Redesigned reasoning effort ladders to be wire-exact, removing the shifted five-tier effort mapping. Models now expose exactly the effort tiers their upstream APIs accept, mapped 1:1. Removed SHIFTED_FIVE_TIER_EFFORT_MAP, ANTHROPIC_ADAPTIVE_EFFORT_MAP_4_TIER, and per-host xhigh-to-max alias maps. Selecting an unsupported tier now automatically clamps down via clampThinkingLevelForModel. Devin effort routing is now mapped 1:1 onto per-tier siblings.

### Added

- Added support for new models: Grok 4.5 family, Dolphin Mistral 24b Venice Edition, GLM5.2-Fast, and Zenmux variants for GPT-5.6 (Luna, Sol, and Terra).
- Added Novita as a model provider, including public catalog discovery, pricing, limits, modality, reasoning, and tool metadata.
- Added useResponsesLite to Model and ModelSpec to support the Responses Lite transport, enabled by default for the GPT-5.6 family.
- Added Effort.Max ("max") as a first-class user-facing thinking level above xhigh.

### Changed

- Enabled reasoning effort controls for Grok 4.5 and updated support flags for additional Grok variants
- Standardized reasoning effort levels to use a wire-exact max tier across all model providers, including Devin routing and Ollama configurations.
- Updated costs and context windows for various models in the catalog.

## [16.3.15] - 2026-07-09

### Added

- Added support for Grok 4.5 model
- Added `gpt-5.6` base models and `gpt-5.6-{luna,sol,terra}-pro` variants
- Added `meta/muse-spark-1.1` model support
- Added support for thinking modes on `poolside/laguna` models
- Added generated GPT-5.6 Pro aliases (`gpt-5.6-{luna,sol,terra}-pro`) on the `openai` and `openai-codex` providers: each alias sends the base model id on the wire (`requestModelId`) with the new `reasoningMode: "pro"` marker, and re-derives from the current base rows on every catalog regeneration.

### Changed

- Updated cache read costs for Grok models
- Reduced max token limit for Grok 4.3 model
- Enabled prompt cache affinity for Grok models via the x-grok-conv-id header in OpenAI compatible endpoints
- Enabled prompt cache affinity for Grok models via the x-grok-conv-id header
- Marked direct xAI Grok Chat Completions models for `x-grok-conv-id` prompt-cache affinity.

## [16.3.14] - 2026-07-09

### Added

- Added support for GPT-5.6 (Luna, Sol, Terra) model variants
- Enabled expanded five-tier reasoning effort scale (minimal to xhigh) for GPT-5.6 models
- Added GPT-5.6 (Terra/Luna/Sol) support for the new `max` reasoning tier: on wire-effort APIs (OpenAI Responses, Codex, Azure, openai-compat/OpenRouter models that advertise reasoning) user efforts shift up one notch — `xhigh` sends `max`, `high` sends `xhigh` — mirroring the Claude Fable/Opus 4.7+ five-tier mapping, and the exposed ladder becomes `minimal..xhigh` with `minimal` reaching the native `low` tier. Devin's per-tier GPT-5.6 sibling rows now collapse into `gpt-5-6-{luna,sol,terra}` logical models with the same shifted routing (`xhigh` → `-max`), plus `-fast` families that keep the direct `low..xhigh` `-priority` scale since Devin serves no `-max-priority` tier.

## [16.3.13] - 2026-07-09

### Added

- Added support for Grok 4.5 across multiple providers
- Added support for GPT-5.6 series models (Luna, Sol, Terra)
- Added Aion 3.0 and 3.0 Mini models
- Added Kuaishou KAT-Coder v2.5 models
- Added Nex-N2-Mini and SWE-1.7 series models
- Added Hy3 models and free variants

### Changed

- Updated cost and token configurations for various models across providers
- Renamed several models for consistency (e.g., MiniMax M3, Gemma 4 31B, Qwen variants)

## [16.3.12] - 2026-07-08

### Fixed

- Fixed LiteLLM discovery stopping at `/model_group/info` when that endpoint omitted `supports_vision`; it now continues to `/model/info` and preserves `model_info.supports_vision=true` for vision-capable proxy models. ([#4747](https://github.com/can1357/oh-my-pi/issues/4747))
- Fixed LiteLLM discovery to fall back to bundled catalog metadata when `models.dev` lacks a model reference, preserving reasoning and thinking support for models such as `glm-5.2`. ([#4695](https://github.com/can1357/oh-my-pi/issues/4695))
- Detected Azure AI Inference / Foundry Anthropic routes as strict-tool-incompatible so resolved Anthropic compat disables strict tools before request construction ([#4679](https://github.com/can1357/oh-my-pi/issues/4679)).

## [16.3.11] - 2026-07-06

### Added

- Added Claude Haiku 4.5 (JP) model support
- Added tencent/hy3 model support via ZenMux

### Changed

- Updated naming format for various synthetic models to include provider prefix
- Adjusted context window limit for MiniMax-M3 model
- Updated pricing for select models

## [16.3.10] - 2026-07-06

### Fixed

- Fixed LiteLLM rich discovery to ignore unusable sentinel placeholders and continue to `/v2/model/info` for real models. ([#4655](https://github.com/can1357/oh-my-pi/issues/4655))

## [16.3.9] - 2026-07-06

### Fixed

- Fixed compatibility with OpenCode Go DeepSeek V4 models by sending max_tokens instead of max_completion_tokens to match the provider's API requirements.

## [16.3.7] - 2026-07-05

### Fixed

- Fixed usage cost calculation to correctly account for provider orchestration token sidecars without misclassifying them as standard input, output, or cache tokens.

## [16.3.4] - 2026-07-03

### Added

- Added Baseten as a supported model provider
- Added support for new models from Baseten, including DeepSeek V4 Pro and Kimi series
- Added new Devin agent models: Claude 5 Fable variants
- Added new Github Copilot models: Kimi K2.7 Code and MAI-Code-1-Flash
- Added Poolside Laguna XS 2.1 models via Kilo and OpenRouter providers
- Added support for Claude Fable 5 (Free) via Zenmux provider

### Changed

- Updated priority ordering to include Baseten
- Updated pricing and limits for various existing models in the catalog

## [16.3.3] - 2026-07-02

### Fixed

- Extended Anthropic-compatible signing-endpoint recognition to Cloudflare AI Gateway, Google Vertex, AWS Bedrock, and Azure AI Inference / Foundry to ensure consistent reasoning-replay and signature-stripping behavior, and exposed ResolvedAnthropicCompat.signingEndpoint in the public API.
- Fixed Zhipu Coding Plan runtime discovery to prioritize account-scoped model lists over bundled fallback models, preventing routing errors for valid non-z.ai keys.

## [16.3.2] - 2026-07-02

### Fixed

- Fixed ZenMux model discovery to run without a `ZENMUX_API_KEY`, so newly published ZenMux models (for example `anthropic/claude-fable-5-free`) auto-update into the runtime `models.db` cache instead of waiting on a regenerated `models.json`.
- Fixed ZenMux runtime discovery to query the `/api/v1/models` endpoint even when the resolved provider base URL points at the Anthropic-compatible route, so discovery no longer requests a non-existent `/api/anthropic/models` path.

## [16.3.1] - 2026-07-02

### Removed

- Removed reasoning suppression prompt logic for GPT-5 models

## [16.3.0] - 2026-07-02

### Breaking Changes

- Renamed the `requiresJuiceZeroHack` compatibility flag to `requiresReasoningSuppressionPrompt` (affecting `OpenAICompat` and `ResolvedOpenAIResponsesCompat`) and removed the unused `"juice-zero-developer-message"` member from `OpenAIReasoningDisableMode`.

### Fixed

- Fixed stream markup healing pattern misfires by disabling the healer on the official OpenAI endpoint.
- Updated the Xiaomi provider's default model to the supported `mimo-v2.5` model.
- Fixed model discovery probes (including Ollama and metadata fetches) failing behind private-CA gateways by ensuring they honor the `NODE_EXTRA_CA_CERTS` environment variable.
- Fixed CoreWeave Serverless Inference project-header detection to ensure blank OpenAI-Project overrides do not block the `COREWEAVE_PROJECT` fallback.
- Fixed LiteLLM MiniMax M3 discovery to remove reseller-only display suffixes and invalidated the model cache to clear stale suffixes immediately.
- Fixed ZenMux's `anthropic-messages` proxy being misclassified as a non-signing reasoning endpoint (`replayUnsignedThinking: true`), matching the GitHub Copilot fix (#2851). ZenMux's `zenmux.ai/api/anthropic` route forwards to signature-enforcing Anthropic, so replaying a stripped/unsigned historical `thinking` block as `signature: ""` — most visibly an end_turn-bound checkpoint/branch-return turn whose signature the transform must strip — caused `400 messages.1.content.0: Invalid signature in thinking` on Claude Sonnet 5 and other reasoning models. ([#4192](https://github.com/can1357/oh-my-pi/issues/4192))

## [16.2.13] - 2026-07-01

### Added

- Added support for human-readable reasoning summaries on compatible OpenAI Codex models (v5.4+)

### Fixed

- Fixed discovered OpenAI Codex models to advertise V2 streaming remote compaction, avoiding the legacy compact endpoint timeout path for Codex sessions. ([#4146](https://github.com/can1357/oh-my-pi/issues/4146))

## [16.2.12] - 2026-07-01

### Breaking Changes

- Removed runtime canonical-equivalence APIs from the identity module, including resolveCanonicalVariant, buildCanonicalModelOrder, CanonicalVariantPreferences, and getBundledCanonicalReferenceData. These utilities have been transitioned to a build-time generator script and are no longer exposed in the runtime bundle.

## [16.2.11] - 2026-07-01

### Fixed

- Fixed a potential memory leak caused by dangling timeout timers during model discovery in OpenAI-compatible, vLLM, LiteLLM, and LM Studio catalogs.
- Widened stream watchdogs for local OpenAI-compatible backends (including llama.cpp, LM Studio, vLLM, and Ollama) to prevent premature timeouts during cold model loads.

## [16.2.10] - 2026-06-30

### Added

- Added Claude Sonnet 3.7, Claude Opus 3, and Claude Sonnet 3 model entries to the Anthropic catalog
- Added Anthropic Claude Sonnet 5 model entry to the Kilo provider catalog
- Added first-party catalog discovery support for the Anthropic provider
- Added Gemini 3.1 Flash Lite Image model entry to the Kilo provider catalog
- Added Anthropic Claude Sonnet 5 model variants with low, medium, high, xhigh, and max thinking efforts to the Devin provider catalog
- Added Claude Sonnet 5 model entry to the Anthropic curated catalog.

### Changed

- Updated the base API URL for the Claude Sonnet 5 model in the Anthropic catalog
- Updated pricing metrics for DeepSeek R1 and DeepSeek V3 model entries to reflect new rates

## [16.2.9] - 2026-06-30

### Added

- Added full capability support for Claude Sonnet 5, aligning it with Claude Opus 4.8 and Fable 5. This includes adaptive thinking display, mid-conversation system messages, sampling parameter and thinking omission API restrictions, and 5-tier adaptive reasoning effort mapping (including xhigh and max levels) across direct APIs, OpenRouter, and Bedrock Converse.

### Changed

- Updated input and output costs for models in the catalog.

## [16.2.7] - 2026-06-30

### Fixed

- Fixed compatibility with Kimi K2.7 Code on native endpoints to ensure thinking mode is preserved and tool choice is not forced.
- Fixed Cerebras gemma-4-31b dynamic discovery to correctly identify the model as image-capable, enabling proper serialization of attached images.

## [16.2.6] - 2026-06-29

### Fixed

- Fixed namespaced GLM-5.x model IDs on Z.AI/Zhipu OpenAI-compatible endpoints to inherit the widened stream watchdog, avoiding spurious stalled-stream errors during long thinking phases. ([#3819](https://github.com/can1357/oh-my-pi/issues/3819))

## [16.2.3] - 2026-06-28

### Added

- Added support and configuration parameters for V2 streaming compaction in RemoteCompactionConfig, catalog types, and model/provider metadata.

### Changed

- Enabled automatic content markup healing for all OpenAI-compatible streaming models
- Updated pricing and context window limits for several catalog models.
- Disabled reasoning capability for multiple providers in the catalog.

## [16.2.2] - 2026-06-27

### Removed

- Removed 'pi' from the list of supported dialects.

## [16.2.0] - 2026-06-27

### Added

- Added GitLab Duo Agent catalog discovery, including namespace selection, live model mapping, and a bundled fallback model for fresh installs.
- Added OpenAICompat.supportsNamedToolChoice to support forced tool use on string-only OpenAI-compatible chat servers without emitting the named function-object tool_choice shape.
- Added model metadata support for provider-native remote compaction and compaction-only model selection.

### Changed

- Disabled the thinking-effort selector for GitLab Duo Agent models since the underlying platform parameters are server-fixed.

### Fixed

- Improved GitLab Duo Agent and Duo Workflow namespace and project discovery to robustly handle paginated groups, SSH remotes with custom ports, Git worktrees, self-managed GitLab instances with relative paths, and configuration via GITLAB_DUO_PROJECT_PATH or GITLAB_DUO_PROJECT_ID.
- Fixed built-in LiteLLM discovery to prefer rich proxy metadata from management endpoints and avoid caching stale capability data.
- Fixed GitLab Duo Workflow model specifications to resolve correct static context windows, enabling accurate context usage tracking and auto-compaction.

## [16.1.23] - 2026-06-26

### Added

- Added `OpenAICompat.qwenPreserveThinking` — auto-enabled when the resolved `thinkingFormat` is `"qwen"` or `"qwen-chat-template"` AND `replayReasoningContent` is on (i.e. the four built-in local OpenAI-compatible providers, or a custom provider pointed at a loopback / RFC1918 / `*.local` baseUrl). Pairs with the chat-completions encoder change so the request body carries `preserve_thinking: true` (twin top-level + `chat_template_kwargs` emission), keeping Qwen3.6+ from stripping `<think>...</think>` off older assistant turns and breaking the local slot's KV cache between user messages. Non-Qwen chat templates ignore the parameter, so the flag stays a no-op outside the Qwen path; users on a cloud Qwen host (Alibaba Dashscope / Qwen Portal) can opt in with `compat.qwenPreserveThinking: true`. ([#3541](https://github.com/can1357/oh-my-pi/issues/3541))
- Added CoreWeave Serverless Inference as an OpenAI-compatible provider with models.dev-backed bundled catalog metadata.

## [16.1.22] - 2026-06-26

### Added

- Added `OpenAICompat.replayReasoningContent` — auto-enabled for the built-in local OpenAI-compatible providers (`llama.cpp`, `lm-studio`, `vllm`, `ollama` on `openai-completions`) and for any provider pointed at a loopback / RFC1918 / `*.local` baseUrl. NOT gated on `spec.reasoning`: the runtime discovery paths for `llama.cpp` / `lm-studio` / `openai-models-list` hardcode `reasoning: false` because the upstream `/models` endpoints don't advertise the capability, while the stream parser still records incoming `reasoning_content` deltas as thinking blocks — gating on the spec flag would leave every discovered local Qwen / DeepSeek model re-triggering #3528. The encoder only writes `reasoning_content` when a thinking block actually exists on the turn, so the flag is a no-op on pure-text histories. Built-in proxy providers (currently `litellm`) are excluded from both checks because they forward to an unrelated upstream that gains no KV-cache benefit and may 400 on the extra field; users running a custom proxy in front of a llama.cpp-style backend can opt in via the sparse `compat.replayReasoningContent: true` override. Signals to the `openai-completions` encoder that preserved `thinking` blocks must be re-emitted as `reasoning_content` on every assistant turn so chat templates that reconstruct `<think>…</think>` from the field (Qwen3, DeepSeek-R1, GLM-5.x) keep the prior turn's tokens byte-stable and llama.cpp's prefix KV cache survives. ([#3528](https://github.com/can1357/oh-my-pi/issues/3528))

## [16.1.20] - 2026-06-25

### Fixed

- Fixed direct Anthropic Claude Sonnet/Haiku 4.5 advisor/agent turns crashing every call with HTTP 400 `This model does not support the effort parameter.` The catalog classified the whole Claude 4.5 family on `anthropic-messages` (and `bedrock-converse-stream`) as `anthropic-budget-effort`, which made the Anthropic provider serialize `output_config.effort` alongside `thinking.budget_tokens`. Anthropic only honors `output_config.effort` on Opus 4.5 and adaptive (4.6+) Messages-API models, so Sonnet 4.5 / Haiku 4.5 rejected the field. `inferThinkingControlMode` now gates `anthropic-budget-effort` to `parsedModel.kind === "opus" && semverGte(version, "4.5")` on both Anthropic-routed APIs, so Sonnet 4.5 / Haiku 4.5 on direct Anthropic + Cloudflare-AI-Gateway + Vertex + GitLab-Duo + Copilot + Bedrock fall through to plain `mode: "budget"` (thinking budget still scales with the selected effort tier). Opus 4.5 keeps `anthropic-budget-effort`. `anthropic-budget-effort` also stays in use for Anthropic-compatible third-party backends that natively support the field (Umans GLM 5.2). ([#3497](https://github.com/can1357/oh-my-pi/issues/3497))

## [16.1.17] - 2026-06-24

### Fixed

- Fixed the Umans GLM-5.2 thinking-level picker collapsing to a single `high` tier after dynamic discovery: the `max` upstream level now resolves to the internal `xhigh` effort, the picker shows both `high` and `xhigh`, and the metadata maps `xhigh` back to Umans's native `max` wire tier. ([#3192](https://github.com/can1357/oh-my-pi/issues/3192))
- Fixed GitHub Copilot business and enterprise endpoints accepting image inputs that they reject with `400 vision is not supported`. The Copilot `/models` response advertises `capabilities.supports.vision = true` for Claude/GPT chat models on every host, but only the canonical personal endpoint (`https://api.githubcopilot.com`) actually serves them; `githubCopilotModelManagerOptions` now forces `input: ["text"]` whenever discovery resolves to a non-personal base URL, and `mergeDynamicModel` honours the dynamic value (instead of OR-upgrading) when the merged endpoint differs from the bundled reference. ([#3387](https://github.com/can1357/oh-my-pi/issues/3387))
- Fixed OpenRouter Anthropic compat to strip Responses reasoning history during replay so signed thinking blocks are not sent back to routed Anthropic providers. ([#3399](https://github.com/can1357/oh-my-pi/issues/3399))

## [16.1.14] - 2026-06-22

### Added

- Added Sakana AI provider support with Fugu model integration
- Added Sakana AI/Fugu provider catalog entries with Fugu model discovery and Responses API metadata
- Added support for "xhigh" reasoning tier across model configurations
- Added configuration for new models GCP-5.4 Mini, GPT-5.5, and variants
- Added `devin` variant collapse table to streamline model tiering

### Changed

- Updated reasoning label pattern to include "minimal" and "max" efforts
- Simplified model identification logic for Devin-powered reasoning models
- Refactored variant routing to consolidate and standardize tier definitions

## [16.1.13] - 2026-06-22

### Added

- Added support for Devin as a model provider
- Added capability to fetch dynamic models from the Devin model manager

## [16.1.11] - 2026-06-21

### Fixed

- Fixed Umans `umans-glm-5.1` / `umans-glm-5.2` advertising native image input. The `models/info` endpoint reports `supports_vision: "via-handoff"` for the GLM models, meaning vision routes through a separate handoff pre-analysis step instead of accepting raw image blocks; `umansSupportsVision` treated any non-empty string as native vision support, so image prompts went directly to GLM and were rejected with `400 This model does not support image inputs`. The helper now requires `supports_vision === true`, the bundled GLM 5.1/5.2 rows are corrected to text-only, and stale mismatched Umans cache rows for those ids are dropped so the vision-handoff path runs even before a successful refresh. ([#3184](https://github.com/can1357/oh-my-pi/issues/3184))

## [16.1.9] - 2026-06-21

### Fixed

- Fixed the `moonshot` provider with no path to the Kimi China API: model discovery now honors a `MOONSHOT_BASE_URL` override (redirecting to `api.moonshot.cn`), and `KIMI_API_KEY` resolves as a fallback for `MOONSHOT_API_KEY`. ([#2883](https://github.com/can1357/oh-my-pi/issues/2883))
- Fixed LiteLLM model discovery preserving colliding models.dev transport metadata (for example `ollama-cloud` `deepseek-v4-flash`) instead of keeping the LiteLLM `openai-completions` provider transport. ([#3162](https://github.com/can1357/oh-my-pi/issues/3162))

### Removed

- Removed bundled Wafer Pass (`wafer-pass`) catalog entries and generation support; Wafer Serverless remains available as `wafer-serverless`.

## [16.1.8] - 2026-06-20

### Fixed

- Fixed Fireworks-hosted Qwen turns (e.g. `fireworks/qwen3.7-plus`) failing with `400 Extra inputs are not permitted, field: 'enable_thinking'`. Fireworks serves Qwen3 with controllable thinking via OpenAI-style `reasoning_effort` and rejects the top-level `enable_thinking` boolean that Alibaba DashScope speaks; `buildOpenAICompat` was selecting `thinkingFormat: "qwen"` from the `qwen` id pattern regardless of host. Fireworks-hosted Qwen models now resolve to `thinkingFormat: "openai"`.
- Fixed MiMo models on OpenAI-compatible gateways to expose only accepted `low`, `medium`, and `high` reasoning tiers and map unsupported raw `minimal`/`xhigh` requests to safe wire values. ([#2864](https://github.com/can1357/oh-my-pi/issues/2864))

## [16.1.7] - 2026-06-20

### Fixed

- Fixed MiniMax-M3 catalog context for the MiniMax Coding/Token Plan providers `minimax-code` and `minimax-code-cn` to report the documented 1M long-context tier instead of the upstream 512K pricing boundary; the previous patch only covered `minimax`/`minimax-cn`, so the Coding Plan picker still showed 512K in the status bar ([#3097](https://github.com/can1357/oh-my-pi/issues/3097)).

## [16.1.4] - 2026-06-19

### Fixed

- Fixed Claude 4.6 routing on the `google-antigravity` (and `google-gemini-cli`) Cloud Code Assist providers, whose backend exposes the models asymmetrically: `claude-sonnet-4-6` has no `-thinking` twin and `claude-opus-4-6` has only the `-thinking` twin. The shared `thinkingPair` family was routing thinking efforts on `claude-sonnet-4-6` to a non-existent `claude-sonnet-4-6-thinking` wire id (404 `Requested entity was not found`); replaced both 4.6 entries with bespoke single-wire families so every effort and off resolve to the live wire id. Added `claude-sonnet-4-6` and `claude-opus-4-6-thinking` entries to `ANTIGRAVITY_MODEL_WIRE_PROFILES` capped at the backend's 64000-output-token limit (over-cap requests 400'd with `Request contains an invalid argument`); `modelEnum` is now optional on `AntigravityModelWireProfile` since the Claude wire ids are accepted without a captured `labels.model_enum`. ([#3067](https://github.com/can1357/oh-my-pi/issues/3067))

## [16.1.3] - 2026-06-19

### Fixed

- Marked Ollama Cloud catalog models to omit on-the-wire output-token caps, preventing context-window-sized `num_predict` values from causing HTTP 400s for models whose true output cap is not discoverable. ([#2984](https://github.com/can1357/oh-my-pi/issues/2984))
- Fixed `readModelCache`/`writeModelCache` using a process-global shared database even when a custom `dbPath` was provided. Custom-path cache operations now open and close a per-call database via `withModelCacheDb`, preventing leaked SQLite handles on Windows

## [16.1.2] - 2026-06-19

### Added

- Added support for Gemini 2.5 Flash-Lite, 3.1 Flash-Lite, and 3.5 Flash models
- Added support for Moonshot V1 model family

### Changed

- Updated context window and token limits for various Claude, Gemini, and GPT-OSS models
- Refined thinking mode behaviors and routing for supported LLM families

### Fixed

- Fixed GLM-5.2 `reasoning_effort` so the top thinking tier reaches each host's genuine maximum instead of 400ing, mapping the internal `xhigh` tier per host dialect (verified against live endpoints): Z.ai/Zhipu collapse onto the model's `none`/`high`/`max` scale (`xhigh → max`); Fireworks, resellers, and Ollama Cloud keep their distinct lower tiers and remap only the top `xhigh → max` (merged over host quirks such as Fireworks' `minimal → none`); and OpenRouter — whose API rejects `max` and treats `xhigh` as its own max tier — now exposes the `xhigh` tier and forwards it verbatim. Dialect detection keys off resolved `compat.thinkingFormat`, so custom OpenRouter/Z.ai-format providers are covered too.
- Maintained thinking effort routing when discovery only returns the base model ID
- Improved credential retrieval logic for Antigravity and Codex providers via auth discovery

## [16.0.9] - 2026-06-18

### Fixed

- Fixed GitHub Copilot's `anthropic-messages` proxy being misclassified as a non-signing reasoning endpoint (`replayUnsignedThinking: true`). It forwards to signature-enforcing Anthropic, so replaying a stripped/unsigned historical `thinking` block as `signature: ""` — most visibly an end_turn-bound checkpoint/branch-return turn whose signature the transform must strip — caused a `400 Invalid signature` that corrupted the session and re-tripped on every full history re-send (e.g. after toggling MCP servers). Copilot now degrades such blocks to text like the official API. ([#2851](https://github.com/can1357/oh-my-pi/issues/2851))
- Added a `supportsImageDetailOriginal` compat flag that resolves to `false` for GitHub Copilot, whose Responses endpoint rejects the `detail: "original"` image hint with a 400, and `true` for every other host. ([#2822](https://github.com/can1357/oh-my-pi/issues/2822))

## [16.0.8] - 2026-06-18

### Changed

- Refactored model family ID predicates and capability checkers to use a shared, uniform process-lifetime `memo` utility to eliminate caching boilerplate.

### Fixed

- Fixed LM Studio dynamic discovery to use native `/api/v0/models` metadata so VLM models advertise image input. ([#2945](https://github.com/can1357/oh-my-pi/issues/2945))

## [16.0.7] - 2026-06-18

### Fixed

- Fixed MiniMax Anthropic-compatible M2/M3 thinking metadata to expose the adaptive transport and keep M2 mandatory reasoning floored ([#2928](https://github.com/can1357/oh-my-pi/issues/2928)).

## [16.0.6] - 2026-06-18

### Added

- Added a dedicated `openrouter` API type and `ResolvedOpenRouterCompat` configuration to support unified chat-completions and Responses-API compatibility for OpenRouter models

### Changed

- Migrated bundled OpenRouter models in the catalog from `openai-completions` to the new `openrouter` API type
- Consolidated the resolved OpenAI compat shape: extracted a shared `ResolvedOpenAISharedCompat` core that both `ResolvedOpenAICompat` and `ResolvedOpenAIResponsesCompat` extend (each builder still computes its own per-surface value, preserving chat↔Responses divergence), added internal resolved wire-quirk fields (`wireModelIdMode`, `stripDeepseekSpecialTokens`, `reasoningDeltasMayBeCumulative`, `emptyLengthFinishIsContextError`, `usesOpenAIToolCallIdLimit`, `dropThinkingWhenReasoningEffort`, `supportsObfuscationOptOut`), and replaced `buildOpenRouterCompat`'s cast-and-copy with an exhaustive `pickResponsesOnly` composition that fails to compile if a new Responses-only field is added without handling. The public `OpenAICompat` config vocabulary is unchanged.
- Expanded `OpenAICompat`/`ResolvedOpenAISharedCompat` with shared reasoning/history/stream/request flags (`reasoningDisableMode`, `omitReasoningEffort`, `includeEncryptedReasoning`, `filterReasoningHistory`, `requiresReasoningContentForAllAssistantTurns`, `streamMarkupHealingPattern`, `promptCacheSessionHeader`, etc.) so model/provider/gateway constraints are declared once in catalog compat and then consumed uniformly by Chat Completions and Responses endpoints.

### Fixed

- Changed the default compatibility builder for `openai-completions` to set `requiresAssistantAfterToolResult` to `isMistral`, enabling the synthetic assistant bridge for built-in Mistral and Devstral models.
- Fixed local Ollama (`provider: "ollama"`) reasoning turns still failing with HTTP 400 `invalid reasoning value: "minimal"` when the model was selected from a stale `~/.omp/models.db` cache row or a hand-written config: the `minimal → low` / `xhigh → max` remap was only stamped during fresh discovery, so cached and custom specs reached the wire unmapped. The remap now lives in the OpenAI chat-completions and Responses compat builders, so every `buildModel` (including cache loads, custom specs, and the `whenThinking` variant) backfills it — no `omp models refresh` required. Custom OpenAI-compatible providers registered under a non-`ollama` provider id still need their own `compat.reasoningEffortMap`.
- Advertised Ollama Cloud GLM-5.2 reasoning efforts as high/xhigh-only and mapped `xhigh` to native max effort ([#2911](https://github.com/can1357/oh-my-pi/pull/2911) by [@serverinspector](https://github.com/serverinspector))
- Fixed OpenRouter pseudo-API model construction so bundled OpenRouter models resolve shared OpenAI compatibility metadata instead of an undefined compat record.
- Fixed custom/direct `xai-oauth` Responses model specs (e.g. `grok-build`) emitting `reasoning.effort` and hitting xAI's HTTP 400: `buildOpenAIResponsesCompat` now defaults `supportsReasoningEffort` to `false` for `xai-oauth` Grok models that are off the effort-capable allowlist (`grok-3-mini`/`grok-4.20-multi-agent`/`grok-4.3`), matching the curated discovery path; explicit `compat.supportsReasoningEffort` still overrides. The allowlist moved to a shared `isGrokReasoningEffortCapable` identity helper consumed by both the compat builder and provider-model curation so the two cannot drift.

## [16.0.5] - 2026-06-17

### Added

- Added `enableGeminiThinkingLoopGuard` to OpenAI compatibility options to allow explicit opt-in or opt-out of the Gemini thinking-loop guard for OpenAI-compatible model aliases
- Added `LITELLM_BASE_URL` as the LiteLLM provider discovery base URL fallback, with discovery caches scoped by the resolved proxy URL and explicit provider `baseUrl` config kept at higher precedence. ([#2726](https://github.com/can1357/oh-my-pi/issues/2726))
- Added `ThinkingConfig.effortBudgets` (per-effort thinking-budget contract baked into collapsed variants) and `ANTIGRAVITY_MODEL_WIRE_PROFILES` (`maxOutputTokens` + `model_enum` per Antigravity wire id) to mirror the captured Antigravity Cloud Code Assist client request shape.

### Changed

- Defaulted `enableGeminiThinkingLoopGuard` from Gemini family detection for both OpenAI completions and responses compatibility specs so Gemini models now enable the thinking-loop guard automatically
- Updated the default Gemini CLI user-agent version fallback to 0.46.0.
- Changed the Antigravity (`google-antigravity`, daily-cloudcode-pa) gemini-3.x collapse families to the `budget` thinking transport with the client's per-tier `thinkingBudget` (3.5 Flash low/medium/high = 1000/4000/10000, 3.1 Pro low/high = 1001/10001) and corrected 3.5 Flash effort→wire routing (medium → `gemini-3.5-flash-low`, high → `gemini-3-flash-agent`). Split the shared CCA collapse table so `google-gemini-cli` (cloudcode-pa) keeps the `google-level` `thinkingLevel` transport for official Gemini CLI parity. Stale collapsed snapshots (bundled catalog, recycled `gemini-3-flash` alias) self-heal from the hand table at collapse time, and the model cache schema is bumped to v7 to invalidate pre-budget Antigravity rows.
- Changed the Antigravity user-agent to the `antigravity/hub/<version>` format (default `2.1.4`) to match the captured client.

### Fixed

- Fixed `off` effort routing for `claude-opus-4-5` and `claude-opus-4-6` to use their base model IDs when thinking is disabled
- Fixed `gemini-2.5-flash` effort routing so all non-off effort levels resolve to `gemini-2.5-flash-thinking`
- Fixed shared variant alias provider resolution so `resolveBareVariantAlias` reports all matching providers when model aliases are present in both CCA collapse tables
- Routed google-antigravity default baseUrl to the stable primary daily endpoint in the catalog generator and all fallback snapshots, resolving connection drops on heavy queries.
- Fixed MiniMax M3 dialect selection so MiniMax-family OpenAI-compatible models use the MiniMax tool-call dialect instead of generic XML. ([#2759](https://github.com/can1357/oh-my-pi/issues/2759))
- Fixed GitHub Copilot dynamic discovery to honor plan-specific API endpoints stored in structured OAuth credentials. ([#2876](https://github.com/can1357/oh-my-pi/issues/2876))

## [16.0.4] - 2026-06-17

### Fixed

- Fixed GLM-5.2 catalog thinking metadata for Zhipu/BigModel so the top effort is exposed as `xhigh` and maps to provider-native `max`. ([#2833](https://github.com/can1357/oh-my-pi/issues/2833))

## [16.0.2] - 2026-06-16

### Fixed

- Fixed Kimi output caps for Umans AI Coding Plan and Venice so discovery metadata cannot use context-sized token ceilings as request caps.
- Marked Umans Anthropic-compatible models as client-tool escaped so cached and bundled metadata do not expose `web_search` as a provider server tool.

## [16.0.1] - 2026-06-15

### Added

- Added the Umans AI Coding Plan provider catalog with Anthropic-compatible model metadata and dynamic discovery ([#2636](https://github.com/can1357/oh-my-pi/pull/2636) by [@oldschoola](https://github.com/oldschoola)).

## [16.0.0] - 2026-06-15

### Breaking Changes

- Renamed the catalog-owned tool syntax API from `ToolCallSyntax`/`FALLBACK_TOOL_SYNTAX`/`preferredToolSyntax` to `Dialect`/`FALLBACK_DIALECT`/`preferredDialect`.

## [15.13.3] - 2026-06-15

### Added

- Added Azure OpenAI as a catalog provider (`azure`, default model `gpt-5.5`, env var `AZURE_OPENAI_API_KEY`), bundling the OpenAI-family models Azure serves over the Responses API (GPT-4/4.1/4o, GPT-5 family, o-series, Codex). Like Amazon Bedrock it is catalog-only — models ship in the bundle and become selectable once the env key is set, with the deployment base URL resolved at runtime from `AZURE_OPENAI_BASE_URL`/`AZURE_OPENAI_RESOURCE_NAME`.
- Added models.dev-backed bundled catalogs for providers that previously shipped no offline models: Hugging Face, Kilo, Moonshot, NanoGPT, Synthetic, Venice, Ollama Cloud, and the Xiaomi Token Plan regions (ams/cn/sgp). They still discover live when credentialed; the bundle is now a non-empty baseline.

### Changed

- Updated stale provider default models to their latest bundled versions: OpenAI-family providers (`azure`, `github-copilot`, `aimlapi`) → GPT-5.5; Gemini providers (`google`, `google-gemini-cli`, `google-vertex`) → `gemini-3.1-pro-preview`; GLM providers (`zai`, `zhipu-coding-plan`) → `glm-5.2`, `cerebras` → `zai-glm-4.7`; Kimi providers (`fireworks`, `opencode-go`, `moonshot`) → `kimi-k2.7-code`, `kimi-code` → `kimi-for-coding`, `together` → `moonshotai/Kimi-K2.7-Code`; `alibaba-coding-plan` → `qwen3.7-plus`; and Claude-Sonnet defaults (`cloudflare-ai-gateway`, `cursor`, `gitlab-duo`, `kilo`, `opencode-zen`, `vercel-ai-gateway`) → Claude Opus 4.x.
- Restricted models.dev Azure discovery to OpenAI-family IDs (`gpt-`, `o1`, `o3`, `o4`, `codex`, `chatgpt`), excluding Foundry-hosted third parties (Claude/DeepSeek/Llama/Mistral/Phi) that Azure serves through non-Responses APIs.
- Detected the Azure OpenAI Responses compat surface (developer role, strict tool mode, strict tool-result pairing) by provider id as well as base URL, so bundled `azure` models whose deployment host is only known at runtime still get the right wire behavior.
- Renamed the `Qwen3-ASR-Flash` model label to `Qwen3 ASR Flash`

### Fixed

- Fixed tool syntax selection for Gemini-family and Gemma model IDs by routing them to dedicated `gemini` and `gemma` formats instead of generic XML
- Fixed `zhipu-coding-plan` and `together` shipping no bundled models: their descriptors referenced non-existent models.dev keys (`zhipu-coding-plan`, `together`); pointed them at the real keys (`zhipuai-coding-plan`, `togetherai`) so they bundle their GLM and full catalogs respectively.
- Folded the `azure-openai-responses` API into the OpenAI Responses thinking-inference branches so Azure reasoning models (o-series, GPT-5, Codex) resolve the discrete effort vocabulary (including `xhigh`) and effort-control mode instead of falling through to generic defaults.
- Fixed `ollama-cloud` discovery inheriting an unsafe cross-provider `contextWindow`/`maxTokens` when `/api/show` returns no size metadata; it now falls back to the safe 128K context / 8K output caps.
- Dropped internal Fireworks control-plane resource ids (`accounts/fireworks/{models,routers}/…`) from the bundle; only the public request ids ship.

## [15.13.2] - 2026-06-15

### Added

- Added the `ToolCallSyntax` union and `FALLBACK_TOOL_SYNTAX` constant to `@oh-my-pi/pi-catalog/identity` (re-exported from `@oh-my-pi/pi-ai/grammar`).
- Added `preferredToolSyntax(modelId)` to `@oh-my-pi/pi-catalog/identity`, resolving a model's native tool-call syntax affinity from its family token (Claude→`anthropic`, GLM→`glm`, Kimi→`kimi`, Qwen→`qwen3`, DeepSeek→`deepseek`, OpenAI/gpt-oss→`harmony`, else the `xml` fallback).
- Added `flux-1-schnell-fp8` to the Fireworks serverless model catalog
- Added `gpt-oss-20b` to the Fireworks model catalog
- Added `qwen3-embedding-8b` to the Fireworks model catalog
- Added `qwen3-reranker-8b` to the Fireworks model catalog
- Added `Gemma 4 E2B IT` and `Gemma 4 E4B IT` to the Google model catalog
- Added `qwen/qwen3-asr-flash` to the Zenmux model catalog
- Added sparse `supportsTools` model metadata so providers can mark models that require in-band tool-call formatting.

### Changed

- Kept non-tool-capable Fireworks serverless models in discovery results and marked them with `supportsTools: false` for fallback-aware handling
- Extended `modelFamilyToken(modelId)` to classify Claude/OpenAI ids the structured parser misses (older dated forms such as `claude-3-5-sonnet-20241022` and `gpt-4o`), returning `anthropic`/`openai` instead of an empty token.

## [15.13.1] - 2026-06-15

### Added

- Added `modelFamilyToken(modelId)` to `@oh-my-pi/pi-catalog/identity`: a coarse vendor-lineage token (`anthropic`/`openai`/`gemini`/`kimi`/…) for "are two models the same family?" comparisons, backed by `parseKnownModel` canonical-id normalization. Opaque and comparison-only; kind/variant collapsed onto the vendor token ([#2406](https://github.com/can1357/oh-my-pi/issues/2406))

### Changed

- Changed catalog metadata to update a model’s per-token pricing to input 0.09 and output 0.18
- Changed the same cataloged model’s maximum token limit from 384000 to 65536

### Fixed

- Fixed MiniMax-M3 catalog context for `minimax` and `minimax-cn` to report the documented 1M long-context tier instead of the upstream 512K pricing boundary ([#2576](https://github.com/can1357/oh-my-pi/issues/2576)).
- Fixed OpenCode Go MiMo catalog metadata so title generation and other tool-enabled calls omit unsupported `tool_choice` instead of triggering provider 400s ([#2509](https://github.com/can1357/oh-my-pi/issues/2509)).
- Fixed OpenCode Go `kimi-k2.7-code` catalog metadata so resolve-gate requests use automatic tool selection instead of Moonshot-rejected forced `tool_choice` ([#2546](https://github.com/can1357/oh-my-pi/issues/2546)).
- Fixed Anthropic compat for the `github-copilot` host so `supportsEagerToolInputStreaming` defaults to `false` there, matching the Copilot proxy which rejects the per-tool `eager_input_streaming` field ([#2558](https://github.com/can1357/oh-my-pi/issues/2558)).
- Scoped vLLM model cache validity to the discovery base URL so changed endpoints refetch immediately, and bounded built-in vLLM discovery requests with a timeout.

## [15.12.6] - 2026-06-14

### Added

- Added GLM-5.2 to the bundled zai (GLM Coding Plan) catalog as the selectable 1M served model.

### Changed

- Pinned zai `glm-5.2` to 1M context during catalog generation so endpoint discovery and older fallbacks cannot regress it to 200k.
- Replaced the hand-maintained `zhipu-coding-plan` GLM reasoning allowlist and vision regex with a `parseGlmModel` family classifier in `identity/classify.ts` (variant + vision + version), surfaced as `isReasoningGlmModelId` / `isGlmVisionModelId`. Discovery now derives reasoning/vision capability from the GLM family instead of a per-id list, so newly-bumped integers (`glm-5.3`, `glm-6`, …) are covered automatically while `-flash`/`-preview` and the vision `…v` shape stay correctly classified.

## [15.12.4] - 2026-06-13

### Added

- Added bundled Fireworks models `deepseek-v4-flash`, `kimi-k2.7-code`, `minimax-m2.5`, `minimax-m3`, `nemotron-3-ultra-nvfp4`, `qwen3.6-plus`, and `qwen3.7-plus`
- Changed

### Changed

- Model `contextWindow`/`maxTokens` are now `number | null`; discovery emits `null` when a provider reports no limit, replacing the `222222`/`8888` (`UNK_CONTEXT_WINDOW`/`UNK_MAX_TOKENS`) sentinels (now removed). Bundled `models.json` unknown limits are `null`.
- Changed the `github-copilot` model context window to `524288` tokens
- Changed Fireworks model discovery to source the control-plane `List Models` API (`GET /v1/accounts/fireworks/models?filter=supports_serverless=true`) instead of the OpenAI-compatible `/v1/models` inference listing. The inference endpoint returns a sparse, account-specific subset that omits on-demand serverless models (e.g. `kimi-k2.7-code`), so newly published serverless models stayed invisible in the picker until hand-added to the bundled catalog. The control-plane catalog enumerates every serverless model with capability metadata (`supportsServerless`/`supportsTools`/`supportsImageInput`/`contextLength`/`displayName`), paginated and filtered to tool-capable `READY` entries, then merged with bundled/models.dev references — the Kimi K2 max-output clamp and DeepSeek V4 thinking-toggle strip are preserved, and unbundled models default to reasoning so `buildModel` derives the Fireworks effort map. New serverless releases now surface automatically with no catalog edits.

### Fixed

- Filled missing `contextWindow` and `maxTokens` in generated `models.json` for proxy/reseller variants by inheriting limits from canonical-family and segment-reference models
- Ignored zero-cost `x-ai` subscription entries as reference sources when backfilling limits so inflated values are not propagated
- Fixed the model cache opening with `PRAGMA journal_mode=WAL` before `PRAGMA busy_timeout`, so concurrent omp startups could crash inside `getDb()` on `SQLITE_BUSY` during WAL recovery instead of waiting through the transient lock. The busy handler is now installed before the first lock-taking statement ([#2421](https://github.com/can1357/oh-my-pi/issues/2421)).

## [15.11.8] - 2026-06-12

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

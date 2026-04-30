# Changelog

## [Unreleased]

## [14.5.10] - 2026-04-30

### Added

- Added provider response metadata callbacks for Anthropic and OpenAI streaming requests.

## [14.5.9] - 2026-04-30
### Added

- Added `usage.reasoningTokens` to OpenAI and Google usage output when providers report reasoning/thinking tokens
- Added `usage.cttl.ephemeral5m` and `usage.cttl.ephemeral1h` to report Anthropic cache-write TTL token buckets
- Added `usage.server.webSearch` and `usage.server.webFetch` to report Anthropic server tool-call request counts

### Fixed

- Fixed OpenAI usage attribution to avoid double-counting `reasoning_tokens` in output totals
- Fixed Anthropic streaming usage handling so a previously populated cache TTL breakdown is preserved when later events omit `cache_creation`

## [14.5.4] - 2026-04-28
### Changed

- Changed OpenAI custom Lark grammar payloads to strip comments and blank lines before sending provider requests.

### Fixed

- Fixed OpenAI Codex GPT model pricing by inheriting matching OpenAI catalog rates for zero-priced discovered Codex entries.

## [14.5.3] - 2026-04-27
### Added

- Added `fireworks` as a supported provider with API key login flow and credential storage
- Added Fireworks model catalog support with `fireworks`-scoped openai-completions models `glm-5`, `glm-5.1`, `kimi-k2.5`, `kimi-k2.6`, and `minimax-m2.7`
- Added built-in discovery wiring so providers with base URL `api.fireworks.ai` are recognized as OpenAI-compatible and can use streaming token control

### Changed

- Updated the built-in model catalog to use corrected `contextWindow` and `maxTokens` values for many existing models instead of placeholder limits
- Updated several model cost entries, including cache-read pricing, to corrected values

### Fixed

- Fixed Fireworks request formatting by translating between public model IDs and API wire IDs when sending OpenAI-completions requests
- Fixed OpenAI-compatible model parameter handling for Fireworks by allowing `max_tokens` to be sent during requests

## [14.5.1] - 2026-04-26

### Fixed

- Fixed NVIDIA NIM DeepSeek-V4 models leaking chat-template tool-call markers (e.g. `<｜DSML｜tool_calls｜>`) into visible response text by stripping the special tokens from streamed `delta.content` ([#798](https://github.com/can1357/oh-my-pi/issues/798))

## [14.4.0] - 2026-04-26

### Added

- Added an `examples` option to `StringEnum` to include example values in the generated schema

### Changed

- Changed Anthropic tool schema generation to strip unsupported schema fields (including `patternProperties`), add `additionalProperties: false` for object types, and apply Anthropic strict-mode limits when marking tools as strict
- Changed Anthropic strict tool planning to cap strict `tools` at twenty entries and convert excess optional/union parameters to nullable schemas to stay within provider constraints

### Fixed

- Fixed Anthropic tool schema compilation failures by keeping the `write` tool out of the strict-tool allowlist when the full coding-agent tool set is active
- Fixed Anthropic 400 `tools.*.custom: For 'object' type, property 'minItems' is not supported` by stripping `minItems` from object-shaped JSON schema nodes (array nodes still keep supported `minItems` values)
- Fixed Anthropic tool schemas that used tuple-style arrays by stripping unsupported `maxItems` and only preserving provider-supported `minItems` values
- Fixed Anthropic and OpenRouter Anthropic tool calls that previously failed with `compiled grammar is too large` by retrying automatically without strict tool schemas and reusing non-strict mode for subsequent requests in the same provider session
- Fixed parsing of JSON tool arguments containing raw control characters inside string values (such as embedded newlines) by escaping them before JSON parsing
- Fixed `validateToolArguments` to accept stringified objects and arrays that include literal control characters inside string fields
- Fixed OpenAI Codex Spark OAuth selection to fall back to non-Pro accounts when no ChatGPT Pro account is connected, so users without a Pro account can still attempt Spark requests in case the server permits access.

## [14.3.0] - 2026-04-25

### Added

- Added support for Claude Opus 4.7 (`claude-opus-4-7`) model ([#726](https://github.com/can1357/oh-my-pi/issues/726))
  - Suppresses sampling parameters (temperature/top_p/top_k) that Opus 4.7 rejects
  - Enables `display: "summarized"` for adaptive thinking to restore visible thinking content

### Fixed

- Fixed Cursor provider losing conversation history on follow-up turns (model responding "this appears to be the start of our session") by populating `ConversationStateStructure.rootPromptMessagesJson` with JSON blob IDs for the system prompt plus prior user/assistant/tool-result messages. Cursor's server builds the model prompt from `rootPromptMessagesJson`, not from the protobuf `turns[]` tree, so sending only the system prompt there caused prior turns to be dropped
- Fixed Cursor provider multi-turn conversations failing with `Connect error internal: Blob not found` on the second message by storing `ConversationStateStructure.turns`, `AgentConversationTurnStructure.user_message`, and `AgentConversationTurnStructure.steps` as content-addressed blob IDs in the KV store (matching the existing handling for `rootPromptMessagesJson`) rather than sending the raw serialized bytes inline ([#678](https://github.com/can1357/oh-my-pi/issues/678))

## [14.2.1] - 2026-04-24

### Fixed

- Fixed OpenAI Codex Spark OAuth selection to require a verified ChatGPT Pro account instead of falling back to Plus or unknown-plan accounts.

## [14.2.0] - 2026-04-23

### Added

- Added `gpt-5.5` to the built-in model catalog for both OpenAI Responses (`openai`) and local `litellm` (`openai-completions`) providers
- Added `gpt-image-2` to the `litellm` built-in model catalog
- Added `isCopilotTransientModelError()` and `callWithCopilotModelRetry()` helpers in `utils/retry` that detect GitHub Copilot's intermittent `HTTP 400 model_not_supported` responses for preview models (`gpt-5.3-codex`, `gpt-5.4`, `gpt-5.4-mini`, ...) and retry the request up to three times with backoff. OpenAI Responses, OpenAI Completions, and Anthropic provider paths now participate in this retry when the model is served through Copilot.
- Added OpenAI Responses custom-tool grammar support for Codex-style `apply_patch` calls, including freeform streaming, history replay, and forced tool-choice mapping to the custom wire name.

### Changed

- Updated built-in model metadata with revised `contextWindow`, `maxTokens`, and pricing values for existing entries
- Changed generated model policies to assign `applyPatchToolType: "freeform"` for first-party GPT-5 OpenAI Responses and Codex models, so regenerated `models.json` preserves the `apply_patch` custom-tool metadata.
- Renamed `rewriteCopilotAuthError` to `rewriteCopilotError` and extended it to rewrite `HTTP 400 model_not_supported` after retries are exhausted with guidance about Copilot's OAuth-client-specific rollout gap (see opencode#13313).

### Fixed

- Fixed Amazon Bedrock proxy handling to honor lowercase `http_proxy`, `https_proxy`, and `all_proxy` environment variables when using HTTP/1 fallback
- Fixed Amazon Bedrock streaming behind corporate HTTP proxies by using a proxy-aware HTTP/1 transport when `HTTPS_PROXY`, `HTTP_PROXY`, or `ALL_PROXY` is configured, including AWS SSO credential calls.
- Fixed Amazon Bedrock requests to retry once with HTTP/1 when the AWS SDK's default HTTP/2 transport fails before streaming begins.
- Fixed OpenAI Responses streaming to display thinking tokens from local providers (llama.cpp, etc.) that send raw `reasoning_text.delta` events and empty `summary` arrays in `output_item.done`. Previously, thinking content was silently dropped during streaming while non-streaming mode worked correctly.
- Synced the bundled OpenCode Go catalog with the current docs so `kimi-k2.6`, `mimo-v2.5`, and `mimo-v2.5-pro` appear in offline/default model lists.

## [14.1.3] - 2026-04-17

### Fixed

- Preserved user-provided `session_id` and `x-client-request-id` headers in OpenAI Responses requests instead of overriding them with automatic session-derived values
- Stopped sending `session_id` and `x-client-request-id` headers for OpenAI Responses requests when `cacheRetention` is set to `none`
- Fixed direct OpenAI Responses requests to send `session_id` and `x-client-request-id` from the same session-derived value as `prompt_cache_key`, improving prompt cache affinity for append-only sessions
## [14.1.1] - 2026-04-14

### Added

- Added `toolStrictMode` compatibility option (`"all_strict"` or `"none"`) to OpenAI-compatible model config to force tool schemas to be sent uniformly strict, uniformly non-strict, or keep mixed per-tool behavior

### Changed

- Changed Cerebras OpenAI-compatible providers to default `toolStrictMode` to `"all_strict"` unless explicitly overridden

### Fixed

- Fixed OpenAI Completions handling for providers that reject mixed `strict` flags by automatically retrying with non-strict tool schemas when an initial all-strict tool request fails with strict-format 400/422 errors
- Fixed OpenAI-completions error reporting by including captured JSON error body details such as type, param, and code when a request fails without a body in the thrown SDK error
- Fixed shell execution failure responses to preserve all result fields when sanitizing, preventing truncated metadata in stream results
- Fixed context overflow detection to recognize `model_context_window_exceeded` from z.ai / GLM providers, preventing infinite retry loops when context window is exceeded ([#638](https://github.com/can1357/oh-my-pi/issues/638))
- Fixed strict tool schema enforcement to preserve `additionalProperties: false` and required keys for reused nested object schemas, preventing invalid `todo_write` function schemas in Codex/OpenAI requests
- Fixed GitHub Copilot reasoning regressions by preserving GPT-5.x / Claude 4.x reasoning controls instead of stripping them from requests ([#773](https://github.com/can1357/oh-my-pi/issues/773))

## [14.1.0] - 2026-04-11

### Added

- Added `accountId` to usage report metadata

### Changed

- Changed usage parsing to emit a usage report with available fields when parsing fails, rather than returning null

### Fixed

- Fixed `planType` resolution to fall back to the raw payload `plan_type` when parsed value is absent
- Fixed usage metadata `raw` fallback to preserve the original payload when parsed raw output is missing

## [14.0.5] - 2026-04-11

### Changed

- Replaced GitHub Copilot authentication from VSCode extension impersonation to the opencode OAuth flow, eliminating TOS concerns. Existing users will need to re-authenticate once with `/login github-copilot`.
- Simplified Copilot token handling: GitHub OAuth token is used directly for all API requests (no JWT exchange or refresh cycle).
- Changed GitHub Copilot API base URL from `api.individual.githubcopilot.com` to `api.githubcopilot.com`.
- Updated default OpenAI stream idle timeout to 120,000 milliseconds to keep stream generation alive longer

### Fixed

- Fixed duplicate synthetic tool results being generated when a real tool result appears later in message history
- Fixed GitHub Copilot `/models` discovery to unwrap structured OAuth credentials before sending the bearer token, preserving dynamic catalog refresh for OAuth-backed callers.

### Removed

- Removed Copilot JWT proxy-ep base URL resolution (no longer needed with opencode auth).

## [14.0.3] - 2026-04-09

### Fixed

- Fixed Ollama discovery cache normalization so cached models upgrade to the OpenAI Responses transport after the provider change

## [14.0.0] - 2026-04-08

### Breaking Changes

- Removed `coerceNullStrings` function and its automatic null-string coercion behavior from JSON parsing

### Added

- Added support for OpenRouter provider with strict mode detection
- Added automatic cleaning of literal escape sequences (`\n`, `\t`, `\r`) in JSON parsing to handle LLM encoding confusion
- Added support for healing JSON with trailing junk after balanced containers (e.g., `]\n</invoke>`)
- Added `CODEX_STARTUP_EVENT_CHANNEL` constant and `CodexStartupEvent` type for monitoring Codex provider initialization status
- Added automatic healing of malformed JSON with single-character bracket errors at the end of strings, improving LLM tool argument parsing robustness

## [13.19.0] - 2026-04-05

### Fixed

- Fixed GitHub Copilot model context window detection by correcting fallback priority for maxContextWindowTokens and maxPromptTokens
- Fixed Gemini 2.5 Pro context window detection in GitHub Copilot model limits test
- Fixed Claude Opus 4.6 context window detection in GitHub Copilot model limits test
- Fixed Anthropic streaming to suppress transient SDK console errors for malformed SSE keep-alive frames so the TUI only shows surfaced provider errors

- Added environment-based credential fallback for the OpenAI Codex provider.

## [13.17.6] - 2026-04-01

### Fixed

- Fixed Anthropic first-event timeouts to exclude stream connection setup from the watchdog, preserve timeout-specific retry classification after local aborts, and reset retry state cleanly between attempts

## [13.17.5] - 2026-04-01

### Changed

- Increased default first-event timeout from 15s to 45s to better accommodate longer request setup times
- Modified first-event watchdog to inherit idle timeout when it exceeds the default, ensuring consistent timeout behavior across different configurations

### Fixed

- Fixed first-event watchdog initialization timing so it no longer starts before the actual stream request is created, preventing premature timeouts during request setup
- Fixed first-event watchdog timing so OpenAI-family providers no longer count slow request setup against the first streamed event timeout, and raised the default first-event timeout to avoid false aborts after long tool turns

## [13.17.2] - 2026-04-01

### Fixed

- Fixed OpenAI-family first-event timeouts to preserve provider-specific timeout errors for retry classification instead of flattening them to generic aborts ([#591](https://github.com/can1357/oh-my-pi/issues/591))

## [13.17.1] - 2026-04-01

### Added

- Added `thinkingSignature` field to thinking content blocks to preserve the original reasoning field name (e.g., `reasoning_text`, `reasoning_content`) for accurate follow-up requests
- Added first-event timeout detection for streaming responses to abort stuck requests before user-visible content arrives
- Added `PI_STREAM_FIRST_EVENT_TIMEOUT_MS` environment variable to configure first-event timeout (defaults to 15 seconds or idle timeout, whichever is lower)

### Changed

- Changed thinking block handling to track and distinguish between different reasoning field types, enabling proper field name preservation across multiple turns

### Fixed

- Fixed Anthropic stream timeout errors to be properly retried by recognizing first-event timeout messages
- Fixed stream stall detection to distinguish between first-event timeouts and idle timeouts, enabling faster recovery for stuck connections

### Added

- Added Vercel AI Gateway to `/login` providers for interactive API key setup

### Fixed

- Fixed `omp commit` failing with HTTP 400 errors when using reasoning-enabled models on OpenAI-compatible endpoints that don't support the `developer` role (e.g., GitHub Copilot, custom proxies). Now falls back to `system` role when `developer` is unsupported.

## [13.17.0] - 2026-03-30

### Changed

- Bumped zai provider default model from glm-4.6 to glm-5.1

## [13.16.5] - 2026-03-29

### Added

- Added Gemma 3 27B model support for Google Generative AI

### Changed

- Updated Kwaipilot KAT-Coder-Pro V2 model display name and pricing information
- Updated Kwaipilot KAT-Coder-Pro V2 context window from 222,222 to 256,000 tokens and max tokens from 8,888 to 80,000

### Fixed

- Fixed normalizeAnthropicBaseUrl returning empty string instead of undefined when baseUrl is empty

## [13.16.4] - 2026-03-28

### Added

- Added support for Groq Compound and Compound Mini models with extended context window (131K tokens) and configurable thinking levels
- Added support for OpenAI GPT-OSS-Safeguard-20B model with reasoning capabilities across multiple providers
- Added support for Kwaipilot KAT-Coder-Pro V2 model across Kilo, NanoGPT, and OpenRouter providers
- Added support for GLM-5.1 model with extended context window (200K tokens) and max output of 131K tokens
- Added support for Qwen3.5-27B-Musica-v1 model
- Added support for zai-org/glm-5.1 model with reasoning capabilities
- Added support for Sapiens AI Agnes-1.5-Lite model with multimodal input (text and image) and reasoning
- Added support for Venice openai-gpt-54-mini model

### Changed

- Updated Qwen QwQ 32B max tokens from 16,384 to 40,960 across multiple providers
- Updated OpenAI GPT-OSS-Safeguard-20B model name to 'Safety GPT OSS 20B' and enabled reasoning capabilities
- Updated OpenAI GPT-OSS-Safeguard-20B context window from 222,222 to 131,072 tokens and max tokens from 8,888 to 65,536
- Updated OpenRouter Qwen QwQ 32B pricing: input from 0.2 to 0.19, output from 1.17 to 1.15, cache read from 0.1 to 0.095
- Updated OpenRouter Claude 3.5 Sonnet pricing: input from 0.45 to 0.42, cache read from 0.225 to 0.21

## [13.16.3] - 2026-03-28

### Changed

- Modified OAuth credential saving to preserve unrelated identities instead of replacing all credentials for a provider
- Updated credential identity resolution to use provider context for more accurate email deduplication

### Fixed

- Fixed OAuth credential updates to replace matching credentials in-place rather than creating disabled rows, preventing unbounded accumulation of soft-deleted credentials

## [13.15.0] - 2026-03-23

### Added

- Added `isUsageLimitError()` to `rate-limit-utils` as a single source of truth for detecting usage/quota limit errors across all providers

### Fixed

- Fixed lazy stream forwarding to properly handle final results from source streams with `result()` methods
- Fixed lazy stream error handling to convert iterator failures into terminal error results instead of silently failing
- Fixed `parseRateLimitReason` to recognize "usage limit" in error messages and correctly classify them as `QUOTA_EXHAUSTED`
- Fixed Codex `fetchWithRetry` retrying 429 responses for `usage_limit_reached` errors for up to 5 minutes instead of returning immediately for credential switching
- Removed `usage.?limit` from `TRANSIENT_MESSAGE_PATTERN` in retry utils since usage limits are not transient and require credential rotation
- Fixed `parseRateLimitReason` not recognizing "usage limit" in Codex error messages, causing incorrect fallback to `UNKNOWN` classification instead of `QUOTA_EXHAUSTED`

## [13.14.2] - 2026-03-21

### Changed

- Updated thinking configuration format from `levels` array to `minLevel` and `maxLevel` properties for improved clarity
- Corrected context window from 400000 to 272000 tokens for GPT-5.4 mini and nano variants on Codex transport
- Normalized GPT-5.4 variant priority handling to use parsed variant instead of special-casing raw model IDs
- Added support for `mini` variant in OpenAI model parsing regex

### Fixed

- Fixed inconsistent thinking level configuration across multiple model definitions

## [13.14.0] - 2026-03-20

### Fixed

- Fixed resumed OpenAI Responses sessions to avoid replaying stale same-provider native history on the first follow-up after process restart ([#488](https://github.com/can1357/oh-my-pi/issues/488))

### Added

- Added bundled GPT-5.4 mini model metadata for OpenAI, OpenAI Codex, and GitHub Copilot, including low-to-xhigh thinking support and GitHub Copilot premium multiplier metadata
- Added bundled GPT-5.4 nano model metadata for OpenAI and OpenAI Codex, including low-to-xhigh thinking support

## [13.13.2] - 2026-03-18

### Changed

- Modified tool result handling for aborted assistant messages to preserve existing tool results when already recorded, instead of always replacing them with synthetic 'aborted' results

## [13.13.0] - 2026-03-18

### Changed

- Changed tool argument validation to always normalize optional null values before type coercion, ensuring consistent handling of LLM-generated 'null' strings

### Fixed

- Fixed tool argument validation to properly handle string 'null' values from LLMs on optional fields by stripping them during normalization
- Improved type safety of `validateToolCall` and `validateToolArguments` functions by returning properly typed `ToolCall["arguments"]` instead of `any`

## [13.12.9] - 2026-03-17

### Changed

- Extracted OpenAI compatibility detection and resolution logic into dedicated `openai-completions-compat` module for improved maintainability and reusability

### Fixed

- Fixed `openai-responses` manual history replay to strip replay-only item IDs and preserve normalized tool `call_id` values for GitHub Copilot follow-up turns ([#457](https://github.com/can1357/oh-my-pi/issues/457))

## [13.12.0] - 2026-03-14

### Added

- Added support for `qwen-chat-template` thinking format to enable reasoning via `chat_template_kwargs.enable_thinking`
- Added `reasoningEffortMap` option to `OpenAICompat` for mapping pi-ai reasoning levels to provider-specific `reasoning_effort` values
- Added `extraBody` to `OpenAICompat` to support provider-specific request body routing fields in OpenAI-completions requests
- Added support for reading token usage from choice-level `usage` field as fallback when root-level usage is unavailable
- Added new models: DeepSeek-V3.2 (Bedrock), Llama 3.1 405B Instruct, Magistral Small 1.2, Ministral 3 3B, Mistral Large 3, Pixtral Large (25.02), NVIDIA Nemotron Nano 3 30B, and Qwen3-5-9b
- Added `close()` method to `AuthStorage` for properly closing the underlying credential store
- Added `initiatorOverride` option in OpenAI and Anthropic providers to customize message attribution

### Changed

- Changed assistant message content serialization to always use plain string format instead of text block arrays to prevent recursive nesting in OpenAI-compatible backends
- Changed Bedrock Opus 4.6 context window from 1M to 1M and added max tokens limit of 128K
- Changed OpenCode Zen/Go Sonnet 4.0/4.5 context window from 1M to 200K
- Changed GitHub Copilot context windows from 200K to 128K for both gpt-4o and gpt-4o-mini
- Changed Claude 3.5 Sonnet (Anthropic API) pricing: input from $0.5 to $0.25, output from $3 to $1.5, cache read from $0.05 to $0.025, cache write from $0 to $1
- Changed Devstral 2 model name from '135B' to '123B'
- Changed ByteDance Seed 2.0-Lite to support reasoning with effort-based thinking mode and image inputs
- Changed Qwen3-32b (Groq) reasoning effort mapping to normalize all levels to 'default'
- Changed finish_reason 'end' to map to 'stop' for improved compatibility with additional providers
- Changed Anthropic reference model merging to prioritize bundled metadata for known models while using models.dev for newly discovered IDs

### Fixed

- Fixed reasoning_effort parameter handling to use provider-specific mappings instead of raw effort values
- Fixed assistant content serialization for GitHub Copilot and other OpenAI-compatible backends that mirror array payloads
- Fixed token usage calculation to properly extract cached tokens from both root and nested `prompt_tokens_details` fields
- Fixed stop reason mapping to handle string values and unknown finish reasons gracefully
- Fixed resource cleanup in `AuthCredentialStore.close()` to properly finalize all prepared statements before closing the database

## [13.11.1] - 2026-03-13

### Fixed

- Added `llama.cpp` as local provider
- Fixed auth schema V0-to-V1 migration crash when the V0 table lacks a `disabled` column

## [13.11.0] - 2026-03-12

### Added

- Added support for Parallel AI provider with API key authentication
- Added `PARALLEL_API_KEY` environment variable support for Parallel provider configuration
- Added automatic websocket reconnection handling for connection limit errors, with fallback to SSE replay when content has already been emitted

### Changed

- Enhanced `CodexProviderStreamError` to include an optional error code field for better error categorization and handling

### Fixed

- Improved retry logic to handle HTTP/2 stream errors and internal_error responses from Anthropic API

## [13.9.16] - 2026-03-10

### Added

- Support for `onPayload` callback to replace provider request payloads before sending, enabling request interception and modification
- Support for structured text signature metadata with phase information (commentary/final_answer) in OpenAI and Azure OpenAI Responses providers
- Support for OpenAI Codex Spark model selection with plan-based account prioritization
- Added `modelId` option to `getApiKey()` to enable model-specific credential ranking

### Changed

- Enhanced `onPayload` callback signature to accept model parameter and support async payload replacement
- Improved error messages for `response.failed` events to include detailed error codes, messages, and incomplete reasons
- Refactored OpenAI Codex response streaming to improve code organization and maintainability with extracted helper functions and type definitions
- Enhanced websocket fallback logic to safely replay buffered output over SSE when websocket connections fail mid-stream
- Improved error recovery for websocket streams by distinguishing between fatal connection errors and retryable stream errors
- Updated credential ranking strategy to prioritize Pro plan accounts when requesting OpenAI Codex Spark models

### Fixed

- Fixed websocket stream recovery to properly reset output state and clear buffered items when falling back to SSE after partial output
- Fixed handling of malformed JSON messages in websocket streams to trigger immediate fallback to SSE without retry attempts

## [13.9.13] - 2026-03-10

### Added

- Added `isSpecialServiceTier` utility function to validate OpenAI service tier values

## [13.9.12] - 2026-03-09

### Added

- Added Tavily web search provider support with API key authentication

### Fixed

- Fixed OpenAI-family streaming transports to fail with an explicit idle-timeout error instead of hanging indefinitely when the provider stops sending events mid-response
- Fixed OpenAI Codex OAuth refresh and usage-limit lookups to respect request timeouts instead of waiting indefinitely during account selection or rotation
- Fixed OpenAI Codex prewarmed websocket requests to fall back quickly when the socket connects but never starts the response stream

## [13.9.10] - 2026-03-08

### Added

- Added `identity_key` column to auth credentials storage for improved credential deduplication
- Added schema versioning system to auth credentials database for safer migrations
- Added automatic backfilling of identity keys during database schema migrations

### Changed

- Changed credential deduplication logic to use single identity key instead of multiple identifiers for better performance
- Changed database schema to store normalized identity keys alongside credentials
- Changed auth schema migration to support upgrading from legacy database versions with automatic data backfill

### Fixed

- Fixed API key credential matching to correctly identify when the same key is re-stored, preventing unnecessary row duplication on re-login
- Fixed credential deduplication to correctly handle OAuth accounts with matching emails but different account IDs
- Fixed API key replacement to reuse existing stored rows instead of accumulating disabled duplicates
- Fixed auth storage to preserve newer recorded schema versions when opened by older binaries

## [13.9.8] - 2026-03-08

### Fixed

- Fixed WebSocket stream fallback logic to safely replay buffered output over SSE when WebSocket fails after partial content has been streamed

## [13.9.4] - 2026-03-07

### Changed

- Simplified API key credential storage to always replace existing credentials on re-login instead of accumulating multiple keys
- Updated Kagi API key placeholder from `kagi_...` to `KG_...` to match current API key format
- Updated Kagi login instructions to clarify Search API access is beta-only and provide support contact
- Disabled usage reporting in streaming responses for Cerebras models due to compatibility issues

### Fixed

- Fixed Cerebras model compatibility by preventing `stream_options` usage requests in chat completions

## [13.9.3] - 2026-03-07

### Breaking Changes

- Changed `reasoning` parameter from `ThinkingLevel | undefined` to `Effort | undefined` in `SimpleStreamOptions`; 'off' is no longer valid (omit the field instead)
- Removed `supportsXhigh()` function; check `model.thinking?.maxLevel` instead
- Removed `ThinkingLevel` and `ThinkingEffort` types; use `Effort` enum
- Removed `getAvailableThinkingLevels()` and `getAvailableThinkingEfforts()` functions
- Changed `transformRequestBody()` signature to require `Model` parameter as second argument for effort validation
- Removed `thinking.ts` module export; import from `model-thinking.ts` instead

### Added

- Added `incremental` flag to `OpenAIResponsesHistoryPayload` to support building conversation history from multiple assistant messages instead of replacing it
- Added `dt` flag to `OpenAIResponsesHistoryPayload` for transport-level metadata
- Added `ThinkingConfig` interface to models for canonical thinking transport metadata with min/max effort levels and provider-specific mode
- Added `thinking` field to `Model` type containing per-model thinking capabilities used to clamp and map user-facing effort levels
- Added `Effort` enum (minimal, low, medium, high, xhigh) as canonical user-facing thinking levels replacing `ThinkingLevel`
- Added `enrichModelThinking()` function to automatically populate thinking metadata on models based on their capabilities
- Added `mapEffortToAnthropicAdaptiveEffort()` function to map user effort levels to Anthropic adaptive thinking effort
- Added `mapEffortToGoogleThinkingLevel()` function to map user effort levels to Google thinking levels
- Added `requireSupportedEffort()` function to validate and clamp effort levels per model, throwing errors for unsupported combinations
- Added `clampThinkingLevelForModel()` function to clamp thinking levels to model-supported range
- Added `applyGeneratedModelPolicies()` and `linkSparkPromotionTargets()` exports from model-thinking module
- Added `serviceTier` option to control OpenAI processing priority and cost (auto, default, flex, scale, priority)
- Added `providerPayload` field to messages and responses for reconstructing transport-native history
- Added Gemini usage provider for tracking quota and tier information
- Added `getCodexAccountId()` utility to extract account ID from Codex JWT tokens
- Added email extraction from OpenAI Codex OAuth tokens for credential deduplication

### Changed

- Changed credential disabling mechanism from boolean `disabled` flag to `disabled_cause` text field for tracking why credentials were disabled
- Changed `deleteAuthCredential()` and `deleteAuthCredentialsForProvider()` methods to require a `disabledCause` parameter explaining the reason for disabling
- Changed Gemini model parsing to strip `-preview` suffix for consistent model identification
- Changed OpenAI Codex websocket error handling to detect fatal connection errors and immediately fall back to SSE without retrying
- Changed OpenAI Codex to always use websockets v2 protocol (removed v1 support)
- Changed `reasoning` parameter type from `ThinkingLevel` to `Effort` in `SimpleStreamOptions`, removing 'off' value (callers should omit the field instead)
- Changed thinking configuration to use model-specific metadata instead of hardcoded provider logic for effort mapping
- Changed OpenAI Codex request transformer to accept `Model` parameter for effort validation instead of string model ID
- Changed Anthropic provider to use model thinking metadata for determining adaptive thinking support instead of model ID pattern matching
- Changed Google Vertex and Google providers to use shorter variable names for thinking config construction
- Moved thinking-related utilities from `thinking.ts` to new `model-thinking.ts` module with expanded functionality
- Moved model policy functions from `provider-models/model-policies.ts` to `model-thinking.ts`
- Moved `googleGeminiCliUsageProvider` from `providers/google-gemini-cli-usage.ts` to `usage/gemini.ts`
- Changed default OpenAI model from gpt-5.1-codex to gpt-5.4 across all providers
- Changed `UsageFetchContext` to remove cache and now() dependencies—usage fetchers now use Date.now() directly
- Removed `resetInMs` field from usage windows; consumers should calculate from `resetsAt` timestamp
- Changed OpenAI Codex credential ranking to deduplicate by email when accountId matches
- Improved OpenAI Codex error handling with retryable error detection

### Removed

- Removed `thinking.ts` module; use `model-thinking.ts` instead
- Removed `provider-models/model-policies.ts` module; functionality moved to `model-thinking.ts`
- Removed `supportsXhigh()` function from models.ts; use model.thinking metadata instead
- Removed `ThinkingLevel` and `ThinkingEffort` types; use `Effort` enum instead
- Removed `getAvailableThinkingLevels()` and `getAvailableThinkingEfforts()` functions
- Removed `model-policies` export from `provider-models/index.ts`
- Removed hardcoded thinking level clamping logic from OpenAI Codex request transformer; now uses model metadata
- Removed `UsageCache` and `UsageCacheEntry` interfaces—caching is now handled internally by AuthStorage
- Removed `google-gemini-cli-usage` export; use new `gemini` usage provider instead
- Removed `resetInMs` computation from all usage providers
- Removed cache TTL constants and cache management from usage fetchers (claude, github-copilot, google-antigravity, kimi, openai-codex, zai)

### Fixed

- Fixed credential purging to respect disabled credentials when deduplicating by email, preventing re-enablement of intentionally disabled credentials
- Fixed OpenAI Codex websocket error reporting to include detailed error messages from error events
- Fixed conversation history reconstruction to support incremental updates from multiple assistant messages while maintaining backward compatibility with full-snapshot payloads
- Fixed OpenAI Codex to reject unsupported effort levels instead of silently clamping them, providing clear error messages about supported efforts
- Fixed model cache normalization to properly apply thinking enrichment when loading cached models
- Fixed dynamic model merging to apply thinking enrichment to merged model results
- Fixed OpenAI Codex streaming to properly include service_tier in SSE payloads
- Fixed type safety in OpenAI responses by removing unsafe type casts on image content blocks
- Fixed credential purging to respect disabled credentials when deduplicating by email
- Fixed API-key provider re-login to replace the active stored key instead of appending stale credentials that were still selected first
- Fixed Kagi login guidance to use the correct `KG_...` key format and mention Search API beta access requirements

## [13.9.2] - 2026-03-05

### Added

- Support for redacted thinking blocks in Anthropic messages, enabling secure handling of encrypted reasoning content
- Preservation of latest Anthropic thinking blocks and redacted thinking content during message transformation, even when switching between Anthropic models

### Changed

- Assistant message content now includes `RedactedThinkingContent` type alongside existing text, thinking, and tool call blocks
- Message transformation logic now preserves signed thinking blocks and redacted thinking for the latest assistant message in Anthropic conversations

### Fixed

- Fixed Unicode normalization to consistently apply `toWellFormed()` to all text content, including thinking blocks, ensuring proper handling of malformed UTF-16 sequences

## [13.9.1] - 2026-03-05

### Breaking Changes

- Removed `THINKING_LEVELS`, `ALL_THINKING_LEVELS`, `ALL_THINKING_MODES`, `THINKING_MODE_DESCRIPTIONS`, and `THINKING_MODE_LABELS` exports
- Renamed `formatThinking()` to `getThinkingMetadata()` with changed return type from string to `ThinkingMetadata` object
- Renamed `getAvailableThinkingLevel()` to `getAvailableThinkingLevels()` and added default parameter
- Renamed `getAvailableEffort()` to `getAvailableEfforts()` and added default parameter

### Added

- Added `ThinkingMetadata` type to provide structured access to thinking mode information (value, label, description)

## [13.9.0] - 2026-03-05

### Added

- Exported new thinking module with `Effort`, `ThinkingLevel`, and `ThinkingMode` types for managing reasoning effort levels
- Added `getAvailableEffort()` function to determine supported thinking effort levels based on model capabilities
- Added `parseEffort()`, `parseThinkingLevel()`, and `parseThinkingMode()` functions for parsing thinking configuration strings
- Added `THINKING_LEVELS`, `ALL_THINKING_LEVELS`, and `ALL_THINKING_MODES` constants for iterating over available thinking options
- Added `THINKING_MODE_DESCRIPTIONS` and `THINKING_MODE_LABELS` for displaying thinking modes in user interfaces
- Added `formatThinking()` function to format thinking modes as compact display labels

### Changed

- Refactored thinking level handling to distinguish between `Effort` (provider-level, no "off") and `ThinkingLevel` (user-facing, includes "off")
- Updated `ThinkingBudgets` type to use `Effort` instead of `ThinkingLevel` for more precise token budget configuration
- Improved reasoning option handling to explicitly support "off" value for disabling reasoning across all providers
- Simplified thinking effort mapping logic by centralizing provider-specific clamping behavior

## [13.7.8] - 2026-03-04

### Added

- Added ZenMux provider support with mixed API routing: Anthropic-owned models discovered from `https://zenmux.ai/api/v1/models` now use the Anthropic transport (`https://zenmux.ai/api/anthropic`), while other ZenMux models use the OpenAI-compatible transport.

## [13.7.7] - 2026-03-04

### Changed

- Modified response ID normalization to preserve existing item ID prefixes when truncating oversized IDs
- Updated tool call ID normalization to use `fc_` prefix for generated item IDs instead of `item_` prefix

### Fixed

- Fixed handling of reasoning item IDs to remain untouched during response normalization while function call IDs are properly normalized

## [13.7.2] - 2026-03-04

### Added

- Added support for Kagi API key authentication via `login kagi` command
- Added Kagi to the list of available OAuth providers

### Fixed

- MCP tool schemas with `$ref`/`$defs` are now dereferenced before being sent to LLM providers, fixing dangling references that left models without type definitions
- Ajv schema validation no longer emits `console.warn()` for non-standard format keywords (e.g. `"uint"`) from MCP servers, preventing TUI corruption
- Tool schema compilation is now cached per schema identity, eliminating redundant recompilation on every tool call

## [13.6.0] - 2026-03-03

### Added

- Added Anthropic Foundry gateway mode controlled by `CLAUDE_CODE_USE_FOUNDRY`, with support for `FOUNDRY_BASE_URL`, `ANTHROPIC_FOUNDRY_API_KEY`, `ANTHROPIC_CUSTOM_HEADERS`, and optional mTLS material (`CLAUDE_CODE_CLIENT_CERT`, `CLAUDE_CODE_CLIENT_KEY`, `NODE_EXTRA_CA_CERTS`)
- Added LM Studio provider support with OpenAI-compatible model discovery and OAuth login.
- Added support for `LM_STUDIO_API_KEY` and `LM_STUDIO_BASE_URL` environment variables for authentication and custom host configuration.

### Changed

- Anthropic key resolution now prefers `ANTHROPIC_FOUNDRY_API_KEY` over `ANTHROPIC_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` when Foundry mode is enabled
- Anthropic auth base-URL fallback now prefers `FOUNDRY_BASE_URL` when `CLAUDE_CODE_USE_FOUNDRY` is enabled

## [13.5.8] - 2026-03-02

### Fixed

- Fixed schema compatibility issue where patternProperties in tool parameters caused failures when converting to legacy Antigravity format

## [13.5.5] - 2026-03-01

### Changed

- Anthropic Claude system-block cloaking now leaves the agent identity block uncached and applies `cache_control: { type: "ephemeral" }` to injected user system blocks without forcing `ttl: "1h"`

### Fixed

- Anthropic request payload construction now enforces a maximum of 4 `cache_control` breakpoints (tools/system/messages priority order) before dispatch
- Anthropic cache-control normalization now removes later `ttl: "1h"` entries when a default/5m block has already appeared earlier in evaluation order

## [13.5.3] - 2026-03-01

### Fixed

- Fixed tool argument coercion to handle malformed JSON with trailing wrapper braces by parsing leading JSON containers

## [13.4.0] - 2026-03-01

### Breaking Changes

- Removed `TInput` generic parameter from `ToolResultMessage` interface and removed `$normative` property

### Added

- `hasUnrepresentableStrictObjectMap()` pre-flight check in `tryEnforceStrictSchema`: schemas with `patternProperties` or schema-valued `additionalProperties` now degrade gracefully to non-strict mode instead of throwing during enforcement
- `generateClaudeCloakingUserId()` generates structured user IDs for Anthropic OAuth metadata (`user_{hex64}_account_{uuid}_session_{uuid}`)
- `isClaudeCloakingUserId()` validates whether a string matches the cloaking user-ID format
- `mapStainlessOs()` and `mapStainlessArch()` map `process.platform`/`process.arch` to Stainless header values; X-Stainless-Os and X-Stainless-Arch in `claudeCodeHeaders` are now runtime-computed
- `buildClaudeCodeTlsFetchOptions()` attaches SNI and default TLS ciphers for direct `api.anthropic.com` connections
- `createClaudeBillingHeader()` generates the `x-anthropic-billing-header` block (SHA-256 payload fingerprint + random build hash)
- `buildAnthropicSystemBlocks()` now injects a billing header block and the Claude Agent SDK identity block with `ephemeral` 1h cache-control when `includeClaudeCodeInstruction` is set
- `resolveAnthropicMetadataUserId()` auto-generates a cloaking user ID for OAuth requests when `metadata.user_id` is absent or invalid
- `AnthropicOAuthFlow` is now exported for direct use
- OAuth callback server timeout extended from 2 min to 5 min
- `parseGeminiCliCredentials()` parses Google Cloud credential JSON with support for legacy (`{token,projectId}`), alias (`project_id`/`refresh`/`expires`), and enriched formats
- `shouldRefreshGeminiCliCredentials()` and proactive token refresh before requests for both Gemini CLI and Antigravity providers (60s pre-expiry buffer)
- `normalizeAntigravityTools()` converts `parametersJsonSchema` → `parameters` in function declarations for Antigravity compatibility
- `ANTIGRAVITY_SYSTEM_INSTRUCTION` is now exported for use by search and other consumers
- `ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA` constant exported from OAuth module with `ANTIGRAVITY` ideType
- Antigravity project onboarding: `onboardProjectWithRetries()` provisions a new project via `onboardUser` LRO when `loadCodeAssist` returns no existing project (up to 5 attempts, 2s interval)
- `getOAuthApiKey` now includes `refreshToken`, `expiresAt`, `email`, and `accountId` in the Gemini/Antigravity JSON credential payload to enable proactive refresh
- Antigravity model discovery now tries the production daily endpoint first, with sandbox as fallback
- `ANTIGRAVITY_DISCOVERY_DENYLIST` filters low-quality/internal models from discovery results

### Changed

- Replaced `sanitizeSurrogates()` utility with native `String.prototype.toWellFormed()` for handling unpaired Unicode surrogates across all providers
- Extended `ANTHROPIC_OAUTH_BETA` constant in the OpenAI-compat Anthropic route with `interleaved-thinking-2025-05-14`, `context-management-2025-06-27`, and `prompt-caching-scope-2026-01-05` beta flags
- `claudeCodeVersion` bumped to `2.1.63`; `claudeCodeSystemInstruction` updated to identify as Claude Agent SDK
- `claudeCodeHeaders`: removed `X-Stainless-Helper-Method`, updated package version to `0.74.0`, runtime version to `v24.3.0`
- `applyClaudeToolPrefix` / `stripClaudeToolPrefix` now accept an optional prefix override and skip Anthropic built-in tool names (`web_search`, `code_execution`, `text_editor`, `computer`)
- Accept-Encoding header updated to `gzip, deflate, br, zstd`
- Non-Anthropic base URLs now receive `Authorization: Bearer` regardless of OAuth status
- Prompt-caching logic now skips applying breakpoints when any block already carries `cache_control`, instead of stripping then re-applying
- `fine-grained-tool-streaming-2025-05-14` removed from default beta set
- Anthropic OAuth token URL changed from `platform.claude.com` to `api.anthropic.com`
- Anthropic OAuth scopes reduced to `org:create_api_key user:profile user:inference`
- OAuth code exchange now strips URL fragment from callback code, using the fragment as state override when present
- Claude usage headers aligned: user-agent updated to `claude-cli/2.1.63 (external, cli)`, anthropic-beta extended with full beta set
- Antigravity session ID format changed to signed decimal (negative int63 derived from SHA-256 of first user message, or random bounded int63)
- Antigravity `requestId` now uses `agent-{uuid}` format; non-Antigravity requests no longer include requestId/userAgent/requestType in the payload
- `ANTIGRAVITY_DAILY_ENDPOINT` corrected to `daily-cloudcode-pa.googleapis.com`; sandbox endpoint kept as fallback only
- Antigravity discovery: removed `recommended`/`agentModelSorts` filter; now includes all non-internal, non-denylisted models
- Antigravity discovery no longer sends `project` in the request body
- Gemini/Antigravity OAuth flows no longer use PKCE (code_challenge removed)
- Antigravity `loadCodeAssist` metadata ideType changed from `IDE_UNSPECIFIED` to `ANTIGRAVITY`
- Antigravity `discoverProject` now uses a single canonical production endpoint; falls back to project onboarding instead of a hardcoded default project ID
- `VALIDATED` tool calling config applied to Antigravity requests with Claude models
- `maxOutputTokens` removed from Antigravity generation config for non-Claude models
- System instruction injection for Antigravity scoped to Claude and `gemini-3-pro-high` models only

### Removed

- Removed `sanitizeSurrogates()` utility function; use native `String.prototype.toWellFormed()` instead

## [13.3.14] - 2026-02-28

### Added

- Exported schema utilities from new `./utils/schema` module, consolidating JSON Schema handling across providers
- Added `CredentialRankingStrategy` interface for providers to implement usage-based credential selection
- Added `claudeRankingStrategy` for Anthropic OAuth credentials to enable smart multi-account selection based on usage windows
- Added `codexRankingStrategy` for OpenAI Codex OAuth credentials with priority boost for fresh 5-hour window starts
- Added `adaptSchemaForStrict()` helper for unified OpenAI strict schema enforcement across providers
- Added schema equality and merging utilities: `areJsonValuesEqual()`, `mergeCompatibleEnumSchemas()`, `mergePropertySchemas()`
- Added Cloud Code Assist schema normalization: `copySchemaWithout()`, `stripResidualCombiners()`, `prepareSchemaForCCA()`
- Added `sanitizeSchemaForGoogle()` and `sanitizeSchemaForCCA()` for provider-specific schema sanitization
- Added `StringEnum()` helper for creating string enum schemas compatible with Google and other providers
- Added `enforceStrictSchema()` and `sanitizeSchemaForStrictMode()` for OpenAI strict mode schema validation
- Added package exports for `./utils/schema` and `./utils/schema/*` subpaths
- Added `validateSchemaCompatibility()` to statically audit a JSON Schema against provider-specific rules (`openai-strict`, `google`, `cloud-code-assist-claude`) and return structured violations
- Added `validateStrictSchemaEnforcement()` to verify the strict-fail-open contract: enforced schemas pass strict validation, failed schemas return the original object identity
- Added `COMBINATOR_KEYS` (`anyOf`, `allOf`, `oneOf`) and `CCA_UNSUPPORTED_SCHEMA_FIELDS` as exported constants in `fields.ts` to eliminate duplication across modules
- Added `tryEnforceStrictSchema` result cache (`WeakMap`) to avoid redundant sanitize + enforce work for the same schema object
- Added comprehensive schema normalization test suite (`schema-normalization.test.ts`) covering strict mode, Google, and Cloud Code Assist normalization paths
- Added schema compatibility validation test suite (`schema-compatibility.test.ts`) covering all three provider targets

### Changed

- Moved schema utilities from `./utils/typebox-helpers` to new `./utils/schema` module with expanded functionality
- Refactored OpenAI provider tool conversion to use unified `adaptSchemaForStrict()` helper across codex, completions, and responses
- Updated `AuthStorage` to support generic credential ranking via `CredentialRankingStrategy` instead of Codex-only logic
- Moved Google schema sanitization functions from `google-shared.ts` to `./utils/schema` module
- Changed export path: `./utils/typebox-helpers` → `./utils/schema` in main index
- `sanitizeSchemaForGoogle()` / `sanitizeSchemaForCCA()` now accept a parameterized `unsupportedFields` set internally, enabling code reuse between the two sanitizers
- `copySchemaWithout()` rewritten using object-rest destructuring for clarity

### Fixed

- Fixed cycle detection: `WeakSet` guards added to all recursive schema traversals (`sanitizeSchemaForStrictMode`, `enforceStrictSchema`, `normalizeSchemaForCCA`, `normalizeNullablePropertiesForCloudCodeAssist`, `stripResidualCombiners`, `sanitizeSchemaImpl`, `hasResidualCloudCodeAssistIncompatibilities`) — circular schemas no longer cause infinite loops or stack overflows
- Fixed `hasResidualCloudCodeAssistIncompatibilities`: cycle detection now returns `false` (not `true`) for already-visited nodes, eliminating false positives that forced the CCA fallback schema on valid recursive inputs
- Fixed `stripResidualCombiners` to iterate to a fixpoint rather than making a single pass, ensuring chained combiner reductions (where one reduction enables another) are fully resolved
- Fixed `mergeObjectCombinerVariants` required-field computation: the flattened object now takes the intersection of all variants' `required` arrays (unioned with own-level required properties that exist in the merged schema), preventing required fields from being silently dropped or over-included
- Fixed `mergeCompatibleEnumSchemas` to use deep structural equality (`areJsonValuesEqual`) instead of `Object.is` when deduplicating object-valued enum members
- Fixed `sanitizeSchemaForGoogle` const-to-enum deduplication to use deep equality instead of reference equality
- Fixed `sanitizeSchemaForGoogle` type inference for `anyOf`/`oneOf`-flattened const enums: type is now derived from all variants (must agree), falling back to inference from enum values; mixed null/non-null infers the non-null type and sets `nullable`
- Fixed `sanitizeSchemaForGoogle` recursion to spread options when descending (previously only `insideProperties`, `normalizeTypeArrayToNullable`, `stripNullableKeyword` were forwarded; new fields `unsupportedFields` and `seen` were silently dropped)
- Fixed `sanitizeSchemaForGoogle` array-valued `type` filtering to exclude non-string entries before processing
- Removed incorrect `additionalProperties: false` stripping from `sanitizeSchemaForGoogle` (the field is valid in Google schemas when `false`)
- Fixed `sanitizeSchemaForStrictMode` to strip the `nullable` keyword and expand it into `anyOf: [schema, {type: "null"}]` in the output, matching what OpenAI strict mode actually expects
- Fixed `sanitizeSchemaForStrictMode` to infer `type: "array"` when `items` is present but `type` is absent
- Fixed `sanitizeSchemaForStrictMode` to infer a scalar `type` from uniform `enum` values when `type` is not explicitly set
- Fixed `sanitizeSchemaForStrictMode` const-to-enum merge to use deep equality, preventing duplicate enum entries when `const` and `enum` both exist with the same value
- Fixed `enforceStrictSchema` to drop `additionalProperties` unconditionally (previously only object-valued `additionalProperties` was recursed into; non-object values were passed through, violating strict schema requirements)
- Fixed `enforceStrictSchema` to recurse into `$defs` and `definitions` blocks so referenced sub-schemas are also made strict-compliant
- Fixed `enforceStrictSchema` to handle tuple-style `items` arrays (previously only single-schema `items` objects were recursed)
- Fixed `enforceStrictSchema` double-wrapping: optional properties already expressed as `anyOf: [..., {type: "null"}]` are not wrapped again
- Fixed `enforceStrictSchema` `Array.isArray` type-narrowing for `type` field to filter non-string entries before checking for `"object"`

## [13.3.8] - 2026-02-28

### Fixed

- Fixed response body reuse error when handling 429 rate limit responses with retry logic

## [13.3.7] - 2026-02-27

### Added

- Added `tryEnforceStrictSchema` function that gracefully downgrades to non-strict mode when schema enforcement fails, enabling better compatibility with malformed or circular schemas
- Added `sanitizeSchemaForStrictMode` function to normalize JSON schemas by stripping non-structural keywords, converting `const` to `enum`, and expanding type arrays into `anyOf` variants
- Added Kilo Gateway provider support with OpenAI-compatible model discovery, OAuth `/login kilo`, and `KILO_API_KEY` environment variable support ([#193](https://github.com/can1357/oh-my-pi/issues/193))

### Changed

- Changed strict mode handling in OpenAI providers to use `tryEnforceStrictSchema` for safer schema enforcement with automatic fallback to non-strict mode
- Enhanced `enforceStrictSchema` to properly handle schemas with type arrays containing `object` (e.g., `type: ["object", "null"]`)

### Fixed

- Fixed `enforceStrictSchema` to properly handle malformed object schemas with required keys but missing properties
- Fixed `enforceStrictSchema` to correctly process nested object schemas within `anyOf`, `allOf`, and `oneOf` combinators

## [13.3.1] - 2026-02-26

### Added

- Added `topP`, `topK`, `minP`, `presencePenalty`, and `repetitionPenalty` options to `StreamOptions` for fine-grained control over model sampling behavior

## [13.3.0] - 2026-02-26

### Changed

- Allowed OAuth provider logins to supply a manual authorization code handler with a default prompt when none is provided

## [13.2.0] - 2026-02-23

### Added

- Added support for GitHub Copilot provider in strict mode for both openai-completions and openai-responses tool schemas

### Fixed

- Fixed tool descriptions being rejected when undefined by providing empty string fallback across all providers

## [12.19.1] - 2026-02-22

### Added

- Exported `isProviderRetryableError` function for detecting rate-limit and transient stream errors
- Support for retrying malformed JSON stream-envelope parse errors from Anthropic-compatible proxy endpoints

### Changed

- Expanded retry detection to include JSON parse errors (unterminated strings, unexpected end of input) in addition to rate-limit errors

## [12.19.0] - 2026-02-22

### Added

- Added GitLab Duo provider with support for Claude, GPT-5, and other models via GitLab AI Gateway
- Added OAuth authentication for GitLab Duo with automatic token refresh and direct access caching
- Added 16 new GitLab Duo models including Claude Opus/Sonnet/Haiku variants and GPT-5 series models
- Added `isOAuth` option to Anthropic provider to force OAuth bearer auth mode for proxy tokens
- Added `streamGitLabDuo` function to route requests through GitLab AI Gateway with direct access tokens
- Added `getGitLabDuoModels` function to retrieve available GitLab Duo model configurations
- Added `clearGitLabDuoDirectAccessCache` function to manually clear cached direct access tokens

### Changed

- Enhanced `getModelMapping()` to support both GitLab Duo alias IDs (e.g., `duo-chat-gpt-5-codex`) and canonical model IDs (e.g., `gpt-5-codex`) for improved model resolution flexibility
- Migrated `AuthCredentialStore` and `AuthStorage` into `@oh-my-pi/pi-ai` as shared credential primitives for downstream packages
- Moved Anthropic auth helpers (`findAnthropicAuth`, `isOAuthToken`, `buildAnthropicSearchHeaders`, `buildAnthropicUrl`) into shared AI utilities for reuse across providers
- Replaced `CliAuthStorage` with `AuthCredentialStore` for improved credential management with multiple credentials per provider
- Updated models.json pricing for Claude 3.5 Sonnet (input: 0.23→0.45, output: 3→2.2, added cache read: 0.225) and Claude 3 Opus (input: 0.3→0.95)
- Moved `mapAnthropicToolChoice` function from gitlab-duo provider to stream module for broader reusability
- Enhanced HTTP status code extraction to handle string-formatted status codes in error objects

### Removed

- Removed `CliAuthStorage` class in favor of new `AuthCredentialStore` with enhanced functionality

## [12.17.2] - 2026-02-21

### Added

- Exported `getAntigravityUserAgent()` function for constructing Antigravity User-Agent headers

### Changed

- Updated default Antigravity version from 1.15.8 to 1.18.3
- Unified User-Agent header generation across Antigravity API calls to use centralized `getAntigravityUserAgent()` function

## [12.17.1] - 2026-02-21

### Added

- Added new export paths for provider models via `./provider-models` and `./provider-models/*`
- Added new export paths for Cursor and OpenAI Codex providers via `./providers/cursor/gen/*` and `./providers/openai-codex/*`
- Added new export paths for usage utilities via `./usage/*`
- Added new export paths for discovery and OAuth utilities via `./utils/discovery` and `./utils/oauth` with subpath exports

### Changed

- Simplified main export path to use wildcard pattern `./src/*.ts` for broader module access
- Updated `models.json` export to include TypeScript declaration file at `./src/models.json.d.ts`
- Reorganized package.json field ordering for improved readability

## [12.17.0] - 2026-02-21

### Fixed

- Cursor provider: bind `execHandlers` when passing handler methods to the exec protocol so handlers receive correct `this` context (fixes "undefined is not an object (evaluating 'this.options')" when using exec tools such as web search with Cursor)

## [12.16.0] - 2026-02-21

### Added

- Exported `readModelCache` and `writeModelCache` functions for direct SQLite-backed model cache access
- Added `<turn_aborted>` guidance marker as synthetic user message when assistant messages are aborted or errored, informing the model that tools may have partially executed
- Added support for Sonnet 4.6 models in adaptive thinking detection

### Changed

- Updated model cache schema version to support improved global model fallback resolution
- Improved GitHub Copilot model resolution to prefer provider-specific model definitions over global references when context window is larger, ensuring optimal model capabilities
- Migrated model cache from per-provider JSON files to unified SQLite database (models.db) for atomic cross-process access
- Renamed `cachePath` option to `cacheDbPath` in ModelManagerOptions to reflect database-backed storage
- Improved non-authoritative cache handling with 5-minute retry backoff instead of retrying on every startup
- Modified handling of aborted/errored assistant messages to preserve tool call structure instead of converting to text summaries, with synthetic 'aborted' tool results injected
- Updated tool call tracking to use status map (Resolved/Aborted) instead of separate sets for better handling of duplicate and aborted tool results

## [12.15.0] - 2026-02-20

### Fixed

- Improved error messages for OAuth token refresh failures by including detailed error information from the provider
- Separated rate limit and usage limit error handling to provide distinct user-friendly messages for ChatGPT rate limits vs subscription usage limits

### Changed

- Increased SDK retry attempts to 5 for OpenAI, Azure OpenAI, and Anthropic clients (was SDK default of 2)
- Changed 429 retry strategy for OpenAI Codex and Google Gemini CLI to use a 5-minute time budget when the server provides a retry delay, instead of a fixed attempt cap

## [12.14.0] - 2026-02-19

### Added

- Added `gemini-3.1-pro` model to opencode provider with text and image input support
- Added `trinity-large-preview-free` model to opencode provider
- Added `google/gemini-3.1-pro-preview` model to nanogpt provider
- Added `google/gemini-3.1-pro-preview` model to openrouter provider with text and image input support
- Added `gemini-3.1-pro` model to cursor provider
- Added optional `intent` field to `ToolCall` interface for harness-level intent metadata

### Changed

- Changed `big-pickle` model API from `openai-completions` to `anthropic-messages`
- Changed `big-pickle` model baseUrl from `https://opencode.ai/zen/v1` to `https://opencode.ai/zen`
- Changed `minimax-m2.5-free` model API from `openai-completions` to `anthropic-messages`
- Changed `minimax-m2.5-free` model baseUrl from `https://opencode.ai/zen/v1` to `https://opencode.ai/zen`

### Fixed

- Fixed tool argument validation to iteratively coerce nested JSON strings across multiple passes, enabling proper handling of deeply nested JSON-serialized objects and arrays

## [12.13.0] - 2026-02-19

### Added

- Added NanoGPT provider support with API-key login, dynamic model discovery from `https://nano-gpt.com/api/v1/models`, and text-model filtering for catalog/runtime discovery ([#111](https://github.com/can1357/oh-my-pi/issues/111))

## [12.12.3] - 2026-02-19

### Fixed

- Fixed retry logic to recognize 'unable to connect' errors as transient failures

## [12.11.3] - 2026-02-19

### Fixed

- Fixed OpenAI Codex streaming to fail truncated responses that end without a terminal completion event, preventing partial outputs from being treated as successful completions.
- Fixed Codex websocket append fallback by resetting stale turn-state/model-etag session metadata when request shape diverges from appendable history.

## [12.11.1] - 2026-02-19

### Added

- Added support for Claude 4.6 Opus and Sonnet models via Cursor API
- Added support for Composer 1.5 model via Cursor API
- Added support for GPT-5.1 Codex Mini and GPT-5.1 High models via Cursor API
- Added support for GPT-5.2 and GPT-5.3 Codex variants (Fast, High, Low, Extra High) via Cursor API
- Added HTTP/2 transport support for Cursor API requests (required by Cursor API)

### Changed

- Updated pricing for Claude 3.5 Sonnet model
- Updated Claude 3.5 Sonnet context window from 262,144 to 131,072 tokens
- Simplified Cursor model display names by removing '(Cursor)' suffix
- Changed Cursor API timeout from 15 seconds to 5 seconds
- Switched Cursor API transport from HTTP/1.1 to HTTP/2

## [12.11.0] - 2026-02-19

### Added

- Added `priority` field to Model interface for provider-assigned model prioritization
- Added `CatalogDiscoveryConfig` interface to standardize catalog discovery configuration across providers
- Added type guards `isCatalogDescriptor()` and `allowsUnauthenticatedCatalogDiscovery()` for safer descriptor handling
- Added `DEFAULT_MODEL_PER_PROVIDER` export from descriptors module for centralized default model management
- Support for 11 new AI providers: Cloudflare AI Gateway, Hugging Face Inference, LiteLLM, Moonshot, NVIDIA, Ollama, Qianfan, Qwen Portal, Together, Venice, vLLM, and Xiaomi MiMo
- Login flows for new providers with API key validation and OAuth token support
- Extended `KnownProvider` type to include all newly supported providers
- API key environment variable mappings for all new providers in service provider map
- Model discovery and configuration for Cloudflare AI Gateway, Hugging Face, LiteLLM, Moonshot, NVIDIA, Ollama, Qianfan, Qwen Portal, Together, Venice, vLLM, and Xiaomi MiMo

### Changed

- Refactored OAuth credential retrieval to simplify storage lifecycle management in model generation script
- Parallelized special model discovery sources (Antigravity, Codex) for improved generation performance
- Reorganized model JSON structure to place `contextWindow` and `maxTokens` before `compat` field for consistency
- Added `priority` field to OpenAI Codex models for provider-assigned model prioritization
- Refactored provider descriptors to use helper functions (`descriptor`, `catalog`, `catalogDescriptor`) for reduced code duplication
- Refactored models.dev provider descriptors to use helper functions (`simpleModelsDevDescriptor`, `openAiCompletionsDescriptor`, `anthropicMessagesDescriptor`) for improved maintainability
- Unified provider descriptors into single source of truth in `descriptors.ts` for both runtime model discovery and catalog generation, improving maintainability
- Refactored model generation script to use declarative `CatalogProviderDescriptor` interface instead of separate descriptor types, reducing code duplication
- Reorganized models.dev provider descriptors into logical groups (Bedrock, Core, Coding Plans, Specialized) for better code organization
- Simplified API resolution for OpenCode and GitHub Copilot providers using rule-based matching instead of inline conditionals
- Refactored model generation script to use declarative provider descriptors instead of inline provider-specific logic, improving maintainability and reducing code duplication
- Extracted model post-processing policies (cache pricing corrections, context window normalization) into dedicated `model-policies.ts` module for better testability and clarity
- Removed static bundled models for Ollama and vLLM from `models.json` to rely on dynamic discovery instead, reducing static catalog size
- Updated `OAuthProvider` type to include new provider identifiers
- Expanded model registry (models.json) with thousands of new model entries across all new providers
- Modified environment variable resolution to use `$pickenv` for providers with multiple possible env var names
- Updated README documentation to list all newly supported providers and their authentication requirements

## [12.10.1] - 2026-02-18

- Added Synthetic provider
- Added API-key login helpers for Synthetic and Cerebras providers

## [12.10.0] - 2026-02-18

### Breaking Changes

- Renamed public API functions: `getModel()` → `getBundledModel()`, `getModels()` → `getBundledModels()`, `getProviders()` → `getBundledProviders()`

### Added

- Exported `ModelManager` API for runtime-aware model resolution with dynamic endpoint discovery
- Exported provider-specific model manager configuration helpers for Google, OpenAI-compatible, Codex, and Cursor providers
- Exported discovery utilities for fetching models from Antigravity, Codex, Cursor, Gemini, and OpenAI-compatible endpoints
- Added `createModelManager()` function to manage bundled and dynamically discovered models with configurable refresh strategies
- Added support for on-disk model caching with TTL-based invalidation
- Added `resolveProviderModels()` function for runtime model resolution across multiple providers
- Added EU cross-region inference variants for Claude Haiku 3.5 on Bedrock
- Added Claude Sonnet 4.6 and Claude Sonnet 4.6 Thinking models to Antigravity provider
- Added GLM-5 Free model via OpenCode provider
- Added GLM-4.7-FlashX model via ZAI provider
- Added MiniMax-M2.5-highspeed model across multiple providers (minimax-code, minimax-code-cn, minimax, minimax-cn)
- Added Claude Sonnet 4.6 model to OpenRouter provider
- Added Qwen 3.5 Plus model to Vercel AI Gateway provider
- Added Claude Sonnet 4.6 model to Vercel AI Gateway provider

### Changed

- Renamed `getModel()` to `getBundledModel()` to clarify it returns compile-time bundled models only
- Renamed `getModels()` to `getBundledModels()` for consistency
- Renamed `getProviders()` to `getBundledProviders()` for consistency
- Refactored model generation script to use modular discovery functions instead of monolithic provider-specific logic
- Updated models.json with new model entries and pricing updates across multiple providers
- Updated pricing for deepseek/deepseek-v3 model on OpenRouter
- Updated maxTokens from 65536 to 4096 for deepseek/deepseek-v3 on OpenRouter
- Updated pricing and maxTokens for mistralai/mistral-large-2411 on OpenRouter
- Updated pricing for qwen/qwen-max on Together AI
- Updated pricing for qwen/qwen-vl-plus on Together AI
- Updated pricing for qwen/qwen-plus on Together AI
- Updated pricing for qwen/qwen-turbo on Together AI
- Expanded EU cross-region inference variant support to all Claude models on Bedrock (previously limited to Haiku, Sonnet, and Opus 4.5)

## [12.8.0] - 2026-02-16

### Added

- Added `contextPromotionTarget` model property to specify preferred fallback model when context promotion is triggered
- Added automatic context promotion target assignment for Spark models to their base model equivalents
- Added support for Brave search provider with BRAVE_API_KEY environment variable

### Changed

- Updated Qwen model context window and max token limits for improved accuracy

## [12.7.0] - 2026-02-16

### Added

- Added DeepSeek-V3.2 model support via Amazon Bedrock
- Added GLM-5 model support via OpenCode
- Added MiniMax M2.5 model support via OpenCode

### Changed

- Updated GLM-4.5, GLM-4.5-Air, GLM-4.5-Flash, GLM-4.5V, GLM-4.6, GLM-4.6V, GLM-4.7, GLM-4.7-Flash, and GLM-5 models to use anthropic-messages API instead of openai-completions
- Updated GLM models base URL from https://api.z.ai/api/coding/paas/v4 to https://api.z.ai/api/anthropic
- Updated pricing for multiple models including Mistral, Moonshot, and Qwen variants
- Updated context window and max tokens for several models to reflect accurate specifications

### Removed

- Removed compat field with supportsDeveloperRole and thinkingFormat properties from GLM models

## [12.6.0] - 2026-02-16

### Added

- Added source-scoped custom API and OAuth provider registration helpers for extension-defined providers.

### Changed

- Expanded `Api` typing to allow extension-defined API identifiers while preserving built-in API exhaustiveness checks.

### Fixed

- Fixed custom API registration to reject built-in API identifiers and prevent accidental provider overrides.

## [12.2.0] - 2026-02-13

### Added

- Added automatic retry logic for WebSocket stream closures before response completion, with configurable retry budget to improve reliability on flaky connections
- Added `providerSessionState` option to enable provider-scoped mutable state persistence across agent turns
- Added WebSocket retry logic with configurable retry budget and delay via `PI_CODEX_WEBSOCKET_RETRY_BUDGET` and `PI_CODEX_WEBSOCKET_RETRY_DELAY_MS` environment variables
- Added WebSocket idle timeout detection via `PI_CODEX_WEBSOCKET_IDLE_TIMEOUT_MS` environment variable to fail stalled connections
- Added WebSocket v2 beta header support via `PI_CODEX_WEBSOCKET_V2` environment variable for newer OpenAI API versions
- Added WebSocket handshake header capture to extract and replay session metadata (turn state, models etag, reasoning flags) across SSE fallback requests
- Added `preferWebsockets` option to enable WebSocket transport for OpenAI Codex responses when supported
- Added `prewarmOpenAICodexResponses()` function to establish and reuse WebSocket connections across multiple requests
- Added `getOpenAICodexTransportDetails()` function to inspect transport layer details including WebSocket status and fallback information
- Added `getProviderDetails()` function to retrieve formatted provider configuration and transport information
- Added automatic fallback from WebSocket to SSE when connection fails, with transparent retry logic
- Added session state management to reuse WebSocket connections and enable request appending across turns
- Added support for x-codex-turn-state header to maintain conversation state across SSE requests

### Changed

- Changed WebSocket session state storage from global maps to provider-scoped session state for multi-agent isolation
- Changed WebSocket connection initialization to accept idle timeout configuration and handshake header callbacks
- Changed WebSocket error handling to use standardized transport error messages with `Codex websocket transport error` prefix
- Changed WebSocket retry behavior to retry transient failures before activating sticky fallback, improving reliability on flaky connections
- Changed OpenAI Codex model configuration to prefer WebSocket transport by default with `preferWebsockets: true`
- Changed header handling to use appropriate OpenAI-Beta header values for WebSocket vs SSE transports
- Perplexity OAuth token refresh now uses JWT expiry extraction instead of Socket.IO RPC, improving reliability when server is unreachable
- Removed Socket.IO client implementation for Perplexity token refresh; tokens are now validated using embedded JWT expiry claims

### Removed

- Removed `refreshPerplexityToken` export; token refresh is now handled internally via JWT expiry detection

### Fixed

- Fixed WebSocket stream retry logic to properly handle mid-stream connection closures and retry before falling back to SSE transport
- Fixed `preferWebsockets` option handling to correctly respect explicit `false` values when determining transport preference
- Fixed WebSocket append state not being reset after aborted requests, preventing stale state from affecting subsequent turns
- Fixed WebSocket append state not being reset after stream errors, preventing failed append attempts from blocking future requests
- Fixed Codex model context window metadata to use 272000 input tokens (instead of 400000 total budget) for non-Spark Codex variants

## [12.0.0] - 2026-02-12

### Added

- Added GPT-5.3 Codex Spark model with 128K context window and extended reasoning capabilities
- Added MiniMax M2.5 and M2.5 Lightning models via OpenAI-compatible API (minimax-code provider)
- Added MiniMax M2.5 and M2.5 Lightning models via OpenAI-compatible API (minimax-code-cn provider for China region)
- Added MiniMax M2.5 and M2.5 Lightning models via Anthropic API (minimax and minimax-cn providers)
- Added Llama 3.1 8B model via Cerebras API
- Added MiniMax M2.5 model via OpenRouter
- Added MiniMax M2.5 model via Vercel AI Gateway
- Added MiniMax M2.5 Free model via OpenCode
- Added Qwen3 VL 32B Instruct multimodal model via OpenRouter

### Changed

- Updated Z.ai GLM-5 pricing and context window configuration on OpenRouter
- Updated Qwen3 Max Thinking max tokens from 32768 to 65536 on OpenRouter
- Updated OpenAI GPT-5 Image Mini pricing on OpenRouter
- Updated OpenAI GPT-5 Pro pricing and context window on OpenRouter
- Updated OpenAI o4-mini pricing and context window on OpenRouter
- Updated Claude Opus 4.5 Thinking model name formatting (removed parentheses)
- Updated Claude Opus 4.6 Thinking model name formatting (removed parentheses)
- Updated Claude Sonnet 4.5 Thinking model name formatting (removed parentheses)
- Updated Gemini 2.5 Flash Thinking model name formatting (removed parentheses)
- Updated Gemini 3 Pro High and Low model name formatting (removed parentheses)
- Updated GPT-OSS 120B Medium model name formatting (removed parentheses) and context window to 131072

### Removed

- Removed GLM-5 model from Z.ai provider
- Removed Trinity Large Preview Free model from OpenCode provider
- Removed MiniMax M2.1 Free model from OpenCode provider
- Removed deprecated Anthropic model entries: `claude-3-5-haiku-latest`, `claude-3-5-haiku-20241022`, `claude-3-7-sonnet-20250219`, `claude-3-7-sonnet-latest`, `claude-3-opus-20240229`, `claude-3-sonnet-20240229` ([#33](https://github.com/can1357/oh-my-pi/issues/33))

### Fixed

- Added deprecation filter in model generation script to prevent re-adding deprecated Anthropic models ([#33](https://github.com/can1357/oh-my-pi/issues/33))

## [11.14.1] - 2026-02-12

### Added

- Added prompt-caching-scope-2026-01-05 beta feature support

### Changed

- Updated Claude Code version header to 2.1.39
- Updated runtime version header to v24.13.1 and package version to 0.73.0
- Increased request timeout from 60s to 600s
- Reordered Accept-Encoding header values for compression preference
- Updated OAuth authorization and token endpoints to use platform.claude.com
- Expanded OAuth scopes to include user:sessions:claude_code and user:mcp_servers

### Removed

- Removed claude-code-20250219 beta feature from default models
- Removed fine-grained-tool-streaming-2025-05-14 beta feature

## [11.13.1] - 2026-02-12

### Added

- Added Perplexity (Pro/Max) OAuth login support via native macOS app extraction or email OTP authentication
- Added `loginPerplexity` and `refreshPerplexityToken` functions for Perplexity account integration
- Added Socket.IO v4 client implementation for authenticated WebSocket communication with Perplexity API

## [11.12.0] - 2026-02-11

### Changed

- Increased maximum retry attempts for Codex requests from 2 to 5 to improve reliability on transient failures

### Fixed

- Fixed tool result content handling in Anthropic provider to provide fallback error message when content is empty
- Improved retry delay calculation to parse delay values from error response bodies (e.g., 'Please try again in 225ms')

## [11.11.0] - 2026-02-10

### Breaking Changes

- Replaced `./models.generated` export with `./models.json` - update imports from `import { MODELS } from './models.generated'` to `import MODELS from './models.json' with { type: 'json' }`

### Added

- Added TypeScript type declarations for `models.json` to enable proper type inference when importing the JSON file

### Changed

- Updated available models in google-antigravity provider with new model variants and updated context window/token limits
- Simplified type signatures for `getModel()` and `getModels()` functions for improved usability
- Changed models export from TypeScript module to JSON format for improved performance and reduced bundle size
- Updated `@anthropic-ai/sdk` dependency from ^0.72.1 to ^0.74.0

## [11.10.0] - 2026-02-10

### Added

- Added support for Kimi K2, K2 Turbo Preview, and K2.5 models with reasoning capabilities

### Fixed

- Fixed Claude Opus 4.6 context window to 200K across all providers (was incorrectly set to 1M)
- Fixed Claude Sonnet 4 context window to 200K across multiple providers (was incorrectly set to 1M)

## [11.8.0] - 2026-02-10

### Added

- Added `auto` model alias for OpenRouter with automatic model routing
- Added `openrouter/aurora-alpha` model with reasoning capabilities
- Added `qwen/qwen3-max-thinking` model with extended context window support
- Added support for `parametersJsonSchema` in Google Gemini tool definitions for improved JSON Schema compatibility

### Changed

- Updated Claude Sonnet 4 and 4.5 context window from 1M to 200K tokens to reflect actual limits
- Updated Claude Opus 4.6 context window to 200K tokens across providers
- Changed default `reasoningSummary` for OpenAI Codex from `undefined` to `auto`
- Updated Qwen model pricing and context window specifications across multiple variants
- Modified Google Gemini CLI system instruction to use compact format
- Changed tool parameter handling for Claude models on Google Cloud Code Assist to use legacy `parameters` field for API translation

### Removed

- Removed `glm-4.7-free` model from OpenCode provider
- Removed `qwen3-coder` model from OpenCode provider
- Removed `ai21/jamba-mini-1.7` model from OpenRouter
- Removed `stepfun-ai/step3` model from OpenRouter
- Removed duplicate test suite for Google Antigravity Provider with `gemini-3-pro-high`

### Fixed

- Fixed Amazon Bedrock HTTP/1.1 handler import to use direct import instead of dynamic import
- Fixed Qwen model context window and pricing inconsistencies across OpenRouter
- Fixed cache read pricing for multiple Qwen models
- Fixed OpenAI Codex reasoning effort clamping for `gpt-5.3-codex` model

## [11.7.1] - 2026-02-07

### Added

- Added Claude Opus 4.6 Thinking model for Antigravity provider
- Added Gemini 2.5 Flash, Gemini 2.5 Flash Thinking, and Gemini 2.5 Pro models for Antigravity provider
- Added Pony Alpha model via OpenRouter

### Changed

- Updated Antigravity models to use free tier pricing (0 cost) across all models
- Changed Antigravity model fetching to dynamically load from API when credentials are available, with hardcoded fallback models
- Updated Claude Opus 4.6 context window from 200,000 to 1,000,000 tokens across Bedrock regions
- Updated Claude Opus 4.6 cache pricing from 1.5/18.75 to 0.5/6.25 for EU and US regions
- Updated Antigravity model pricing to free tier (0 cost) for Claude Opus 4.5 Thinking, Claude Sonnet 4.5 Thinking, Gemini 3 Flash, Gemini 3 Pro variants, and GPT-OSS 120B Medium
- Updated GPT-OSS 120B Medium reasoning capability from false to true
- Updated Gemini 3 Flash max tokens from 65,535 to 65,536
- Updated Claude Opus 4.5 Thinking display name formatting to include parentheses
- Updated various model pricing and context window parameters across OpenRouter and other providers
- Removed Claude Opus 4.6 20260205 model from Anthropic provider

### Fixed

- Fixed Claude Opus 4.6 model ID format by removing version suffix (:0) in Bedrock configurations
- Fixed Llama 3.1 70B Instruct pricing and context window parameters
- Fixed Mistral model pricing and cache read costs
- Fixed DeepSeek and other model pricing inconsistencies
- Fixed Qwen model pricing and token limits
- Fixed GLM model pricing and context window specifications

## [11.6.0] - 2026-02-07

### Added

- Added Bedrock cache retention support with `PI_CACHE_RETENTION` env var and per-request `cacheRetention` option
- Added adaptive thinking support for Bedrock Opus 4.6+ models
- Added `AWS_BEDROCK_SKIP_AUTH` env var to support unauthenticated Bedrock proxies
- Added `AWS_BEDROCK_FORCE_HTTP1` env var to force HTTP/1.1 for custom Bedrock endpoints
- Re-exported `Static`, `TSchema`, and `Type` from `@sinclair/typebox`

### Fixed

- Fixed OpenAI Responses storage disabled by default (`store: false`)
- Fixed reasoning effort clamping for gpt-5.3 Codex models (minimal -> low)
- Fixed Bedrock `supportsPromptCaching` to also check model cost fields

## [11.5.1] - 2026-02-07

### Fixed

- Fixed schema normalization to handle array-valued `type` fields by converting them to a single type with nullable flag for Google provider compatibility

## [11.3.0] - 2026-02-06

### Added

- Added `cacheRetention` option to control prompt cache retention preference ('none', 'short', 'long') across providers
- Added `maxRetryDelayMs` option to cap server-requested retry delays and fail fast when delays exceed the limit
- Added `effort` option for Anthropic Opus 4.6+ models to control adaptive thinking effort levels ('low', 'medium', 'high', 'max')
- Added support for Anthropic Opus 4.6+ adaptive thinking mode that lets Claude decide when and how much to think
- Added `PI_AI_ANTIGRAVITY_VERSION` environment variable to customize Antigravity sandbox endpoint version
- Exported `convertAnthropicMessages` function for converting message formats to Anthropic API
- Automatic fallback for Anthropic assistant-prefill requests: appends synthetic user "Continue." message when conversation ends with assistant turn to maintain API compatibility

### Changed

- Changed `supportsXhigh()` to include GPT-5.1 Codex Max and broaden Anthropic support to all Anthropic Messages API models with budget-based thinking capability
- Changed Anthropic thinking mode to use adaptive thinking for Opus 4.6+ models instead of budget-based thinking
- Changed `supportsXhigh()` to support GPT-5.2/5.3 and Anthropic Opus 4.6+ models with adaptive thinking
- Changed prompt caching to respect `cacheRetention` option and support TTL configuration for Anthropic
- Changed OpenAI tool definitions to conditionally include `strict` field only when provider supports it
- Changed Qwen model support to use `enable_thinking` boolean parameter instead of OpenAI-style reasoning_effort

### Fixed

- Fixed indentation and formatting in `convertAnthropicMessages` function
- Fixed handling of conversations ending with assistant messages on Anthropic-routed models that reject assistant prefill requests

## [11.2.3] - 2026-02-05

### Added

- Added Claude Opus 4.6 model support across multiple providers (Anthropic, Amazon Bedrock, GitHub Copilot, OpenRouter, OpenCode, Vercel AI Gateway)
- Added GPT-5.3 Codex model support for OpenAI
- Added `readSseJson` utility import for improved SSE stream handling in Google Gemini CLI provider

### Changed

- Updated Google Gemini CLI provider to use `readSseJson` utility for cleaner SSE stream parsing
- Updated pricing for Llama 3.1 405B model on Vercel AI Gateway (cache read rate adjusted)
- Updated Llama 3.1 405B context window and max tokens on Vercel AI Gateway (256000 for both)

### Removed

- Removed Kimi K2, Kimi K2 Turbo Preview, and Kimi K2.5 models
- Removed Deep Cogito Cogito V2 Preview models from OpenRouter

## [11.0.0] - 2026-02-05

### Changed

- Replaced direct `Bun.env` access with `getEnv()` utility from `@oh-my-pi/pi-utils` for consistent environment variable handling across all providers
- Updated environment variable names from `OMP_*` prefix to `PI_*` prefix for consistency (e.g., `OMP_CODING_AGENT_DIR` → `PI_CODING_AGENT_DIR`)

### Removed

- Removed automatic environment variable migration from `PI_*` to `OMP_*` prefixes via `migrate-env.ts` module

## [10.5.0] - 2026-02-04

### Changed

- Updated @anthropic-ai/sdk to ^0.72.1
- Updated @aws-sdk/client-bedrock-runtime to ^3.982.0
- Updated @google/genai to ^1.39.0
- Updated @smithy/node-http-handler to ^4.4.9
- Updated openai to ^6.17.0
- Updated @types/node to ^25.2.0

### Removed

- Removed proxy-agent dependency
- Removed undici dependency

## [9.4.0] - 2026-01-31

### Added

- Added `getEnv()` function to retrieve environment variables from Bun.env, cwd/.env, or ~/.env
- Added support for reading .env files from home directory and current working directory
- Added support for `exa` and `perplexity` as known providers in `getEnvApiKey()`

### Changed

- Changed `getEnvApiKey()` to check Bun.env, cwd/.env, and ~/.env files in order of precedence
- Refactored provider API key resolution to use a declarative service provider map

## [9.2.2] - 2026-01-31

### Added

- Added OpenCode Zen provider with API key authentication for accessing multiple AI models
- Added 4 new free models via OpenCode: glm-4.7-free, kimi-k2.5-free, minimax-m2.1-free, trinity-large-preview-free
- Added glm-4.7-flash model via Zai provider
- Added Kimi Code provider with OpenAI and Anthropic API format support
- Added prompt cache retention support with PI_CACHE_RETENTION env var
- Added overflow patterns for Bedrock, MiniMax, Kimi; reclassified 429 as rate limiting
- Added profile endpoint integration to resolve user emails with 24-hour caching
- Added automatic token refresh for expired Kimi OAuth credentials
- Added Kimi Code OAuth handler with device authorization flow
- Added Kimi Code usage provider with quota caching
- Added 4 new Kimi Code models (kimi-for-coding, kimi-k2, kimi-k2-turbo-preview, kimi-k2.5)
- Added Kimi Code provider integration with OAuth and token management
- Added tool-choice utility for mapping unified ToolChoice to provider-specific formats
- Added ToolChoice type for controlling tool selection (auto, none, any, required, function)

### Changed

- Updated Kimi K2.5 cache read pricing from 0.1 to 0.08
- Updated MiniMax M2 pricing: input 0.6→0.6, output 3→3, cache read 0.1→0.09999999999999999
- Updated OpenRouter DeepSeek V3.1 pricing and max tokens: input 0.6→0.5, output 3→2.8, maxTokens 262144→4096
- Updated OpenRouter DeepSeek R1 pricing and max tokens: input 0.06→0.049999999999999996, output 0.24→0.19999999999999998, maxTokens 262144→4096
- Updated Anthropic Claude 3.5 Sonnet max tokens from 256000 to 65536 on OpenRouter
- Updated Vercel AI Gateway Claude 3.5 Sonnet cache read pricing from 0.125 to 0.13
- Updated Vercel AI Gateway Claude 3.5 Sonnet New cache read pricing from 0.125 to 0.13
- Updated Vercel AI Gateway GPT-5.2 cache read pricing from 0.175 to 0.18 and display name to 'GPT 5.2'
- Updated Zai GLM-4.6 cache read pricing from 0.024999999999999998 to 0.03
- Updated Zai Qwen QwQ max tokens from 66000 to 16384
- Added delta event batching and throttling (50ms, 20 updates/sec max) to AssistantMessageEventStream
- Updated MiniMax-M2 pricing: input 1.2→0.6, output 1.2→3, cacheRead 0.6→0.1

### Removed

- Removed OpenRouter google/gemini-2.0-flash-exp:free model
- Removed Vercel AI Gateway stealth/sonoma-dusk-alpha and stealth/sonoma-sky-alpha models

### Fixed

- Fixed rate limit issues with Kimi models by always sending max_tokens
- Added handling for sensitive stop reason from Anthropic API safety filters
- Added optional chaining for safer JSON schema property access in Anthropic provider

## [8.6.0] - 2026-01-27

### Changed

- Replaced JSON5 dependency with Bun.JSON5 parsing

### Fixed

- Filtered empty user text blocks for OpenAI-compatible completions and normalized Kimi reasoning_content for OpenRouter tool-call messages

## [8.4.0] - 2026-01-25

### Added

- Added Azure OpenAI Responses provider with deployment mapping and resource-based base URL support

### Changed

- Added OpenRouter routing preferences for OpenAI-compatible completions

### Fixed

- Defaulted Google tool call arguments to empty objects when providers omit args
- Guarded Responses/Codex streaming deltas against missing content parts and handled arguments.done events

## [8.2.1] - 2026-01-24

### Fixed

- Fixed handling of streaming function call arguments in OpenAI responses to properly parse arguments when sent via `response.function_call_arguments.done` events

## [8.2.0] - 2026-01-24

### Changed

- Migrated node module imports from named to namespace imports across all packages for consistency with project guidelines

## [8.0.0] - 2026-01-23

### Fixed

- Fixed OpenAI Responses API 400 error "function_call without required reasoning item" when switching between models (same provider, different model). The fix omits the `id` field for function_calls from different models to avoid triggering OpenAI's reasoning/function_call pairing validation
- Fixed 400 errors when reading multiple images via GitHub Copilot's Claude models. Claude requires tool_use -> tool_result adjacency with no user messages interleaved. Images from consecutive tool results are now batched into a single user message

## [7.0.0] - 2026-01-21

### Added

- Added usage tracking system with normalized schema for provider quota/limit endpoints
- Added Claude usage provider for 5-hour and 7-day quota windows
- Added GitHub Copilot usage provider for chat, completions, and premium requests
- Added Google Antigravity usage provider for model quota tracking
- Added Google Gemini CLI usage provider for tier-based quota monitoring
- Added OpenAI Codex usage provider for primary and secondary rate limit windows
- Added ZAI usage provider for token and request quota tracking

### Changed

- Updated Claude usage provider to extract account identifiers from response headers
- Updated GitHub Copilot usage provider to include account identifiers in usage reports
- Updated Google Gemini CLI usage provider to handle missing reset time gracefully

### Fixed

- Fixed GitHub Copilot usage provider to simplify token handling and improve reliability
- Fixed GitHub Copilot usage provider to properly resolve account identifiers for OAuth credentials
- Fixed API validation errors when sending empty user messages (resume with `.`) across all providers:
- Google Cloud Code Assist (google-shared.ts)
- OpenAI Responses API (openai-responses.ts)
- OpenAI Codex Responses API (openai-codex-responses.ts)
- Cursor (cursor.ts)
- Amazon Bedrock (amazon-bedrock.ts)
- Clamped OpenAI Codex reasoning effort "minimal" to "low" for gpt-5.2 models to avoid API errors
- Fixed GitHub Copilot usage fallback to internal quota endpoints when billing usage is unavailable
- Fixed GitHub Copilot usage metadata to include account identifiers for report dedupe
- Fixed Anthropic usage metadata extraction to include account identifiers when provided by the usage endpoint
- Fixed Gemini CLI usage windows to consistently label quota windows for display suppression

## [6.9.69] - 2026-01-21

### Added

- Added duration and time-to-first-token (ttft) metrics to all AI provider responses
- Added performance tracking for streaming responses across all providers

## [6.9.0] - 2026-01-21

### Removed

- Removed openai-codex provider exports from main package index
- Removed openai-codex prompt utilities and moved them inline
- Removed vitest configuration file

## [6.8.4] - 2026-01-21

### Changed

- Updated prompt caching strategy to follow Anthropic's recommended hierarchy
- Fixed token usage tracking to properly handle cumulative output tokens from message_delta events
- Improved message validation to filter out empty or invalid content blocks
- Increased OAuth callback timeout from 120 seconds to 120,000 milliseconds

## [6.8.3] - 2026-01-21

### Added

- Added `headers` option to all providers for custom request headers
- Added `onPayload` hook to observe provider request payloads before sending
- Added `strictResponsesPairing` option for Azure OpenAI Responses API compatibility
- Added `originator` option to `loginOpenAICodex` for custom OAuth flow identification
- Added per-request `headers` and `onPayload` hooks to `StreamOptions`
- Added `originator` option to `loginOpenAICodex`

### Fixed

- Fixed tool call ID normalization for OpenAI Responses API cross-provider handoffs
- Skipped errored or aborted assistant messages during cross-provider transforms
- Detected AWS ECS/IRSA credentials for Bedrock authentication checks
- Detected AWS ECS/IRSA credentials for Bedrock authentication checks
- Normalized Responses API tool call IDs during handoffs and refreshed handoff tests
- Enforced strict tool call/result pairing for Azure OpenAI Responses API
- Skipped errored or aborted assistant messages during cross-provider transforms

### Security

- Enhanced AWS credential detection to support ECS task roles and IRSA web identity tokens

## [6.8.2] - 2026-01-21

### Fixed

- Improved error handling for aborted requests in Google Gemini CLI provider
- Enhanced OAuth callback flow to handle manual input errors gracefully
- Fixed login cancellation handling in GitHub Copilot OAuth flow
- Removed fallback manual input from OpenAI Codex OAuth flow

### Security

- Hardened database file permissions to prevent credential leakage
- Set secure directory permissions (0o700) for credential storage

## [6.8.0] - 2026-01-20

### Added

- Added `logout` command to CLI for OAuth provider logout
- Added `status` command to show logged-in providers and token expiry
- Added persistent credential storage using SQLite database
- Added OAuth callback server with automatic port fallback
- Added HTML callback page with success/error states
- Added support for Cursor OAuth provider

### Changed

- Updated Promise.withResolvers usage for better compatibility
- Replaced custom sleep implementations with Bun.sleep and abortableSleep
- Simplified SSE stream parsing using readLines utility
- Updated test framework from vitest to bun:test
- Replaced temp directory creation with TempDir API
- Changed credential storage from auth.json to ~/.omp/agent/agent.db
- Changed CLI command examples from npx to bunx
- Refactored OAuth flows to use common callback server base class
- Updated OAuth provider interfaces to use controller pattern

### Fixed

- Fixed OAuth callback handling with improved error states
- Fixed token refresh for all OAuth providers

## [6.7.670] - 2026-01-19

### Changed

- Updated Claude Code compatibility headers and version
- Improved OAuth token handling with proper state generation
- Enhanced cache control for tool and user message blocks
- Simplified tool name prefixing for OAuth traffic
- Updated PKCE verifier generation for better security

## [5.7.67] - 2026-01-18

### Fixed

- Added error handling for unknown OAuth providers

## [5.6.77] - 2026-01-18

### Fixed

- Prevented duplicate tool results for errored or aborted messages when results already exist

## [5.6.7] - 2026-01-18

### Added

- Added automatic retry logic for OpenAI Codex responses with configurable delay and max retries
- Added tool call ID sanitization for Amazon Bedrock to ensure valid characters
- Added tool argument validation that coerces JSON-encoded strings for expected non-string types

### Changed

- Updated environment variable prefix from PI* to OMP* for better consistency
- Added automatic migration for legacy PI* environment variables to OMP* equivalents
- Adjusted Bedrock Claude thinking budgets to reserve output tokens when maxTokens is too low

### Fixed

- Fixed orphaned tool call handling to ensure proper tool_use/tool_result pairing for all assistant messages
- Fixed message transformation to insert synthetic tool results for errored/aborted assistant messages with tool calls
- Fixed tool prefix handling in Claude provider to use case-insensitive comparison
- Fixed Gemini 3 model handling to treat unsigned tool calls as context-only with anti-mimicry context
- Fixed message transformation to filter out empty error messages from conversation history
- Fixed OpenAI completions provider compatibility detection to use provider metadata
- Fixed OpenAI completions provider to avoid using developer role for opencode provider
- Fixed orphaned tool call handling to skip synthetic results for errored assistant messages

## [5.5.0] - 2026-01-18

### Changed

- Updated User-Agent header from 'opencode' to 'pi' for OpenAI Codex requests
- Simplified Codex system prompt instructions
- Removed bridge text override from Codex system prompt builder

## [5.3.0] - 2026-01-15

### Changed

- Replaced detailed Codex system instructions with simplified pi assistant instructions
- Updated internal documentation references to use pi-internal:// protocol

## [5.1.0] - 2026-01-14

### Added

- Added Amazon Bedrock provider with `bedrock-converse-stream` API for Claude models via AWS
- Added MiniMax provider with OpenAI-compatible API
- Added EU cross-region inference model variants for Claude models on Bedrock

### Fixed

- Fixed Gemini CLI provider retries with proper error handling, retry delays from headers, and empty stream retry logic
- Fixed numbered list items showing "1." for all items when code blocks break list continuity (via `start` property)

## [5.0.0] - 2026-01-12

### Added

- Added support for `xhigh` thinking level in `thinkingBudgets` configuration

### Changed

- Changed Anthropic thinking token budgets: minimal (1024→3072), low (2048→6144), medium (8192→12288), high (16384→24576)
- Changed Google thinking token budgets: minimal (1024), low (2048→4096), medium (8192), high (16384), xhigh (24575)
- Changed `supportsXhigh()` to return true for all Anthropic models

## [4.6.0] - 2026-01-12

### Fixed

- Fixed incorrect classification of thought signatures in Google Gemini responses—thought signatures are now correctly treated as metadata rather than thinking content indicators
- Fixed thought signature handling in Google Gemini CLI and Vertex AI streaming to properly preserve signatures across text deltas
- Fixed Google schema sanitization stripping property names that match schema keywords (e.g., "pattern", "format") from tool definitions

## [4.4.9] - 2026-01-12

### Fixed

- Fixed Google provider schema sanitization to strip additional unsupported JSON Schema fields (patternProperties, additionalProperties, min/max constraints, pattern, format)

## [4.4.8] - 2026-01-12

### Fixed

- Fixed Google provider schema sanitization to properly collapse `anyOf`/`oneOf` with const values into enum arrays
- Fixed const-to-enum conversion to infer type from the const value when type is not specified

## [4.4.6] - 2026-01-11

### Fixed

- Fixed tool parameter schema sanitization to only apply Google-specific transformations for Gemini models, preserving original schemas for other model types

## [4.4.5] - 2026-01-11

### Changed

- Exported `sanitizeSchemaForGoogle` utility function for external use

### Fixed

- Fixed Google provider schema sanitization to strip additional unsupported JSON Schema fields ($schema, $ref, $defs, format, examples, and others)
- Fixed Google provider to ignore `additionalProperties: false` which is unsupported by the API

## [4.4.4] - 2026-01-11

### Fixed

- Fixed Cursor todo updates to bridge update_todos tool calls to the local todo_write tool

## [4.3.0] - 2026-01-11

### Added

- Added debug log filtering and display script for Cursor JSONL logs with follow mode and coalescing support
- Added protobuf definition extractor script to reconstruct .proto files from bundled JavaScript
- Added conversation state caching to persist context across multiple Cursor API requests in the same session
- Added shell streaming support for real-time stdout/stderr output during command execution
- Added JSON5 parsing for MCP tool arguments with Python-style boolean and None value normalization
- Added Cursor provider with support for Claude, GPT, and Gemini models via Cursor's agent API
- Added OAuth authentication flow for Cursor including login, token refresh, and expiry detection
- Added `cursor-agent` API type with streaming support and tool execution handlers
- Added Cursor model definitions including Claude 4.5, GPT-5.x, Gemini 3, and Grok variants
- Added model generation script to automatically fetch and update AI model definitions from models.dev and OpenRouter APIs

### Changed

- Changed Cursor debug logging to use structured JSONL format with automatic MCP argument decoding
- Changed MCP tool argument decoding to use protobuf Value schema for improved type handling
- Changed tool advertisement to filter Cursor native tools (bash, read, write, delete, ls, grep, lsp) instead of only exposing mcp\_ prefixed tools

### Fixed

- Fixed Cursor conversation history serialization so subagents retain task context and can call complete

## [4.2.1] - 2026-01-11

### Changed

- Updated `reasoningSummary` option to accept only `"auto"`, `"concise"`, `"detailed"`, or `null` (removed `"off"` and `"on"` values)
- Changed default `reasoningSummary` from `"auto"` to `"detailed"`
- OpenAI Codex: switched to bundled system prompt matching opencode, changed originator to "opencode", simplified prompt handling

### Fixed

- Fixed Cloud Code Assist tool schema conversion to avoid unsupported `const` fields

## [4.0.0] - 2026-01-10

### Added

- Added `betas` option in `AnthropicOptions` for passing custom Anthropic beta feature flags
- OpenCode Zen provider support with 26 models (Claude, GPT, Gemini, Grok, Kimi, GLM, Qwen, etc.). Set `OPENCODE_API_KEY` env var to use.
- `thinkingBudgets` option in `SimpleStreamOptions` for customizing token budgets per thinking level on token-based providers
- `sessionId` option in `StreamOptions` for providers that support session-based caching. OpenAI Codex provider uses this to set `prompt_cache_key` and routing headers.
- `supportsUsageInStreaming` compatibility flag for OpenAI-compatible providers that reject `stream_options: { include_usage: true }`. Defaults to `true`. Set to `false` in model config for providers like gatewayz.ai.
- `GOOGLE_APPLICATION_CREDENTIALS` env var support for Vertex AI credential detection (standard for CI/production)
- Exported OpenAI Codex utilities: `CacheMetadata`, `getCodexInstructions`, `getModelFamily`, `ModelFamily`, `buildCodexPiBridge`, `buildCodexSystemPrompt`, `CodexSystemPrompt`
- Headless OAuth support for all callback-server providers (Google Gemini CLI, Antigravity, OpenAI Codex): paste redirect URL when browser callback is unreachable
- Cancellable GitHub Copilot device code polling via AbortSignal
- Improved error messages for OpenRouter providers by including raw metadata from upstream errors

### Changed

- Changed Anthropic provider to include Claude Code system instruction for all API key types, not just OAuth tokens (except Haiku models)
- Changed Anthropic OAuth tool naming to use `proxy_` prefix instead of mapping to Claude Code tool names, avoiding potential name collisions
- Changed Anthropic provider to include Claude Code headers for all requests, not just OAuth tokens
- Anthropic provider now maps tool names to Claude Code's exact tool names (Read, Write, Edit, Bash, Grep, Glob) instead of using prefixed names
- OpenAI Completions provider now disables strict mode on tools to allow optional parameters without null unions

### Fixed

- Fixed Anthropic OAuth code parsing to accept full redirect URLs in addition to raw authorization codes
- Fixed Anthropic token refresh to preserve existing refresh token when server doesn't return a new one
- Fixed thinking mode being enabled when tool_choice forces a specific tool, which is unsupported
- Fixed max_tokens being too low when thinking budget is set, now auto-adjusts to model's maxTokens
- Google Cloud Code Assist OAuth for paid subscriptions: properly handles long-running operations for project provisioning, supports `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_PROJECT_ID` env vars for paid tiers
- `os.homedir()` calls at module load time; now resolved lazily when needed
- OpenAI Responses tool strict flag to use a boolean for LM Studio compatibility
- Gemini CLI abort handling: detect native `AbortError` in retry catch block, cancel SSE reader when abort signal fires
- Antigravity provider 429 errors by aligning request payload with CLIProxyAPI v6.6.89
- Thinking block handling for cross-model conversations: thinking blocks are now converted to plain text when switching models
- OpenAI Codex context window from 400,000 to 272,000 tokens to match Codex CLI defaults
- Codex SSE error events to surface message, code, and status
- Context overflow detection for `context_length_exceeded` error codes
- Codex provider now always includes `reasoning.encrypted_content` even when custom `include` options are passed
- Codex requests now omit the `reasoning` field entirely when thinking is off
- Crash when pasting text with trailing whitespace exceeding terminal width

## [3.37.1] - 2026-01-10

### Added

- Added automatic type coercion for tool arguments when LLMs return JSON-encoded strings instead of native types (numbers, booleans, arrays, objects)

### Changed

- Changed tool argument validation to attempt JSON parsing and type coercion before rejecting mismatched types
- Changed validation error messages to include both original and normalized arguments when coercion was attempted

## [3.37.0] - 2026-01-10

### Changed

- Enabled type coercion in JSON schema validation to automatically convert compatible types

## [3.35.0] - 2026-01-09

### Added

- Enhanced error messages to include retry-after timing information from API rate limit headers

## [0.42.0] - 2026-01-09

### Added

- Added OpenCode Zen provider support with 26 models (Claude, GPT, Gemini, Grok, Kimi, GLM, Qwen, etc.). Set `OPENCODE_API_KEY` env var to use.

## [0.39.0] - 2026-01-08

### Fixed

- Fixed Gemini CLI abort handling: detect native `AbortError` in retry catch block, cancel SSE reader when abort signal fires ([#568](https://github.com/badlogic/pi-mono/pull/568) by [@tmustier](https://github.com/tmustier))
- Fixed Antigravity provider 429 errors by aligning request payload with CLIProxyAPI v6.6.89: inject Antigravity system instruction with `role: "user"`, set `requestType: "agent"`, and use `antigravity` userAgent. Added bridge prompt to override Antigravity behavior (identity, paths, web dev guidelines) with Pi defaults. ([#571](https://github.com/badlogic/pi-mono/pull/571) by [@ben-vargas](https://github.com/ben-vargas))
- Fixed thinking block handling for cross-model conversations: thinking blocks are now converted to plain text (no `<thinking>` tags) when switching models. Previously, `<thinking>` tags caused models to mimic the pattern and output literal tags. Also fixed empty thinking blocks causing API errors. ([#561](https://github.com/badlogic/pi-mono/issues/561))

## [0.38.0] - 2026-01-08

### Added

- `thinkingBudgets` option in `SimpleStreamOptions` for customizing token budgets per thinking level on token-based providers ([#529](https://github.com/badlogic/pi-mono/pull/529) by [@melihmucuk](https://github.com/melihmucuk))

### Breaking Changes

- Removed OpenAI Codex model aliases (`gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `codex-mini-latest`, `gpt-5-codex`, `gpt-5.1-codex`, `gpt-5.1-chat-latest`). Use canonical model IDs: `gpt-5.1`, `gpt-5.1-codex-max`, `gpt-5.1-codex-mini`, `gpt-5.2`, `gpt-5.2-codex`. ([#536](https://github.com/badlogic/pi-mono/pull/536) by [@ghoulr](https://github.com/ghoulr))

### Fixed

- Fixed OpenAI Codex context window from 400,000 to 272,000 tokens to match Codex CLI defaults and prevent 400 errors. ([#536](https://github.com/badlogic/pi-mono/pull/536) by [@ghoulr](https://github.com/ghoulr))
- Fixed Codex SSE error events to surface message, code, and status. ([#551](https://github.com/badlogic/pi-mono/pull/551) by [@tmustier](https://github.com/tmustier))
- Fixed context overflow detection for `context_length_exceeded` error codes.

## [0.37.6] - 2026-01-06

### Added

- Exported OpenAI Codex utilities: `CacheMetadata`, `getCodexInstructions`, `getModelFamily`, `ModelFamily`, `buildCodexPiBridge`, `buildCodexSystemPrompt`, `CodexSystemPrompt` ([#510](https://github.com/badlogic/pi-mono/pull/510) by [@mitsuhiko](https://github.com/mitsuhiko))

## [0.37.3] - 2026-01-06

### Added

- `sessionId` option in `StreamOptions` for providers that support session-based caching. OpenAI Codex provider uses this to set `prompt_cache_key` and routing headers.

## [0.37.2] - 2026-01-05

### Fixed

- Codex provider now always includes `reasoning.encrypted_content` even when custom `include` options are passed ([#484](https://github.com/badlogic/pi-mono/pull/484) by [@kim0](https://github.com/kim0))

## [0.37.0] - 2026-01-05

### Breaking Changes

- OpenAI Codex models no longer have per-thinking-level variants (e.g., `gpt-5.2-codex-high`). Use the base model ID and set thinking level separately. The Codex provider clamps reasoning effort to what each model supports internally. (initial implementation by [@ben-vargas](https://github.com/ben-vargas) in [#472](https://github.com/badlogic/pi-mono/pull/472))

### Added

- Headless OAuth support for all callback-server providers (Google Gemini CLI, Antigravity, OpenAI Codex): paste redirect URL when browser callback is unreachable ([#428](https://github.com/badlogic/pi-mono/pull/428) by [@ben-vargas](https://github.com/ben-vargas), [#468](https://github.com/badlogic/pi-mono/pull/468) by [@crcatala](https://github.com/crcatala))
- Cancellable GitHub Copilot device code polling via AbortSignal

### Fixed

- Codex requests now omit the `reasoning` field entirely when thinking is off, letting the backend use its default instead of forcing a value. ([#472](https://github.com/badlogic/pi-mono/pull/472))

## [0.36.0] - 2026-01-05

### Added

- OpenAI Codex OAuth provider with Responses API streaming support: `openai-codex-responses` streaming provider with SSE parsing, tool-call handling, usage/cost tracking, and PKCE OAuth flow ([#451](https://github.com/badlogic/pi-mono/pull/451) by [@kim0](https://github.com/kim0))

### Fixed

- Vertex AI dummy value for `getEnvApiKey()`: Returns `"<authenticated>"` when Application Default Credentials are configured (`~/.config/gcloud/application_default_credentials.json` exists) and both `GOOGLE_CLOUD_PROJECT` (or `GCLOUD_PROJECT`) and `GOOGLE_CLOUD_LOCATION` are set. This allows `streamSimple()` to work with Vertex AI without explicit `apiKey` option. The ADC credentials file existence check is cached per-process to avoid repeated filesystem access.

## [0.32.3] - 2026-01-03

### Fixed

- Google Vertex AI models no longer appear in available models list without explicit authentication. Previously, `getEnvApiKey()` returned a dummy value for `google-vertex`, causing models to show up even when Google Cloud ADC was not configured.

## [0.32.0] - 2026-01-03

### Added

- Vertex AI provider with ADC (Application Default Credentials) support. Authenticate with `gcloud auth application-default login`, set `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`, and access Gemini models via Vertex AI. ([#300](https://github.com/badlogic/pi-mono/pull/300) by [@default-anton](https://github.com/default-anton))

### Fixed

- **Gemini CLI rate limit handling**: Added automatic retry with server-provided delay for 429 errors. Parses delay from error messages like "Your quota will reset after 39s" and waits accordingly. Falls back to exponential backoff for other transient errors. ([#370](https://github.com/badlogic/pi-mono/issues/370))

## [0.31.0] - 2026-01-02

### Breaking Changes

- **Agent API moved**: All agent functionality (`agentLoop`, `agentLoopContinue`, `AgentContext`, `AgentEvent`, `AgentTool`, `AgentToolResult`, etc.) has moved to `@mariozechner/pi-agent-core`. Import from that package instead of `@oh-my-pi/pi-ai`.

### Added

- **`GoogleThinkingLevel` type**: Exported type that mirrors Google's `ThinkingLevel` enum values (`"THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH"`). Allows configuring Gemini thinking levels without importing from `@google/genai`.
- **`ANTHROPIC_OAUTH_TOKEN` env var**: Now checked before `ANTHROPIC_API_KEY` in `getEnvApiKey()`, allowing OAuth tokens to take precedence.
- **`event-stream.js` export**: `AssistantMessageEventStream` utility now exported from package index.

### Changed

- **OAuth uses Web Crypto API**: PKCE generation and OAuth flows now use Web Crypto API (`crypto.subtle`) instead of Node.js `crypto` module. This improves browser compatibility while still working in Node.js 20+.
- **Deterministic model generation**: `generate-models.ts` now sorts providers and models alphabetically for consistent output across runs. ([#332](https://github.com/badlogic/pi-mono/pull/332) by [@mrexodia](https://github.com/mrexodia))

### Fixed

- **OpenAI completions empty content blocks**: Empty text or thinking blocks in assistant messages are now filtered out before sending to the OpenAI completions API, preventing validation errors. ([#344](https://github.com/badlogic/pi-mono/pull/344) by [@default-anton](https://github.com/default-anton))
- **Thinking token duplication**: Fixed thinking content duplication with chutes.ai provider. The provider was returning thinking content in both `reasoning_content` and `reasoning` fields, causing each chunk to be processed twice. Now only the first non-empty reasoning field is used.
- **zAi provider API mapping**: Fixed zAi models to use `openai-completions` API with correct base URL (`https://api.z.ai/api/coding/paas/v4`) instead of incorrect Anthropic API mapping. ([#344](https://github.com/badlogic/pi-mono/pull/344), [#358](https://github.com/badlogic/pi-mono/pull/358) by [@default-anton](https://github.com/default-anton))

## [0.28.0] - 2025-12-25

### Breaking Changes

- **OAuth storage removed** ([#296](https://github.com/badlogic/pi-mono/issues/296)): All storage functions (`loadOAuthCredentials`, `saveOAuthCredentials`, `setOAuthStorage`, etc.) removed. Callers are responsible for storing credentials.
- **OAuth login functions**: `loginAnthropic`, `loginGitHubCopilot`, `loginGeminiCli`, `loginAntigravity` now return `OAuthCredentials` instead of saving to disk.
- **refreshOAuthToken**: Now takes `(provider, credentials)` and returns new `OAuthCredentials` instead of saving.
- **getOAuthApiKey**: Now takes `(provider, credentials)` and returns `{ newCredentials, apiKey }` or null.
- **OAuthCredentials type**: No longer includes `type: "oauth"` discriminator. Callers add discriminator when storing.
- **setApiKey, resolveApiKey**: Removed. Callers must manage their own API key storage/resolution.
- **getApiKey**: Renamed to `getEnvApiKey`. Only checks environment variables for known providers.

## [0.27.7] - 2025-12-24

### Fixed

- **Thinking tag leakage**: Fixed Claude mimicking literal `</thinking>` tags in responses. Unsigned thinking blocks (from aborted streams) are now converted to plain text without `<thinking>` tags. The TUI still displays them as thinking blocks. ([#302](https://github.com/badlogic/pi-mono/pull/302) by [@nicobailon](https://github.com/nicobailon))

## [0.25.1] - 2025-12-21

### Added

- **xhigh thinking level support**: Added `supportsXhigh()` function to check if a model supports xhigh reasoning level. Also clamps xhigh to high for OpenAI models that don't support it. ([#236](https://github.com/badlogic/pi-mono/pull/236) by [@theBucky](https://github.com/theBucky))

### Fixed

- **Gemini multimodal tool results**: Fixed images in tool results causing flaky/broken responses with Gemini models. For Gemini 3, images are now nested inside `functionResponse.parts` per the [docs](https://ai.google.dev/gemini-api/docs/function-calling#multimodal). For older models (which don't support multimodal function responses), images are sent in a separate user message.

- **Queued message steering**: When `getQueuedMessages` is provided, the agent loop now checks for queued user messages after each tool call and skips remaining tool calls in the current assistant message when a queued message arrives (emitting error tool results).

- **Double API version path in Google provider URL**: Fixed Gemini API calls returning 404 after baseUrl support was added. The SDK was appending its default apiVersion to baseUrl which already included the version path. ([#251](https://github.com/badlogic/pi-mono/pull/251) by [@shellfyred](https://github.com/shellfyred))

- **Anthropic SDK retries disabled**: Re-enabled SDK-level retries (default 2) for transient HTTP failures. ([#252](https://github.com/badlogic/pi-mono/issues/252))

## [0.23.5] - 2025-12-19

### Added

- **Gemini 3 Flash thinking support**: Extended thinking level support for Gemini 3 Flash models (MINIMAL, LOW, MEDIUM, HIGH) to match Pro models' capabilities. ([#212](https://github.com/badlogic/pi-mono/pull/212) by [@markusylisiurunen](https://github.com/markusylisiurunen))

- **GitHub Copilot thinking models**: Added thinking support for additional Copilot models (o3-mini, o1-mini, o1-preview). ([#234](https://github.com/badlogic/pi-mono/pull/234) by [@aadishv](https://github.com/aadishv))

### Fixed

- **Gemini tool result format**: Fixed tool result format for Gemini 3 Flash Preview which strictly requires `{ output: value }` for success and `{ error: value }` for errors. Previous format using `{ result, isError }` was rejected by newer Gemini models. Also improved type safety by removing `as any` casts. ([#213](https://github.com/badlogic/pi-mono/issues/213), [#220](https://github.com/badlogic/pi-mono/pull/220))

- **Google baseUrl configuration**: Google provider now respects `baseUrl` configuration for custom endpoints or API proxies. ([#216](https://github.com/badlogic/pi-mono/issues/216), [#221](https://github.com/badlogic/pi-mono/pull/221) by [@theBucky](https://github.com/theBucky))

- **GitHub Copilot vision requests**: Added `Copilot-Vision-Request` header when sending images to GitHub Copilot models. ([#222](https://github.com/badlogic/pi-mono/issues/222))

- **GitHub Copilot X-Initiator header**: Fixed X-Initiator logic to check last message role instead of any message in history. This ensures proper billing when users send follow-up messages. ([#209](https://github.com/badlogic/pi-mono/issues/209))

## [0.22.3] - 2025-12-16

### Added

- **Image limits test suite**: Added comprehensive tests for provider-specific image limitations (max images, max size, max dimensions). Discovered actual limits: Anthropic (100 images, 5MB, 8000px), OpenAI (500 images, ≥25MB), Gemini (~2500 images, ≥40MB), Mistral (8 images, ~15MB), OpenRouter (~40 images context-limited, ~15MB). ([#120](https://github.com/badlogic/pi-mono/pull/120))

- **Tool result streaming**: Added `tool_execution_update` event and optional `onUpdate` callback to `AgentTool.execute()` for streaming tool output during execution. Tools can now emit partial results (e.g., bash stdout) that are forwarded to subscribers. ([#44](https://github.com/badlogic/pi-mono/issues/44))

- **X-Initiator header for GitHub Copilot**: Added X-Initiator header handling for GitHub Copilot provider to ensure correct call accounting (agent calls are not deducted from quota). Sets initiator based on last message role. ([#200](https://github.com/badlogic/pi-mono/pull/200) by [@kim0](https://github.com/kim0))

### Changed

- **Normalized tool_execution_end result**: `tool_execution_end` event now always contains `AgentToolResult` (no longer `AgentToolResult | string`). Errors are wrapped in the standard result format.

### Fixed

- **Reasoning disabled by default**: When `reasoning` option is not specified, thinking is now explicitly disabled for all providers. Previously, some providers like Gemini with "dynamic thinking" would use their default (thinking ON), causing unexpected token usage. This was the original intended behavior. ([#180](https://github.com/badlogic/pi-mono/pull/180) by [@markusylisiurunen](https://github.com/markusylisiurunen))

## [0.22.2] - 2025-12-15

### Added

- **Interleaved thinking for Anthropic**: Added `interleavedThinking` option to `AnthropicOptions`. When enabled, Claude 4 models can think between tool calls and reason after receiving tool results. Enabled by default (no extra token cost, just unlocks the capability). Set `interleavedThinking: false` to disable.

## [0.22.1] - 2025-12-15

_Dedicated to Peter's shoulder ([@steipete](https://twitter.com/steipete))_

### Added

- **Interleaved thinking for Anthropic**: Enabled interleaved thinking in the Anthropic provider, allowing Claude models to output thinking blocks interspersed with text responses.

## [0.22.0] - 2025-12-15

### Added

- **GitHub Copilot provider**: Added `github-copilot` as a known provider with models sourced from models.dev. Includes Claude, GPT, Gemini, Grok, and other models available through GitHub Copilot. ([#191](https://github.com/badlogic/pi-mono/pull/191) by [@cau1k](https://github.com/cau1k))

### Fixed

- **GitHub Copilot gpt-5 models**: Fixed API selection for gpt-5 models to use `openai-responses` instead of `openai-completions` (gpt-5 models are not accessible via completions endpoint)

- **GitHub Copilot cross-model context handoff**: Fixed context handoff failing when switching between GitHub Copilot models using different APIs (e.g., gpt-5 to claude-sonnet-4). Tool call IDs from OpenAI Responses API were incompatible with other models. ([#198](https://github.com/badlogic/pi-mono/issues/198))

- **Gemini 3 Pro thinking levels**: Thinking level configuration now works correctly for Gemini 3 Pro models. Previously all levels mapped to -1 (minimal thinking). Now LOW/MEDIUM/HIGH properly control test-time computation. ([#176](https://github.com/badlogic/pi-mono/pull/176) by [@markusylisiurunen](https://github.com/markusylisiurunen))

## [0.18.2] - 2025-12-11

### Changed

- **Anthropic SDK retries disabled**: Set `maxRetries: 0` on Anthropic client to allow application-level retry handling. The SDK's built-in retries were interfering with coding-agent's retry logic. ([#157](https://github.com/badlogic/pi-mono/issues/157))

## [0.18.1] - 2025-12-10

### Added

- **Mistral provider**: Added support for Mistral AI models via the OpenAI-compatible API. Includes automatic handling of Mistral-specific requirements (tool call ID format). Set `MISTRAL_API_KEY` environment variable to use.

### Fixed

- Fixed Mistral 400 errors after aborted assistant messages by skipping empty assistant messages (no content, no tool calls) ([#165](https://github.com/badlogic/pi-mono/issues/165))

- Removed synthetic assistant bridge message after tool results for Mistral (no longer required as of Dec 2025) ([#165](https://github.com/badlogic/pi-mono/issues/165))

- Fixed bug where `ANTHROPIC_API_KEY` environment variable was deleted globally after first OAuth token usage, causing subsequent prompts to fail ([#164](https://github.com/badlogic/pi-mono/pull/164))

## [0.17.0] - 2025-12-09

### Added

- **`agentLoopContinue` function**: Continue an agent loop from existing context without adding a new user message. Validates that the last message is `user` or `toolResult`. Useful for retry after context overflow or resuming from manually-added tool results.

### Breaking Changes

- Removed provider-level tool argument validation. Validation now happens in `agentLoop` via `executeToolCalls`, allowing models to retry on validation errors. For manual tool execution, use `validateToolCall(tools, toolCall)` or `validateToolArguments(tool, toolCall)`.

### Added

- Added `validateToolCall(tools, toolCall)` helper that finds the tool by name and validates arguments.

- **OpenAI compatibility overrides**: Added `compat` field to `Model` for `openai-completions` API, allowing explicit configuration of provider quirks (`supportsStore`, `supportsDeveloperRole`, `supportsReasoningEffort`, `maxTokensField`). Falls back to URL-based detection if not set. Useful for LiteLLM, custom proxies, and other non-standard endpoints. ([#133](https://github.com/badlogic/pi-mono/issues/133), thanks @fink-andreas for the initial idea and PR)

- **xhigh reasoning level**: Added `xhigh` to `ReasoningEffort` type for OpenAI codex-max models. For non-OpenAI providers (Anthropic, Google), `xhigh` is automatically mapped to `high`. ([#143](https://github.com/badlogic/pi-mono/issues/143))

### Changed

- **Updated SDK versions**: OpenAI SDK 5.21.0 → 6.10.0, Anthropic SDK 0.61.0 → 0.71.2, Google GenAI SDK 1.30.0 → 1.31.0

## [0.13.0] - 2025-12-06

### Breaking Changes

- **Added `totalTokens` field to `Usage` type**: All code that constructs `Usage` objects must now include the `totalTokens` field. This field represents the total tokens processed by the LLM (input + output + cache). For OpenAI and Google, this uses native API values (`total_tokens`, `totalTokenCount`). For Anthropic, it's computed as `input + output + cacheRead + cacheWrite`.

## [0.12.10] - 2025-12-04

### Added

- Added `gpt-5.1-codex-max` model support

### Fixed

- **OpenAI Token Counting**: Fixed `usage.input` to exclude cached tokens for OpenAI providers. Previously, `input` included cached tokens, causing double-counting when calculating total context size via `input + cacheRead`. Now `input` represents non-cached input tokens across all providers, making `input + output + cacheRead + cacheWrite` the correct formula for total context size.

- **Fixed Claude Opus 4.5 cache pricing** (was 3x too expensive)
  - Corrected cache_read: $1.50 → $0.50 per MTok
  - Corrected cache_write: $18.75 → $6.25 per MTok
  - Added manual override in `scripts/generate-models.ts` until upstream fix is merged
  - Submitted PR to models.dev: https://github.com/sst/models.dev/pull/439

## [0.9.4] - 2025-11-26

Initial release with multi-provider LLM support.
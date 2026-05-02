# Model and Provider Configuration (`models.yml`)

This document describes how the coding-agent currently loads models, applies overrides, resolves credentials, and chooses models at runtime.

## What controls model behavior

Primary implementation files:

- `src/config/model-registry.ts` — loads built-in + custom models, provider overrides, runtime discovery, auth integration
- `src/config/model-resolver.ts` — parses model patterns and selects initial/smol/slow models
- `src/config/settings-schema.ts` — model-related settings (`modelRoles`, provider transport preferences)
- `src/session/auth-storage.ts` — API key + OAuth resolution order
- `packages/ai/src/models.ts` and `packages/ai/src/types.ts` — built-in providers/models and `Model`/`compat` types

## Config file location and legacy behavior

Default config path:

- `~/.omp/agent/models.yml`

Legacy behavior still present:

- If `models.yml` is missing and `models.json` exists at the same location, it is migrated to `models.yml`.
- Explicit `.json` / `.jsonc` config paths are still supported when passed programmatically to `ModelRegistry`.

## `models.yml` shape

```yaml
providers:
  <provider-id>:
    # provider-level config
equivalence:
  overrides:
    <provider-id>/<model-id>: <canonical-model-id>
  exclude:
    - <provider-id>/<model-id>
```

`provider-id` is the canonical provider key used across selection and auth lookup.

`equivalence` is optional and configures canonical model grouping on top of concrete provider models:

- `overrides` maps an exact concrete selector (`provider/modelId`) to an official upstream canonical id
- `exclude` opts a concrete selector out of canonical grouping

## Provider-level fields

```yaml
providers:
  my-provider:
    baseUrl: https://api.example.com/v1
    apiKey: MY_PROVIDER_API_KEY
    api: openai-completions
    headers:
      X-Team: platform
    authHeader: true
    auth: apiKey
    disableStrictTools: false  # set true for Anthropic-compatible endpoints that reject the strict field
    discovery:
      type: ollama
    modelOverrides:
      some-model-id:
        name: Renamed model
    models:
      - id: some-model-id
        name: Some Model
        api: openai-completions
        reasoning: false
        input: [text]
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
        contextWindow: 128000
        maxTokens: 16384
        headers:
          X-Model: value
        compat:
          supportsStore: true
          supportsDeveloperRole: true
          supportsReasoningEffort: true
          maxTokensField: max_completion_tokens
          openRouterRouting:
            only: [anthropic]
          vercelGatewayRouting:
            order: [anthropic, openai]
          extraBody:
            gateway: m1-01
            controller: mlx
```

### Allowed provider/model `api` values

- `openai-completions`
- `openai-responses`
- `openai-codex-responses`
- `azure-openai-responses`
- `anthropic-messages`
- `google-generative-ai`
- `google-vertex`

### Allowed auth/discovery values

- `auth`: `apiKey` (default), `none`, or `oauth`; for `models.yml` custom models, `oauth` is accepted by schema but does not waive the `apiKey` requirement
- `discovery.type`: `ollama`, `llama.cpp`, or `lm-studio`

## Validation rules (current)

### Full custom provider (`models` is non-empty)

Required:

- `baseUrl`
- `apiKey` unless `auth: none`
- `api` at provider level or each model

### Override-only provider (`models` missing or empty)

Must define at least one of:

- `baseUrl`
- `headers`
- `compat`
- `disableStrictTools`
- `modelOverrides`
- `discovery`

### Discovery

- `discovery` requires provider-level `api`.

### Model value checks

- `id` required
- `contextWindow` and `maxTokens` must be positive if provided

## Merge and override order

ModelRegistry pipeline (on refresh):

1. Load built-in providers/models from `@oh-my-pi/pi-ai`.
2. Load `models.yml` custom config.
3. Apply provider overrides (`baseUrl`, `headers`, `disableStrictTools`) to built-in models.
4. Apply `modelOverrides` (per provider + model id).
5. Merge custom `models`:
   - same `provider + id` replaces existing
   - otherwise append
6. Load cached/runtime-discovered models (Ollama, llama.cpp, LM Studio, plus built-in provider managers), then re-apply model overrides.

## Canonical model equivalence and coalescing

The registry keeps every concrete provider model and then builds a canonical layer above them.

Canonical ids are official upstream ids only, for example:

- `claude-opus-4-6`
- `claude-haiku-4-5`
- `gpt-5.3-codex`

### `models.yml` equivalence config

Example:

```yaml
providers:
  zenmux:
    baseUrl: https://api.zenmux.example/v1
    apiKey: ZENMUX_API_KEY
    api: openai-codex-responses
    models:
      - id: codex
        name: Zenmux Codex
        reasoning: true
        input: [text]
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
        contextWindow: 200000
        maxTokens: 32768

equivalence:
  overrides:
    zenmux/codex: gpt-5.3-codex
    p-codex/codex: gpt-5.3-codex
  exclude:
    - demo/codex-preview
```

Build order for canonical grouping:

1. exact user override from `equivalence.overrides`
2. bundled official-id matches from built-in model metadata
3. conservative heuristic normalization for gateway/provider variants
4. fallback to the concrete model's own id

Current heuristics are intentionally narrow:

- embedded upstream prefixes can be stripped when present, for example `anthropic/...` or `openai/...`
- dotted and dashed version variants can normalize only when they map to an existing official id, for example `4.6 -> 4-6`
- ambiguous families or versions are not merged without a bundled match or explicit override

### Canonical resolution behavior

When multiple concrete variants share a canonical id, resolution uses:

1. availability and auth
2. `config.yml` `modelProviderOrder`
3. existing registry/provider order if `modelProviderOrder` is unset

Disabled or unauthenticated providers are skipped.

Session state and transcripts continue to record the concrete provider/model that actually executed the turn.

Provider defaults vs per-model overrides:

- Provider `headers` are baseline.
- Model `headers` override provider header keys.
- `modelOverrides` can override model metadata (`name`, `reasoning`, `input`, `cost`, `contextWindow`, `maxTokens`, `headers`, `compat`, `contextPromotionTarget`).
- `compat` is deep-merged for nested routing blocks (`openRouterRouting`, `vercelGatewayRouting`, `extraBody`).

## Runtime discovery integration

### Implicit Ollama discovery

If `ollama` is not explicitly configured, registry adds an implicit discoverable provider:

- provider: `ollama`
- api: `openai-responses`
- base URL: `OLLAMA_BASE_URL` or `http://127.0.0.1:11434`
- auth mode: keyless (`auth: none` behavior)

Runtime discovery calls Ollama endpoints and normalizes discovered OpenAI-compatible models to `openai-responses`.

### Implicit llama.cpp discovery

If `llama.cpp` is not explicitly configured, registry adds an implicit discoverable provider:

- provider: `llama.cpp`
- api: `openai-responses`
- base URL: `LLAMA_CPP_BASE_URL` or `http://127.0.0.1:8080`
- auth mode: keyless (`auth: none` behavior)

Runtime discovery calls llama.cpp model endpoints and synthesizes model entries with local defaults.

### Implicit LM Studio discovery

If `lm-studio` is not explicitly configured, registry adds an implicit discoverable provider:

- provider: `lm-studio`
- api: `openai-completions`
- base URL: `LM_STUDIO_BASE_URL` or `http://127.0.0.1:1234/v1`
- auth mode: keyless (`auth: none` behavior)

Runtime discovery fetches models (`GET /models`) and synthesizes model entries with local defaults.

### Explicit provider discovery

You can configure discovery yourself:

```yaml
providers:
  ollama:
    baseUrl: http://127.0.0.1:11434
    api: openai-responses
    auth: none
    discovery:
      type: ollama

  llama.cpp:
    baseUrl: http://127.0.0.1:8080
    api: openai-responses
    auth: none
    discovery:
      type: llama.cpp
```

### Extension provider registration

Extensions can register providers at runtime (`pi.registerProvider(...)`), including:

- model replacement/append for a provider
- custom stream handler registration for new API IDs
- custom OAuth provider registration

## Auth and API key resolution order

When requesting a key for a provider, effective order is:

1. Runtime override (CLI `--api-key`)
2. Stored API key credential in `agent.db`
3. Stored OAuth credential in `agent.db` (with refresh)
4. Environment variable mapping (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.)
5. ModelRegistry fallback resolver (provider `apiKey` from `models.yml`, env-name-or-literal semantics)

`models.yml` `apiKey` behavior:

- Value is first treated as an environment variable name.
- If no env var exists, the literal string is used as the token.

If `authHeader: true` and provider `apiKey` is set, models get:

- `Authorization: Bearer <resolved-key>` header injected.

Keyless providers:

- Providers marked `auth: none` are treated as available without credentials.
- `getApiKey*` returns `kNoAuth` for them.

## Model availability vs all models

- `getAll()` returns the loaded model registry (built-in + merged custom + discovered).
- `getAvailable()` filters to models that are keyless or have resolvable auth.

So a model can exist in registry but not be selectable until auth is available.

## Runtime model resolution

### CLI and pattern parsing

`model-resolver.ts` supports:

- exact `provider/modelId`
- exact canonical model id
- exact model id (provider inferred)
- fuzzy/substring matching
- glob scope patterns in `--models` (e.g. `openai/*`, `*sonnet*`)
- optional `:thinkingLevel` suffix (`off|minimal|low|medium|high|xhigh`)

`--provider` is legacy; `--model` is preferred.

Resolution precedence for exact selectors:

1. exact `provider/modelId` bypasses coalescing
2. exact canonical id resolves through the canonical index
3. exact bare concrete id still works
4. fuzzy and glob matching run after the exact paths

### Initial model selection priority

`findInitialModel(...)` uses this order:

1. explicit CLI provider+model
2. first scoped model (if not resuming)
3. saved default provider/model
4. known provider defaults (e.g. OpenAI/Anthropic/etc.) among available models
5. first available model

### Role aliases and settings

Supported model roles:

- `default`, `smol`, `slow`, `vision`, `plan`, `designer`, `commit`, `task`

Role aliases like `pi/smol` expand through `settings.modelRoles`. Each role value can also append a thinking selector such as `:minimal`, `:low`, `:medium`, or `:high`.

If a role points at another role, the target model still inherits normally and any explicit suffix on the referring role wins for that role-specific use.

Related settings:

- `modelRoles` (record)
- `enabledModels` (scoped pattern list)
- `modelProviderOrder` (global canonical-provider precedence)
- `providers.kimiApiFormat` (`openai` or `anthropic` request format)
- `providers.openaiWebsockets` (`auto|off|on` websocket preference for OpenAI Codex transport)

`modelRoles` may store either:

- `provider/modelId` to pin a concrete provider variant
- a canonical id such as `gpt-5.3-codex` to allow provider coalescing

For `enabledModels` and CLI `--models`:

- exact canonical ids expand to all concrete variants in that canonical group
- explicit `provider/modelId` entries stay exact
- globs and fuzzy matches still operate on concrete models

## `/model` and `--list-models`

Both surfaces keep provider-prefixed models visible and selectable.

They now also expose canonical/coalesced models:

- `/model` includes a canonical view alongside provider tabs
- `--list-models` prints a canonical section plus the concrete provider rows

Selecting a canonical entry stores the canonical selector. Selecting a provider row stores the explicit `provider/modelId`.

## Context promotion (model-level fallback chains)

Context promotion is an overflow recovery mechanism for small-context variants (for example `*-spark`) that automatically promotes to a larger-context sibling when the API rejects a request with a context length error.

### Trigger and order

When a turn fails with a context overflow error (e.g. `context_length_exceeded`), `AgentSession` attempts promotion **before** falling back to compaction:

1. If `contextPromotion.enabled` is true, resolve a promotion target (see below).
2. If a target is found, switch to it and retry the request — no compaction needed.
3. If no target is available, fall through to auto-compaction on the current model.

### Target selection

Selection is model-driven, not role-driven:

1. `currentModel.contextPromotionTarget` (if configured)
2. smallest larger-context model on the same provider + API

Candidates are ignored unless credentials resolve (`ModelRegistry.getApiKey(...)`).

### OpenAI Codex websocket handoff

If switching from/to `openai-codex-responses`, session provider state key `openai-codex-responses` is closed before model switch. This drops websocket transport state so the next turn starts clean on the promoted model.

### Persistence behavior

Promotion uses temporary switching (`setModelTemporary`):

- recorded as a temporary `model_change` in session history
- does not rewrite saved role mapping

### Configuring explicit fallback chains

Configure fallback directly in model metadata via `contextPromotionTarget`.

`contextPromotionTarget` accepts either:

- `provider/model-id` (explicit)
- `model-id` (resolved within current provider)

Example (`models.yml`) for Spark -> non-Spark on the same provider:

```yaml
providers:
  openai-codex:
    modelOverrides:
      gpt-5.3-codex-spark:
        contextPromotionTarget: openai-codex/gpt-5.3-codex
```

The built-in model generator also assigns this automatically for `*-spark` models when a same-provider base model exists.

## Compatibility and routing fields

The `compat` block on a provider or model overrides the URL-based auto-detection in `packages/ai/src/providers/openai-completions-compat.ts`. It is validated by `OpenAICompatSchema` in `packages/coding-agent/src/config/model-registry.ts` and consumed by every `openai-completions` transport (`packages/ai/src/providers/openai-completions.ts`). The canonical type is `OpenAICompat` in `packages/ai/src/types.ts`.

`models.yml` accepts the following keys (all optional; unset falls back to URL detection):

Request shaping:

- `supportsStore` — emit `store: false` on requests. Default: auto (off for non-standard endpoints).
- `supportsDeveloperRole` — use the `developer` system role for reasoning models instead of `system`. Default: auto.
- `supportsUsageInStreaming` — send `stream_options: { include_usage: true }` to receive token usage on streaming responses. Default: `true`.
- `maxTokensField` — `"max_completion_tokens"` or `"max_tokens"`. Default: auto.
- `supportsToolChoice` — emit the `tool_choice` parameter when the caller forces a specific tool. Default: `true`. Set `false` for endpoints that 400 on `tool_choice` (e.g. DeepSeek when reasoning is on).
- `disableReasoningOnForcedToolChoice` — drop `reasoning_effort` / OpenRouter `reasoning` whenever `tool_choice` forces a call. Default: auto (Kimi/Anthropic-fronted endpoints).
- `extraBody` — extra top-level fields merged into every request body (gateway hints, controller selectors, etc.).

Reasoning / thinking:

- `supportsReasoningEffort` — accept `reasoning_effort`. Default: auto (off for Grok and zAI).
- `reasoningEffortMap` — partial map from internal effort levels (`minimal|low|medium|high|xhigh`) to provider-specific strings (e.g. DeepSeek maps `xhigh -> "max"`).
- `thinkingFormat` — request shape for thinking: `"openai"` (`reasoning_effort`), `"openrouter"` (`reasoning: { effort }`), `"zai"` (`thinking: { type: "enabled" }`), `"qwen"` (top-level `enable_thinking`), or `"qwen-chat-template"` (`chat_template_kwargs.enable_thinking`). Default: `"openai"`.
- `reasoningContentField` — assistant field carrying chain-of-thought: `"reasoning_content"`, `"reasoning"`, or `"reasoning_text"`. Default: auto.
- `requiresReasoningContentForToolCalls` — assistant tool-call turns must round-trip the reasoning field (DeepSeek-R1, Kimi, OpenRouter when reasoning is on). Default: `false`.
- `requiresAssistantContentForToolCalls` — assistant tool-call turns must include non-empty text content (Kimi). Default: `false`.

Tool / message normalization:

- `requiresToolResultName` — tool-result messages need a `name` field (Mistral). Default: auto.
- `requiresAssistantAfterToolResult` — a user message after a tool result needs an assistant turn in between. Default: auto.
- `requiresThinkingAsText` — convert thinking blocks to text wrapped in `<thinking>` delimiters (Mistral). Default: auto.
- `requiresMistralToolIds` — normalize tool-call ids to exactly 9 alphanumeric chars. Default: auto.
- `supportsStrictMode` — accept the per-tool `strict` field on tool schemas. Default: conservative auto-detect per provider/baseUrl.
- `toolStrictMode` — `"all_strict"` forces strict on every tool, `"none"` forces it off; unset keeps the existing per-tool mixed behavior.

Gateway routing (only applied when `baseUrl` matches the gateway):

- `openRouterRouting.only` / `openRouterRouting.order` — provider routing on `openrouter.ai` (see <https://openrouter.ai/docs/provider-routing>).
- `vercelGatewayRouting.only` / `vercelGatewayRouting.order` — provider routing on `ai-gateway.vercel.sh` (see <https://vercel.com/docs/ai-gateway/models-and-providers/provider-options>).

Provider-level `compat` is the baseline; per-model `compat` is deep-merged on top, with `openRouterRouting`, `vercelGatewayRouting`, and `extraBody` merged as nested objects.

### Anthropic compatibility (`anthropic-messages`)

For `anthropic-messages` models the runtime uses a separate `AnthropicCompat` shape (`packages/ai/src/types.ts`). The `models.yml` schema currently exposes only the strict-tools opt-out as a top-level provider field (see below); the remaining Anthropic-side knobs (`disableAdaptiveThinking`, `supportsEagerToolInputStreaming`, `supportsLongCacheRetention`) are set by built-in catalog metadata and are not user-configurable from `models.yml`.

### Strict tool schemas (`disableStrictTools`)

Anthropic's API supports a `strict` field on tool definitions that forces the model to always follow the provided schema exactly. This is enabled by default for all `anthropic-messages` providers because it guarantees schema conformance in agentic systems.

Third-party providers that front the Anthropic API (AWS Bedrock, Azure, self-hosted proxies) do not always implement this field and will reject requests that include it. Set `disableStrictTools: true` at the provider level to opt out:

```yaml
providers:
  bedrock-anthropic:
    baseUrl: https://bedrock-runtime.us-east-1.amazonaws.com/anthropic
    apiKey: AWS_BEARER_TOKEN
    api: anthropic-messages
    disableStrictTools: true
    models:
      - id: claude-sonnet-4-20250514
        name: Claude Sonnet 4 (Bedrock)
        input: [text, image]
        contextWindow: 200000
        maxTokens: 16384
        cost:
          input: 3.00
          output: 15.00
          cacheRead: 0.30
          cacheWrite: 3.75
```

`disableStrictTools` is a provider-level flag that applies to all models in the provider.
## Practical examples

### Local OpenAI-compatible endpoint (no auth)

```yaml
providers:
  local-openai:
    baseUrl: http://127.0.0.1:8000/v1
    auth: none
    api: openai-completions
    models:
      - id: Qwen/Qwen2.5-Coder-32B-Instruct
        name: Qwen 2.5 Coder 32B (local)
```

### Hosted proxy with env-based key

```yaml
providers:
  anthropic-proxy:
    baseUrl: https://proxy.example.com/anthropic
    apiKey: ANTHROPIC_PROXY_API_KEY
    api: anthropic-messages
    authHeader: true
    disableStrictTools: true  # if the proxy doesn't support strict tool schemas
    models:
      - id: claude-sonnet-4-20250514
        name: Claude Sonnet 4 (Proxy)
        reasoning: true
        input: [text, image]
```

### Override built-in provider route + model metadata

```yaml
providers:
  openrouter:
    baseUrl: https://my-proxy.example.com/v1
    headers:
      X-Team: platform
    modelOverrides:
      anthropic/claude-sonnet-4:
        name: Sonnet 4 (Corp)
        compat:
          openRouterRouting:
            only: [anthropic]
```

## Legacy consumer caveat

Most model configuration now flows through `models.yml` via `ModelRegistry`. Explicit `.json` / `.jsonc` paths remain supported only when passed programmatically to `ModelRegistry`; the default user config is `~/.omp/agent/models.yml`.

## Failure mode

If `models.yml` fails schema or validation checks:

- registry keeps operating with built-in models
- error is exposed via `ModelRegistry.getError()` and surfaced in UI/notifications

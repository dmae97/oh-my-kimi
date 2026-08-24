# Provider Resilience

OMK can recover an agent turn from provider failures that are unlikely to succeed unchanged:

- content or safety stops reported as errors
- billing-cycle or quota exhaustion
- orphaned `tool_call_id` protocol errors
- transient transport and server failures
- gateway/upstream availability failures (5xx passthroughs, streams that end without a finish reason)

This is availability behavior, not a safety bypass. Provider safety policy and the user's configured model access remain authoritative.

## Settings

Configure resilience in `~/.omk/agent/settings.json` or `.omk/settings.json`:

```json
{
  "providerResilience": {
    "blockStickySafetyModels": true,
    "autoFailoverOnSafetyStop": true,
    "failoverCandidates": [
      { "provider": "kimi-coding", "id": "k3" },
      { "provider": "modelstudio-maas", "id": "qwen3.8-max-preview" }
    ]
  }
}
```

| Setting | Default | Behavior |
|---|---:|---|
| `blockStickySafetyModels` | `true` | Blocks interactive and automatic activation of models known to produce sticky false-positive safety stops. The catalog still lists them; set this to `false` to use an interactive or saved selection. |
| `autoFailoverOnSafetyStop` | `true` | Enables failover for safety stops and quota/billing exhaustion. |
| `failoverCandidates` | built-in chain | Ordered models considered before an automatic retry. |

Automatic recovery also requires `retry.enabled: true` and available retry budget.

An explicit `--model` or `--provider`/`--model` pin keeps automatic resilience from replacing that model. A later manual model selection can still change it.
Safety-stop failover and sticky-model eject do not run on a pinned model.
Claude Fable, Opus, and Sonnet also stay on-model after a content/safety stop,
even without `--model` and even when skills are loaded. Those refusals are not
retried on DeepSeek or Kimi.

## Failover behavior

For a safety stop or recognized quota/billing error, OMK:

1. classifies the failed provider attempt;
2. excludes the current model and models already failed during this retry sequence;
3. selects the first non-sticky candidate that exists and has configured authentication;
4. switches models before retrying with a short delay.

A content/safety stop gets at most one automatic retry, including a retry that switches model, regardless of the larger transport retry budget. Other transient failures keep the configured retry policy and backoff. Plain authentication errors remain non-retryable and do not trigger failover.

Recognized quota shapes include billing-cycle usage limits, `insufficient_quota`, exhausted balances, `GoUsageLimitError`, `FreeUsageLimitError`, and out-of-budget responses. These are classified as `provider.rate_limit`, even when a provider wraps them in HTTP 403.

Gateway/upstream availability failures — "503 Upstream request failed", "Endpoint is unavailable", or a stream that ended without a finish reason — are classified as `provider.network`: transport problems that heal by retry or model switch, never by transcript sanitization.

The default candidate order is:

1. `kimi-coding/k3`
2. `modelstudio-maas/qwen3.8-max-preview`
3. `xai/grok-4.5`
4. `deepseek/deepseek-v4-pro`
5. `deepseek/deepseek-v4-flash`
6. `modelstudio-maas/deepseek-v4-pro`
7. `kimi-coding/kimi-for-coding`

## Same-model route rotation

The same underlying model is often served by several provider routes (for example `openrouter/stealth/ox-alpha` and `opencode-go/ox-alpha-free`). When the active route fails with an upstream availability error, OMK rotates to another authenticated route of the same model family before touching the cross-model failover chain, so the retry lands on a live endpoint instead of hammering the dead one.

Routes already visited this turn and routes without configured authentication are excluded from rotation. Route rotation runs inside the normal retry budget; when no sibling route remains, the standard failover behavior applies.

Compaction summarization reuses the same chain: when the summarization model hits quota/billing exhaustion, the configured failover candidates are tried once each before the run fails with a non-retryable `compaction.quota_exhausted` termination cause. See [Compaction](compaction.md).

## Retry and termination events

Each provider attempt is journaled separately and emits `session_termination`. A retryable failure is attempt-level when an `auto_retry_start` event follows it. A recovered retry later emits a `completed` termination; an exhausted retry budget leaves the last provider failure as the final termination.

See [Sessions](sessions.md#retries-and-termination-events) for consumer guidance.

## Protocol recovery

For orphaned `tool_call_id` errors, OMK removes the failed assistant message from the live retry context. The standard message transform then drops tool results whose originating call is absent. Persisted session history remains unchanged for auditability.

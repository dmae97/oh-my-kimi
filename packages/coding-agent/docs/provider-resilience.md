# Provider resilience (root-level)

Built into OMK core — not an optional extension.

## What it does

1. **Blocks sticky safety models** (e.g. `claude-fable-5`) from being selected as the session chat model.
2. **Ejects** them at prompt time if a resumed session still has one loaded.
3. On **content/safety stop** (`stop_reason=refusal`), **auto-failovers** to `k3 → grok-4.5 → deepseek` before retry.
4. Works with message sanitize (`transform-messages` orphan `tool_call_id` drop) so K3 protocol 400s can heal on retry.

This is session survival engineering, not a jailbreak.

## Settings (`~/.omk/agent/settings.json`)

```json
{
  "defaultProvider": "kimi-coding",
  "defaultModel": "k3",
  "providerResilience": {
    "blockStickySafetyModels": true,
    "autoFailoverOnSafetyStop": true,
    "failoverCandidates": [
      { "provider": "kimi-coding", "id": "k3" },
      { "provider": "grok-oauth-proxy", "id": "grok-4.5" },
      { "provider": "deepseek", "id": "deepseek-v4-pro" }
    ]
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `blockStickySafetyModels` | `true` | Refuse `setModel` / initial pick of Fable-class ids |
| `autoFailoverOnSafetyStop` | `true` | Switch model before auto-retry on safety stop |
| `failoverCandidates` | k3→grok→deepseek… | Ordered targets |

Disable only if you intentionally want Fable:

```json
"providerResilience": { "blockStickySafetyModels": false, "autoFailoverOnSafetyStop": false }
```

## Code

| Module | Role |
|---|---|
| `src/core/provider-resilience.ts` | Shared detectors + failover pick |
| `src/core/agent-session.ts` | eject / failover / retry wiring |
| `src/core/model-resolver.ts` | skip sticky on initial model pick |
| `src/core/settings-manager.ts` | `providerResilience` settings |
| `packages/ai/.../transform-messages.ts` | drop orphan tool results |

## How Fable is neutralized (not "jailbroken")

Server-side content/safety stops cannot be removed by OAuth RE or local patches.
OMK **deletes Fable from the operational surface**:

| Layer | Kill switch |
|---|---|
| `models.json` | `claude-fable-5` removed from anthropic catalog |
| `model-registry.loadModels` | `/fable/i` filtered unless `OMK_ALLOW_STICKY_SAFETY_MODELS=1` |
| `model-resolver` | sticky skipped; k3 preferred |
| `setModel` | throws if sticky + block on |
| `cycleModel` (scoped + available) | sticky filtered; goes through `setModel` |
| prompt boundary | ejects leftover Fable session model → k3 |
| safety-stop retry | failover chain before continue |

**You don't fight Fable. You never load it.**

## Operator

```
# after rebuild — restart OMK session (required)

/model k3          # if still on a bad model
/new               # if transcript is corrupted (orphan tool ids)

# emergency re-enable Fable (not recommended)
OMK_ALLOW_STICKY_SAFETY_MODELS=1 omk
# and settings: providerResilience.blockStickySafetyModels=false
```

## arXiv note (2026-07)

Recent cs.CL hits on refusal/jailbreak are mostly attack-ASR / weight-edit / prefill studies.
No immediate ops patch beyond routing+sanitize already in-tree. Skip theory-only papers.

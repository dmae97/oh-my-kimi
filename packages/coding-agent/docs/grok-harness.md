# Grok harness

This page is the canonical operator guide for the native `xai` provider. Use `/login` for xAI subscription OAuth or `XAI_API_KEY` for xAI Platform API billing. A user-local `~/.omk/agent/grok.md` may add operator notes, but it is not the portable product contract.

## Presets

Project presets live in `.omk/presets.json` and are consumed by the preset extension from `packages/coding-agent/examples/extensions/preset.ts`. The shared Grok presets intentionally omit the `tools` key so role/domain lane grants keep control of the active tools.

| Preset | Provider | Model | Thinking | Use |
| --- | --- | --- | --- | --- |
| `grok-verified` | `xai` | `grok-4.5` | `high` | Default native xAI text-chat baseline. |
| `grok-adaptorch-prod` | `xai` | `grok-4.5` | `high` | Same baseline, with AdaptOrch reserved for explicit DAG routing, synthesis, or consistency-verification lanes. |

## Authentication and weekly usage

Both authentication methods use provider ID `xai`. See [Providers](providers.md#xai-grok) for the authoritative OAuth, API-key, credential-storage, and weekly-usage behavior. Do not put OAuth access or refresh tokens in `models.json`.

## Thinking tiers

OMK sends the mapped value as xAI `reasoning_effort`.

| OMK tier | `grok-4.6` | `grok-4.5` | `grok-4.3` |
| --- | --- | --- | --- |
| `off` | unavailable | unavailable | `none` |
| `minimal` | unavailable | unavailable | unavailable |
| `low` | `low` | `low` | `low` |
| `medium` | `medium` | `medium` | `medium` |
| `high` | `high` | `high` | `high` |
| `xhigh` | `xhigh` | unavailable | unavailable |
| `max` | `xhigh` | `high` | `high` |
| `ultra` | `xhigh` | `high` | `high` |

Grok 4.6 and 4.5 cannot disable reasoning. Grok 4.3 supports `off` by sending `reasoning_effort: "none"`.

## Migration from `grok-oauth-proxy`

The proxy provider is retired. Remove stale `grok-oauth-proxy` entries from `models.json` and `auth.json`, then use native `xai`. OMK ignores stale entries during migration.

## Suggested TUI flow

1. Run `/grok` only when you want to load the optional local operator overlay.
2. Select `/preset grok-verified` for normal chat/coding work.
3. Select `/preset grok-adaptorch-prod` only when the task has an explicit DAG, routing, or synthesis objective.
4. Keep credentials and OAuth material out of preset JSON.

## Domain routing

Selecting the native `xai` provider auto-applies the `grok-harness` loadout by default; this does not require `OMK_DOMAIN_ROUTING=1`. Set `OMK_GROK_HARNESS=0` to disable that provider-specific dispatch.

General prompt-based domain routing is separate and opt-in through `OMK_DOMAIN_ROUTING=1`. It selects one of the profiles under [`loadout-domains/`](loadout-domains/README.md) and composes it with the active role loadout. Grok presets only set provider, model, thinking level, and instruction pointers.

## Chat model selection

The native `xai` catalog includes `grok-4.6`, `grok-4.5`, and `grok-4.3`. Use `/model` or `omk --list-models xai` for the current complete list. Project presets intentionally pin the verified `grok-4.5` baseline, and `grok-4.3` remains a fallback. Do not use `grok-imagine-*` IDs as chat models.

## Imagine tools

Imagine media generation is tool-based, not model-selection-based:

| Task | OMK tool |
| --- | --- |
| Text-to-image, image edits, restyles | `grok_imagine_image` |
| Text-to-video or image-to-video | `grok_imagine_video` |

Do not select `grok-imagine-image`, `grok-imagine-image-quality`, `grok-imagine-video`, or similar Imagine ids as the chat model. For media tasks, require tool output evidence such as the final saved path or URL before claiming success.

## Skill and MCP matrix summary

Use the normal OMK lane grant model: grant the smallest skill and MCP surface that matches the task, and keep media exceptions explicit.

| Task class | Skills | MCP |
| --- | --- | --- |
| Multi-package or repo-context work | `packages`; add `headroom` only under context pressure | none by default |
| Repo graph or broad comprehension | `understand-anything`; optionally `packages` | `understand-anything` |
| DAG planning or synthesis | `adaptorch` / `adaptorch-route` / `adaptorch-synthesize` | `adaptorch` |
| TypeScript/Rust/Python/Go edits | `programming`; add `lsp` or `ast-grep` only for symbol/structural work | none by default |
| Runtime failures or broken behavior | `debugging` | task-specific only |
| UI/TUI verification | `visual-qa` | `playwright` only when browser/UI evidence is required |
| Current public URL or docs lookup | task skill as needed | `fetch` |
| Image prompts or media generation | explicit-only `image-prompt`, `omnigen-vault`, or `gpt-image-2-prompts` | none by default |

Relevant evidence hooks for Grok lanes are `pre-shell-guard`, `protect-secrets`, `typecheck-after-edit`, and `stop-verify`. Hook output is incremental evidence; code changes still need the project's required final verification command before claiming type/lint cleanliness.

## Local overlay

`/grok` may load `~/.omk/agent/grok.md` for host-specific Hermes, Telegram, or Imagine notes. Treat that file as optional local configuration; this page and the current provider documentation remain authoritative.

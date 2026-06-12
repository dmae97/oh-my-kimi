# OMK Runtime Architecture

## Overview

OMK CLI V2 implements a runtime pipeline that separates control-plane (OMK orchestration) from model-facing (provider prompt). The key principle: **"모델에게는 작은 NLP prompt만. 런타임에는 sidecar만. 사용자에게는 theme/NLG만."**

## Pipeline

```
User Input / Slash Command
  → CommandBus (src/runtime/command-bus.ts)
  → IntentClassifier (src/runtime/debloat-nlp.ts: classifyIntent)
  → CapabilitySelector (src/runtime/debloat-nlp.ts: selectCapabilities)
  → RuntimeSidecar Builder (src/runtime/debloat-nlp.ts: compileBloatToNlp)
  → NLP Prompt Compiler + Filtered MCP Config
  → ProviderAdapter + Provider Runtime
  → ProviderEventNormalizer (src/runtime/provider-event-normalizer.ts)
  → OmkEventBus (src/runtime/contracts/command-envelope.ts)
  → OutputRouter (src/runtime/output-router.ts)
  → ThemeRenderer / NlpRenderer / JsonRenderer / NlgRenderer
```

## Core Modules

| Module | File | Purpose |
|--------|------|---------|
| CommandBus | `src/runtime/command-bus.ts` | Routes slash commands to handlers |
| IntentClassifier | `src/runtime/debloat-nlp.ts` | Classifies user intent (status/chat/code_edit/etc.) |
| CapabilitySelector | `src/runtime/debloat-nlp.ts` | Selects required/optional MCP, skills |
| RuntimeSidecar | `src/runtime/debloat-nlp.ts` | Builds sidecar metadata (provider/model/risk/sandbox) |
| MCP Config Filter | `src/runtime/debloat-nlp.ts` | Per-turn MCP config filtering |
| Provider Runtime Selector | `src/runtime/debloat-nlp.ts` | Selects kimi-event vs kimi-print |
| ProviderEventNormalizer | `src/runtime/provider-event-normalizer.ts` | Converts raw provider events to OmkEvent |
| OutputRouter | `src/runtime/output-router.ts` | Routes OmkEvent to appropriate renderer |
| ThemeRenderer | `src/runtime/renderers.ts` | Rich terminal output with ThemePalette |
| NlpRenderer | `src/runtime/renderers.ts` | Plain text bilingual output |
| JsonRenderer | `src/runtime/renderers.ts` | Structured JSON output |
| NlgRenderer | `src/runtime/nlg-renderer.ts` | Consent-aware NLG reports |
| ReasoningTrace | `src/runtime/reasoning-trace.ts` | Evidence summaries, privacy redaction |
| UI Components | `src/runtime/ui-components.ts` | statusCard, providerCard, errorBox, etc. |
| SlashCommands | `src/runtime/slash-commands.ts` | /model, /status, /theme, /help handlers |

## Key Types

- `CommandEnvelope`: Normalized CLI input (kind, source, rawText, outputProfile)
- `RequestIntent`: status|resume|memory_query|repo_read|code_edit|debug_error|web_research|plan|chat|unknown
- `CapabilityPlan`: availableMcp[], requiredMcp[], optionalMcp[], disabledMcp[], selectedSkills[]
- `RuntimeSidecar`: provider, model, intent, risk, sandbox, requiredMcp, optionalMcp, disabledMcp
- `OmkEvent`: turn_started|progress|mcp_status|warning|result|error|turn_finished
- `ReasoningTrace`: intent, plan, execution, evidence, result, privacy

## Invariants

- I-001: availableMcp ≠ prompt MUST activate
- I-004: optional MCP failure = warning, not fatal
- I-005: raw provider events not visible in stdout
- I-006: status requiredMcp=[]
- I-008: slash commands go through CommandBus
- I-011: kimi-print is debug-only

## Theme System

- `src/cli/theme/theme-registry.ts`: ThemePalette with SemanticToken, 5 palettes (omk/minimal/mono/dark/light)
- `src/cli/theme/theme-resolver.ts`: Resolves active theme from --theme flag → OMK_THEME env → project config → user config

## i18n

- `src/util/i18n.ts`: Bilingual (KO/EN) support via `t()` function
- Keys: nlp.*, normalizer.*, ui.*, nlg.*

## CLI v2

- `src/cli/v2/cli-v2-skeleton.ts`: Clipanion-based commands (Chat, Run, Status, Model, Doctor, Memory, Theme)
- `src/cli/v2/provider-commands.ts`: Provider + Model commands
- `src/cli/v2/workflow-commands.ts`: Workflow + Consent commands
- `src/cli/v2/chat-repl.ts`: Interactive REPL with pipeline integration
- `src/cli/v2/persistent-memory.ts`: Section 17 memory store
- Enable with `OMK_CLI_V2=1`

## Providers

- Default: mimo (mimo-v2.5-pro) via `https://api.xiaomimimo.com/v1`
- Kimi: kimi-api (direct Moonshot HTTP), kimi-wire (kimi --wire binary)
- Others: codex, deepseek, opencode, openrouter, qwen, local-llm

## Tests

- `test/v2-regression.test.mjs`: 10 tests (20.1-20.7) — all PASS
- `test/cli-v2-gating.test.mjs`: 7 tests — all PASS

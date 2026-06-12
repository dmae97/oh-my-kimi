# CLI v2 Migration Guide

## Overview

OMK CLI v2 migrates from Commander.js to Clipanion + Clack for a modern CLI experience matching opencode-style terminal UX.

## Enabling CLI v2

```bash
OMK_CLI_V2=1 omk <command>
```

## Migrated Commands

### Core Commands (cli-v2-skeleton.ts)
| Command | Clipanion Class | Status |
|---------|----------------|--------|
| `omk chat` | ChatCommand | ✅ |
| `omk run` | RunCommand | ✅ |
| `omk status` | StatusCommand | ✅ |
| `omk model` | ModelCommand | ✅ |
| `omk doctor` | DoctorCommand | ✅ |
| `omk memory` | MemoryCommand | ✅ |
| `omk theme` | ThemeCommand | ✅ |

### Provider Commands (provider-commands.ts)
| Command | Clipanion Class | Status |
|---------|----------------|--------|
| `omk provider list` | ProviderListCommand | ✅ |
| `omk provider use` | ProviderUseCommand | ✅ |
| `omk provider set` | ProviderSetCommand | ✅ |
| `omk provider enable` | ProviderEnableCommand | ✅ |
| `omk provider disable` | ProviderDisableCommand | ✅ |
| `omk provider doctor` | ProviderDoctorCommand | ✅ |
| `omk provider profiles` | ProviderProfilesCommand | ✅ |
| `omk model list` | ModelListCommand | ✅ |
| `omk model aliases` | ModelAliasesCommand | ✅ |
| `omk model resolve` | ModelResolveCommand | ✅ |
| `omk model use` | ModelUseCommand | ✅ |

### Workflow Commands (workflow-commands.ts)
| Command | Clipanion Class | Status |
|---------|----------------|--------|
| `omk plan` | PlanCommand | ✅ |
| `omk feature` | FeatureCommand | ✅ |
| `omk bugfix` | BugfixCommand | ✅ |
| `omk refactor` | RefactorCommand | ✅ |
| `omk review` | ReviewCommand | ✅ |
| `omk team` | TeamCommand | ✅ |
| `omk orchestrate` | OrchestrateCommand | ✅ |
| `omk consent` | ConsentCommand | ✅ |

## Architecture

All CLI v2 commands route through the full runtime pipeline:

```
User Input → Clipanion CLI → OmkCommand.executePipeline()
  → CommandBus → IntentClassifier → CapabilitySelector
  → RuntimeSidecar → OutputRouter → ThemeRenderer/NlpRenderer/JsonRenderer
```

## Key Files

- `src/cli/v2/cli-v2-skeleton.ts`: Core commands + createCliV2()
- `src/cli/v2/provider-commands.ts`: Provider + Model commands
- `src/cli/v2/workflow-commands.ts`: Workflow + Consent commands
- `src/cli/v2/chat-repl.ts`: Interactive REPL
- `src/cli/v2/interactive-prompt.ts`: Clack prompts
- `src/cli/v2/persistent-memory.ts`: Memory store
- `src/cli/main.ts`: CLI v2 routing (isCliV2Enabled())

## UI/UX Style

CLI v2 uses opencode-style terminal output:
- `> provider · model` one-line header
- Spinner animation during processing
- Compact error display with box drawing
- Status bar at bottom
- Bilingual (KO/EN) via i18n

## Testing

```bash
node --test test/cli-v2-gating.test.mjs  # 7 tests
node --test test/v2-regression.test.mjs   # 10 tests
```

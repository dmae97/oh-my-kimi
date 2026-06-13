# Settings

`omp` resolves settings from persistent global config, project-local config, one-shot CLI overlays, and in-memory runtime overrides. Use project settings when one repository needs a different provider set, model role, tool policy, memory backend, or UI behavior than your global defaults.

For model/provider credentials and custom `models.yml` providers, see [Providers](./providers.md). For instruction files discovered into the agent context, see [Context files](./context-files.md).

## Where settings live

| Scope | Path | Read behavior | Write behavior |
|---|---|---|---|
| Global | `~/.omp/agent/config.yml` | Main persistent settings file. `PI_CODING_AGENT_DIR` changes the `~/.omp/agent` base directory. | `/settings`, `omp config set`, and runtime settings changes write here. |
| Global legacy | `~/.omp/agent/settings.json` | Migrated to `config.yml` when `config.yml` is missing. | Not written after migration. |
| Project | `<cwd>/.omp/config.yml` | Read when the process current working directory contains a non-empty `.omp/` directory. | Read-only through discovery; edit the file by hand. |
| Project legacy | `<cwd>/.omp/settings.json` | Still read before project `config.yml`. | Not written by settings commands. |
| CLI overlay | Any YAML file passed with `--config <file>` | Loaded after global and project settings for that one process. Repeat `--config` to layer files. | Never persisted. |

Native project settings are intentionally local to the process cwd's `.omp/` directory. Unlike context files, native settings discovery does not walk ancestor directories looking for the nearest `.omp/`. Other discovery providers can also contribute project-level settings from their own files (`.claude/settings.json`, `.gemini/settings.json`, `.codex/config.toml`, `.cursor/settings.json`, `opencode.json`); those sources are read-only from `omp` settings commands and can be disabled by provider ID.

### Legacy migration

When `config.yml` is missing, startup attempts to migrate the matching legacy JSON file:

- Global: `~/.omp/agent/settings.json` -> `~/.omp/agent/config.yml`
- Project/native discovery: `<cwd>/.omp/settings.json` remains readable, but project settings are not rewritten by `omp`
- Generic `ConfigFile` users also support `.json` -> `.yml` migration when the `.yml` file is absent

If both the YAML and legacy JSON files exist at the same scope, YAML wins for settings loaded from that scope. For native project settings, `settings.json` is read first and `config.yml` is read second, so project `config.yml` overrides duplicate keys from project `settings.json`.

## Reading and writing settings

Interactive `/settings` and `omp config` operate on the merged effective settings, but persistent writes go to the global config file:

```bash
omp config list
omp config get theme.dark
omp config set compaction.enabled false
omp config set tools.approvalMode write
omp config set disabledProviders '["anthropic","openai"]'
omp config reset compaction.enabled
omp config path
```

Value parsing is schema-driven:

- booleans accept `true`, `false`, `yes`, `no`, `on`, `off`, `1`, `0`
- numbers parse as JavaScript numbers
- enums must match one of the implemented values
- arrays and records must be JSON on the command line
- strings are stored as provided

`omp config set` and `/settings` do not write into `<cwd>/.omp/config.yml`. To make a project-local override, create or edit that file directly.

## Precedence

Effective precedence is:

```text
built-in defaults <- global config <- project config <- CLI overlays <- runtime overrides
```

From highest to lowest priority:

1. Runtime overrides and dedicated CLI flags (`--model`, `--smol`, `--slow`, `--plan`, `--approval-mode`, `--auto-approve`/`--yolo`, `--hide-thinking`, `--no-pty`, `--api-key`, protocol-mode defaults)
2. CLI config overlays (`--config <file>`; later overlay files override earlier overlay files)
3. Project settings (`<cwd>/.omp/settings.json`, then `<cwd>/.omp/config.yml`)
4. Global settings (`~/.omp/agent/config.yml`)
5. Built-in defaults from the settings schema

Environment variables are not a single settings layer. They are read by the feature that owns the value, often as an override or fallback:

- `PI_SMOL_MODEL`, `PI_SLOW_MODEL`, and `PI_PLAN_MODEL` override `modelRoles.smol`, `modelRoles.slow`, and `modelRoles.plan` for the current process.
- `PI_NO_PTY=1` disables PTY-backed bash execution; `--no-pty` sets it for the current process.
- `PI_PY` and `PI_JS` override `eval.py` and `eval.js`.
- `PI_TINY_DEVICE` and `PI_TINY_DTYPE` override `providers.tinyModelDevice` and `providers.tinyModelDtype`.
- `OMP_AUTH_BROKER_URL` and `OMP_AUTH_BROKER_TOKEN` override `auth.broker.url` and `auth.broker.token`.
- Provider API keys come from stored auth, OAuth, `models.yml`, environment variables, and `.env` files as described in [Providers](./providers.md).

Environment-derived values are not written back to `config.yml`.

## Merge rules

Settings files are YAML mappings. Use nested YAML objects for setting paths that contain dots:

```yaml
theme:
  dark: titanium
  light: light

tools:
  approvalMode: write
  approval:
    bash: prompt
```

Objects are deep-merged. Scalars and arrays are replaced by the higher-precedence layer.

```yaml
# ~/.omp/agent/config.yml
tools:
  approvalMode: write
  approval:
    bash: prompt
    read: allow
disabledProviders:
  - anthropic
  - openai
  - gemini

# <project>/.omp/config.yml
tools:
  approval:
    bash: allow
disabledProviders:
  - groq
```

Effective result in that project:

```yaml
tools:
  approvalMode: write   # kept from global
  approval:
    bash: allow         # overridden by project
    read: allow         # kept from global
disabledProviders:
  - groq                # project array replaces global array
```

Array replacement is important: a project `disabledProviders` array does not append to the global array. It becomes the complete array for that project layer.

## Project-local config examples

Create `<repo>/.omp/config.yml` when a repository needs its own settings:

```yaml
# <repo>/.omp/config.yml
modelRoles:
  default: anthropic/claude-sonnet-4-5
  smol: openai/gpt-4.1-mini
  slow: anthropic/claude-opus-4-5:high

tools:
  approvalMode: write
  approval:
    bash: prompt

compaction:
  strategy: context-full
  thresholdPercent: 80

theme:
  dark: titanium
```

Keep secrets out of committed project config unless your repository policy allows them. Prefer environment variables, stored auth, an auth broker, or an untracked local overlay for credentials.

### One-shot overlays

Use `--config` for a temporary layer that should not persist:

```bash
omp --config ./local/ci-settings.yml "check this failure"
omp --config ./base.yml --config ./experiment.yml "try this model"
```

Overlay paths are resolved relative to the process cwd. Each overlay must parse as a YAML mapping; missing or malformed overlay files are hard errors.

## Path-scoped arrays

`enabledModels` and `disabledProviders` can contain string entries and path-scoped entries:

```yaml
enabledModels:
  - claude-sonnet-4-5
  - path: ~/work/high-context
    models:
      - anthropic/claude-opus-4-5

disabledProviders:
  - ollama
  - paths:
      - ~/projects/sensitive
      - ~/clients/acme
    providers:
      - anthropic
      - openai
```

String entries apply everywhere. Scoped entries apply when the current working directory is exactly the configured path or is under it. `~` expands to your home directory, and relative paths are resolved before matching.

Accepted path keys:

- `path`
- `paths`
- `pathPrefix`
- `pathPrefixes`

Accepted value keys:

- `models` for `enabledModels`
- `providers` for `disabledProviders`
- `values` or `items` for either setting

Only string values are kept. Malformed scoped entries are ignored.

## Provider disabling

`disabledProviders` uses a shared provider ID namespace. It can disable model providers and discovery providers:

| Entry type | Examples | Effect |
|---|---|---|
| Model provider IDs | `anthropic`, `openai`, `gemini`, `groq`, `ollama`, `openrouter` | Prevent those model providers from becoming selectable, even if credentials are available. |
| Discovery provider IDs | `native`, `claude`, `codex`, `gemini`, `github`, `opencode`, `cursor` | Prevent that config source from contributing capabilities such as context files, MCP servers, commands, prompts, tools, hooks, extensions, or settings. |

Most provider-control use cases should list model provider IDs:

```yaml
disabledProviders:
  - anthropic
  - openai
  - gemini
  - groq
```

Use discovery provider IDs only when you want to turn off an entire source. For example, disabling `claude` prevents Claude-format discovery from contributing context/config items; it is different from disabling the `anthropic` model provider. See [Context files](./context-files.md) for the discovery-provider distinction.

Because arrays replace, put the complete desired list in project config:

```yaml
# ~/.omp/agent/config.yml
disabledProviders:
  - anthropic
  - openai

# <repo>/.omp/config.yml
disabledProviders:
  - groq
```

Inside `<repo>`, only `groq` is disabled by settings; `anthropic` and `openai` are no longer disabled by the global array.

## Common settings

The authoritative setting names are the keys shown by `omp config list --json`. Useful groups include:

### Models

```yaml
modelRoles:
  default: anthropic/claude-sonnet-4-5
  smol: openai/gpt-4.1-mini
  slow: anthropic/claude-opus-4-5:high
  vision: gemini/gemini-3-pro-preview
  plan: anthropic/claude-opus-4-5
  designer: anthropic/claude-sonnet-4-5
  commit: openai/gpt-4.1-mini
  task: anthropic/claude-sonnet-4-5

cycleOrder:
  - smol
  - default
  - slow

modelProviderOrder:
  - anthropic
  - openai
```

Built-in role names are `default`, `smol`, `slow`, `vision`, `plan`, `designer`, `commit`, and `task`. Additional custom roles can be introduced by `modelRoles`, `modelTags`, or `cycleOrder`. Role values may include a thinking suffix such as `:minimal`, `:low`, `:medium`, `:high`, or `:xhigh`.

Other model settings include:

```yaml
defaultThinkingLevel: high  # minimal, low, medium, high, xhigh, or auto
hideThinkingBlock: false
temperature: -1            # -1 means provider default
topP: -1
topK: -1
minP: -1
presencePenalty: -1
repetitionPenalty: -1
serviceTier: none          # none, auto, default, flex, scale, priority, openai-only, claude-only
retry:
  enabled: true
  maxRetries: 10
  modelFallback: true
```

### Tools and approvals

```yaml
tools:
  approvalMode: write      # always-ask, write, yolo
  approval:
    bash: prompt           # allow, prompt, or deny
    edit: allow
  discoveryMode: auto      # auto, off, mcp-only, all
  essentialOverride: []
  maxTimeout: 0            # seconds; 0 means no limit

bash:
  enabled: true
  autoBackground:
    enabled: false

eval:
  py: true
  js: true

lsp:
  enabled: true
  lazy: true
  diagnosticsOnWrite: true
```

`--approval-mode` and `--auto-approve`/`--yolo` are runtime overrides. They affect the current process and are not persisted.

### UI and terminal

```yaml
theme:
  dark: titanium
  light: light
symbolPreset: unicode      # unicode, nerd, ascii
colorBlindMode: false

statusLine:
  preset: default          # default, minimal, compact, full, nerd, ascii, custom
  separator: powerline-thin
  transparent: false
  showHookStatus: true

terminal:
  showImages: true
images:
  autoResize: true
  blockImages: false
tui:
  hyperlinks: auto         # off, auto, always
```

Use `statusLine.leftSegments`, `statusLine.rightSegments`, and `statusLine.segmentOptions` only with `statusLine.preset: custom`.

### Context, memory, and files

```yaml
contextPromotion:
  enabled: true

compaction:
  enabled: true
  strategy: context-full   # context-full, handoff, shake, snapcompact, off
  thresholdPercent: -1     # -1 means default reserve-based behavior
  thresholdTokens: -1      # fixed token limit when set
  remoteEnabled: true

memory:
  backend: off             # off, local, hindsight, mnemopi

read:
  defaultLimit: 300
  summarize:
    enabled: true
    prose: false

edit:
  mode: hashline
  fuzzyMatch: true
  blockAutoGenerated: true
```

See [Context files](./context-files.md) for files that are injected as instructions. Those are separate from settings; putting `disabledProviders` in `AGENTS.md` or another context file has no effect.

### Provider/service settings

```yaml
providers:
  webSearch: auto
  image: auto
  fetch: auto
  tinyModel: online
  tinyModelDevice: default
  tinyModelDtype: default
  openaiWebsockets: auto
  openrouterVariant: default
  kimiApiFormat: anthropic

provider:
  appendOnlyContext: auto  # auto, on, off

exa:
  enabled: true
  enableSearch: true
  enableResearcher: false
  enableWebsets: false

searxng:
  endpoint: https://search.example.com
  token: SEARXNG_TOKEN
```

Provider credentials and custom model definitions belong in stored auth, environment variables, or `~/.omp/agent/models.yml`; see [Providers](./providers.md) and [Model and Provider Configuration](./models.md).

## Troubleshooting

### A project setting is not taking effect

- Start `omp` from the directory that contains `.omp/config.yml`. Native settings discovery only checks the current cwd's `.omp/` directory.
- Ensure `.omp/` is non-empty; native discovery ignores empty config directories.
- Check that the file is valid YAML and its top level is a mapping.
- Run `omp config get <key>` from that cwd to see the effective value.
- Remember that runtime flags and `--config` overlays can override project config.

### A global array seems to disappear in a project

Arrays replace; they do not append. If a project sets `disabledProviders`, `enabledModels`, `extensions`, `cycleOrder`, or another array, include the complete desired project value.

### A provider is still available after editing config

- Check whether you disabled the model provider ID (`anthropic`) or a discovery provider ID (`claude`). They are different.
- Check for project config replacing the global `disabledProviders` array.
- Check for credentials in environment variables, `.env`, OAuth, stored auth, or `models.yml`.
- Restart the session if the provider list was already initialized.

### `omp config set` changed the wrong file

`omp config set` always writes the global config under the active agent directory. Use `omp config path` to print that directory. Edit `<repo>/.omp/config.yml` directly for project-local settings.

### A CLI overlay fails at startup

`--config` files are process-local YAML mappings. A missing file, invalid YAML, or a top-level array/string is an error; it does not silently fall back to lower-precedence settings.

### An environment variable beats config

Some settings intentionally allow env/runtime overrides for machine-local behavior or credentials. Unset the environment variable or remove the CLI flag if you want the persisted config value to win.

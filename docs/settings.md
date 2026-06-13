# Settings

`omp` reads settings from global files, project files, one-shot config overlays, and runtime inputs. Use project settings when one repository needs a different provider set, model role, tool policy, or UI setting than your global defaults.

## Files

| Scope | Path | Notes |
|---|---|---|
| Global | `~/.omp/agent/config.yml` | Main persistent settings file. `/settings` and `omp config set` write here. |
| Global legacy | `~/.omp/agent/settings.json` | Migrated to `config.yml` when possible. |
| Project | `<project>/.omp/config.yml` | Recommended per-project override file. Read from the process cwd's `.omp/` directory. |
| Project legacy | `<project>/.omp/settings.json` | Still supported for project settings. |
| Overlay | Any YAML file passed with `--config <file>` | Applies only to that process and is not persisted. Repeat `--config` to layer files. |

Project settings are read-only from discovery: changing settings through `/settings` or `omp config set` updates the global file, not `<project>/.omp/config.yml`.

## Precedence

Highest priority wins:

1. Runtime overrides and dedicated CLI flags (`--slow`, `--no-pty`, `--api-key`, etc.)
2. Environment variables for fields that define env fallbacks (`PI_SLOW_MODEL`, provider API keys, etc.)
3. CLI config overlays (`--config <file>`, later files override earlier files)
4. Project settings (`<project>/.omp/settings.json`, then `<project>/.omp/config.yml`; `config.yml` wins within the project layer)
5. Global settings (`~/.omp/agent/config.yml`)
6. Built-in defaults

The settings merge itself is:

```text
defaults <- global <- project <- CLI config overlays <- runtime overrides
```

Environment variables are not written into config files; they are consulted by the feature that owns the setting or credential.

## Project settings

Put a config file in a project's `.omp/` directory to override global settings only for sessions launched from that directory:

```yaml
# <project>/.omp/config.yml
disabledProviders:
  - groq
modelRoles:
  default: anthropic/claude-sonnet-4-5
  smol: openai/gpt-5.3-mini
```

Objects are deep-merged. Arrays are replaced wholesale by the higher-precedence layer.

```yaml
# ~/.omp/agent/config.yml
disabledProviders:
  - anthropic
  - openai
  - gemini

# <project>/.omp/config.yml
disabledProviders:
  - groq
```

Effective result in that project:

```json
["groq"]
```

The project array replaces the global array; it does not append to it. In this example, `anthropic`, `openai`, and `gemini` are re-enabled for the project.

## `disabledProviders`

`disabledProviders` accepts provider IDs. It disables model providers such as `anthropic`, `openai`, `gemini`, `groq`, `openrouter`, `ollama`, and extension-registered model providers. The same setting also gates capability discovery providers when the entry matches a discovery provider ID such as `native`, `claude`, `codex`, or `gemini`.

Use model provider IDs when you want to prevent a provider from becoming selectable even if credentials are available from `.env`, OAuth, or stored auth.

```yaml
disabledProviders:
  - anthropic
  - openai
  - gemini
  - groq
```

## Path-scoped arrays

`enabledModels` and `disabledProviders` can include entries scoped to a path prefix:

```yaml
enabledModels:
  - claude-sonnet-4-5
  - path: ~/work/high-context
    models:
      - anthropic/claude-opus-4-5

disabledProviders:
  - ollama
  - path: ~/projects/sensitive
    providers:
      - anthropic
      - openai
```

String entries apply everywhere. Scoped entries apply when the current working directory is the configured path or one of its subdirectories. Accepted path keys: `path`, `paths`, `pathPrefix`, `pathPrefixes`. Use `models` for `enabledModels`, `providers` for `disabledProviders`, or `values` for either.

# Providers

Providers are the model backends `omp` can route requests to: Anthropic, OpenAI, Gemini, Groq, Ollama, OpenRouter, custom `models.yml` providers, and extension-registered providers.

## Credentials

Provider credentials can come from stored auth, OAuth, `models.yml`, or environment variables. `omp` eagerly reads `.env` files at startup, including the current project's `<cwd>/.env`, so provider API keys in a project directory can make those providers available without any additional config.

Common environment variables include:

| Provider | Environment variable |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Gemini | `GEMINI_API_KEY` |
| Groq | `GROQ_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |

## Disabling model providers

Use the `disabledProviders` setting to make a model provider unavailable, even if credentials exist in `.env` or stored auth:

```yaml
# ~/.omp/agent/config.yml or <project>/.omp/config.yml
disabledProviders:
  - anthropic
  - openai
  - gemini
  - groq
```

Project settings replace the global `disabledProviders` array. To disable a different set in one repository, put that complete set in `<project>/.omp/config.yml`.

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

Effective result inside the project: only `groq` is disabled.

For configuration file locations and precedence, see [Settings](./settings.md).

## Path-scoped provider settings

Scope `disabledProviders` to a directory with `path:` when only one subtree needs different provider availability:

```yaml
disabledProviders:
  - ollama
  - path: ~/projects/sensitive
    providers:
      - anthropic
      - openai
```

String entries apply everywhere. Scoped entries apply when the current working directory is the configured path or one of its subdirectories.

## Custom providers

Custom providers live in `~/.omp/agent/models.yml`. See [Model and Provider Configuration](./models.md) for the full `models.yml` schema, runtime discovery options, provider overrides, and model resolution behavior.

# Context files

Context files are markdown files `omp` discovers and injects into the agent context so repository rules, project notes, and tool-specific instructions follow the session.

## Native `.omp` files

| File | Scope | Behavior |
|---|---|---|
| `<cwd>/.omp/AGENTS.md` | Project | Project instructions loaded with the current directory. |
| `~/.omp/agent/AGENTS.md` | User | User-level instructions loaded from the agent directory. |
| `<cwd>/.omp/RULES.md` | Project | Sticky always-apply rule content re-injected near the current turn. |
| `~/.omp/agent/RULES.md` | User | User-level sticky rule content. |

Other discovery providers can contribute compatible context files from their own conventions, such as Claude, Codex, Gemini, and GitHub instruction files.

## Discovery providers vs model providers

`disabledProviders` is a setting, not a context-file field. It accepts provider IDs in a shared namespace:

| Entry type | Examples | Effect |
|---|---|---|
| Model provider IDs | `anthropic`, `openai`, `gemini`, `groq`, `ollama`, `openrouter` | Prevent those model providers from becoming selectable, even when credentials are present. |
| Discovery provider IDs | `native`, `claude`, `codex`, `gemini`, `github` | Prevent that capability provider from contributing context files, commands, hooks, tools, prompts, or other capability items. |

Most provider-control use cases should list model provider IDs. Use discovery provider IDs only when you intend to disable an entire config source.

```yaml
# Disable model providers in this project.
disabledProviders:
  - anthropic
  - openai
```

```yaml
# Disable the Claude discovery source entirely.
disabledProviders:
  - claude
```

Project-level values are configured in `<project>/.omp/config.yml`; global values live in `~/.omp/agent/config.yml`. See [Settings](./settings.md) for precedence and array replacement behavior.

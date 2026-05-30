# Mnemosyne memory backend

Oh My Pi can use `@oh-my-pi/pi-mnemosyne` as a local long-term memory backend.

Set:

```yaml
memory:
  backend: mnemosyne
```

Example:

```yaml
memory:
  backend: mnemosyne
mnemosyne:
  scoping: per-project-tagged
```

With this backend enabled, the coding agent:

1. Opens a local Mnemosyne SQLite database.
2. Recalls relevant memories into a `<memories>` block before the first model turn.
3. Retains completed conversation turns into the same bank after agent turns.
4. Uses the normal `/memory view`, `/memory clear`, and `/memory enqueue` commands through the shared memory backend interface.

Recalled memory is background context, not instructions. Current user messages and tool output take precedence when they conflict.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `memory.backend` | `off` | Set to `mnemosyne` to enable this backend. |
| `mnemosyne.dbPath` | agent memories dir | Optional SQLite database path. |
| `mnemosyne.bank` | project directory name | Base bank name passed to `Mnemosyne`; the coding-agent wrapper scopes from this base according to `mnemosyne.scoping`. |
| `mnemosyne.scoping` | `per-project` | Memory visibility mode: `global` = one shared bank, `per-project` = isolated project memory, `per-project-tagged` = project-local writes plus global recall visibility. |
| `mnemosyne.autoRecall` | `true` | Recall memory on the first turn of a session. |
| `mnemosyne.autoRetain` | `true` | Retain completed turns automatically. |
| `mnemosyne.retainEveryNTurns` | `4` | Minimum user turns between automatic retain writes. |
| `mnemosyne.recallLimit` | `8` | Maximum recalled memories in the prompt block. |
| `mnemosyne.recallContextTurns` | `3` | Prior user-bounded turns included in recall queries. |
| `mnemosyne.recallMaxQueryChars` | `4000` | Maximum composed recall query length. |
| `mnemosyne.injectionTokenLimit` | `5000` | Approximate token budget for memory prompt injection. |
| `mnemosyne.debug` | `false` | Enable debug logging for backend failures. |
| `mnemosyne.noEmbeddings` | `false` | Pass `noEmbeddings` to `Mnemosyne` and force FTS-only recall. |
| `mnemosyne.embeddingModel` | env/default | Embedding model passed to `Mnemosyne`. |
| `mnemosyne.embeddingApiUrl` | env/default | OpenAI-compatible embedding endpoint passed to `Mnemosyne`. |
| `mnemosyne.embeddingApiKey` | env/default | Embedding API key passed to `Mnemosyne`. |
| `mnemosyne.llmMode` | `smol` | `smol` uses the configured pi-ai smol model, `remote` uses the settings below, and `none` disables LLM calls. |
| `mnemosyne.llmBaseUrl` | env/default | OpenAI-compatible LLM endpoint for `llmMode: remote`. |
| `mnemosyne.llmApiKey` | env/default | LLM API key for `llmMode: remote`. |
| `mnemosyne.llmModel` | env/default | LLM model id for `llmMode: remote`. |

## Scoping

The coding-agent wrapper applies scoping on top of the underlying `Mnemosyne` package:

- `global` uses one shared bank for every project.
- `per-project` uses a separate bank per project.
- `per-project-tagged` keeps writes project-local while recall can also read from shared global memory.

The combined project-plus-global behavior lives in the wrapper. The `@oh-my-pi/pi-mnemosyne` package itself still exposes banks and constructor options directly, including `bank` for selecting a bank name.
## LLM and embeddings

The backend passes these settings to the `Mnemosyne` constructor; if a setting is omitted, Mnemosyne falls back to its `MNEMOSYNE_*` environment defaults. The backend does not download or run a local GGUF LLM. LLM-dependent paths use a configured pi-ai model, a dynamic completion function, a remote OpenAI-compatible endpoint, or deterministic no-LLM fallbacks.

FTS-only:

```yaml
memory:
  backend: mnemosyne
mnemosyne:
  noEmbeddings: true
```

Equivalent constructor shape:

```ts
new Mnemosyne({ noEmbeddings: true });
```

Remote embeddings:

```yaml
mnemosyne:
  embeddingModel: text-embedding-3-small
  embeddingApiUrl: https://api.openai.com/v1
  embeddingApiKey: ${OPENAI_API_KEY}
```

Equivalent constructor shape:

```ts
new Mnemosyne({
  embeddingModel: "text-embedding-3-small",
  embeddingApiUrl: "https://api.openai.com/v1",
  embeddingApiKey,
});
```

Remote LLM:

```yaml
mnemosyne:
  llmMode: remote
  llmBaseUrl: https://api.openai.com/v1
  llmApiKey: ${OPENAI_API_KEY}
  llmModel: gpt-4.1-mini
```

Equivalent constructor shapes:

```ts
new Mnemosyne({ llm: { baseUrl, apiKey, model } });
new Mnemosyne({ llmBaseUrl: baseUrl, llmApiKey: apiKey, llmModel: model });
```

Dynamic function LLM for rotating OAuth tokens:

```ts
new Mnemosyne({
  llm: async (prompt, opts) => {
    const token = await getFreshOauthToken();
    return await completeWithPiAi(prompt, {
      token,
      maxTokens: opts?.maxTokens,
      temperature: opts?.temperature,
    });
  },
});
```

pi-ai smol model LLM:

```yaml
mnemosyne:
  llmMode: smol
```

The coding agent resolves its configured smol role and passes a dynamic completion function so every Mnemosyne LLM call can fetch the current provider credentials at call time:

```ts
new Mnemosyne({
  llm: async (prompt, opts) => completeSmolWithCurrentAuth(prompt, opts),
});
```

## Operational notes

- The default database lives under the agent memories directory in `mnemosyne/mnemosyne.db`.
- `/memory clear` removes the active Mnemosyne SQLite database and sidecar WAL/SHM files.
- `/memory enqueue` forces retention of the current session and runs Mnemosyne sleep/consolidation.
- Subagents do not auto-retain separate transcript windows; parent sessions own durable retention.

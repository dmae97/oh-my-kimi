# Mnemopi memory backend

Oh My Pi can use `@oh-my-pi/pi-mnemopi` as a local long-term memory backend.

Set:

```yaml
memory:
  backend: mnemopi
```

Example:

```yaml
memory:
  backend: mnemopi
mnemopi:
  scoping: per-project-tagged
```

With this backend enabled, the coding agent:

1. Opens one or more local Mnemopi SQLite databases according to the configured bank scoping.
2. Recalls relevant memories into a `<memories>` block for the first model turn of a session and refreshes the base prompt if recall happens from the `agent_start` listener.
3. Retains completed conversation turns into the retain bank after agent turns, no more often than `mnemopi.retainEveryNTurns`.
4. Adds recalled memory as extra compaction context when compaction asks the memory backend for `preCompactionContext`.
5. Uses the normal `/memory view`, `/memory stats`, `/memory diagnose`, `/memory clear`, and `/memory enqueue` commands through the shared memory backend interface.

Recalled memory is background context, not instructions. Current user messages and tool output take precedence when they conflict.

## Settings

| Setting                         | Default                | Description                                                                                                                                                             |
| ------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.backend`                | `off`                  | Set to `mnemopi` to enable this backend.                                                                                                                              |
| `mnemopi.dbPath`              | agent memories dir     | Optional SQLite database path.                                                                                                                                          |
| `mnemopi.bank`                | unset                  | Optional shared bank base name passed to `Mnemopi`; the coding-agent wrapper scopes from this base according to `mnemopi.scoping`. Unset → shared bank `default`; per-project modes derive a project bank from the project root name plus a stable hash. |
| `mnemopi.scoping`             | `per-project`          | Memory visibility mode: `global` = one shared bank, `per-project` = isolated project memory, `per-project-tagged` = project-local writes plus global recall visibility. |
| `mnemopi.autoRecall`          | `true`                 | Recall memory on the first turn of a session.                                                                                                                           |
| `mnemopi.autoRetain`          | `true`                 | Retain completed turns automatically.                                                                                                                                   |
| `mnemopi.polyphonicRecall`    | `false`                | Enable 4-voice polyphonic recall (vector, graph, fact, temporal) with reciprocal rank fusion; `MNEMOPI_POLYPHONIC_RECALL` overrides when set.                            |
| `mnemopi.enhancedRecall`      | `false`                | Enable the tiered query result cache for repeated/similar recall queries; `MNEMOPI_ENHANCED_RECALL` overrides when set.                                                  |
| `mnemopi.retainEveryNTurns`   | `4`                    | Minimum user turns between automatic retain writes.                                                                                                                     |
| `mnemopi.recallLimit`         | `8`                    | Maximum recalled memories in the prompt block.                                                                                                                          |
| `mnemopi.recallContextTurns`  | `3`                    | Prior user-bounded turns included in recall queries.                                                                                                                    |
| `mnemopi.recallMaxQueryChars` | `4000`                 | Maximum composed recall query length.                                                                                                                                   |
| `mnemopi.injectionTokenLimit` | `5000`                 | Approximate token budget for memory prompt injection.                                                                                                                   |
| `mnemopi.debug`               | `false`                | Enable debug logging for backend failures.                                                                                                                              |
| `mnemopi.noEmbeddings`        | `false`                | Pass `noEmbeddings` to `Mnemopi` and force FTS-only recall.                                                                                                           |
| `mnemopi.embeddingModel`      | env/default            | Embedding model passed to `Mnemopi`.                                                                                                                                  |
| `mnemopi.embeddingApiUrl`     | env/default            | OpenAI-compatible embedding endpoint passed to `Mnemopi`.                                                                                                             |
| `mnemopi.embeddingApiKey`     | env/default            | Embedding API key passed to `Mnemopi`.                                                                                                                                |
| `mnemopi.llmMode`             | `smol`                 | `smol` uses the configured pi-ai smol model, `remote` uses the settings below, and `none` disables LLM calls.                                                           |
| `mnemopi.llmBaseUrl`          | env/default            | OpenAI-compatible LLM endpoint for `llmMode: remote`.                                                                                                                   |
| `mnemopi.llmApiKey`           | env/default            | LLM API key for `llmMode: remote`.                                                                                                                                      |
| `mnemopi.llmModel`            | env/default            | LLM model id for `llmMode: remote`.                                                                                                                                     |

## Scoping

The coding-agent wrapper applies scoping on top of the underlying `Mnemopi` package:

- `global` uses one shared bank for recall and writes.
- `per-project` writes to and recalls from a bank derived from the current git repository root (or cwd) plus a stable hash.
- `per-project-tagged` writes to the project-local bank and recalls from both the project-local bank and the shared global bank, with duplicate recall results merged.

The combined project-plus-global behavior lives in the wrapper. The `@oh-my-pi/pi-mnemopi` package itself still exposes banks and constructor options directly, including `bank` for selecting a bank name. Project-local banks other than the shared bank are stored as sibling bank databases managed by Mnemopi's `BankManager`.

## LLM and embeddings

The backend passes these settings to the `Mnemopi` constructor; if a setting is omitted, Mnemopi falls back to its `MNEMOPI_*` environment defaults. The backend does not download or run a local GGUF LLM. LLM-dependent paths use a configured pi-ai model, an opt-in local on-device memory model (`providers.memoryModel`, ONNX — overrides `smol`/`remote` when set to a local model), a dynamic completion function, a remote OpenAI-compatible endpoint, or deterministic no-LLM fallbacks.

FTS-only:

```yaml
memory:
  backend: mnemopi
mnemopi:
  noEmbeddings: true
```

Equivalent constructor shape:

```ts
new Mnemopi({ noEmbeddings: true });
```

Remote embeddings:

```yaml
mnemopi:
  embeddingModel: text-embedding-3-small
  embeddingApiUrl: https://api.openai.com/v1
  embeddingApiKey: ${OPENAI_API_KEY}
```

Equivalent constructor shape:

```ts
new Mnemopi({
  embeddingModel: "text-embedding-3-small",
  embeddingApiUrl: "https://api.openai.com/v1",
  embeddingApiKey,
});
```

Remote LLM:

```yaml
mnemopi:
  llmMode: remote
  llmBaseUrl: https://api.openai.com/v1
  llmApiKey: ${OPENAI_API_KEY}
  llmModel: gpt-4.1-mini
```

Equivalent constructor shapes:

```ts
new Mnemopi({ llm: { baseUrl, apiKey, model } });
new Mnemopi({ llmBaseUrl: baseUrl, llmApiKey: apiKey, llmModel: model });
```

Dynamic function LLM for rotating OAuth tokens:

```ts
new Mnemopi({
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
mnemopi:
  llmMode: smol
```

The coding agent resolves its configured smol role and passes a dynamic completion function so every Mnemopi LLM call can fetch the current provider credentials at call time:

```ts
new Mnemopi({
  llm: async (prompt, opts) => completeSmolWithCurrentAuth(prompt, opts),
});
```

## Operational notes

- The default shared database lives under the agent memories directory in `mnemopi/mnemopi.db`; project-scoped banks use sibling database paths under that Mnemopi directory.
- `/memory clear` removes every scoped Mnemopi SQLite database and sidecar WAL/SHM files for the active configuration.
- `/memory enqueue` forces retention of the current session, flushes pending fact extractions, and runs Mnemopi sleep/consolidation.
- `/memory stats` and `/memory diagnose` render backend-specific bank statistics/diagnostics when the Mnemopi backend is active.
- Subagents do not own separate Mnemopi retain loops; they alias the parent state when a parent Mnemopi state exists, and otherwise remain inert.

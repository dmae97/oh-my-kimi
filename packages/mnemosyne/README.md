# @oh-my-pi/pi-mnemosyne

Local SQLite memory engine for Oh My Pi agents.

This package is the Bun/TypeScript port of the Mnemosyne memory engine. It provides:

- `Mnemosyne`, a small facade for remember/recall/stats/sleep workflows.
- `BeamMemory`, the lower-level working/episodic memory engine.
- MCP tool definitions and a dispatcher for host integrations.
- Optional local ONNX embeddings through `fastembed` and optional OpenAI-compatible embedding/LLM endpoints.

The package does not bundle or download a local GGUF LLM. LLM paths are host-backend or OpenAI-compatible remote only; when no LLM is configured, deterministic heuristic paths are used.

## Basic use

```ts
import { Mnemosyne } from "@oh-my-pi/pi-mnemosyne";

const memory = new Mnemosyne({ dbPath: "./mnemosyne.db", bank: "project" });
const id = memory.remember("The deployment target is stable-cluster.", {
	source: "notes",
	importance: 0.8,
	veracity: "true",
});

const results = memory.recall("deployment target", 5);
console.log(id, results[0]?.content);

memory.close();
```

## Configuration

`Mnemosyne` accepts LLM and embedding options directly. `MNEMOSYNE_*` environment variables remain fallbacks/defaults when the matching constructor option is omitted.

```ts
import { Mnemosyne } from "@oh-my-pi/pi-mnemosyne";
import type { Model } from "@oh-my-pi/pi-ai";

const ftsOnly = new Mnemosyne({ noEmbeddings: true });

const remoteEmbeddings = new Mnemosyne({
	embeddingModel: "text-embedding-3-small",
	embeddingApiUrl: "https://api.openai.com/v1",
	embeddingApiKey: process.env.OPENAI_API_KEY,
});

const remoteLlm = new Mnemosyne({
	llm: {
		baseUrl: "https://api.openai.com/v1",
		apiKey: process.env.OPENAI_API_KEY,
		model: "gpt-4.1-mini",
	},
	// Equivalent aliases: llmBaseUrl, llmApiKey, llmModel.
});

declare const smolModel: Model;
const piAiLlm = new Mnemosyne({ llm: smolModel });
const dynamicLlm = new Mnemosyne({
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

### Banks and host scoping

`Mnemosyne` itself exposes banks directly through constructor options such as `bank`; it does not hard-code coding-agent project scoping.

The Oh My Pi coding-agent wrapper adds `mnemosyne.scoping` on top of those constructor options:

- `global`: one shared bank
- `per-project`: isolated project memory
- `per-project-tagged`: project-local writes plus global recall visibility

In `per-project-tagged`, the wrapper is responsible for combining project-local retention with global recall visibility. The package still just exposes banks plus constructor-level LLM and embedding options.

Common environment fallbacks:

- `MNEMOSYNE_DATA_DIR` / `MNEMOSYNE_DB_PATH`: default storage location.
- `MNEMOSYNE_NO_EMBEDDINGS=1`: force FTS-only recall.
- `MNEMOSYNE_EMBEDDING_MODEL`: defaults to `BAAI/bge-small-en-v1.5`.
- `MNEMOSYNE_EMBEDDING_API_URL` and `MNEMOSYNE_EMBEDDING_API_KEY`: OpenAI-compatible embedding endpoint.
- `MNEMOSYNE_LLM_ENABLED=1`, `MNEMOSYNE_LLM_BASE_URL`, `MNEMOSYNE_LLM_API_KEY`, `MNEMOSYNE_LLM_MODEL`: OpenAI-compatible LLM endpoint.

Local embeddings use the `fastembed` npm package. Its default `BGESmallENV15` model is 384-dimensional and uses the package's CLS pooling plus vector normalization path. Local GGUF LLMs are not available in this package.

## Commands

```sh
mnemosyne remember "Use stable-cluster for production deploys"
mnemosyne recall "production deploy target"
mnemosyne stats
mnemosyne sleep
```

## Tests

```sh
bun --cwd packages/mnemosyne test
bun --cwd packages/mnemosyne run check
```

# Embedded Local Tiny-Model Experiments

This document summarizes the experiments behind the optional **local** tiny-model paths for
session-title generation (`providers.tinyModel`), Mnemopi memory extraction/consolidation
(`providers.memoryModel`), and the `auto` thinking-level difficulty classifier
(`providers.autoThinkingModel`, which reuses the memory-model registry). It is a factual engineering
record for maintainers: what we measured, which recipes won, and which models we shipped. All three
settings default to `online`, so existing users incur no downloads or on-device inference cost unless
they opt in.

## Runtime / environment findings

- **Stack**: `@huggingface/transformers` (transformers.js) v4 running under Bun. In Bun the library
  loads the **native `onnxruntime-node` backend** (not the WASM build).
- **Device policy**: local tiny models default to CPU-only inference and retry once on CPU if an
  explicit accelerated provider cannot initialize.
  - Pick a provider persistently with the `providers.tinyModelDevice` setting (`default` keeps CPU),
    or per-run with the `PI_TINY_DEVICE` env var (which overrides the setting).
  - Accepted values are `cpu`, `gpu`, `metal`/`webgpu`, `auto`, `cuda`, `dml`, `coreml`, `wasm`,
    `webnn`, `webnn-gpu`, `webnn-cpu`, and `webnn-npu`.
  - Direct `coreml` remains opt-in via `PI_TINY_DEVICE=coreml`; it is not part of the default because
    cached decoder-LLM ONNX loads can fail during session initialization.
  - WebGPU/Metal works for the single-process eval harness, but the production worker forces
    Darwin `gpu`/`webgpu`/`auto` requests back to CPU because ONNX Runtime/Bun currently
    hard-crashes on worker teardown after WebGPU inference.
  - Use `providers.tinyModelDevice` or `PI_TINY_DEVICE` only when explicitly opting out of the CPU
    default.
- **Quantization: q4 is the sweet spot** — smaller on disk, faster to load, and fast at inference.
  q8/int8 loads slower _and_ infers slower on CPU. Every shipped model defaults to `q4`; override the
  precision persistently with the `providers.tinyModelDtype` setting (`default` keeps `q4`, e.g. `fp16`
  for higher fidelity), or per-run with `PI_TINY_DTYPE` (which overrides the setting). Accepts `auto`,
  `fp32`, `fp16`, `q8`, `int8`, `uint8`, `q4`, `bnb4`, `q4f16`, `q2`, `q2f16`, `q1`, `q1f16`; an
  unrecognized value fails loudly at worker startup.
- **Load-time correction (important).** An earlier belief that "q4 >=1B models take minutes to load"
  was a **measurement artifact** caused by running ~5 multi-GB HuggingFace downloads in parallel
  (I/O saturation). Clean, isolated **warm** loads are all sub-3s:
  - TinyLlama-1.1B q4: ~0.5s
  - Llama-3.2-1B q4: ~2.8s (`graphOpt=all`) / ~0.5s (`disabled`)
  - LFM2-1.2B q4: ~0.36s
  - Qwen2.5-1.5B q4: ~1.5s
  - Qwen3-1.7B q4: ~1.6s
  - gemma-3-1b q4: ~1.1s
  - Conclusion: **1B–1.7B models are viable on CPU.**
- **`session_options.graphOptimizationLevel`** trades load vs inference speed: `disabled` = fastest
  load, slightly slower inference; `all` = default.
- **First run** downloads weights from the HF Hub to a cache dir (q4 weights ~200MB–1.1GB depending
  on model); subsequent **warm** loads are sub-second to ~3s. Inference is async and
  background-friendly for memory tasks; titles are semi-interactive.

## Task 1: Session title generation (`providers.tinyModel`)

**Task**: turn the first user message into a 3–6 word title. Tiny models (sub-1B) suffice.

**Winning recipe**:

- Plain system prompt (no few-shot).
- **Prefill** the assistant turn with `<title>` and **stop at `</title>`**, then take the first line.
- Greedy decoding (`do_sample:false`), `enable_thinking:false` in the chat template.

**What we learned**:

- **Few-shot examples HURT sub-0.6B models** for titles; the tag-prefill rescues even 270M models.
- **Token biasing (`bad_words_ids`) is a confirmed no-op** here — the prefill already controls the
  opener.

**Leaderboard** (tag trick, CPU, warm):

| Model         | Verdict                             |
| ------------- | ----------------------------------- |
| LFM2-350M     | Best speed/quality balance (~212MB) |
| Qwen3-0.6B    | Most robust                         |
| gemma-3-270m  | Smallest viable                     |
| Qwen2.5-0.5B  | Acceptable                          |
| SmolLM2-135M  | Too small                           |
| flan-t5-small | Rejected — just echoes the input    |

**Shipped local options**: `lfm2-350m`, `qwen3-0.6b`, `gemma-270m`, `qwen2.5-0.5b`, `lfm2-700m`.
**Default**: `online` (pi/smol).

## Task 2: Mnemopi memory (`providers.memoryModel`)

Mnemopi runs two small-LLM tasks:

1. **Extraction** — pull durable, structured items from a single message.
2. **Consolidation** — summarize a list of memories into 1–3 faithful sentences.

These need **bigger models than titles: 1B–1.7B**. We tested LFM2-1.2B, Qwen2.5-1.5B, Qwen3-1.7B,
and gemma-3-1b (q4, CPU) via four parallel agents each running 27–31 experiments.

### Extraction findings

The stock 5-category JSON prompt fails on small models in two ways:

1. The all-empty example `{"facts":[],...}` gets **copied verbatim** → 0 facts extracted.
2. Capable models emit **JSON objects inside arrays**, which Mnemopi's `String(item)` coerces into
   the literal string `[object Object]`.

The robust fix is a **one-item-per-line output format** (consumed by Mnemopi's parser line-fallback)
or a **flat JSON array of strings**. Every model also over-extracts pure small talk; an explicit
chit-chat → NONE example is the best mitigation.

### Technique polarity flips vs titles

- At 1B+, **few-shot is the dominant quality lever**: e.g. Qwen2.5-1.5B extraction F1 0.52 → 0.83
  going 1 → 3 shots; gemma recall 0.65 → 0.92 with 2 shots.
- **Prefill HURTS extraction** — it forces output on small talk, producing false positives.
- **System-split** (instructions in the system role) helps models that have a system role.
- **Greedy >= temperature** for both tasks.
- **Token biasing** is again a no-op.

### Per-model verdicts (head-to-head, 16-fixture set)

- **Qwen3-1.7B** — most disciplined extraction: returns empty on small talk, no buried-fact leak,
  preserves language, clean flat JSON. Weaknesses: coarse granularity, missed a multi-turn value
  update.
- **Qwen2.5-1.5B** — best extraction granularity (atomic facts), caught the value update, zero
  small-talk leakage. Weaknesses: weakest consolidation (run-on, no dedup) and one degenerate
  buried-fact output.
- **gemma-3-1b** — best consolidation (dedup works, faithful, clean single-memory). Weaknesses: leaks
  small talk and translated German.
- **LFM2-1.2B** — solid and fastest to load. Weaknesses: `Label: value` noise, small-talk + buried
  leaks, a fluffy single-memory summary.

### Recommendation

Extraction favors **precision** (do not pollute long-term memory) → **Qwen3-1.7B is the best single
pick** (its consolidation is good enough). If running a second model for consolidation, **gemma-3-1b**
wins that task.

**Shipped local options**: `qwen3-1.7b` (recommended), `gemma-3-1b`, `qwen2.5-1.5b`, `lfm2-1.2b`.
**Default**: `online` (the configured smol model).

### Known Mnemopi parser bugs (surfaced by these experiments)

- `String(item)` produces `[object Object]` on object array items.
- The line-fallback drops items `<=10` chars, so a correct short fact like `Name: Can` is discarded.

## Task 3: Shake-summary compression (`providers.shakeSummaryModel`)

**Task**: extractively compress aged heavy tool-result regions for `/shake summary` and the
`shake-summary` auto-compaction strategy. This path is strictly local/on-device and always keeps an
`artifact://` recovery link, so the model must prefer faithful omission over invented detail — the
full original is one fetch away.

**Grain (validated against practice)**: the summary is **per tool result** and **extractive** — what
the result established (paths, identifiers, signatures, error messages, exit codes, commands kept
verbatim), not a free-form "what happened" narrative. Industry consensus (Factory.ai compression
evals, LangChain Deep Agents, Manus, Anthropic's agent loop) is that per-tool/per-phase extractive
summaries with an external artifact pointer preserve attribution and recoverability far better than a
single whole-trajectory narrative; "what happened" prose belongs in a separate global session-state
layer, not the per-result path. A per-result "what happened" summary is near-contentless (the tool
call already says what ran), which is exactly what the bench showed.

**Bench**: dev script `scripts/bench-shake-summary.ts` against one real `-Projects-pi` transcript,
driving the shared tiny-model worker directly (q4, CPU, greedy). It captures coverage (regions that
parse to a `<region>` summary), compression ratio, latency, and — for unparseable outputs — the raw
completion, so format failures are judgeable instead of vanishing. Representative aged **read** result
(`auth-storage.ts`, 3002 lines, middle-truncated to a 32 KB prompt sample). Artifacts:
`/tmp/shake-bench-lfm2-350m.json`, `/tmp/shake-bench-prefill*.json`.

**Findings**:
- **Model floor is ~1B.** LFM2-350M loads fastest (~0.3 s) but on a long read it *hallucinated*
  fictional code in a markdown fence instead of extracting, and never emitted the `<region>` format —
  unusable for a faithful record. Sub-1B models pattern-match "rewrite the code" and confabulate.
- **Prefill fixes format, not comprehension.** Pinning the assistant turn open with the output tag
  (a recognized SLM technique) forced LFM2-350M/700M to emit a well-formed block, but the *content*
  stayed empty/garbage (`409`, `The`, `This`). A content-bearing prefix (`The tool returned `) makes
  it worse — it biases a garden-path completion. Prefill must pin format only.
- **Single-shot whole-region input breaks the capable model.** Feeding ~10 K tokens in one completion
  crashed Qwen3-1.7B's q4 ONNX build ("Unknown failure"); the production path avoids this by batching
  at `DEFAULT_BATCH_TOKEN_BUDGET` (4 K), which Qwen3-1.7B handles cleanly.

**Recommendation**: keep **Qwen3-1.7B** as the shake-summary default. It is not the fastest, but the
task values faithfulness over prettiness — invented line numbers, paths, or commands are worse than
terse omission since the artifact remains recoverable — and Qwen3-1.7B is the smallest candidate that
extracts faithfully without confabulating. Incremental background precompute (see below) amortizes its
latency outside the foreground compaction path. A format-only prefill (`<region index="N">`) is a
low-risk future reliability win for the local models; the worker already supports it.

**Shipped local options**: `qwen3-1.7b` (recommended), `gemma-3-1b`, `qwen2.5-1.5b`, `lfm2-1.2b`.
**Default**: `qwen3-1.7b`.

**Instant compaction**: aged eligible tool results past the shake protect window are summarized in the
background (off-thread worker) as they age out and cached on the message (`ToolResultMessage.shakeSummary`,
keyed by `toolCallId` + content hash + model). A warm `/shake summary` then reuses the cache and issues
zero foreground `complete` calls; cache entries invalidate on content-hash or model-key change and are
skipped once `prunedAt` is set.

## Integration notes

- `providers.tinyModel`, `providers.memoryModel`, and `providers.autoThinkingModel` default to
  `online`, so existing users get **no downloads or on-device inference cost** unless they opt in.
- Local inference runs **in a worker** (off the main thread); models are cached on disk and
  downloaded on first use.
- The memory local path applies the refined recipes (line-format + small-talk-guarded extraction
  prompt, hardened consolidation prompt) via Mnemopi prompt overrides; the **online path is
  unchanged**.
- `providers.autoThinkingModel` uses the same shipped local options as `providers.memoryModel`.

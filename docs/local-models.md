# Embedded Local Tiny-Model Experiments

This document summarizes the experiments behind the optional **local** tiny-model paths for two
coding-agent tasks: session-title generation (`providers.tinyModel`) and Mnemosyne memory
extraction/consolidation (`providers.memoryModel`). It is a factual engineering record for
maintainers: what we measured, which recipes won, and which models we shipped. Both settings
default to `online`, so existing users incur no downloads or CPU cost unless they opt in.

## Runtime / environment findings

- **Stack**: `@huggingface/transformers` (transformers.js) v4 running under Bun. In Bun the library
  loads the **native `onnxruntime-node` backend** (not the WASM build). Available device options are
  `cpu` / `coreml` / `webgpu` — there is **no `wasm` device** in the node build.
- **Device verdict: use `device:"cpu"`.** CPU is the only reliable path.
  - `coreml` EP is **broken for decoder LLMs**: it rejects the dynamic KV-cache `past_key_values`
    zero-element first-token shape.
  - `webgpu` runs but is **slower and numerically divergent** (worse output quality).
- **Quantization: q4 is the sweet spot** — smaller on disk, faster to load, and fast at inference.
  q8/int8 loads slower *and* infers slower on CPU.
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

| Model | Verdict |
| --- | --- |
| LFM2-350M | Best speed/quality balance (~212MB) |
| Qwen3-0.6B | Most robust |
| gemma-3-270m | Smallest viable |
| Qwen2.5-0.5B | Acceptable |
| SmolLM2-135M | Too small |
| flan-t5-small | Rejected — just echoes the input |

**Shipped local options**: `lfm2-350m`, `qwen3-0.6b`, `gemma-270m`, `qwen2.5-0.5b`, `lfm2-700m`.
**Default**: `online` (pi/smol).

## Task 2: Mnemosyne memory (`providers.memoryModel`)

Mnemosyne runs two small-LLM tasks:

1. **Extraction** — pull durable, structured items from a single message.
2. **Consolidation** — summarize a list of memories into 1–3 faithful sentences.

These need **bigger models than titles: 1B–1.7B**. We tested LFM2-1.2B, Qwen2.5-1.5B, Qwen3-1.7B,
and gemma-3-1b (q4, CPU) via four parallel agents each running 27–31 experiments.

### Extraction findings

The stock 5-category JSON prompt fails on small models in two ways:

1. The all-empty example `{"facts":[],...}` gets **copied verbatim** → 0 facts extracted.
2. Capable models emit **JSON objects inside arrays**, which Mnemosyne's `String(item)` coerces into
   the literal string `[object Object]`.

The robust fix is a **one-item-per-line output format** (consumed by Mnemosyne's parser line-fallback)
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

### Known Mnemosyne parser bugs (surfaced by these experiments)

- `String(item)` produces `[object Object]` on object array items.
- The line-fallback drops items `<=10` chars, so a correct short fact like `Name: Can` is discarded.

## Integration notes

- Both settings default to `online`, so existing users get **no downloads or CPU cost** unless they
  opt in.
- Local inference runs **in a worker** (off the main thread); models are cached on disk and
  downloaded on first use.
- The memory local path applies the refined recipes (line-format + small-talk-guarded extraction
  prompt, hardened consolidation prompt) via Mnemosyne prompt overrides; the **online path is
  unchanged**.

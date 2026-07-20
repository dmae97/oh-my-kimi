# AI tool-schema normalization

`@oh-my-pi/pi-ai` exposes one unified schema normalizer that providers consume
before tools are sent on the wire. All walkers live in
`packages/ai/src/utils/schema/normalize.ts`; the operational contract is
`packages/ai/src/utils/schema/CONSTRAINTS.md`.

There is no separate `strict-mode.ts` module any more — OpenAI strict-mode
sanitization, OpenAI Responses `oneOf` rewriting, Google/Vertex/Gemini-CLI
sanitization, Cloud Code Assist Claude sanitization, and MCP sanitization all
share the same option-driven walk.

## Entry points

All exports live under `@oh-my-pi/pi-ai/utils/schema`:

- `normalizeSchema(value, options)` — generic option-driven walker.
- `normalizeSchemaForGoogle(value)` — Gemini / Vertex / Gemini CLI.
- `normalizeSchemaForCCA(value)` — Cloud Code Assist Claude (Antigravity + GCA).
- `normalizeSchemaForMCP(value)` — MCP inputSchemas before they enter the
  custom-tool registry. `tool-bridge.ts` runs every MCP `inputSchema` through
  this dispatcher.
- `sanitizeSchemaForOpenAIResponses(schema)` (alias
  `normalizeSchemaForOpenAIResponses`) — rewrites `oneOf` → `anyOf` for the
  Responses family.
- `sanitizeSchemaForStrictMode(schema)` and
  `enforceStrictSchema(schema)` / `tryEnforceStrictSchema(schema)` — the
  OpenAI strict-mode pipeline (sanitize → enforce). All three are exported
  from `normalize.ts`.
- `adaptSchemaForStrict(schema, strict)` from `./adapt` — thin composer that
  upgrades draft-07 inputs to 2020-12 and wraps `tryEnforceStrictSchema` for
  provider call sites. `./adapt` also exports the `NO_STRICT` global-bypass
  flag (env `PI_NO_STRICT`) honored by every provider that emits `strict: true`.

Removed in the unified-flow refactor:

- `strict-mode.ts` (merged into `normalize.ts`).
- `sanitize-google.ts` and `normalize-cca.ts` (replaced by
  `normalizeSchemaFor*` dispatchers).
- `StringEnum` helper — use `z.enum([...])` directly; Zod's emitted JSON
  Schema is already wire-compatible with Google and other providers.
- `sanitizeSchemaFor{Google,CCA,MCP}` / `prepareSchemaForCCA` — renamed to
  `normalizeSchemaFor{Google,CCA,MCP}`.

## Dispatcher mapping

| Provider transport(s)                                              | Dispatcher                                  |
| ------------------------------------------------------------------ | ------------------------------------------- |
| `openai-completions`, `openai-responses`, `openai-codex-responses` | `adaptSchemaForStrict` (sanitize + enforce) |
| `openai-responses` family (`oneOf` → `anyOf` only)                 | `normalizeSchemaForOpenAIResponses`         |
| `google-generative-ai`, `google-vertex`, Gemini CLI                | `normalizeSchemaForGoogle`                  |
| Cloud Code Assist Claude (Antigravity + GCA, `claude-*` model ids) | `normalizeSchemaForCCA`                     |
| MCP `inputSchema` ingestion                                        | `normalizeSchemaForMCP`                     |
| `anthropic-messages` (native, not CCA)                             | per-provider whitelist in `anthropic.ts`    |

Gemini CLI / Antigravity CCA MUST run the full `normalizeSchemaForCCA`
pipeline (not just the first keyword-stripping pass) to keep parity with the
shared Google Claude path.

## Walk semantics

`normalizeSchema` first detoxifies serialized Zod-instance-shaped inputs, upgrades them to
JSON Schema 2020-12, dereferences the tree, then walks it with the option set
pinned by the dispatcher. Each node:

1. Renames `snake_case` combinator/property keys to camelCase
   (`any_of` → `anyOf`, etc.; collisions follow python-genai
   `pop(from)`/`set(to)` semantics — snake_case wins).
2. Applies the `handle_null_fields` collapse for nullable unions before
   recursing into children.
3. Strips keys the target provider does not support, optionally lifting
   human-meaningful keys (`pattern`, `format`, min/max, `default`,
   `examples`, ...) into the sibling `description` via the spill formatter
   (`spill.ts`). Structural/meta keys (`$ref`, `$defs`,
   `additionalProperties`) are not spilled.
4. Normalizes type unions (`type: ["T", "null"]` → `type: "T"` + nullable
   marker on Google, plain `type: "T"` on CCA).
5. Collapses object-only / same-type combiners, optionally lossy-collapses
   mixed-type combiners (CCA only), and runs the residual-combiner fixpoint.
6. Validates with the in-house structural validator (`isValidJsonSchema`
   from `meta-validator.ts`) when `validateAndFallback` is set (CCA path)
   and emits the per-tool fallback `{ "type": "object", "properties": {} }`
   on residual incompatibility — `type` array, `type: "null"`, `nullable`
   key, or any remaining `anyOf`/`oneOf`/`allOf`.

## OpenAI strict-mode pipeline

`adaptSchemaForStrict(schema, strict)` runs `tryEnforceStrictSchema`,
which composes:

1. **Sanitize** (`sanitizeSchemaForStrictMode`): strips non-structural
   keywords (`format`, `pattern`, min/max, `examples`, `default`,
   `if`/`then`/`else`, `not`, `unevaluated*`, `patternProperties`,
   `dependent*`, `content*`, `min/maxProperties`, `$dynamicRef`, etc.). The
   `default` value is inlined into the sibling `description` as
   ` (default: X)` before being dropped, unless `description` already
   contains `(default:` or no `description` exists.
2. **Enforce** (`enforceStrictSchema`): every object node gets
   `additionalProperties: false`, every property goes into `required`, and
   optional properties become nullable unions
   (`anyOf: [<original>, { "type": "null" }]`). Tuple `prefixItems` are
   strictified recursively.

The two passes use cache/cycle guards, so refs, `allOf`, and nullable wrapping
stay deterministic without recursing forever. `tryEnforceStrictSchema` is
fail-open: if anything throws, it returns `{ strict: false, schema: upgraded }`
so callers MUST emit `strict: true` only when enforcement actually succeeded.

### Edge cases the strict-mode normalizer handles

- **Local `$ref` inlining.** OpenAI strict mode rejects
  `{ "$ref": "...", "description": "..." }` with sibling keys. The
  sanitizer pre-resolves local `#/...` refs against the root and merges
  with **sibling keys winning** over the resolved def — same precedence
  as `openai-python`'s `_ensure_strict_json_schema`. Recursive refs are
  guarded by the per-walk epoch.
- **Single-item `allOf`.** A `{ "allOf": [X], ...siblings }` collapses to
  `{ ...X, ...siblings }` with the inlined entry's keys winning over the
  original siblings (matches `openai-python`'s `_pydantic.py:79-83`). Multi-
  item `allOf` is left intact for the downstream validator to reject if
  needed.
- **Type-array branches and nullable unions.** When a node has
  `type: ["T", "U"]`, the sanitizer emits one variant schema per type,
  pruning type-specific keywords (e.g. `properties`/`required` only stay on
  the `object` variant, `items` only on the `array` variant). The shared
  `description` is **hoisted onto the `anyOf` wrapper** instead of being
  duplicated on every branch — so a strict nullable union becomes
  `{ anyOf: [T, { type: "null" }], description: "..." }`, not
  `anyOf: [{ ..., description }, { ..., description }]`.
- **Enum/const without a `type`.** Both sanitize and enforce paths call
  `inferStrictPrimitiveTypeFromEnumOrConst` to infer the primitive `type`
  from `enum` / `const` values. Mixed-primitive enums (`[1, "two", null]`),
  enums containing objects/arrays, and non-primitive `const` values
  (`{a:1}`, `[1,2,3]`) cannot be described by a single `type` keyword and
  trigger the strict-mode fail-open path — emitting a typeless schema
  would just be rejected on the wire by OpenAI.

## Performance: static fingerprint cache

`resolveProviderModels` in `packages/catalog/src/model-manager.ts` and
`readModelCache`/`writeModelCache` in `packages/catalog/src/model-cache.ts`
cooperate via a `static_fingerprint` column on the `model_cache` SQLite
table (current cache schema version 6).

- `fingerprintStatic(staticModels)` hashes the static catalog slice
  (`Bun.hash(JSON.stringify(models))` in base36) and memoizes the result
  by tagging the array with a symbol property. Multiple cold-start arms
  calling `resolveProviderModels` with the same `staticModels` array pay
  the JSON+hash cost once.
- On cache read, if the network fetch is being skipped, the cached row is
  fresh + authoritative, and the cached `static_fingerprint` matches the
  current one, `resolveProviderModels` returns the cached models verbatim
  — the cache already incorporates the same static state, so re-running
  `mergeDynamicModels(static, cache)` would just rebuild the same objects.
- `mergeModelSources` and `mergeDynamicModels` short-circuit on
  empty-source inputs (the common shape after `(static, [])` or for
  providers without a static catalog), avoiding Map churn entirely.

Cache rows written before the current schema version are dropped by the
cache-version check; the column defaults to `''` for any row that survives
a version upgrade so the fingerprint-equality check naturally fails closed
and the full merge re-runs.

## Related

- `docs/models.md` — registry, equivalence, compat flags
  (`supportsStrictMode`, `toolStrictMode`, `disableStrictTools`).
- `docs/provider-streaming-internals.md` — how the normalized schemas are
  used downstream during the provider stream loop.
- `docs/mcp-server-tool-authoring.md` — MCP `inputSchema` ingestion via
  `normalizeSchemaForMCP`.
- `packages/ai/src/utils/schema/CONSTRAINTS.md` — operational contract for
  every normalization rule.

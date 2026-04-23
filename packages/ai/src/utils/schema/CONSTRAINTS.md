# Schema Constraints

This document is the operational contract for schema normalization/strictness in `packages/ai/src/utils/schema`.

## Scope

- Applies to provider-facing tool schemas produced by:
  - `sanitize-google.ts`
  - `normalize-cca.ts`
  - `strict-mode.ts`
  - `adapt.ts`
  - `fields.ts`
- Covers OpenAI-style strict mode, Google schema constraints, and Cloud Code Assist Claude constraints.

---

## 1) OpenAI-style strict mode (`adaptSchemaForStrict` / `tryEnforceStrictSchema`)

When strict mode is requested (`strict=true` at call site), the schema MUST satisfy all of the following after adaptation:

1. **Non-structural keywords are removed before strict enforcement**
   - Sanitization uses `sanitizeSchemaForStrictMode`.
   - Removed keys include formatting/validation/decorative keywords and unsupported structural extras:
     - `format`, `pattern`, `minLength`, `maxLength`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`
     - `minItems`, `maxItems`, `uniqueItems`, `multipleOf`
     - `$schema`, `examples`, `default`, `title`, `$comment`
     - `if`, `then`, `else`, `not`
     - `prefixItems`, `unevaluatedProperties`, `unevaluatedItems`, `patternProperties`
     - `propertyNames`, `contains`, `minContains`, `maxContains`
     - `dependentRequired`, `dependentSchemas`
     - `contentEncoding`, `contentMediaType`, `contentSchema`
     - `deprecated`, `readOnly`, `writeOnly`
     - `minProperties`, `maxProperties`
     - `$dynamicRef`, `$dynamicAnchor`
   - Before stripping `default`, its value is inlined into the sibling `description` as ` (default: X)` so that strict-mode providers retain the default hint in free-form text. Inlining is skipped when `description` already contains `(default:` or when no sibling `description` is present.

2. **`const` is normalized to `enum`**
   - If a node contains `const`, strict sanitization converts it to `enum: [const]`.

3. **Object strictness is enforced recursively**
   - Every object node gets `additionalProperties: false`.
   - Every property key is included in `required`.
   - Optional properties are wrapped as nullable unions:
     - `anyOf: [<original schema>, { "type": "null" }]`.

4. **Schema nodes must be representable in strict mode**
   - Nodes without `type`, combinator, `$ref`, or `not` are invalid in strict enforcement and MUST throw.
   - Example invalid node: `{}` or `{ items: {} }`.

5. **Failure mode is fail-open to non-strict**
   - `tryEnforceStrictSchema` MUST return `{ strict: false, schema: original }` when strict enforcement throws.
   - It MUST NOT emit partially-broken strict schema.

6. **Provider payload strict flag must match effective strictness**
   - Callers MUST send `strict: true` only if enforcement succeeded (`effectiveStrict === true`).

---

## 2) Google Gemini / Vertex / Gemini CLI (`sanitizeSchemaForGoogle`)

Schemas sent on Google JSON Schema path MUST follow:

1. **Unsupported JSON Schema keywords are stripped (except property names under `properties`)**
   - Unsupported keys (`UNSUPPORTED_SCHEMA_FIELDS`):
     - `$schema`, `$ref`, `$defs`, `$dynamicRef`, `$dynamicAnchor`
     - `examples`, `prefixItems`, `unevaluatedProperties`, `unevaluatedItems`
     - `patternProperties`, `additionalProperties`
     - `minItems`, `maxItems`, `minLength`, `maxLength`
     - `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`
     - `pattern`, `format`
   - Important: keys inside a `properties` object are treated as property names and MUST NOT be stripped by keyword match.

2. **`type` arrays are normalized to scalar type + nullable marker**
   - `type: ["T", "null"]` becomes `type: "T"` and `nullable: true`.
   - Google expects scalar type, not `type[]`.

3. **`const` is converted to `enum`**
   - If `const` exists, schema uses/merges `enum` with the const value.

4. **`additionalProperties: false` is removed**
   - This value is stripped during sanitization for Google compatibility.

---

## 3) Claude via Cloud Code Assist (`prepareSchemaForCCA`)

For Cloud Code Assist Claude tool declarations, schema MUST satisfy stricter constraints than generic Google path.

### 3.1 Transport contract

1. **Use legacy `parameters` field** (not `parametersJsonSchema`) for CCA Claude.
2. CCA path uses `sanitizeSchemaForCCA` + normalization pipeline.

### 3.2 Sanitization contract

1. Start with Google sanitizer behavior.
2. **`nullable` keyword MUST be stripped** in CCA Claude path.
3. `type: ["T", "null"]` becomes `type: "T"` with no `nullable` marker.

### 3.3 Combiner/union normalization contract

1. Object-only `anyOf`/`oneOf` variants SHOULD be merged into a single object shape where safe.
2. Same-type combiner variants SHOULD be collapsed to one schema.
3. Mixed-type combiner variants MAY be lossy-collapsed to first non-null scalar type when required for CCA acceptance.
4. Residual combiners are recursively stripped where collapsible (`stripResidualCombiners`).

### 3.4 Nullable property normalization contract

1. Property-local nullability expressed as:
   - `nullable: true`, or
   - `type` union including `null`, or
   - `anyOf`/`oneOf` with one `{ "type": "null" }` branch
     MUST be converted to non-required property semantics where possible.
2. If a property is detected nullable after normalization, it MUST be removed from `required`.

### 3.5 Residual incompatibility gate (hard stop)

After normalization, schema MUST NOT contain any of:

- `type` as array
- `type: "null"`
- `nullable` key
- `anyOf`, `oneOf`, `allOf` arrays

If any remain, schema is incompatible.

### 3.6 Validation + fallback contract

1. Normalized schema is validated with AJV 2020 schema validation.
2. If invalid OR residual incompatibilities exist, output MUST fallback to:

```json
{ "type": "object", "properties": {} }
```

3. Fallback is per-tool and fail-open; one bad tool schema MUST NOT fail the whole request.

---

## 4) Practical provider mapping

- **OpenAI-compatible strict paths** (`openai-completions`, `openai-responses`, `openai-codex-responses`):
  - Use `adaptSchemaForStrict`.
  - Emit `strict: true` only when effective strict enforcement succeeded.

- **Google Gemini/Vertex/Gemini CLI (non-CCA Claude)**:
  - Use Google sanitizer and send schema on `parametersJsonSchema` path.

- **Cloud Code Assist Claude models (`model.id` starts with `claude-`)**:
  - Use CCA preparation pipeline and send sanitized normalized schema in `parameters`.

---

## 5) Maintenance rules

When adding/changing provider adapters:

1. Any new unsupported keyword MUST be added to the appropriate set in `fields.ts`.
2. Any new normalization rule MUST include regression tests under `packages/ai/test`.
3. Never bypass adapter helpers (`adaptSchemaForStrict`, `sanitizeSchemaForGoogle`, `prepareSchemaForCCA`) in provider code.
4. If a provider rejects schema with partial support, prefer deterministic per-tool fallback over request-wide failure.

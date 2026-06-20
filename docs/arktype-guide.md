# ArkType Guide (for migrating Zod → ArkType in this repo)

Pinned to **arktype 2.2.0** (installed). Verified against the installed `.d.ts` and runtime this
session. Author types with `import { type } from "arktype"`.

> **Scope rule (READ FIRST).** Zod stays supported at the **external boundary** — `Tool.parameters`
> accepts Zod *or* ArkType *or* JSON Schema, and the public `pi.zod` extension API + the Zod-backed
> `typebox` shim are untouched. Migrate **internal** schemas to ArkType. If a file genuinely cannot be
> expressed cleanly in ArkType (see "Resilient parsing" below) and it parses an external/untrusted
> payload, it MAY stay on Zod — say so in your report rather than shipping broken ArkType.

## The detection contract (don't break it)
`packages/ai/src/utils/schema/wire.ts` distinguishes the three schema kinds:
- **ArkType** = a *callable function* with `.toJsonSchema` and `.assert` methods (`isArkSchema`).
- **Zod** = a non-callable object carrying `_zod` + `.parse` (`isZodSchema`).
- **JSON Schema** = a plain object.

So an ArkType `Type` is a function. NEVER detect it via `$`/`_arktype`/`__arktype` markers — those
don't exist. `isArkSchema`, `arkToWireSchema`, `isZodSchema`, `zodToWireSchema` all remain exported.

## Core translation table (Zod → ArkType)
| Zod | ArkType |
|---|---|
| `z.object({ a: ... })` | `type({ a: ... })` |
| `z.string()` / `z.number()` / `z.boolean()` | `"string"` / `"number"` / `"boolean"` |
| `z.number().int()` | `"number.integer"` |
| `z.literal("x")` | `"'x'"` ; `z.literal(5)` → `"5"` |
| `z.enum(["a","b"])` (static) | `"'a' | 'b'"` |
| `z.enum(RUNTIME_ARRAY)` (dynamic) | `type.enumerated(...RUNTIME_ARRAY)` — NOT `type(arr.join("|"))` |
| `z.array(z.string())` | `"string[]"` |
| `z.array(Item)` (Item is a `type`) | `Item.array()` |
| `z.union([A,B])` | `A.or(B)` or `"a | b"` |
| `z.record(z.string(), z.number())` | `type({ "[string]": "number" })` — use the real value type, NOT `"unknown"` unless it was `z.unknown()` |
| `z.unknown()` / `z.any()` | `"unknown"` |
| `z.null()` | `"null"` |
| `z.nullable(X)` | `X.or("null")` or `"X | null"` |
| field `.optional()` | optional **key**: `{ "a?": "string" }` (NOT a value method) |
| string length `.min(n)`/`.max(n)` | `"string >= n"` / `"string <= n"` / `"1 <= string <= 10"` |
| number `.min/.max/.gt/.lt` | `"number >= n"` / `"number > n"` / `"1 <= number <= 10"` |
| dynamic bound (runtime var) | chain methods: `type("string").atLeastLength(1).atMostLength(MAX)` — NOT a template string |
| `.describe("d")` | `.describe("d")` (emits JSON Schema `description`) |
| `.strict()` (reject extras) | add key `"+": "reject"`: `type({ "+": "reject", ... })` |
| `.strip()` (drop extras — Zod default) | add key `"+": "delete"` |
| `.passthrough()` / `.loose()` | drop it (ArkType keeps undeclared keys by default) |
| `.refine(fn, msg)` | `.narrow((d, ctx) => fn(d) || ctx.mustBe("<expectation>"))` |
| `z.infer<typeof S>` | `typeof S.infer` |
| `z.input<typeof S>` | `typeof S.inferIn` |

## FOOTGUNS (these caused real breakage — avoid them)
1. **Never put `.default()` on an optional `?` key.** `z.X.default(v).optional()` in Zod is
   **output-optional** (default applied in code via `?? `) → translate to an **optional key, no
   default**: `"limit?": "number"`. Only `z.X.default(v)` *without* `.optional()` (output-required)
   becomes `field: type("number").default(v)` (key has NO `?`).
2. **`.default()` only works as an object-property value.** `type("number = 0")` standalone throws —
   use it inline (`type({ count: "number = 0" })`) or `.default()` on a non-optional key.
3. **A described literal union emits `anyOf` of `const`, not `enum`.** That is correct and validates
   identically; assert semantic wire properties (`description`, required, `additionalProperties`), not
   the exact `enum` vs `anyOf` shape.
4. **`type()` needs a statically-known definition.** A runtime-built string (`type(arr.join("|"))`,
   `type(\`1 <= string <= ${MAX}\`)`) fails TS. Use `type.enumerated(...)` / chain methods instead.
5. **Integer ranges:** `"1 <= number.integer <= 3600"` (NOT `"number.integer >= 1 <= 3600"`).
6. **`$schema` is emitted by `toJsonSchema()`** — strip it for wire parity (`delete raw.$schema`).

## Validating with a schema (replacing `.parse` / `.safeParse`)
ArkType `Type` is **invoked** to validate; failure returns an `ArkErrors` instance:
```ts
import { type } from "arktype";
const out = schema(value);
if (out instanceof type.errors) {
  // out.summary -> human message; out.map(e => `${e.path}: ${e.message}`)
  throw new Error(out.summary);
}
// else `out` is the validated/morphed value
```
- `.parse(x)` → `const out = schema(x); if (out instanceof type.errors) throw new Error(out.summary); use out;`
- `.safeParse(x).success` → `!(schema(x) instanceof type.errors)`
- NEVER use `.allows()` for tool validation — it skips morphs/defaults/narrows.
- `.infer` (output) and `.inferIn` (input) are inference-only properties (no runtime value).

## Advanced

### Scopes (reusable aliases / mutually-referential schemas)
Replace a cluster of cross-referencing Zod schemas with a scope, then `.export()` to a module:
```ts
import { scope } from "arktype";
const myScope = scope({
  inner: { id: "string" },
  outer: { inner: "inner", tags: "string[]" },
});
const m = myScope.export();        // Module — m.outer, m.inner are Type instances
```
Use `.export()` — NOT `.compile()` (that method does not exist on a Scope).

### Morphs / transforms (replacing `.transform()`)
```ts
const n = type("string").pipe(s => Number.parseInt(s));   // validate then transform
const o = type("string").to("number.integer");            // .to(def) == .pipe(type(def))
```

### narrow (cross-field / post-validation predicate, replacing `.refine`)
`narrow` runs AFTER all validators/morphs (output side). `ctx.mustBe("<expectation>")` returns `false`
and records `must be <expectation>`:
```ts
type({ action: "string", "body?": "string" })
  .narrow((p, ctx) => p.action === "delete" || p.body !== undefined || ctx.mustBe("a body unless deleting"));
```

### Resilient parsing (replacing Zod `.catch(fallback)`)
ArkType has **no built-in `.catch()`**. For "parse, else fallback", wrap the unsafe work in a morph:
```ts
const resilient = type("unknown").pipe(raw => {
  const out = innerSchema(raw);
  return out instanceof type.errors ? FALLBACK : out;   // never throws
});
```
For "missing → default", use the `=` default syntax (`"number = 5"`). If a parser relies heavily on
per-field `.catch()` over an untrusted external payload and the morph rewrite gets unwieldy, that file
is a candidate to **stay on Zod** (external-boundary exception) — note it in your report.

### Defaults recap
- `type({ count: "number = 0", flag: "boolean = false" })` — inline, output-required, wire `default`.
- `type({ x: type("number").describe("d").default(0) })` — `.default()` on a NON-optional key when you
  also need `.describe()`.

## When you finish a file
- Replace `import { z } from "zod/v4"` with `import { type } from "arktype"` (keep `z` only if still used).
- Preserve every `.describe()` string and field optionality EXACTLY.
- Convert every `.parse`/`.safeParse` call site in the file.
- Do NOT run build/test/lint/format — the orchestrator runs gates once at the end.
- Report: files changed, any `.strict`→`"+"`, `.refine`→`.narrow`, `.catch`→morph, and any file you
  intentionally left on Zod (with the reason).

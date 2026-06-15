# pi-native tool-call format

The **pi-native** format is the tool-call serialization used by the omp / pi coding agent. Unlike the JSON-in-a-tag conventions (Hermes/Qwen, Harmony) and unlike the fully separate JSON content-block channel (Anthropic Messages API), pi-native serializes each call as an **XML-flavored block** whose tag carries the tool name — `<call:NAME>…</call:NAME>` — and whose arguments are child elements named after the parameters. It is **schema-driven**: the tool's JSON Schema decides how each value is typed (string vs number vs object vs array) and which compact spellings are legal.

This document is a **specification** of the format (it is the contract a renderer must emit and a parser must accept), not a reverse-engineering of trained model weights. It is designed around four goals:

- **Token economy** — the common cases (a single scalar argument; a single string payload) collapse to one short line.
- **Verbatim payloads** — a large multi-line string argument (a patch body, a file's contents, a shell script) is carried **raw**, with no JSON string-escaping and no entity-encoding, terminated by the call's own unique closing tag.
- **Human legibility** — a call reads like the function it denotes; nesting maps to nesting.
- **Lenient parsing** — the tags are plain text matched by a tolerant parser (regex / streaming state machine), not a strict XML parser; output is *not* required to be well-formed XML.

Scope: pi-native specifies only the **tool-call (and argument) serialization**. It is **envelope-agnostic** — the `<call:…>` blocks are emitted as ordinary assistant text and embed unchanged in any conversation envelope (ChatML, Harmony, the Anthropic two-role shape, …). Reasoning channels, role markers, and result delivery are the host envelope's concern; the one envelope-level requirement pi-native imposes is in [Tool-result correlation](#tool-result-correlation).

Lineage: the attribute spelling (`<call:read path="…"/>`) follows Anthropic's modern attribute XML (`<invoke name="…">` / `<parameter name="…">`); the schema-driven **unquoted** value rule (a bare string value carries no quotes; non-strings are JSON) follows GLM-4.5's `<arg_value>` convention. pi-native folds both into one recursive, name-on-the-tag grammar and adds the verbatim **inline body** for bulk string arguments. See [`anthropic.md`](./anthropic.md) and [`glm-4.5.md`](./glm-4.5.md) in this folder.

## Structural tags

pi-native has **no special tokens**. Every marker is plain UTF-8 text that BPE-splits like any other text and survives detokenization unchanged; a parser matches the tags as literal substrings (and MUST work even when the surrounding stream is not valid XML). All brackets are ASCII `<` `>` `/` and the literal colon `:`. There are no namespaces, no `<?xml?>` prolog, no entity expansion, and no CDATA sections.

| Tag (verbatim) | Role |
|---|---|
| `<call:NAME …>` … `</call:NAME>` | One tool call. `NAME` is the tool/recipient name; it is repeated on the closing tag. |
| `<call:NAME …/>` | Self-closing tool call (all arguments supplied as attributes). |
| `<KEY>` … `</KEY>` | One argument (or one nested field). `KEY` is the parameter name. |
| `<KEY …/>` | Self-closing argument: an object-valued field whose scalar sub-fields are attributes, or an empty value. |
| `KEY="…"` / `KEY='…'` / `KEY=…` | An attribute: a scalar field given inline on a tag. Quotes are **delimiters, not type markers** (see [value coercion](#value-coercion)). |

Names (tool names and parameter names) match `^[A-Za-z_][A-Za-z0-9_-]*$`. The `call:` prefix is a literal four-character marker plus the colon; the colon is what distinguishes a call block from a nested argument element of the same name.

## Tool-call forms

A single call has three interchangeable surface forms. Which forms are legal for a given tool is decided by its parameter schema; a renderer SHOULD pick the most compact legal form, and a parser MUST accept all three.

### 1. Element form (canonical, fully general)

Each top-level argument is a child element named after the parameter; the element body is the value. This form expresses every schema — scalars, strings, arrays, and nested objects:

```text
<call:read>
<path>src/server/auth.ts</path>
<offset>50</offset>
</call:read>
```

→ `read({ "path": "src/server/auth.ts", "offset": 50 })` (`offset` is JSON because the schema types it as a number; `path` is a verbatim string).

### 2. Attribute form (compact scalars)

When the arguments being passed are **top-level scalars** (string, number, integer, boolean, null), they MAY be written as attributes on the call tag. With every argument as an attribute the tag is self-closing:

```text
<call:read path="src/server/auth.ts"/>
```

→ `read({ "path": "src/server/auth.ts" })`.

Attributes and child elements MAY be combined on a non-self-closing call tag — attributes carry the scalars, child elements carry anything structured:

```text
<call:read path="src/server/auth.ts">
<offset>50</offset>
</call:read>
```

An attribute whose value cannot be represented as a scalar (an object or array argument) MUST use the element form instead — there is no attribute spelling for structured values on a call tag.

### 3. Inline-body form (verbatim string payload)

When the tool's parameters are **all strings** — most often a single string parameter — the call body MAY be the argument value written **verbatim**, with no child element tags:

```text
<call:edit>
*** Begin Patch
@@ src/server/auth.ts
-  return user;
+  return user ?? null;
*** End Patch
</call:edit>
```

→ `edit({ "input": "*** Begin Patch\n@@ src/server/auth.ts\n-  return user;\n+  return user ?? null;\n*** End Patch" })`.

Rules for the inline body:

- The body fills the **first parameter not already supplied by an attribute**. With no attributes that is simply the first parameter (the "first argument verbatim").
- It is permitted only when that target parameter is **string**-typed (the enabling condition "the type only contains string arguments"); any *other* parameters set on the same call MUST be scalars given as attributes.
- The value is captured **verbatim** up to the call's own closing tag `</call:NAME>`. No JSON escaping, no entity decoding. The body MAY freely contain `<`, `>`, `&`, quotes, JSON, even other `<call:…>`-looking text — the only sequence it MUST NOT contain is the literal closer `</call:NAME>`. Because that closer carries the tool name, collisions are far rarer than with a short generic delimiter.
- Whitespace: a single newline immediately after the opening `>` and a single newline immediately before the closing `</` are treated as block delimiters and are **not** part of the value; all other whitespace (indentation, blank lines, trailing spaces) is preserved exactly.

A multi-string tool can still use the inline body for its bulk argument by passing the others as attributes — the body then fills the first parameter left unset:

```text
<call:write path="notes/todo.md">
# TODO
- ship pi-native parser
</call:write>
```

→ `write({ "path": "notes/todo.md", "content": "# TODO\n- ship pi-native parser" })` (here `path` is given by attribute, so the body fills the next string parameter, `content`).

Inline-eligible tools may always fall back to the element form; `<call:edit><input>…</input></call:edit>` and the inline `<call:edit>…</call:edit>` are equivalent.

## Value model

The body of a call (and of any nested element) maps to JSON by a single recursive rule set. **Typing is driven by the parameter's JSON Schema**; the parser only falls back to syntactic heuristics when no schema is available.

### Value coercion

Let `coerce(text, type)` produce the JSON value for a captured scalar `text`:

- `type == "string"` → the value is `text`, **verbatim** (never JSON-parsed, never unquoted). This is why `<path>4</path>` for a string parameter is the string `"4"`, and a Windows path `C:\new\tab` survives intact.
- `type` is a non-string scalar (`number` / `integer` / `boolean` / `null`) → `JSON.parse(text)` (so `<offset>50</offset>` → `50`, `<recursive>true</recursive>` → `true`).
- `type` unknown (no schema) → **best-effort JSON coercion**: try `JSON.parse(text)`; on success use the parsed value (number, boolean, null, quoted-string, object, or array); on failure treat `text` as a literal string. So a bare `4` becomes the number `4`, `foo.ts` (not valid JSON) becomes `"foo.ts"`.

The same `coerce` applies to **attribute values** after the surrounding quotes (if any) are stripped — the quotes are XML delimiters only. Hence both spellings below are identical, and both yield the **number** `4` (not the string `"4"`) when `y` is untyped/numeric:

```text
<object y=4/>     →  { "object": { "y": 4 } }
<object y="4"/>   →  { "object": { "y": 4 } }
```

Consequence to internalize: under loose/no schema, quoting does **not** force a string — `"4"` still coerces to `4`. To carry a numeric-looking value *as a string*, the parameter MUST be `string`-typed in the schema (then the verbatim rule keeps `"4"` → `"4"`). Unquoted attribute values run until whitespace or the closing `>` / `/>`; spaces around `=` are tolerated; a bare attribute with no `=value` (e.g. `<call:tool dry_run/>`) denotes boolean `true`.

### Scalars and strings

A scalar argument is one element (or one attribute). String values are unquoted and verbatim; non-string scalars are JSON literals:

```text
<call:bash command="ls -la" timeout=30/>
```

→ `bash({ "command": "ls -la", "timeout": 30 })`.

### Arrays — repeat the element

An array-typed field is expressed by **repeating** its element; each occurrence contributes one item, in order:

```text
<list>x</list>
<list>y</list>
```

→ `"list": ["x", "y"]`.

A field the schema types as an **array always yields an array, even for a single occurrence** — so one `<list>x</list>` under an array-typed `list` is `["x"]`, not `"x"`. When no schema is available the parser falls back to a count heuristic: a name appearing **2+ times among its siblings** is an array; a name appearing **once** is a scalar (so schema typing is the only way to express a one-element array with the heuristic alone). Item values coerce by the array's item type (`<ports>80</ports><ports>443</ports>` → `[80, 443]` for a `number[]`); arrays of objects repeat a nested block (see below). There is no attribute spelling for an array (attributes cannot repeat) — arrays require element form.

### Objects — a nested block

An object-typed field opens its own block and follows the **same rules recursively**: its child elements become its properties, repeated children become arrays, and nested object children open further blocks.

```text
<object>
<list>x</list>
</object>
```

→ `"object": { "list": ["x"] }` (with `object` typed object and `list` typed array).

An object's **scalar** sub-fields MAY instead be written as attributes — `<object y=4/>` is shorthand for `<object><y>4</y></object>`. Attributes and child elements may be combined on the same object element (attributes for scalars, children for structured sub-fields). An empty object is `<object/>` or `<object></object>` → `{}`.

### Recursion

The call body, an object element's body, and an array item's body are all parsed by the identical procedure. Parsing element `E` (tag = field name `F`, schema type `T`):

1. Gather `E`'s attributes → scalar properties via `coerce`.
2. Determine `E`'s body shape from `T` (or, with no schema, from whether the body's first non-whitespace content is a child tag):
   - `T` object → properties from child elements (+ the attributes from step 1).
   - `T` array (item type `Ti`) → collect **all** siblings named `F`; each occurrence is one item parsed as `Ti`.
   - `T` scalar/string → the body is captured text; value = `coerce(text, T)`.
3. The call itself is element `E` with no enclosing key: its attributes + child elements **are** the arguments object directly (the tool name on `<call:NAME>` is the recipient, not a key).

## Multiple / parallel tool calls

There is no wrapper element around a set of calls. Parallel calls are simply **consecutive `<call:…>` blocks** in one assistant turn (separated by whitespace/newlines; interleaved prose is allowed and is ordinary content):

```text
<call:read path="src/a.ts"/>
<call:read path="src/b.ts"/>
```

A parser returns these as `tool_calls[0]`, `tool_calls[1]`, … in emission order. The host executes them and returns one result per call, in the same order (see correlation, next).

## Tool definitions and schema dependence

pi-native does not prescribe how tools are advertised; a host typically lists them as JSON Schema, exactly as the OpenAI / Anthropic / Hermes families do. What pi-native **requires** is that the parser have access to each tool's parameter schema, because the schema is what disambiguates:

- string (verbatim, unquoted) vs other scalar (JSON) values;
- a one-element array vs a scalar (a single `<list>…</list>`);
- which body shape (text vs nested members) a non-self-closing element carries;
- whether the inline-body form is legal (first unset parameter is a string).

Without a schema the parser MUST degrade gracefully to the syntactic fallbacks named above (JSON-coerce scalars; repetition-counts for arrays; child-tag presence for object bodies). The fallbacks are lossy at exactly the ambiguous points the schema would resolve, so production hosts SHOULD always supply the schema.

## Tool-result correlation

pi-native calls carry **no per-call wire id** (like GLM and Qwen, unlike Anthropic's `toolu_…`). Results are therefore correlated to calls **positionally, by emission order**: the host delivers tool outputs in the same order the `<call:…>` blocks appeared, using whatever its envelope provides for tool output (a `tool`/`user` turn, a Harmony tool message, an Anthropic `tool_result` block, …). When a transport requires an id (e.g. an OpenAI-compatible bridge), the host synthesizes one and maintains the call↔result mapping itself; the id never appears in the pi-native text.

## End-to-end example

A short agent turn exercising all three forms plus nesting. Schemas in play: `read(path: string, offset?: number)`, `bash(command: string, timeout?: number)`, `edit(input: string)`, and a synthetic `configure(object: { list: string[]; y?: number })`.

```text
I'll inspect the file, run the tests, then apply the fix.

<call:read path="src/server/auth.ts"/>

<call:bash command="bun test src/server/auth.test.ts" timeout=120/>

<call:configure>
<object y=4>
<list>alpha</list>
<list>beta</list>
</object>
</call:configure>

<call:edit>
*** Begin Patch
@@ src/server/auth.ts
-  return user;
+  return user ?? null;
*** End Patch
</call:edit>
```

Parses to four calls, in order:

```json
[
  { "name": "read",      "arguments": { "path": "src/server/auth.ts" } },
  { "name": "bash",      "arguments": { "command": "bun test src/server/auth.test.ts", "timeout": 120 } },
  { "name": "configure", "arguments": { "object": { "y": 4, "list": ["alpha", "beta"] } } },
  { "name": "edit",      "arguments": { "input": "*** Begin Patch\n@@ src/server/auth.ts\n-  return user;\n+  return user ?? null;\n*** End Patch" } }
]
```

Note: `timeout=120` and `y=4` are JSON numbers (numeric/untyped scalars), `path` and the `list` items are verbatim strings (string-typed), `object` opens a nested block whose `y` rides as an attribute while `list` repeats into an array, and the `edit` body is captured verbatim up to `</call:edit>` despite containing `@@`, `-`/`+`, and other non-XML text.

## Grammar (lenient EBNF)

This is the shape a tolerant parser accepts; it is intentionally looser than XML (mismatched-but-recoverable tails are closed heuristically — see gotchas).

```ebnf
stream       ::= ( text | call )*
call         ::= self-call | block-call
self-call    ::= "<call:" Name attr* ws? "/>"
block-call   ::= "<call:" Name attr* ">" call-body "</call:" Name ">"
call-body    ::= members | inline-text          ; inline-text only if first param is string
members      ::= ( ws | element )*
element      ::= self-element | block-element
self-element ::= "<" Name attr* ws? "/>"         ; object via attrs, or empty value
block-element::= "<" Name attr* ">" ( members | scalar-text ) "</" Name ">"
attr         ::= ws Name ( ws? "=" ws? attr-val )?   ; bare Name → boolean true
attr-val     ::= '"' dq-chars '"' | "'" sq-chars "'" | bareword
Name         ::= [A-Za-z_] [A-Za-z0-9_-]*
scalar-text  ::= < any chars up to the matching close tag, verbatim >
inline-text  ::= < any chars up to "</call:" Name ">", verbatim >
```

## Parsing notes & gotchas

- **Schema decides string-vs-JSON.** A `string`-typed value is verbatim and unquoted; everything else is JSON. With no schema, scalars best-effort JSON-coerce and fall back to string. This is the single most error-prone rule (identical to GLM-4.5's unquoted strings): emitting `"San Francisco"` for a string parameter yields the literal value *including the quote characters*.
- **Quotes are delimiters, not types.** `y="4"` and `y=4` both coerce to the number `4` under loose/no schema. Quoting an attribute never makes it a string; only a `string` schema type does.
- **Arrays = repetition; single-element arrays need the schema.** Two same-named siblings is unambiguously an array. One occurrence is a scalar under the count heuristic and an array only because the schema says so — a parser without the schema cannot tell `<list>x</list>` (scalar) from a one-element array.
- **Verbatim bodies are delimited by the named closer.** The inline body and any `string`-typed element body are captured up to their matching `</call:NAME>` / `</KEY>`. A body that contains that exact closing sequence truncates early; there is no escaping mechanism. The inline body's risk is minimal because the delimiter includes the tool name (`</call:edit>`), but a short string-typed *element* (e.g. `<note>…</note>`) is more exposed — prefer the inline-body form for any value that might contain markup, or keep such values in the single-string inline payload.
- **Element form vs inline body.** A block call whose body's first non-whitespace content is a child tag matching a known parameter is parsed as element form; otherwise (all-string tool) it is the inline body. A string value that legitimately *starts* with a `<param>`-looking token is the one ambiguity — emit such a tool in element form, or rely on the schema (a tool with structured params is never inline-eligible).
- **No ids; order is the contract.** Calls carry no id; results MUST be returned in call order. Reordering results silently misattributes them.
- **Lenient, not strict XML.** Do not feed pi-native to an XML parser: tag names contain a colon (`call:read`), attribute values may be unquoted, bodies are not entity-encoded, and the stream need not be balanced beyond each call's own open/close. Match the tags as literals (regex / streaming state machine).
- **Streaming.** A stateful parser emits the tool name as soon as `<call:NAME` closes, then streams attribute/child deltas; for an inline body it streams body text incrementally and holds back any partial trailing `</call:` until it can decide whether it is the closer. Coercion of a scalar can only finalize at the value's close tag (a partial number/boolean is not yet valid JSON).
- **Whitespace.** Element/inline bodies preserve all whitespace except one leading and one trailing newline that delimit the block. Attribute and indentation whitespace between tags is insignificant.

## Sources

pi-native is specified here; it is not derived from a published model template. Its two direct influences are documented in this folder:

- Anthropic attribute XML (`<invoke name="…">` / `<parameter name="…">`, "parsed with regular expressions", not required to be valid XML): [`anthropic.md`](./anthropic.md).
- GLM-4.5 schema-driven, **unquoted** string values vs JSON non-strings, and positional (id-less) call↔result correlation: [`glm-4.5.md`](./glm-4.5.md).

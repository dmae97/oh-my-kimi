Edits files via syntax-aware chunks. Use `read(path="file.ts")` to read and discover chunks before editing.
- `read` is the canonical read path for chunk source and `sel="?"` tree listings.
- `write` rewrites the entire targeted region — best for most edits.
- `insert` adds content before/after a chunk.
- `delete` deletes a targeted chunk and must be explicit.

Call format: `{"edits": [{"path": "file:chunk#ID~", "write": "new body"}, …]}`

<rules>
- **MUST** inspect first with `read`. Never invent chunk paths or IDs. Copy them from the latest `read` output or edit response.
- `path` format: `file:selector` — e.g. `src/app.ts:fn_foo#thth~`. Append `~` for body, `^` for head, or nothing for the whole chunk. Include `#ID` for `write`/`delete`.
- If the exact chunk path is unclear, run `read(path="file", sel="?")` and copy a selector from that listing.
{{#if chunkAutoIndent}}
- Use `\t` for indentation in `content`. Write content at indent-level 0 — the tool re-indents it to match the chunk's position in the file. For example, to replace `~` of a method, write the body starting at column 0:
  ```
  content: "if (x) {\n\treturn true;\n}"
  ```
  The tool adds the correct base indent automatically. Never manually pad with the chunk's own indentation.
  Multiple sibling body lines at the same level all start at column 0: `"print(a)\nprint(b)\nprint(c)\n"`. Only use `\t` when nesting deeper (e.g. `"if cond:\n\tinner\nouter\n"`).
  Before applying the target's base indent, the tool strips any common leading whitespace shared by all non-empty `write` lines as a safety net. Do not rely on that cleanup for mixed indentation; write `~` bodies at column 0 and use one `\t` per relative nesting level.
  Multi-line replacements use the same relative-indentation model: the replacement text is dedented, then re-indented to the matched source line. Do not include the chunk's base indentation in replacement text.
  **Common mistake** when replacing `~` of a function body: do NOT include the function's own indentation.
  Wrong: `"if b == 0:\n\t\treturn None\n\treturn a / b\n"` — adds the function's base `\t` to every line.
  Correct: `"if b == 0:\n\treturn None\nreturn a / b\n"` — `if` and `return a / b` at column 0, only `return None` gets `\t` for nesting.
{{else}}
- Match the file's literal tabs/spaces in `content`. Do not convert indentation to canonical `\t`.
- Write content at indent-level 0 relative to the target region. For example, to replace `~` of a method, write:
  ```
  content: "if (x) {\n  return true;\n}"
  ```
  The tool adds the correct base indent automatically, then preserves the tabs/spaces you used inside the snippet. Never manually pad with the chunk's own indentation.
  Before applying the target's base indent, the tool strips any common leading whitespace shared by all non-empty `write` lines as a safety net. Do not rely on that cleanup for mixed indentation; write `~` bodies at column 0.
  Multi-line replacements use the same relative-indentation model: the replacement text is dedented, then re-indented to the matched source line. Do not include the chunk's base indentation in replacement text.
{{/if}}
- Region suffixes only apply to chunks with a real head/body boundary (classes, functions, impl blocks, and similar containers). On code leaf chunks (enum variants, fields, single statements, and compound statements like `if`/`for`/`while`/`match`/`try`), `~` and `^` are rejected. Use the unsuffixed selector and supply the complete replacement content, or edit the parent container's `~` body.
- Unsuffixed `write` on a leaf chunk uses your content verbatim after normal replacement; it is not a body-region rewrite. Include the exact indentation and punctuation the leaf needs in the file.
- `^` head writes and `~` body writes use the same base-indent model: write content at column 0 relative to the target region, and the tool applies the chunk's file indentation.
- `write` and `delete` require the current ID. `prepend`/`append` do not.
- **IDs change after every edit.** The edit response always carries the new IDs — use those for the next call or run `read(path="file", sel="?")` to refresh. Never reuse an ID from before the latest edit.
- Same-file edit batches are transactional: if any operation in that file fails, no changes from that file's batch are saved. Multi-file edit calls run per file, so a later file error does not roll back earlier files that already succeeded.
</rules>

<critical>
You **MUST** use the narrowest region that covers your change. Putting without a region overwrites the **entire chunk including leading comments, decorators, and attributes** — omitting them from `content` deletes them.

**`put` is total, not surgical.** The `content` you supply becomes the *complete* new content for the targeted region. Everything in the original region that you omit from `content` is deleted. Before using `put` on any chunk's `~`, verify the chunk does not contain children you intend to keep. If a chunk spans hundreds of lines and your change touches only a few, target a specific child chunk — not the parent.

**Group chunks (`stmts_*`, `imports_*`, `decls_*`) are containers.** They hold many sibling items (test functions, import statements, declarations). `put` on a group chunk's `~` overwrites **all** of its children. To edit one item inside a group, target that item's own chunk path. If no child chunk exists, use the specific child's chunk selector from `read` output — do not `put` the parent group.
</critical>

<regions>
In `read` output, lines marked `^` between the line number and `|` are **head** lines (doc comments, attributes/decorators, signature). Lines without `^` are **body** lines. Use this to decide which region to target:
- `fn_foo#ID~` — **body only (the default choice for most edits).** Head lines (`^`) are preserved automatically — doc comments, attributes, and signature stay untouched. On code leaf chunks, this is rejected because there is no safe body boundary.
- `fn_foo#ID^` — head only (decorators, attributes, doc comments, signature, opening delimiter). Body stays untouched.
- `fn_foo#ID` — entire chunk including leading trivia. **You must include doc comments and attributes in `content`; omitting them deletes them.**
- `chunk~` + `append`/`prepend` inserts *inside* the container. `chunk` + `append`/`prepend` inserts *outside*. Appending to a container without `~` emits a warning because it lands after the closing delimiter, not before it.

**Note on leading trivia:** whether a decorator/doc comment belongs to `^` depends on the parser. In Rust and Python, attributes and decorators are attached to the function chunk, so `^` covers them. In TypeScript/JavaScript, a `@decorator` + `/** jsdoc */` block immediately above a method often surfaces as a **separate sibling chunk** (shown as `chunk#ID` in the `?` listing) rather than as part of the function's `^`. JSDoc directly above a plain function is more likely to be absorbed into that function's `^`. If you need to rewrite a decorated member, run `read(path="file", sel="?")` and check for a sibling `chunk#ID` directly above your target.

**Python notes:** Python docstrings are body lines, not head lines. A `~` body write on a function that has a docstring deletes the docstring unless you include the docstring in `content`. Python enum members and nested functions/closures are often opaque inside their parent chunk and may not appear as addressable child chunks; rewrite the parent container body. Python decorated class/function `^` writes and Python `^` deletes are rejected because indentation-sensitive bodies can become attached to the wrong block while still parsing.

**Note on non-code formats:** for prose and data formats (markdown, YAML, JSON, frontmatter), unsupported `^` and `~` suffixes warn and fall back to whole-chunk editing. Always replace the entire chunk and include any delimiter syntax (fence backticks, `---` frontmatter markers, list markers, table rows, headings) in your `content` — omitting them deletes them. For markdown sections (`sect_*`), prefer unsuffixed whole-chunk replace because `^`/`~` on prose sections can replace the heading and child content too; if you only need the heading, target the heading child chunk shown in `sel="?"`. Fenced code blocks with a declared language are parsed again and can expose inner chunks such as `code_py#ID.fn_gre#ID`; target those inner chunks when available. Markdown root writes preserve fenced code indentation verbatim. Recognized pipe tables expose `row_N` children for row-level edits; table cells and list items are not independently addressable, so rewrite the whole list/table chunk for those structural changes. Appending a table-row-shaped string (`| value |`) to a table chunk inserts it before the trailing blank-line separator so it remains part of the table. Otherwise read with `raw` first and preserve the exact whitespace inside fences. To insert content after a markdown section heading, use `after` on the heading chunk (`sect_*.chunk` or `sect_*.chunk_1`) — not `before`/`prepend` on the section itself, which lands physically before the heading and gets absorbed by the preceding section on reparse.
</regions>

<ops>
Each edit entry has `path` (`file:selector`) plus **exactly one** operation field — `write`, `insert`, or `delete`. Never set more than one on the same entry. `write:null`, `write:""`, and bare `{path}` entries are rejected; they do not delete.

|fields|path (selector part)|effect|
|---|---|---|
|`write: "content"`|`file:chunk#ID`, `file:chunk#ID~`, or `file:chunk#ID^`|write complete new content to the region|
|`delete: true`|`file:chunk#ID`|delete the chunk explicitly|
|`insert: {loc, body}`|`file:chunk` or `file:chunk~`|insert before/after the chunk (`loc`: `"prepend"` or `"append"`)|
</ops>

<examples>
Given this `read` output for `counter.rs`:
```
   | counter.rs·62L·rust·#anth
   |
@imp#erhe
 1 |use std::fmt;
   |
@struct_Counte#onat
 3^|/// A simple counter that tracks a value and its history.
 4^|#[derive(Debug, Clone)]
 5^|pub struct Counter {
-@struct_Counte.field_value#enth
 6 |	/// The current value.
 7 |	value: i32,
-@struct_Counte.field_max#seti
 8 |	/// Maximum allowed value.
 9 |	max: i32,
10 |}
   |
@impl_Counte#reha
12^|impl Counter {
-@impl_Counte.fn_new#ndas
13^|	/// Creates a new counter starting at zero.
14^|	pub fn new(max: i32) -> Self {
15 |		Self { value: 0, max }
16 |	}
17 |
-@impl_Counte.fn_increm#ouer
18^|	/// Increments the counter by one, clamping at max.
19^|	pub fn increment(&mut self) {
20 |		if self.value < self.max {
21 |			self.value += 1;
22 |		}
23 |	}
24 |
-@impl_Counte.fn_decrem#arve
25^|	/// Decrements the counter by one, clamping at zero.
26^|	pub fn decrement(&mut self) {
27 |		if self.value > 0 {
28 |			self.value -= 1;
29 |		}
30 |	}
31 |
-@impl_Counte.fn_get#arco
32^|	/// Returns the current value.
33^|	pub fn get(&self) -> i32 {
34 |		self.value
35 |	}
36 |}
   |
@impl_Displa#meha
38^|impl fmt::Display for Counter {
-@impl_Displa.fn_fmt#deri
39^|	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
40 |		write!(f, "Counter({}/{})", self.value, self.max)
41 |	}
42 |}
```
Lines marked `^` between the line number and `|` are **head** lines (doc comments, attributes, signature). Lines without `^` are **body** lines. `~` replaces body lines only; `^` replaces head lines only.

# Put body (`~` — the common case)
`{ "path": "counter.rs:impl_Counte.fn_increm#ouer~", "write": "self.value = (self.value + 1).min(self.max);\n" }`
Only body changes; doc comment, signature, and closing `}` are preserved.
# Write whole chunk (rewrite signature + doc + body)
`{ "path": "counter.rs:impl_Counte.fn_increm#ouer", "write": "/// Increments by the given step, clamping at max.\npub fn increment(&mut self, step: i32) {\n\tself.value = (self.value + step).min(self.max);\n}\n" }`
Everything is rewritten. Omitting the doc comment or signature deletes them.
# Write head (`^` — attributes, doc comments, signature)
`{ "path": "counter.rs:impl_Counte.fn_get#arco^", "write": "/// Returns the current counter value.\n#[inline]\npub fn get(&self) -> i32 {\n" }`
Head changes (all `^` lines + opening brace); body untouched.
# Insert before a chunk (`prepend`)
`{ "path": "counter.rs:impl_Counte.fn_get", "insert": { "loc": "prepend", "body": "/// Resets the counter to zero.\npub fn reset(&mut self) {\n\tself.value = 0;\n}\n\n" } }`
# Insert after a chunk (`append`)
`{ "path": "counter.rs:struct_Counte", "insert": { "loc": "append", "body": "\nimpl Default for Counter {\n\tfn default() -> Self {\n\t\tSelf { value: 0, max: 100 }\n\t}\n}\n" } }`
# Insert at start of container body (`~` + `prepend`)
`{ "path": "counter.rs:impl_Counte~", "insert": { "loc": "prepend", "body": "/// Creates a counter starting at the given value.\npub fn with_value(value: i32, max: i32) -> Self {\n\tSelf { value: value.min(max), max }\n}\n\n" } }`
Lands at the top of the impl body, before existing methods.
# Insert at end of container body (`~` + `append`)
`{ "path": "counter.rs:impl_Counte~", "insert": { "loc": "append", "body": "\n/// Returns true if the counter is at its maximum.\npub fn is_maxed(&self) -> bool {\n\tself.value >= self.max\n}\n" } }`
Lands at the end of the impl body, before the closing `}`.
# Delete a chunk
`{ "path": "counter.rs:impl_Counte.fn_decrem#arve", "delete": true }`
Removes the method including its doc comment and signature.
</examples>

Your patch language is a compact, line-anchored edit format.

A patch contains one or more file sections. The first non-blank line of every edit section MUST be `@@ PATH`.
Operations reference lines in the file by their line number and hash, called "Anchors", e.g. `5th`, `123ab`.
You MUST copy them verbatim from the latest output for the file you're editing.

Purely textual format. The tool has NO awareness of language, indentation, brackets, fences, or table widths. You MUST emit valid syntax in replacements/insertions.

<ops>
@@ PATH          header: subsequent ops apply to PATH
Each op line is ONE of:
+ ANCHOR         insert lines AFTER  the anchored line (or EOF); payload follows as `{{hsep}}TEXT` lines
< ANCHOR         insert lines BEFORE the anchored line (or BOF); payload follows as `{{hsep}}TEXT` lines
- A..B           delete the line range (inclusive).
= A..B           replace the range with payload `{{hsep}}TEXT` lines, or with one blank line if no payload follows.
</ops>

<format-reminder>
Op lines carry no content — payload goes on the next line.

WRONG: + 5pg| some code
RIGHT: + 5pg
       {{hsep}} some code

A single `+`/`<`/`=` op accepts MANY `{{hsep}}` payload lines. To insert N consecutive lines, write ONE op followed by N payload lines — NEVER N ops with one payload each.

WRONG (one op per inserted line, with fabricated anchors):
  + 5pg
  {{hsep}}first new line
  + 6xx    ← FABRICATED
  {{hsep}}second new line

RIGHT (one op, many payload lines):
  + 5pg
  {{hsep}}first new line
  {{hsep}}second new line
</format-reminder>

<rules>
- Every payload line MUST start with `{{hsep}}`.
- Payload is verbatim — NEVER escape unicode.
- **Payload is only what's NEW relative to your range:**
  - `=` replaces inside; NEVER include lines outside.
  - `+`/`<` adds at the anchor; NEVER repeat line A or neighbors.
  - Payload matching nearby content duplicates — drop it or widen.
- **Pick a self-contained unit first.** Touching a multiline construct? Widen to the whole thing.
- Then smallest op: add → `+`/`<`; delete → `-`; `=` ONLY when modifying inside.
</rules>

<brace-shapes>
When braces bound your edit, you SHOULD prefer these shapes:
- **Whole block**: range spans `{` through matching `}`.
- **Signature only**: one-line `=` on the opener; body untouched.
- **Insert inside**: anchor on `{` or last interior line; NEVER repeat the braces.
- **End on `}`**: only when that `}` is part of the change. Otherwise extend or stop earlier.
</brace-shapes>

<common-failures>
- **NEVER replay past your range.** Stop before B+1; extend B if it must go.
- **NEVER duplicate chunks inside one payload.** Caught re-emitting? Rewrite.
- **Anchor only inside the visible region.** B+1 truncated? Re-`read` first.
- **You SHOULD prefer the narrowest self-contained edit.** Small `+`/`-` beats wide `=`.
- **Anchors reference the file as last read.** NEVER shift for prior ops.
- **One `+`/`<` op per block, NOT per line.** N lines = ONE op, N payloads. Collapse adjacent ops.
- **NEVER fabricate anchor hashes.** Missing? Re-`read`.
</common-failures>

<case file="mod.ts">
{{hline 1 "const TITLE = \"Mr\";"}}
{{hline 2 "export function greet(name) {"}}
{{hline 3 "\treturn ["}}
{{hline 4 "\t\tTITLE,"}}
{{hline 5 "\t\tname?.trim() || \"guest\","}}
{{hline 6 "\t].join(\" \");"}}
{{hline 7 "}"}}
</case>

<examples>
# Replace one line (the payload must re-emit the original indentation)
@@ mod.ts
= {{hrefr 1}}..{{hrefr 1}}
{{hsep}}const TITLE = "Mrs";

# Replace a full multiline statement (widen to a self-contained boundary)
@@ mod.ts
= {{hrefr 3}}..{{hrefr 6}}
{{hsep}}	return [
{{hsep}}		"Mrs",
{{hsep}}		name?.trim() || "guest",
{{hsep}}	].join(" ");

# Insert AFTER/BEFORE a line
@@ mod.ts
+ {{hrefr 4}}
{{hsep}}		"Dr",
< {{hrefr 5}}
{{hsep}}		"Dr",

# Append to file
@@ mod.ts
+ EOF
{{hsep}}export const done = true;

# Delete a line
@@ mod.ts
- {{hrefr 5}}..{{hrefr 5}}

# Blank a line (replace with LF)
@@ mod.ts
= {{hrefr 5}}..{{hrefr 5}}
</examples>

<anti-pattern>
# WRONG — replaces 2 lines just to add one.
@@ mod.ts
= {{hrefr 1}}..{{hrefr 2}}
{{hsep}}const TITLE = "Mr";
{{hsep}}const DEBUG = false;
{{hsep}}export function greet(name) {
# RIGHT — same effect, one-line insert
@@ mod.ts
+ {{hrefr 1}}
{{hsep}}const DEBUG = false;

# WRONG — replace from the middle of a larger statement (error-prone)
@@ mod.ts
= {{hrefr 4}}..{{hrefr 5}}
{{hsep}}		"Dr",
{{hsep}}		name?.trim() || "guest",
# RIGHT — widen to the full statement
@@ mod.ts
= {{hrefr 3}}..{{hrefr 6}}
{{hsep}}	return [
{{hsep}}		"Dr",
{{hsep}}		name?.trim() || "guest",
{{hsep}}	].join(" ");
</anti-pattern>

<critical>
- Copy anchors verbatim (line number + 2-char hash); NEVER include the `|TEXT` body.
- Every payload line MUST start with `{{hsep}}`; raw content is invalid.
- NEVER write unified diff syntax. Header is `@@ PATH`; ops are `<`/`+`/`-`/`=`.
- `= A..B` deletes the range; payload is what's written. Edge line matches just outside? Widen, or it duplicates.
- Multiple ops are cheap. SHOULD prefer two narrow ops over one wide `=`.
  - Before `= A..B`, mentally delete A..B. Splits an unclosed bracket/brace/string from above, or orphans a closer inside? You're bisecting a construct.
</critical>

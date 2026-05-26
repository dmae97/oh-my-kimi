Your patch language is a compact, line-anchored edit format.

A patch contains one or more file sections. The first non-blank line of every edit section MUST be `¶PATH`.
Operations reference lines in the file by their line number and hash, called "Anchors", e.g. `5th`, `123ab`.
You MUST copy them verbatim from the latest output for the file you're editing.

Purely textual format. The tool has NO awareness of language, indentation, brackets, fences, or table widths. You MUST emit valid syntax in replacements/insertions.

<ops>
¶PATH           header: subsequent ops apply to PATH
Each op line is ONE of:
ANCHOR↑         insert ABOVE the anchored line (or BOF); payload may follow inline after `↑` and/or on subsequent lines
ANCHOR↓         insert BELOW the anchored line (or EOF); payload may follow inline after `↓` and/or on subsequent lines
A-B→            replace the inclusive range A..B with payload; delete the range if no payload follows
A→              shorthand for A-A→
</ops>

<rules>
- The arrow points to where the content lands relative to the anchor: `↑` above, `↓` below, `→` overwrite.
- Payload text is verbatim — NEVER escape unicode.
- An op line is `ANCHOR<SIGIL>[INLINE_PAYLOAD]`. Anything after the sigil on the same line is the first payload line; subsequent payload lines follow on the next lines.
- A payload run ends at the next op line, the next `¶PATH`, an envelope marker, or EOF.
- `A-B→` with no payload deletes the range. To keep a blank line, include one explicit empty payload line on the next line.
- **Payload is only what's NEW relative to your range:**
  - `→` replaces inside; NEVER include lines outside.
  - `↑`/`↓` adds at the anchor; NEVER repeat line A or neighbors.
  - Payload matching nearby content duplicates — drop it or widen.
- **Pick a self-contained unit first.** Touching a multiline construct? Widen to the whole thing.
- Then smallest op: add → `↑`/`↓`; delete/replace → `→`.
</rules>

<brace-shapes>
When braces bound your edit, you SHOULD prefer these shapes:
- **Whole block**: range spans `{` through matching `}`.
- **Signature only**: one-line `→` on the opener; body untouched.
- **Insert inside**: anchor on `{` or last interior line; NEVER repeat the braces.
- **End on `}`**: only when that `}` is part of the change. Otherwise extend or stop earlier.
</brace-shapes>

<common-failures>
- **NEVER replay past your range.** Stop before B+1; extend B if it must go.
- **NEVER duplicate chunks inside one payload.** Caught re-emitting? Rewrite.
- **Anchor only inside the visible region.** B+1 truncated? Re-`read` first.
- **You SHOULD prefer the narrowest self-contained edit.** Narrow range beats wide range.
- **Anchors reference the file as last read.** NEVER shift for prior ops.
- **One `↓`/`↑` op per block, NOT per line.** N lines = ONE op, N payloads. Collapse adjacent ops.
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
¶mod.ts
{{hrefr 1}}→
const TITLE = "Mrs";

# Replace a full multiline statement (widen to a self-contained boundary)
¶mod.ts
{{hrefr 3}}-{{hrefr 6}}→
	return [
		"Mrs",
		name?.trim() || "guest",
	].join(" ");

# Insert ABOVE/BELOW a line
¶mod.ts
{{hrefr 4}}↓
		"Dr",
{{hrefr 5}}↑
		"Dr",

# Append to file
¶mod.ts
EOF↓
export const done = true;

# Delete a line
¶mod.ts
{{hrefr 5}}→

# Blank a line (replace with LF: the empty payload is the blank line before `EOF↓`)
¶mod.ts
{{hrefr 5}}→

EOF↓
export const done = true;
</examples>

<anti-pattern>
# WRONG — replaces 2 lines just to add one.
¶mod.ts
{{hrefr 1}}-{{hrefr 2}}→
const TITLE = "Mr";
const DEBUG = false;
export function greet(name) {
# RIGHT — same effect, one-line insert
¶mod.ts
{{hrefr 1}}↓
const DEBUG = false;

# WRONG — replace from the middle of a larger statement (error-prone)
¶mod.ts
{{hrefr 4}}-{{hrefr 5}}→
		"Dr",
		name?.trim() || "guest",
# RIGHT — widen to the full statement
¶mod.ts
{{hrefr 3}}-{{hrefr 6}}→
	return [
		"Dr",
		name?.trim() || "guest",
	].join(" ");
</anti-pattern>

<critical>
- Copy anchors verbatim (line number + 2-char hash); NEVER include the `|TEXT` body.
- NEVER write unified diff syntax. Headers are `¶PATH`; ops put `↑`/`↓`/`→` AFTER the anchor.
- `A-B→` deletes the range when no payload follows. To keep a blank line, include one explicit empty payload line.
- `A-B→` with payload writes exactly that payload. Edge line matches just outside? Widen, or it duplicates.
- Multiple ops are cheap. SHOULD prefer two narrow ops over one wide `→`.
  - Before `A-B→`, mentally delete A..B. Splits an unclosed bracket/brace/string from above, or orphans a closer inside? You're bisecting a construct.
- NEVER use this tool to reformat code (indentation, whitespace, line wrapping, style). Run the project's formatter instead.
</critical>

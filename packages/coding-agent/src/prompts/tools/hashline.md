Your patch language is a compact, line-anchored edit format.

A patch contains one or more file sections. The first non-blank line of an anchored edit section MUST be `¶PATH#HASH`, copied from the latest `read`/`search` output for that file. `HASH` is a 4-hex file hash.
Operations reference lines by bare line number, e.g. `5`, `123`.

`¶PATH` without `#HASH` is allowed ONLY for new-file / `BOF` / `EOF` boundary inserts. Anchored line ops without a header hash are rejected.

Purely textual format. The tool has NO awareness of language, indentation, brackets, fences, or table widths. You MUST emit valid syntax in replacements/insertions.

<ops>
¶PATH#HASH      header: subsequent anchored ops apply to PATH at file hash HASH
¶PATH           unbound header: only BOF/EOF boundary inserts
Each op line is ONE of:
LINE↑           insert ABOVE the anchored line (or BOF); payload may follow inline after `↑` and/or on subsequent lines
LINE↓           insert BELOW the anchored line (or EOF); payload may follow inline after `↓` and/or on subsequent lines
A-B:            replace the inclusive range A..B with payload
A:              shorthand for A-A:
A-B!            delete the inclusive range A..B; payload forbidden
A!              shorthand for A-A!
</ops>

<rules>
- The sigil tells where content lands: `↑` above, `↓` below, `:` replaces, `!` deletes.
- Payload text is verbatim — NEVER escape unicode.
- Op line shape: `ANCHOR<SIGIL>[INLINE_PAYLOAD]`.
- Payload ends at next op, next `¶PATH`, envelope marker, or EOF. Blank lines immediately before a next op or `¶PATH` are treated as separators (dropped); blank lines between two content payload lines, or trailing at EOF, are preserved.
- `:` / `↑` / `↓` payload may be inline after the sigil and/or on subsequent lines.
- A bare `A↑` / `A↓` (no payload) inserts one blank line. A bare `A:` / `A-B:` (no payload, no inline body) replaces the line/range with a single blank line.
- `!` delete ops NEVER include payload.
- Blank a line with bare `A:`, or remove it entirely with `A!`. Insert a blank line with bare `A↑` / `A↓`.
- **Payload is only what's NEW relative to your range:**
  - `:` replaces inside; NEVER include lines outside.
  - `↑`/`↓` adds at anchor; NEVER repeat line A or neighbors.
  - Payload matching nearby content duplicates — drop it or widen.
- **Pick a self-contained unit first.** Touching multiline construct? Widen to it.
- Then smallest op: add with `↑`/`↓`; replace with `:`; delete with `!`.
</rules>

<brace-shapes>
When braces bound your edit, you SHOULD prefer these shapes:
- **Whole block**: range spans `{` through matching `}`.
- **Signature only**: one-line `:` on opener; body untouched.
- **Insert inside**: anchor on `{` or last interior line; NEVER repeat braces.
- **End on `}`**: only when that `}` is part of the change. Otherwise extend or stop earlier.
</brace-shapes>

<common-failures>
- **NEVER replay past your range.** Stop before B+1; extend B if it must go.
- **NEVER duplicate chunks inside one payload.** Caught re-emitting? Rewrite.
- **Anchor only inside visible content.** B+1 truncated? Re-`read` first.
- **Use the section hash from latest output.** Missing/stale? Re-`read`.
- **You SHOULD prefer the narrowest self-contained edit.** Narrow range beats wide range.
- **Anchors reference the file as last read.** NEVER shift for prior ops.
- **One patch, one coordinate space.** Later ops still use original line numbers.
- **Read lines already look like replace ops.** `84:content` already means “make line 84 equal to content”. Do not echo a second context line before it.
- **One `↓`/`↑` op per block, NOT per line.** N lines = ONE op, N payloads.
- **NEVER fabricate file hashes.** Missing? Re-`read`.
- **`A!` deletes silently.** Deleting a line that closes/opens a block (`}`, `} else {`, `})`, `*/`) breaks structure with no parse error. If you misfired an earlier edit and reach for `A!` to clean up, re-read first — you'll get a warning if the deleted line was a structural boundary, but the warning only fires after the fact.
</common-failures>

<case file="mod.ts">
¶mod.ts#1a2b
{{hline 1 'const TITLE = "Mr";'}}
{{hline 2 'export function greet(name) {'}}
{{hline 3 '	return ['}}
{{hline 4 '		TITLE,'}}
{{hline 5 '		name?.trim() || "guest",'}}
{{hline 6 '	].join(" ");'}}
{{hline 7 "}"}}
</case>

<examples>
# Replace one line (payload must re-emit original indentation)
¶mod.ts#1a2b
{{hrefr 1}}:
const TITLE = "Mrs";

# Replace a full multiline statement (widen to self-contained boundary)
¶mod.ts#1a2b
{{hrefr 3}}-{{hrefr 6}}:
	return [
		"Mrs",
		name?.trim() || "guest",
	].join(" ");

# Delete one line
¶mod.ts#1a2b
{{hrefr 5}}!

# Blank a line
¶mod.ts#1a2b
{{hrefr 5}}:
# Insert ABOVE/BELOW a line
¶mod.ts#1a2b
{{hrefr 4}}↓
		"Dr",
{{hrefr 5}}↑
		"Dr",

# Append to existing file; hash optional because EOF is a boundary insert
¶mod.ts
EOF↓
export const done = true;

# Create a file
¶new.ts
BOF↓
export const done = true;

# Multi-file patch
¶src/a.ts#1a2b
12:
const enabled = true;
¶src/b.ts#3c4d
20!
</examples>

<anti-pattern>
# WRONG — replaces 2 lines just to add one.
¶mod.ts#1a2b
{{hrefr 1}}-{{hrefr 2}}:
const TITLE = "Mr";
const DEBUG = false;
export function greet(name) {
# RIGHT — same effect, one-line insert
¶mod.ts#1a2b
{{hrefr 1}}↓
const DEBUG = false;

# WRONG — replace from the middle of a larger statement (error-prone)
¶mod.ts#1a2b
{{hrefr 4}}-{{hrefr 5}}:
		"Dr",
		name?.trim() || "guest",
# RIGHT — widen to the full statement
¶mod.ts#1a2b
{{hrefr 3}}-{{hrefr 6}}:
	return [
		"Dr",
		name?.trim() || "guest",
	].join(" ");
</anti-pattern>

<critical>
- Copy the `¶PATH#HASH` header verbatim for anchored edits.
- Copy only line numbers into ops; NEVER include `:TEXT` body unless you are intentionally using `LINE:TEXT` as replace syntax.
- NEVER write unified diff syntax. Ops put `↑`/`↓`/`:`/`!` AFTER the anchor.
- `:` replaces; bare `A:` blanks the line. `↑` / `↓` insert; bare `A↑` / `A↓` insert one blank line. Use `A!` to delete entirely.
- `!` deletes and forbids payload.
- Multiple ops are cheap. SHOULD prefer two narrow ops over one wide `:`.
  - Before `A-B:` or `A-B!`, mentally delete A..B. Splits an unclosed bracket/brace/string from above, or orphans a closer inside? You're bisecting a construct.
- NEVER use this tool to reformat code. Run the project's formatter instead.
</critical>

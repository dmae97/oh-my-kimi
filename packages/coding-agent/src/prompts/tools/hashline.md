Your patch language is a compact, line-anchored edit format.

A patch contains one or more file sections. The first non-blank line of every edit section **MUST** be `@PATH`.
Operations reference lines in the file by their line number and hash, called "Anchors", e.g. `5th`, `123ab`.
You **MUST** copy them verbatim from the latest output for the file you're editing.

This format is purely textual. The tool has NO awareness of language, indentation, brackets, fences, or table widths. You are responsible for emitting valid syntax in your replacements/insertions.

<ops>
@PATH            header: subsequent ops apply to PATH
< ANCHOR         insert lines BEFORE the anchored line (or BOF); payload follows as `|TEXT` lines
+ ANCHOR         insert lines AFTER  the anchored line (or EOF); payload follows as `|TEXT` lines
- A..B           delete the line range (inclusive); `- A` for one line
= A..B           replace the range with payload `|TEXT` lines, or with one blank line if no payload follows
</ops>

<rules>
- Every line of inserted/replacement content **MUST** be emitted as a payload line starting with `|`.
- `|` is syntax, not content. The inserted text begins after the first `|`; use a bare `|` to insert a blank line.
- `< A` inserts before line A; `+ A` inserts after line A. `< BOF` / `+ BOF` both prepend; `< EOF` / `+ EOF` both append.
- `= A..B` replaces the inclusive range with the following payload lines. `= A` (or `= A..B`) with no payload blanks the range to a single empty line.
- `- A..B` deletes the inclusive range; omit `..B` for one line.
</rules>

<case file="a.ts">
{{hline 1 "const DEF = \"guest\";"}}
{{hline 2 ""}}
{{hline 3 "export function label(name) {"}}
{{hline 4 "\tconst clean = name || DEF;"}}
{{hline 5 "\treturn clean.trim();"}}
{{hline 6 "}"}}
</case>

<examples>
# Replace one line (preserve the leading tab from the original)
@a.ts
= {{hrefr 5}}
|	return clean.trim().toUpperCase();

# Replace a contiguous range with multiple lines
@a.ts
= {{hrefr 3}}..{{hrefr 6}}
|export function label(name: string): string {
|	const clean = (name || DEF).trim();
|	return clean.length === 0 ? DEF : clean.toUpperCase();
|}

# Insert BEFORE a line
@a.ts
< {{hrefr 5}}
|	const debug = false;

# Insert AFTER a line
@a.ts
+ {{hrefr 4}}
|	if (clean.length === 0) return DEF;

# Append to end of file
@a.ts
+ EOF
|export const done = true;

# Delete a single line
@a.ts
- {{hrefr 2}}

# Blank a line in place (no payload required)
@a.ts
= {{hrefr 2}}
</examples>

<critical>
- Always copy anchors exactly from tool output, but **NEVER** include line content after the `|` separator in the op line.
- Only emit changed lines. Do not restate unchanged context as payload.
- Every inserted/replacement content line **MUST** start with `|`; raw content lines are invalid.
- Do not write unified diff syntax (`@@`, `-OLD`, `+NEW`).
- To replace a block, use one `= A..B` op followed by all replacement `|TEXT` payload lines.
</critical>

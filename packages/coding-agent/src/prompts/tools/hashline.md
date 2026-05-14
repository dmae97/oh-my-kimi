Your patch language is a compact, line-anchored edit format.

A patch contains one or more file sections. The first non-blank line of every edit section MUST be `@@ PATH`.
Operations reference lines in the file by their line number and hash, called "Anchors", e.g. `5th`, `123ab`.
You MUST copy them verbatim from the latest output for the file you're editing.

Purely textual format. The tool has NO awareness of language, indentation, brackets, fences, or table widths. Emit valid syntax in replacements/insertions.

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
</format-reminder>

<rules>
- Every line of inserted/replacement content MUST be emitted as a payload line starting with `{{hsep}}`.
- `{{hsep}}` is syntax, not content. The inserted text begins after the first `{{hsep}}`; use a bare `{{hsep}}` to insert a blank line.
- Payload is verbatim — don't escape unicode (write `—`, not `\u2014`).
- `< A` inserts before line A; `+ A` inserts after line A. `< BOF` / `+ BOF` both prepend; `< EOF` / `+ EOF` both append.
- `= A..B` replaces the inclusive range with the following payload lines. `= A..B` with no payload blanks the range to a single empty line.
- `- A..B` deletes the inclusive range; `A..A` for one line.
- **Choose a self-contained syntactic unit first.** If the change touches part of a multiline call, destructuring assignment, control-flow header, wrapper, or other construct, widen the range to include the whole construct before optimizing for size.
- Only after the range is self-contained, pick the smallest op for the change: pure addition → `+`/`<`; pure deletion → `-`; `= A..B` ONLY when content inside `A..B` is actually being modified or removed.
</rules>

<brace-shapes>
When your edit involves brace boundaries (`{` / `}`), prefer these shapes:
- **Whole block replace/delete**: pick the range so it spans both halves of the brace pair — start on the line that ends with `{`, end on the matching `}`. For pure removal use `-` with empty payload; for replacement, the payload's first line ends with `{` and last line is the matching `}`.
- **Signature-only edit**: if you are only changing the line that ends with `{` (function signature, control statement, etc.), use a one-line `=` on that opener; the body and matching `}` are untouched and stay outside the range.
- **Insert inside a block**: anchor on the opener (`+ ANCHOR` after the `{` line) or just above the closer (`+ ANCHOR` after the last interior line); emit only the new interior lines. Do not include the surrounding `{` or `}` in the payload — they're already there.
- **Range ending on `}`**: only end on `}` when that `}` is itself part of what you're changing. The line at B+1 should be blank, an opener (next block), or a signature — not another `}`. Otherwise extend B past the closer or stop one line earlier.
</brace-shapes>

<common-failures>
- **Do not replay the line past your range.** For `= A..B`, never end the payload with content that already exists at B+1. Stop the payload at the last line you are actually changing; if you need that next line gone, extend B.
- **Do not duplicate chunks inside one payload.** When emitting a long `=` payload, never paste the same multi-line block twice. If you catch yourself re-emitting an earlier run of lines, stop and rewrite the op.
- **Anchor only inside the visible region.** If the read output around your `=`/`-` end anchor is truncated (you cannot see the line at B+1), issue a fresh `read` before editing — anchoring blind drops or duplicates the boundary line.
- **Prefer the narrowest self-contained edit.** Once your range cleanly contains the construct you are changing, a `+`/`<` insert plus a small `-` delete is almost always clearer and safer than a single wide `= A..B` that re-emits unchanged context.
- **Anchors always reference the file as you last read it.** When stacking multiple `+`/`<`/`-`/`=` ops in one patch, NEVER mentally shift line numbers to account for prior ops in the same patch. Every op resolves against the original line numbering.
</common-failures>

<case file="a.ts">
{{hline 1 "const DEF = \"guest\";"}}
{{hline 2 ""}}
{{hline 3 "export function label(name) {"}}
{{hline 4 "\tconst clean = name || DEF;"}}
{{hline 5 "\treturn clean.trim();"}}
{{hline 6 "}"}}
</case>

<case file="b.ts">
{{hline 1 "const {"}}
{{hline 2 "\tevents,"}}
{{hline 3 "\tresponse,"}}
{{hline 4 "\trequestId,"}}
{{hline 5 "} = await getStreamResponse("}}
{{hline 6 "\trequest,"}}
{{hline 7 "\tsignal,"}}
{{hline 8 ");"}}
{{hline 9 "await notify(requestId);"}}
</case>

<examples>
# Replace one line (preserve the leading tab from the original)
@@ a.ts
= {{hrefr 5}}..{{hrefr 5}}
{{hsep}}	return clean.trim().toUpperCase();

# Replace a contiguous range with multiple lines
@@ a.ts
= {{hrefr 4}}..{{hrefr 5}}
{{hsep}}	const clean = (name || DEF).trim();
{{hsep}}	return clean.length === 0 ? DEF : clean.toUpperCase();

# Replace a full multiline destructuring/call statement
@@ b.ts
= {{hrefr 1}}..{{hrefr 8}}
{{hsep}}const {
{{hsep}}	events,
{{hsep}}	response,
{{hsep}}	requestId,
{{hsep}}} = await getStreamResponse(
{{hsep}}	request,
{{hsep}}	signal,
{{hsep}}	onEvent,
{{hsep}});

# Insert BEFORE a line
@@ a.ts
< {{hrefr 5}}
{{hsep}}	const debug = false;

# Insert AFTER a line
@@ a.ts
+ {{hrefr 4}}
{{hsep}}	if (clean.length === 0) return DEF;

# Append to end of file
@@ a.ts
+ EOF
{{hsep}}export const done = true;

# Delete a single line
@@ a.ts
- {{hrefr 2}}..{{hrefr 2}}

# Blank a line in place (no payload required)
@@ a.ts
= {{hrefr 2}}..{{hrefr 2}}
</examples>

<anti-pattern>
# WRONG — replaces 5 lines just to add one. Use `+` at the boundary instead.
@@ a.ts
= {{hrefr 1}}..{{hrefr 5}}
{{hsep}}const DEF = "guest";
{{hsep}}const DEBUG = false;
{{hsep}}
{{hsep}}export function label(name) {
{{hsep}}	const clean = name || DEF;
{{hsep}}	return clean.trim();

# RIGHT — same effect, one-line insert
@@ a.ts
+ {{hrefr 1}}
{{hsep}}const DEBUG = false;

# WRONG — continuation-fragment payload from the middle of a larger statement.
@@ b.ts
= {{hrefr 5}}..{{hrefr 7}}
{{hsep}}} = await getStreamResponse(
{{hsep}}	request,
{{hsep}}	signal,
{{hsep}}	onEvent,

# RIGHT — widen to the full statement so the payload starts at a self-contained boundary.
@@ b.ts
= {{hrefr 1}}..{{hrefr 8}}
{{hsep}}const {
{{hsep}}	events,
{{hsep}}	response,
{{hsep}}	requestId,
{{hsep}}} = await getStreamResponse(
{{hsep}}	request,
{{hsep}}	signal,
{{hsep}}	onEvent,
{{hsep}});

If your replacement payload would render with even one unchanged line in the diff, or if the first or last payload line is only a continuation fragment from a larger construct (`} =`, `);`, `,`, `.method(`), you have the wrong op or range. Stop and widen to a self-contained boundary before minimizing the edit.
</anti-pattern>

<critical>
- Always copy anchors exactly from tool output, but NEVER include line content after the `{{hsep}}` separator in the op line.
- Every inserted/replacement content line MUST start with `{{hsep}}`; raw content lines are invalid.
- Do not write unified diff syntax (`@@ -X,Y +X,Y @@`, `-OLD`, `+NEW`). The header is `@@ PATH`; line ops are `<`/`+`/`-`/`=`.
- `= A..B` deletes the range; payload is what's written. If a payload edge line already exists immediately outside `A..B`, widen the range to cover it — otherwise it duplicates.
- Multiple ops in one patch are cheap. Prefer two narrow ops over one wide `=`.
  - Before choosing a `= A..B` range, mentally delete lines A through B. If that would split an unclosed bracket, paren, brace, or string/template from a line above A, or orphan a closing delimiter that belongs to an opener inside the range, you are bisecting a syntactic construct. Widen the range to a self-contained boundary, or use `+`/`-` instead.
  - `= A..B` removes the range as a unit; the lines immediately outside it remain. If those outside lines form a wrapper (`try {`, `catch`, `if`, `else`, loop delimiters) you do not intend to delete, your payload is inserted inside that wrapper. Make sure the payload remains valid and preserves required behavior like error handling. If you need to change the wrapper itself, include it in the range and reproduce it.
</critical>

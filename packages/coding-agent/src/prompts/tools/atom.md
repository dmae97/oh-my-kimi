Your patch language is a compact, line-anchored edit format.

A patch contains one or more file sections. The first non-blank line of every section **MUST** be `---PATH`.
A "Lid" is a per-line anchor emitted by `read`, `grep`, etc. — `<lineNumber><hash>`, e.g. `5th`, `123ab`, or `7a<` (opening-brace marker), `42>p` (closing-brace marker). You **MUST** copy a Lid verbatim from the latest output for the file you're editing.

This format is purely textual. The tool has NO awareness of language, indentation, brackets, fences, or table widths. You are responsible for emitting valid syntax in your replacements/insertions.

<ops>
---PATH    start a section editing PATH; cursor begins at EOF
^          move cursor to BOF (before line 1)
$          move cursor to EOF (after the last line)
@Lid       move cursor to AFTER the anchored line (does not modify the file)
^Lid       move cursor to BEFORE the anchored line (does not modify the file)
+TEXT      insert one line containing TEXT at the cursor
+          insert one blank line at the cursor
Lid=TEXT   replace the anchored line with TEXT
LidA..LidB=TEXT replace the range with one line; following `+TEXT` lines extend the replacement (since the cursor sits at the slot the range vacated)
Lid=       blank the anchored line's content but KEEP the line (results in an empty line, NOT a removed line; use `-Lid` to remove)
-Lid       delete the anchored line (repeat for multi-line delete)
-LidA..LidB delete the contiguous line range LidA..LidB (inclusive)
!rm        delete the section's PATH (**MUST** be the only op in the section)
!mv DEST   rename the section's PATH to DEST (**MUST** be the only op in the section)
</ops>

<rules>
- Cursor-only ops (`^`, `$`, `@Lid`, `^Lid`) reposition without modifying. To insert anything you **MUST** follow them with `+TEXT` (or `+` for a blank).
- TEXT in `+TEXT` and `Lid=TEXT` is literal line content, INCLUDING leading whitespace. You **MUST NOT** trim or re-indent it.
- Consecutive `+TEXT` ops produce consecutive lines in the order written. You **MUST NOT** separate them with a stray `+` unless you intend to insert a blank line.
- `Lid=TEXT` rewrites ONE line. To rewrite K adjacent lines, you **MUST** use `LidA..LidB=FIRST_LINE` followed immediately by `+NEXT_LINE` lines (or use `Lid=FIRST_LINE` + `+NEXT_LINE…` to extend a single anchor downward). The `+TEXT` lines insert at the cursor that `Lid=…` / `LidA..LidB=…` parks on the just-set / just-vacated slot. Use bare `+` for blank replacement lines.
- The legacy `-LidA..LidB` + `+TEXT…` block-rewrite form also works.
- To insert ABOVE a line, you **MUST** use `^Lid` then `+TEXT`. To insert above line 1, you **MUST** use `^` (BOF) then `+TEXT`. To insert below a line, you **MUST** use `@Lid` then `+TEXT`.
- Multiple `---PATH` sections **MAY** appear in one input; each section is applied in order.
- `!rm` / `!mv DEST` **MUST NOT** be combined with line edits in the same section.
- Lids contain a content hash. If a line has changed since you read it, the tool rejects the edit and shows the current content; you **MUST** re-read and retry with fresh Lids.
- After `+TEXT` (or `+`) the cursor advances past the inserted line, so consecutive `+TEXT` ops stack in order. After `Lid=TEXT` the cursor sits on the modified anchor; after `-Lid` it sits on the slot the deleted line vacated. You **MUST** use a fresh `@Lid` / `^Lid` / `^` / `$` to reposition.
- The tool is syntax-blind: it will not check brackets, indentation, table column counts, or fence integrity. You **MUST** verify indentation-sensitive or structured files after editing (Python, Markdown tables/fences).
- A section whose PATH does not yet exist creates the file from your `+TEXT` lines (use `^` or `$` then `+TEXT…`). No separate "create file" op is needed.
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
---a.ts
{{hrefr 5}}=	return clean.trim().toUpperCase();

# Rewrite multiple adjacent lines (delete each, then insert new content)
---a.ts
-{{hrefr 3}}
-{{hrefr 4}}
-{{hrefr 5}}
-{{hrefr 6}}
+export function label(name: string): string {
+	return (name || DEF).trim().toUpperCase();
+}

# Same rewrite using a range (equivalent to four `-Lid` lines)
---a.ts
-{{hrefr 3}}..{{hrefr 6}}
+export function label(name: string): string {
+	return (name || DEF).trim().toUpperCase();
+}

# Replace a contiguous range with one line (range-replace shorthand)
---a.ts
{{hrefr 3}}..{{hrefr 6}}=export const label = (name: string) => (name || DEF).trim().toUpperCase();

# Replace a contiguous range with multiple lines (continuation form)
---a.ts
{{hrefr 3}}..{{hrefr 6}}=export function label(name: string): string {
\	return (name || DEF).trim().toUpperCase();
\}

# Replace one contiguous block when the existing lines themselves change; the replacement may have more/fewer lines than the selected range
---a.ts
{{hrefr 3}}..{{hrefr 6}}=/** Format a display label, falling back to DEF when empty. */
+export function label(name: string): string {
+	const clean = (name || DEF).trim();
+
+	if (clean.length === 0) return DEF;
+	return clean.toUpperCase();
+}

# Insert ABOVE a line
---a.ts
^{{hrefr 5}}
+	const debug = false;

# Insert BELOW a line
---a.ts
@{{hrefr 4}}
+	const debug = false;

# Insert above the first line (use BOF)
---a.ts
^
+// Copyright (c) 2026
+

# Append at end of file
---a.ts
$
+export { DEF };

# Delete a single line
---a.ts
-{{hrefr 2}}

# Blank a line in place (line stays, content removed). Use this — not `-Lid` — when the EOL/indentation should remain.
---a.ts
{{hrefr 2}}=

# Range replace expanding a 3-line block to 5 lines (cursor parks in the slot, so each `+TEXT` extends the replacement)
---a.ts
{{hrefr 3}}..{{hrefr 5}}=export function label(name: string): string {
+	if (!name) return DEF;
+	const clean = name.trim();
+	if (clean.length === 0) return DEF;
+	return clean;

# Range replace contracting a 4-line block to 1 line
---a.ts
{{hrefr 3}}..{{hrefr 6}}=export const label = (name: string) => (name || DEF).trim() || DEF;

# Delete the file (no other ops in the section)
---a.ts
!rm

# Rename a file
---a.ts
!mv b.ts

# Multi-file edit in one input
---a.ts
{{hrefr 1}}=const DEF = "user";
---other.ts
$
+// new footer
</examples>

<critical>
- You **MUST** copy Lids EXACTLY from the latest read/grep output. You **MUST NOT** guess, shorten, drop letters, or invent line numbers.
- Current/added preview lines include fresh `LINE+hash|content` anchors. Removed preview lines show deleted content and **MUST NOT** be reused as anchors.
- You **MUST** emit only lines that change. You **MUST NOT** echo unchanged context; the anchor implies position.
- You **MUST NOT** write `Lid=<sameTextThatIsAlreadyOnThatLine>`; the tool reports a no-op (no change applied). Emit `Lid=TEXT` only when TEXT differs.
- You **MUST NOT** use `Lid=<originalLineContent>` + `+continuations` as an "insert after" idiom. That form is a *replacement* whose first line lands at the anchor and pushes the original next line down. When the anchor is a closing brace and your continuations also end in `}`, the original line below — often itself `}` (a sibling block, mod, or impl closer) — sits adjacent to yours and you ship a duplicate `}`. For pure insertion, use `@Lid` + `+TEXT…` (after) or `^Lid` + `+TEXT…` (before). Never re-state the anchor's content as the first line of a replacement.
- A line of the form `Lid|content` (a Lid, then `|`, then text, with NO leading `+`/`-`/`^`/`@`/`=`/`..`) is **FORBIDDEN**. That shape only appears in `read`/`grep` output as an anchor for *you*; it is never an edit op. If you copy a `Lid|content` line verbatim from a read into a patch, you have made an error — every edit op must start with `+`, `-`, `^`, `@`, `$`, `!`, or a Lid immediately followed by `=` or `..`.
- To replace a contiguous block with new content, the canonical form is `LidA..LidB=FIRST_LINE` + `+NEXT_LINE…`. You **MUST NOT** write the old block and then the new block — that is unified-diff thinking and the tool does not understand it. If you find yourself emitting pre-image lines (with or without operators) before your new content, STOP and rewrite the section as a single range-replace.
- TEXT after `=` or `+` includes leading whitespace verbatim. You **MUST NOT** trim or re-indent it.
- This is NOT unified diff. You **MUST NOT** write `@@` headers, `-OLD`/`+NEW` pairs, context lines, or `+Lid|…` (bad: `+5th|new text`; good: `5th=new text`).
- You **MUST NOT** split `Lid=TEXT` across two physical lines.
- For a contiguous range replacement, you **MAY** use either `Lid=FIRST_LINE` + `+NEXT_LINE…` (extends one anchor downward) or `LidA..LidB=FIRST_LINE` + `+NEXT_LINE…` (collapses an existing range and fills the slot), or fall back to `-LidA..LidB` + `+TEXT…` (delete + insert).
- The tool is syntax-blind. Indentation, brackets, fences, table widths — you remain responsible.
- Hashes may contain `<` or `>` (the brace markers `[a-z]<` for `{`-ending lines, `>[a-z]` for `}`-starting lines). The Lid is everything before the first `|` separator. Example: in a read line `28>i|}` the Lid is `28>i` and the content is `}`. Copy the whole anchor up to the first `|` — do NOT split at `<`/`>` inside the hash.
- `@Lid` + `+TEXT…` where the anchor line ends with `{` inserts your content as the FIRST element inside that block's body. If you intended a sibling (after the closing brace), use `^Lid` on the next sibling line instead. The tool emits a warning when the inserted indent ≤ the anchor indent in this configuration; treat the warning as "did you really mean body content?"
</critical>

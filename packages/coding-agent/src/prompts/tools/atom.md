Your patch language is a compact, file-oriented edit format.

When emitting a patch, the first non-blank line **MUST** be `---PATH`.
A Lid is the anchor emitted in read/grep etc. (line number + id, e.g. `5th`).

<ops>
---PATH  start editing PATH with cursor at EOF
!rm      delete PATH
!mv X    move file to X
^        move cursor to BOF
$        move cursor to EOF
@Lid     move cursor after Lid
+X       insert X at the cursor; `+` alone inserts a blank line
Lid=X    replace whole line with X; `Lid=` blanks it out
-Lid     delete line (repeat for multi)
</ops>

<rules>
- You may have multiple `---PATH` sections to edit multiple files at once.
- Ops starting with `$` / `^` / `@Lid` do not alter lines; you must still issue an op like `+` afterwards.
- Consecutive `+X` ops insert consecutive lines.
- `Lid=X` replaces the whole line. X must be the complete new line, not a fragment.
- To rewrite multiple adjacent lines, delete each with `-Lid` then emit the new content as `+TEXT` lines. Do not stack `Lid=X` over a contiguous range — it requires the new block to match the old line count and silently corrupts the file when they differ.
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
# Replace line
---a.ts
{{hrefr 5}}=	return clean.trim().toUpperCase();

# Rewrite multiple adjacent lines (delete the old, insert the new)
---a.ts
-{{hrefr 3}}
-{{hrefr 4}}
-{{hrefr 5}}
-{{hrefr 6}}
+export function label(name: string): string {
+	return (name || DEF).trim().toUpperCase();
+}

# Append after
---a.ts
@{{hrefr 4}}
+	const suffix = "";

# Delete a line
---a.ts
-{{hrefr 2}}

# Prepend and append
---a.ts
^
+// Copyright (c) 2026
+
$
+export { DEF };

# File ops
---a.ts
!rm
---b.ts
!mv a.ts

# Wrong: `@Lid=TEXT` is not replacement syntax
---a.ts
@{{hrefr 5}}=	return clean.trim().toUpperCase();

# Wrong: do not split `Lid=TEXT` across lines
---a.ts
{{hrefr 5}}=
	return clean.trim().toUpperCase();

# Wrong: do not replace by deleting then adding
---a.ts
-{{hrefr 5}}
+{{hrefr 5}}=	return clean.trim().toUpperCase();
</examples>

<critical>
- Copy Lids **EXACTLY** from prior tool output. Never guess, shorten, or omit the letters.
- Only emit lines that change. Never repeat unchanged context — anchors imply it.
- This is **NOT** unified diff. Never send `@@`, `-OLD` / `+NEW` pairs, or unchanged context.
- Never split `Lid=TEXT` across two physical lines.
- Never stack `Lid=X` over a contiguous range. Use `-Lid`+`+TEXT` for block rewrites.
</critical>

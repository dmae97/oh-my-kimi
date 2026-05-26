Your patch language is a compact, line-anchored edit format.

A patch contains one or more file sections. Each anchored section starts with `¶PATH#HASH`, copied verbatim from the latest `read`/`search` output. `HASH` is a 4-hex file hash; `¶PATH` without `#HASH` is allowed only for new-file / `BOF` / `EOF` boundary inserts.

Operations reference lines by bare line number (`5`, `123`). Payload text is verbatim — NEVER escape unicode. The tool has NO awareness of language, indentation, brackets, fences, or table widths. Emit valid syntax in replacements/insertions.

<ops>
¶PATH#HASH     header: subsequent anchored ops apply to PATH at file hash HASH
¶PATH          unbound header: only BOF/EOF boundary inserts
LINE↑PAYLOAD   insert ABOVE the anchored line (or BOF)
LINE↓PAYLOAD   insert BELOW the anchored line (or EOF)
A-B:PAYLOAD    replace the inclusive range A..B with PAYLOAD
A:PAYLOAD      shorthand for A-A:PAYLOAD
A-B!           delete the inclusive range A..B (payload forbidden)
A!             shorthand for A-A!
</ops>

<payload>
- The first payload line is whatever follows the sigil on the op line. Additional payload lines follow on the next lines and append after the first.
- An empty inline IS an empty first line. So bare `A↓` / `A↑` insert one blank line; bare `A:` / `A-B:` replace with one blank line. `A↓\nfoo` inserts blank-then-`foo`, NOT just `foo`.
- Payload ends at the next op, next `¶PATH`, envelope marker, or EOF. Blank lines immediately before a next op or `¶PATH` are dropped; blank lines between content lines are preserved.
</payload>

<rules>
- The sigil tells where content lands: `↑` above, `↓` below, `:` replaces, `!` deletes.
- **Payload is only what's NEW relative to your range.** `:` replaces inside; `↑`/`↓` add at anchor. NEVER repeat the anchor line or neighbors — that duplicates them.
- **Pick a self-contained unit.** Touching a multiline construct (return, array, brace block, JSX element)? Widen the range to span it. Don't bisect.
- Smallest op wins: add with `↑`/`↓`; replace with `:`; delete with `!`.
- Anchors reference the file as last read. ONE patch, ONE coordinate space — later ops still use original line numbers.
</rules>

<common-failures>
- **NEVER replay past your range.** Stop before B+1; extend B if it must go.
- **NEVER duplicate chunks inside one payload.**
- **Read lines look like replace ops.** `84:content` already means "make line 84 equal to content" — don't echo a context line before it.
- **NEVER fabricate file hashes.** Missing? Re-`read`.
- **`A!` deletes silently.** Deleting a line that closes/opens a block (`}`, `} else {`, `})`, `*/`) breaks structure with no parse error.
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
# Replace one line (inline payload preserves original indentation)
¶mod.ts#1a2b
{{hrefr 1}}:const TITLE = "Mrs";

# Replace a multiline statement — first line inline, rest below
¶mod.ts#1a2b
{{hrefr 3}}-{{hrefr 6}}:	return [
		"Mrs",
		name?.trim() || "guest",
	].join(" ");

# Insert ABOVE / BELOW a line
¶mod.ts#1a2b
{{hrefr 4}}↓		"Dr",
{{hrefr 5}}↑		"Dr",

# Delete one line / blank a line / insert a blank line
¶mod.ts#1a2b
{{hrefr 5}}!
{{hrefr 6}}:
{{hrefr 7}}↑

# Create a file / append to one (hash optional for boundary-only inserts)
¶new.ts
BOF↓export const done = true;
¶mod.ts
EOF↓export const done = true;

# Multi-file patch
¶src/a.ts#1a2b
12:const enabled = true;
¶src/b.ts#3c4d
20!
</examples>

<anti-pattern>
# WRONG — replaces 2 lines just to add one.
¶mod.ts#1a2b
{{hrefr 1}}-{{hrefr 2}}:const TITLE = "Mr";
const DEBUG = false;
export function greet(name) {

# RIGHT — one-line insert
¶mod.ts#1a2b
{{hrefr 1}}↓const DEBUG = false;

# WRONG — bisects a multiline statement
¶mod.ts#1a2b
{{hrefr 4}}-{{hrefr 5}}:		"Dr",
		name?.trim() || "guest",

# RIGHT — widen to the full statement
¶mod.ts#1a2b
{{hrefr 3}}-{{hrefr 6}}:	return [
		"Dr",
		name?.trim() || "guest",
	].join(" ");
</anti-pattern>

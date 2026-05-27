Your patch language is a compact, line-anchored edit format.

<payload>
Patch payload is a series of hunks: `¶PATH#HASH` header followed by any number of operations. `HASH` should be copied as is from read/search. Missing? Re-`read`.
- No context rows, no gutters.
- NEVER restate unchanged lines "for context".
- Op lines carry NO payload. Every payload line lives on its own row and MUST start with `+`; that delimiter is stripped.
- Payload indentation is literal.
</payload>

<ops>
LINE↑    insert before (or BOF↑)        — anchor SURVIVES
LINE↓    insert after  (or EOF↓)        — anchor SURVIVES
A-B:     replace A..B  (or A: == A..A)  — anchor DELETED, then payload written in its place
+PAYLOAD payload line for the preceding op
</ops>

<rules>
- **Payload is only what's NEW.** `:` replaces inside; `↑`/`↓` add at anchor. NEVER repeat anchor lines or neighbors.
- **Use `+` for a blank payload line; use `++text` to write a line starting with `+text`.**
- **Inserts add ONLY the rows you list.** The file's existing newlines around the anchor stay. NEVER tack a trailing `+` blank "for spacing" — it writes a literal blank line into the file, doubling whatever is already there.
- **A bare `LINE↑`/`LINE↓` with no payload still inserts ONE blank line.** Not a no-op. Omit the op if you want nothing there.
- **Pick the op for your intent.** Does the anchor's existing content SURVIVE?
  - Survives + new lines next to it → `↑` / `↓`. Go small: prefer `↑`/`↓` over `:` whenever you can.
  - Changes in place → `:`
  When unsure: you wanted `↓`. `:` is destructive — it deletes the anchor line.
- **`A-B:` deletes EXACTLY A..B. Payload length never extends the deletion.** `1:` with 10 payload lines still deletes only line 1, then writes 10 lines there. To prepend without deleting, use `1↑` (or `BOF↑`).
- **Line numbers are frozen references to what you have seen.** Later ops in the same hunk still use original line numbers; they do NOT shift as earlier ops apply.
</rules>

<common-failures>
- **NEVER replay past your range.** Stop before B+1; extend B if needed.
- **Read lines look like replace ops.** `84:content` = "make line 84 content" — and inline content is rejected. Don't echo read-style rows.
- **`LINE:` from a read is NOT `LINE:` as an op.** Read shows what's there; the op DELETES it. Want to keep what you just read? Use `↑`/`↓`, not `:`.
- **NEVER fabricate file hashes.** Missing? Re-`read`.
</common-failures>

<example>
```a.ts#1a2b
1:const X = "a";
2:
3:export function f() { return X; }
4:f();
```

# replace one line, insert after
```
¶a.ts#1a2b
1:
+const X = "b";
+export const Y = X;
1↓
+const Z = Y;
```
</example>

<anti-pattern>
# WRONG — inline payload after the sigil is rejected
1:const X = "b";
1↓const Z = Y;
1-2:const X = "b";
+export const Y = X;
# WRONG — INSERT used to change a line (old line survives)
1↓
+const X = "b";
# WRONG — REPLACE used to add a line (original is silently deleted)
# intent: keep `const X = "a";`, add `const Y = X;` on the next line
1:
+const Y = X;
# `1:` replaces line 1 — `const X = "a";` is gone, breaking `f()` which returns X. Use `1↓` to insert after.
# WRONG — multi-line payload on `:` does NOT mean "insert N lines here"; the anchor is still destroyed.
# intent: prepend a helper ABOVE `const X = "a";`
1:
+function helper() { return X; }
+const Y = X;
# `1:` deletes line 1 and writes the payload there — payload count never extends the deletion range. To prepend: `1↑` (or `BOF↑`).
# WRONG — echoing read-style lines as context before the real op
1:const X = "a";
1-2:
+const X = "b";
+export const Y = X;
# WRONG — trailing `+` blank writes a literal empty line; the new blank lands right next to the orig blank at line 2, doubling it
1↓
+const Y = X;
+
# WRONG — `2↓` still anchors at PRE-EDIT line 2 (frozen), NOT at the line just inserted by `1↓`. Both inserts land at their own anchors, giving three consecutive blanks (new from `1↓`, orig blank line 2, new from `2↓`).
1↓
2↓
</anti-pattern>

<critical>
- One op per range, ever.
- Pick op precisely. Update: `:`, add: `↑`/`↓`.
- Payload always lives on its own `+`-prefixed line — never inline with the op.
- Payload is only what's NEW; never repeat anchor lines or neighbors.
- Anchor exactly; don't anchor neighbors.
</critical>

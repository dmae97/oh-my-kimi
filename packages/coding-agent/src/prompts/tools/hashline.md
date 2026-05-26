Your patch language is a compact, line-anchored edit format.

<payload>
Patch payload is a series of hunks: `¶PATH#HASH` header followed by any number of operations. `HASH` should be copied as is from read/search. Missing? Re-`read`.
- No context rows, no gutters.
- NEVER restate unchanged lines "for context".
- Inline payload after an op is literal. Additional payload lines MUST start with `+`; that delimiter is stripped.
- Payload indentation is literal.
</payload>

<ops>
LINE↑PAYLOAD   insert before (or BOF↑)
LINE↓PAYLOAD   insert after  (or EOF↓)
A-B:PAYLOAD    replace A..B  (or A: == A..A)
A-B!           delete A..B   (or A! == A..A)
+PAYLOAD       continuation payload line
</ops>

<rules>
- **Payload is only what's NEW.** `:` replaces inside; `↑`/`↓` add at anchor. NEVER repeat anchor lines or neighbors.
- **Continuation lines require `+`.** Use `+` for a blank payload line; use `++text` to write a line starting with `+text`.
- **Go small.** Add → `↑`/`↓`; replace → `:`; delete → `!`.
- **Line numbers are frozen references to what you have seen.** Later ops still use original line numbers.
</rules>

<common-failures>
- **NEVER replay past your range.** Stop before B+1; extend B if needed.
- **Read lines look like replace ops.** `84:content` = "make line 84 content" — don't echo context before it.
- **NEVER fabricate file hashes.** Missing? Re-`read`.
</common-failures>

<example>
```a.ts#1a2b
1:const X = "a";
2:export function f() { return X; }
```

# replace with a continuation line, insert after, delete
```
¶a.ts#1a2b
1:const X = "b";
+export const Y = X;
1↓const Z = Y;
2!
```
</example>

<anti-pattern>
# WRONG — INSERT used to change a line (old line survives)
1↓const X = "b";
# WRONG — echoing read-style lines as context before the real op
1:const X = "a";
1-2:const X = "b";
+export const Y = X;
</anti-pattern>

<critical>
- One op per range, ever.
- Pick op precisely. Update: `:`, add: `↑`/`↓`, remove: `!`.
- Payload is only what's NEW; never repeat anchor lines or neighbors.
- Continuation payload lines after the op line must start with `+`.
- Anchor exactly; don't anchor neighbors.
</critical>

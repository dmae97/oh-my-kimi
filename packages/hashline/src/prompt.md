Your patch language names lines to replace, delete, or insert at, then lists the new content. Rule of thumb: a header ending in `:` is followed by `+` body rows; `DEL` has no body.

<headers>
Every file section starts with `[PATH#TAG]`. `TAG` is the 4-hex snapshot tag from your latest `read`/`search`, and is REQUIRED on every section — there is no hashless form. To create a new file, use the `write` tool; hashline only edits files that already exist.
</headers>

<ops>
`XCHG N..M:` — replace original lines N..M with the body rows below. INCLUSIVE — line M is consumed too.
`XCHG.BLK N:` — replace the whole syntactic block that BEGINS on line N; tree-sitter resolves the closing line. Body rows below.
`DEL N..M` — delete original lines N..M. No body.
`DEL.BLK N` — delete the whole syntactic block that BEGINS on line N.
`INS.PRE N:` — insert the body rows immediately before line N.
`INS.POST N:` — insert the body rows immediately after line N.
`INS.BLK.POST N:` — insert the body rows after the END of the block that BEGINS on line N — outside it, at sibling depth. To append inside a block, use `INS.POST`.
`INS.HEAD:` — insert the body rows at the very start of the file.
`INS.TAIL:` — insert the body rows at the very end of the file.
Single line: `XCHG N..N:` / `DEL N`. The range is the ORIGINAL lines you touch; body length is irrelevant (replacing 1 line with 10 is still `XCHG N..N:`).
</ops>

<body-rows>
Body rows appear only under a `:` header. Every body row is:
  +TEXT     add a new literal line `TEXT`, verbatim (leading whitespace kept). `+` alone adds a blank line.
There is NO other body row kind. NEVER write `-old` or a bare/context line. To keep a line, leave it out of every range. To insert a literal line starting with `-` or `+`, prefix it: `+-x`, `++x`.
</body-rows>

<rules>
- Line numbers and the `[PATH#TAG]` header come from your latest `read`/`search` (`LINE:TEXT` rows).
- Numbers refer to the ORIGINAL file; they do not shift as hunks apply.
- They die with the call: every applied edit mints a fresh `#TAG` and renumbers — anchor the next edit on the edit response or a fresh `read`.
- Touch only lines your latest `read`/`search` literally displayed as `LINE:TEXT`; the tag certifies the snapshot, not your memory of it. A hunk anchored on a line you never displayed is REJECTED — re-`read` those exact lines first. (Seeing a line ≠ it holding the code you mean: confirm the numbers map to the construct you intend, especially far from your last-read window.)
- Elided regions are UNSEEN: `…`/`..` markers and a collapsed `N-M:` summary row (only boundary lines N and M were shown) hide their interior. NEVER place or span a hunk inside one — `read` the range first.
- Never start or end a range mid-expression or mid-block.
- Indent body rows exactly for the depth they should live at.
- On a stale-tag rejection or any surprising result: STOP and re-`read` before further edits.
- One hunk per range; the body is the final content, never an old/new pair.
- Ranges cover ONLY lines whose content changes. Never widen over unchanged lines — a stale wide range shreds everything it spans.
- Whole construct → `XCHG.BLK N` (tree-sitter resolves the end); lines inside it → `XCHG N..M`.
- `XCHG.BLK N` resolves EXACTLY the node at N. Leading decorators/attributes/doc-comments are separate nodes: point N at the FIRST decorator to sweep both; standalone line-comments are never swept — use `XCHG N..M`.
- Block ops (`XCHG.BLK`/`DEL.BLK`/`INS.BLK.POST`) anchor the OPENING line of a MULTI-LINE construct — never its closer, its last line, or a bare statement inside it. Anchoring a single statement resolves to ONE line and is REJECTED: use the plain op (`XCHG N..N` / `DEL N` / `INS.POST N`) for one line, or point N at the real opener. Saw the closer? Use plain `INS.POST M:`.
- Non-adjacent changes = separate hunks; untouched lines stay out of every range.
- Pure additions use `INS.PRE` / `INS.POST` / `INS.HEAD` / `INS.TAIL`, never a widened `XCHG` — retyped keepers are exactly what gets dropped. A multi-line `XCHG` whose body restates the line just outside the range is auto-dropped as an off-by-one keeper (with a warning), but issue the payload as the final content for the range only and never lean on the repair.
- NEVER format/restyle code with this tool; run the project formatter instead.
</rules>

<example>
Original (the exact shape `read` returns):
```
[greet.py#A1B2]
1:def greet(name):
2:    msg = "Hello, " + name
3:    print(msg)
4:greet("world")
```

Insert a guard after line 1:
```
[greet.py#A1B2]
INS.POST 1:
+    if not name: name = "stranger"
```

Replace line 2 with two lines:
```
[greet.py#A1B2]
XCHG 2..2:
+    greeting = "Hi"
+    msg = f"{greeting}, {name}"
```

Delete line 3:
```
[greet.py#A1B2]
DEL 3
```

Add a header and trailer:
```
[greet.py#A1B2]
INS.HEAD:
+# generated header
INS.TAIL:
+greet("everyone")
```

Replace the whole `greet` function block — `XCHG.BLK 1:` resolves lines 1–3 (the `def` header through `print(msg)`); line 4 is a separate statement and stays:
```
[greet.py#A1B2]
XCHG.BLK 1:
+def greet(name):
+    print(f"Hello, {name}")
```

A decorator or doc-comment is a SEPARATE block — `XCHG.BLK` on the `def`/`fn` line keeps it. Point N at the decorator to take both; here line 1 is `@cache`, so anchoring on the `def` (line 2) would resolve only the function and orphan `@cache`:
```
[svc.py#C3D4]
XCHG.BLK 1:
+@cache
+def load(key):
+    return store[key]
```
</example>

<anti-patterns>
# WRONG — empty `XCHG` to delete. RIGHT: DEL 4
XCHG 4..4:

# WRONG — range describes post-edit size. RIGHT: XCHG 1..1: (body length is irrelevant)
XCHG 1..2:
+def greet(name):

# WRONG — `-` rows / bare context lines do not exist. The range deletes; the body is only the new content.
XCHG 3..3:
    msg = "Hello, " + name
-   print(msg)
+   return msg
# RIGHT
XCHG 3..3:
+   return msg

# WRONG — a pure insertion done as a widened `XCHG`: you only want to add one line after 2,
# but you replace 2..4, retype the keepers in the body, and drop one (here line 4, `greet("world")`).
XCHG 2..4:
+    msg = "Hello, " + name
+    extra = compute(name)
+    print(msg)
# RIGHT — touch nothing you keep; the new line is the whole body.
INS.POST 2:
+    extra = compute(name)

# WRONG — `INS.BLK.POST N:` anchored on a closing delimiter / last visible line. RIGHT: plain `INS.POST M:`
INS.BLK.POST 3:
+after()
# RIGHT
INS.POST 3:
+after()
</anti-patterns>

<critical>
If you remember nothing else:
1. RE-GROUND AFTER EVERY EDIT. Every apply mints a fresh `#TAG` and renumbers — take the next edit's numbers from the edit response or a fresh `read`. Stale tag or surprise? STOP, re-`read`.
2. RANGES ARE TIGHT. Cover only lines that change; a stale wide range shreds everything it spans. Whole construct → `XCHG.BLK N`.
3. THE BODY IS THE FINAL CONTENT. Only `+TEXT` rows; never `-old`/context lines. The range does the deleting.
</critical>

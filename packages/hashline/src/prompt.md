Patch language names lines to replace, delete, or insert at, then lists new content. Rule of thumb: header ending `:` followed by `+` body rows; `delete` has no body.

<headers>
Every file section starts `¶PATH#TAG`. `TAG` is 4-hex snapshot tag from latest `read`/`search`, REQUIRED on every section — no hashless form. To create new file, use `write` tool; hashline only edits files already exist.
</headers>

<ops>
replace N..M:      replace original lines N..M with body rows below.
replace block N: replace whole syntactic block BEGINNING line N — header through closing line — resolved tree-sitter. Body rows below. Point N at line OPENING construct (the `if`/`function`/`def`/`{`-bearing line), not closing `}` or blank.
delete N..M: delete original lines N..M. No body.
delete block N: delete whole syntactic block BEGINNING line N.
insert before N: insert body rows immediately before line N.
insert after N: insert body rows immediately after line N.
insert head: insert body rows at very start of file.
insert tail: insert body rows at file end.
Single line: `replace N..N:` / `delete N`. Range is ORIGINAL lines touched; body length irrelevant (replacing 1 line with 10 still `replace N..N:`).
</ops>

<body-rows>
Body rows appear only under `:` header. Every body row is:
+TEXT adds new literal line `TEXT`, verbatim (leading whitespace kept). `+` alone adds blank line.
NO other body row kind. NEVER write `-old` or bare/context line. To keep line, leave out of every range. To insert literal line starting `-` or `+`, prefix: `+-x`, `++x`.
</body-rows>

<rules>
- Line numbers from `read`/`search` (`LINE:TEXT`). Copy `¶PATH#TAG` header; use bare LINE numbers.
- Numbers refer to ORIGINAL file; stay valid whole patch — do not shift as hunks apply.
- Across calls NOT survive: each applied edit mints fresh `#TAG`, renumbers file, so tag and line numbers just used are dead. Anchor next edit on `¶PATH#TAG` and lines from edit response (or re-`read`), never on pre-edit numbers.
- Line number is offset, not structural boundary: NEVER `insert after N` into construct not read, NEVER start or end `replace`/`delete` range mid-expression or mid-block. If unsure what on those lines, `read` first.
- On stale-tag rejection — or any result you cannot fully account for — STOP and re-`read`. NEVER stack more line-numbered edits onto output you have not re-grounded; that compounds corruption.
- One hunk per range; body is final content, NEVER old/new pair.
- Keep every range tight as the change: range MUST cover ONLY lines whose content actually changes. NEVER widen to swallow unchanged signature, brace, or neighboring statement just to rewrite few lines inside — change one line with `replace N..N`, not whole block around it. (Range where every line genuinely changes is correctly long; tightness is about excluding unchanged lines, not about being short.) This bounds blast radius if number off: stale single-line replace corrupts one line, while stale block replace shreds whole block and its structure.
- To change lines 2 and 5 while keeping 3–4, issue two hunks (`replace 2..2:` and `replace 5..5:`). Untouched lines absent from every range.
- NEVER use this tool to format code — reordering imports, re-indenting, aligning columns, any mechanical restyling. That is project formatter's job; run it instead of hand-editing layout here.
</rules>

<example>
Original (exact shape `read` returns):
```
¶greet.py#A1B2
1:def greet(name):
2:    msg = "Hello, " + name
3:    print(msg)
4:greet("world")
```

Insert guard after line 1:
```
¶greet.py#A1B2
insert after 1:
+    if not name: name = "stranger"
```

Replace line 2 with two lines:
```
¶greet.py#A1B2
replace 2..2:
+    greeting = "Hi"
+    msg = f"{greeting}, {name}"
```

Delete line 3:
```
¶greet.py#A1B2
delete 3
```

Add header and trailer:
```
¶greet.py#A1B2
insert head:
+# generated header
insert tail:
+greet("everyone")
```

Replace whole `greet` function block — `replace block 1:` resolves lines 1–3 (the `def` header through `print(msg)`); line 4 separate statement, stays:
```
¶greet.py#A1B2
replace block 1:
+def greet(name):
+    print(f"Hello, {name}")
```
</example>

<anti-patterns>
# WRONG — empty `replace` to delete. RIGHT: delete 4
replace 4..4:

# WRONG — range describes post-edit size. RIGHT: replace 1..1: (body length is irrelevant)
replace 1..2:
+def greet(name):

# WRONG — `-` rows / bare context lines do not exist. The range deletes; the body is only the new content.
replace 3..3:
    msg = "Hello, " + name
-   print(msg)
+   return msg
# RIGHT
replace 3..3:
+   return msg
</anti-patterns>

<critical>
Remember:
1. RE-GROUND AFTER EVERY EDIT. Each applied edit mints fresh `#TAG`, renumbers file — tag and line numbers just used now dead. Take next edit's numbers from edit response or fresh `read`, NEVER from pre-edit memory. On stale-tag rejection or unexpected result, STOP and re-`read`.
2. RANGES TIGHT IN-BOUNDS. Cover only lines whose content actually changes; NEVER widen range to swallow unchanged signature, brace, or statement, NEVER start or end range mid-expression or mid-block. Stale single-line replace corrupts one line; stale block replace shreds whole block.
3. BODY IS FINAL CONTENT. Only `+TEXT` rows under `:` header — NEVER `-old`/bare context lines, NEVER old/new pair. Range does deleting.
</critical>

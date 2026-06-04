Your patch language names lines to replace, delete, or insert at, then lists the new content. Rule of thumb: a header ending in `:` is followed by `+` body rows; `delete` has no body.

<headers>
Every file section starts with `¶PATH#TAG`. `TAG` is the 4-hex snapshot tag from your latest `read`/`search`, and is REQUIRED on every section — there is no hashless form. To create a new file, use the `write` tool; hashline only edits files that already exist.
</headers>

<ops>
replace N..M:      replace original lines N..M with the body rows below.
replace block N:   replace the whole syntactic block that BEGINS on line N — its header line through its closing line — resolved with tree-sitter. Body rows below. Point N at the line that OPENS the construct (the `if`/`function`/`def`/`{`-bearing line), not a closing `}` or a blank line.
delete N..M        delete original lines N..M. No body.
delete block N     delete the whole syntactic block that BEGINS on line N.
insert before N:   insert the body rows immediately before line N.
insert after N:    insert the body rows immediately after line N.
insert head:       insert the body rows at the very start of the file.
insert tail:       insert the body rows at the very end of the file.
Single line: `replace N..N:` / `delete N`. The range is the ORIGINAL lines you touch; body length is irrelevant (replacing 1 line with 10 is still `replace N..N:`).
</ops>

<body-rows>
Body rows appear only under a `:` header. Every body row is:
  +TEXT     add a new literal line `TEXT`, verbatim (leading whitespace kept). `+` alone adds a blank line.
There is NO other body row kind. NEVER write `-old` or a bare/context line. To keep a line, leave it out of every range. To insert a literal line starting with `-` or `+`, prefix it: `+-x`, `++x`.
</body-rows>

<rules>
- Line numbers come from `read`/`search` (`LINE:TEXT`). Copy the `¶PATH#TAG` header; use the bare LINE numbers.
- Numbers refer to the ORIGINAL file and stay valid for the whole patch — they do not shift as hunks apply.
- Across calls they do NOT survive: each applied edit mints a fresh `#TAG` and renumbers the file, so the tag and line numbers you just used are dead. Anchor the next edit on the `¶PATH#TAG` and lines from the edit response (or re-`read`), never on pre-edit numbers.
- A line number is an offset, not a structural boundary: never `insert after N` into a construct you have not read, and never start or end a `replace`/`delete` range mid-expression or mid-block. If unsure what is on those lines, `read` them first.
- On a stale-tag rejection — or any result you cannot fully account for — STOP and re-`read`. Never stack more line-numbered edits onto output you have not re-grounded; that compounds corruption.
- One hunk per range; the body is the final content, never an old/new pair.
- Keep every range as tight as the change: a range must cover ONLY lines whose content actually changes. Never widen it to swallow an unchanged signature, brace, or neighboring statement just to rewrite a few lines inside — change one line with `replace N..N`, not the whole block around it. (A range where every line genuinely changes is correctly long; tightness is about excluding unchanged lines, not about being short.) This bounds the blast radius if a number is off: a stale single-line replace corrupts one line, while a stale block replace shreds the whole block and its structure.
- To change lines 2 and 5 while keeping 3–4, issue two hunks (`replace 2..2:` and `replace 5..5:`). Untouched lines are simply absent from every range.
- NEVER use this tool to format code — reordering imports, re-indenting, aligning columns, or any mechanical restyling. That is the project formatter's job; run it instead of hand-editing layout here.
</rules>

<example>
Original (the exact shape `read` returns):
```
¶greet.py#A1B2
1:def greet(name):
2:    msg = "Hello, " + name
3:    print(msg)
4:greet("world")
```

Insert a guard after line 1:
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

Add a header and trailer:
```
¶greet.py#A1B2
insert head:
+# generated header
insert tail:
+greet("everyone")
```

Replace the whole `greet` function block — `replace block 1:` resolves lines 1–3 (the `def` header through `print(msg)`); line 4 is a separate statement and stays:
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
If you remember nothing else:
1. RE-GROUND AFTER EVERY EDIT. Each applied edit mints a fresh `#TAG` and renumbers the file — the tag and line numbers you just used are now dead. Take the next edit's numbers from the edit response or a fresh `read`, never from pre-edit memory. On a stale-tag rejection or any unexpected result, STOP and re-`read`.
2. RANGES ARE TIGHT AND IN-BOUNDS. Cover only lines whose content actually changes; never widen a range to swallow an unchanged signature, brace, or statement, and never start or end a range mid-expression or mid-block. A stale single-line replace corrupts one line; a stale block replace shreds the whole block.
3. THE BODY IS THE FINAL CONTENT. Only `+TEXT` rows under a `:` header — never `-old`/bare context lines, never an old/new pair. The range does the deleting.
</critical>

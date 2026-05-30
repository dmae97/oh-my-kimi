Your patch language names lines to replace, delete, or insert at, then lists the new content. Rule of thumb: a header ending in `:` is followed by `+` body rows; `delete` has no body.

<headers>
Every file section starts with `¶PATH#TAG`. `TAG` is the 3-char snapshot tag from your latest `read`/`search`. REQUIRED for any hunk that names line numbers. Hashless `¶PATH` is allowed only for new-file creation or a patch that is purely `insert head:` / `insert tail:`.
</headers>

<ops>
replace N..M:      replace original lines N..M with the body rows below.
delete N..M        delete original lines N..M. No body.
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
- One hunk per range; the body is the final content, never an old/new pair.
- To change lines 2 and 5 while keeping 3–4, issue two hunks (`replace 2..2:` and `replace 5..5:`). Untouched lines are simply absent from every range.
</rules>

<example>
Original (the exact shape `read` returns):
```
¶greet.py#A1
1:def greet(name):
2:    msg = "Hello, " + name
3:    print(msg)
4:greet("world")
```

Insert a guard after line 1:
```
¶greet.py#A1
insert after 1:
+    if not name: name = "stranger"
```

Replace line 2 with two lines:
```
¶greet.py#A1
replace 2..2:
+    greeting = "Hi"
+    msg = f"{greeting}, {name}"
```

Delete line 3:
```
¶greet.py#A1
delete 3
```

Add a header and trailer:
```
¶greet.py#A1
insert head:
+# generated header
insert tail:
+greet("everyone")
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

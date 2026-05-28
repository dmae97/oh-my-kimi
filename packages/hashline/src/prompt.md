Your patch language selects ranges of file lines and rewrites them. Each hunk picks a range and lists its new content; an empty body deletes the range.

<body-rows>
Every body row is **exactly one** of two kinds:
  +TEXT     add a new literal line `TEXT` (verbatim, leading whitespace included)
  &A..B     copy lines A..B from snapshot
</body-rows>

<anchors>
```
A B             select lines A..B; the body rows below describe their new content
                (empty body = delete the range). Always TWO numbers — single
                lines are spelled `A A`.
BOF             virtual position before line 1; body rows insert there
EOF             virtual position after the last line; body rows insert there
```

A hunk header is **just the anchor on its own line** — no `@@`, no brackets, no prefix.
</anchors>

<header>
Every file section starts with `¶PATH#HASH`. `HASH` is the snapshot tag from your latest `read`/`search` of that file. It is required whenever a hunk uses a numeric anchor. Hashless `¶PATH` is only valid for new-file creation or BOF/EOF-only patches.
</header>

<rules>
- Anchors are line **numbers**, never line **content**, and always come in PAIRS. `read` shows each file row as `LINE:TEXT`; for a patch the hunk header is `4 4` (single line) or `4 7` (range), and the body is `+TEXT` (or `&4` to keep it).
- A bare single number (`4`) is REJECTED — always write two numbers.
- `A B` describes the **original** lines you are replacing. Replacing one line with ten new lines is still `4 4`, NOT `4 13`.
- Each range may appear in only ONE hunk per patch.
- Line numbers refer to the ORIGINAL file and stay valid for the whole patch — they do not shift as your hunks land.
- An empty body **deletes** the selected range entirely. To replace lines A..B with completely new content, list the new content under the hunk header (do not write `&A..B` for the lines you are replacing).
- `@@` is NOT a hashline construct. Do not wrap headers in `@@ ... @@` — write the anchor bare.
</rules>


<example>
This is the original file (the exact shape `read` returns):
```
¶greet.py#A1
1:def greet(name):
2:    msg = "Hello, " + name
3:    print(msg)
4:greet("world")
```

# To insert a guard as the first line of greet:
```
¶greet.py#A1
1 1
&1
+    if not name: name = "stranger"
```

# Replace line 2 with two new lines.
```
2 2
+    greeting = "Hi"
+    msg = f"{greeting}, {name}"
```

# Delete line 4.
```
¶greet.py#A1
4 4
```

# Add header & trailer.
```
¶greet.py#A1
BOF
+# generated header
EOF
+greet("everyone")
```
</example>

<anti-patterns>
# WRONG — range set based on what it will be (RIGHT: 1 1, inserted line count doesn't matter)
1 2
+def greet(name):
+    """Greet a user by name."""

# WRONG — do not include context lines, nor delete old lines, the selector `2 2` itself deletes the entire range
3 3
    msg = "Hello, " + name
-   print(msg)
+   return msg
</anti-patterns>

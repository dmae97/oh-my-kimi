Your patch language selects ranges of file lines and rewrites them. Each hunk picks a range and lists its new content; an empty body deletes the range.

<body-rows>
Every body row is **exactly one** of two kinds:

  +TEXT     add a new literal line `TEXT` (verbatim, leading whitespace included)
  &A..B     keep original lines A..B as-is

`+` and `&` are siblings, not stackable. Never write `+&…`. A row starts with one of them, never both.
</body-rows>

<example>
This is the original file (the exact shape `read` returns):
```
¶greet.ts#0A3
1:export function greet(name: string): string {
2:  return `Hello, ${name}!`;
3:}
```

To add a null check between the signature and the return, open a hunk on lines 1..3 and list its new content:
```
¶greet.ts#0A3
1 3
&1
+  if (!name) return "Hello, stranger!";
&2..3
```

The body says: keep line 1, then add the new literal line, then keep lines 2..3. Result:
```
1:export function greet(name: string): string {
2:  if (!name) return "Hello, stranger!";
3:  return `Hello, ${name}!`;
4:}
```
</example>

<anchors>
```
A B             select lines A..B; the body rows below describe their new content
                (empty body = delete the range)
A               select single line A (shorthand for `A A`)
BOF             virtual position before line 1; body rows insert there
EOF             virtual position after the last line; body rows insert there
```

A hunk header is **just the anchor on its own line** — no `@@`, no brackets, no prefix.
</anchors>

<header>
Every file section starts with `¶PATH#HASH`. `HASH` is the snapshot tag from your latest `read`/`search` of that file. It is required whenever a hunk uses a numeric anchor. Hashless `¶PATH` is only valid for new-file creation or BOF/EOF-only patches.
</header>

<rules>
- Anchors are line **numbers**, never line **content**. `read` shows each file row as `LINE:TEXT`; for a patch the hunk header is `4` (or `4 4`) and the body is `+TEXT` (or `&4` to keep it).
- Each range may appear in only ONE hunk per patch.
- Line numbers refer to the ORIGINAL file and stay valid for the whole patch — they do not shift as your hunks land.
- An empty body **deletes** the selected range entirely. To replace lines A..B with completely new content, list the new content under the hunk header (do not write `&A..B` for the lines you are replacing).
- `@@` is NOT a hashline construct. Do not wrap headers in `@@ ... @@` — write the anchor bare.
</rules>

<more-examples>
# Replace line 1 of `greet.ts#0A3` with two new lines.
```
¶greet.ts#0A3
1
+const X = "b";
+export const Y = X;
```

# Delete lines 2..3 of `greet.ts#0A3`.
```
¶greet.ts#0A3
2 3
```

# Prepend a header.
```
¶greet.ts#0A3
BOF
+// generated header
```
</more-examples>

<anti-patterns>
# WRONG — do not include old lines.
2 3
- print "hello"
+ print "hi"

# WRONG — do not include context lines.
2 3
 fn hi():
+ print "hi"

# WRONG — no `@@` brackets in hashline.
@@ 2..3 @@
+ print "hi"

# RIGHT — same intent, well-formed.
2 3
+ print "hi"
</anti-patterns>

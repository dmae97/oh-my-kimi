Your patch language selects ranges of file lines and rewrites them. The body rows below an anchor describe the new content of the selected range.

<body-rows>
Every body row is **exactly one** of two kinds:

  +TEXT     add a new literal line `TEXT` (verbatim, leading whitespace included)
  ^A-B      keep original lines A..B as-is

`+` and `^` are siblings, not stackable. Never write `+^…`. A row starts with one of them, never both.
</body-rows>

<example>
This is the original file (the exact shape `read` returns):
```
¶greet.ts#0A3
1:export function greet(name: string): string {
2:  return `Hello, ${name}!`;
3:}
```

To add a null check between the signature and the return, select lines 1..3 and rewrite:
```
¶greet.ts#0A3
1-3:
^1-1
+  if (!name) return "Hello, stranger!";
^2-3
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
A-B:            select lines A..B; the body rows below describe their new content
A-B:-           delete lines A..B (no body)
BOF:            virtual position before line 1; body rows insert there
EOF:            virtual position after the last line; body rows insert there
```
`A-A:` for one line is preferred over the bare shorthand `A:`. `BOF:` / `EOF:` take no range.
</anchors>

<header>
Every section starts with `¶PATH#HASH`. `HASH` is the snapshot tag from your latest `read`/`search` of that file. It is required whenever a block uses a line-number anchor (`A-B:` or `A-B:-`). Hashless `¶PATH` is only valid for new-file creation or BOF/EOF-only patches.
</header>

<rules>
- Anchors are line **numbers**, never line **content**. `read` shows each file row as `LINE:TEXT`; for a patch the anchor is `4-4:` and the body is `+TEXT` (or `^4-4` to keep it).
- Each range may appear in only ONE block per patch.
- Line numbers refer to the ORIGINAL file and stay valid for the whole patch — they do not shift as your blocks land.
- `A-B:` with no body replaces the range with ONE blank line. To **delete** the lines entirely, use `A-B:-`.
- If you want to replace lines A..B with completely new content, just list the new content; do not write `^A-B`.
</rules>

<more-examples>
# Replace line 1 of `greet.ts#0A3` with two new lines.
```
¶greet.ts#0A3
1-1:
+const X = "b";
+export const Y = X;
```

# Delete lines 2..3 of `greet.ts#0A3`.
```
¶greet.ts#0A3
2-3:-
```

# Prepend a header.
```
¶greet.ts#0A3
BOF:
+// generated header
```
</more-examples>

<anti-patterns>
# WRONG — two blocks expressing old → new. Rejected as overlap.
1-1:
1-1:-

# WRONG — `A-A:` with no body REPLACES with a blank line. Use `A-A:-` to delete.
2-2:
2-2:-

# WRONG — `read`-output rows pasted as body. Body rows need `+` or `^`.
2-3:
  return `Hello, ${name}!`;
}

# RIGHT — same intent, well-formed.
2-3:
+  return `Hello, ${name}!`;
+}
</anti-patterns>

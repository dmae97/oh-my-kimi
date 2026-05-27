Your patch language is a compact, line-anchored edit format.

<payload>
Patch payload = one or more file sections:
```
¶PATH#HASH
A-B:
|literal line
^A-B
A-B:-
BOF:
|literal at start
EOF:
|literal at end
```
- `HASH` comes from latest `read`/`search`; missing? re-read.
- `A-B:` anchors original lines A..B; use `A-A:` for one line.
- `BOF:`/`EOF:` insert at file start/end.
- `A-B:-` deletes original lines A..B.
- Body rows are linear; output order = row order.
- `|TEXT` emits literal `TEXT`; bare `|` emits blank.
- `^A-B` repeats original lines A..B; one line = `^A-A`.
</payload>

<semantics>
- Concrete `A-B:` body replaces A..B.
- Concrete `A-B:` with no body replaces A..B with one blank line.
- Virtual `BOF:`/`EOF:` body inserts there.
- Virtual empty body inserts one blank line.
- Line numbers are frozen for the whole patch.
</semantics>

<examples>
# Replace line 1 with two lines.
```
¶a.ts#1a2b
1-1:
|const X = "b";
|export const Y = X;
```
# Insert below line 5.
```
¶a.ts#1a2b
5-5:
^5-5
|const Y = X;
```
# Delete lines 5..7: `5-7:-`.
</examples>
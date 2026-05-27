Your patch language is a compact, line-anchored edit format.

<payload>
Patch payload = one or more file sections:

```
¶PATH#HASH
A-B:
|replacement line
↑inserted above line
↓inserted below line
```

- `HASH` comes from the latest `read`/`search` header. Missing? Re-`read`.
- No context rows, no gutters, no unchanged lines.
- Anchor rows are ALWAYS bare: `A-B:`, `A:`, `BOF:`, `EOF:`.
- Payload rows MUST start with `|`, `↑`, or `↓`.
- The first sigil is stripped; remaining bytes are file content.
</payload>

<anchors>
`A-B:` — anchor A..B inclusive.
`A:` — shorthand for `A-A:`.
`BOF:` — virtual position before line 1.
`EOF:` — virtual position after the last line.
</anchors>

<sigils>
`|content` — replace A..B with `content`.
`↑content` — insert `content` before A.
`↓content` — insert `content` after B.
</sigils>

<semantics>
- **No payload → delete.** `5:` deletes line 5.
- **Buckets combine.** `↑` before A, `|` in place, `↓` after B.
- **Bucket order ignores interleaving.** Output order = all `↑`, then `|`/original, then all `↓`.
- **Order within a bucket is preserved.** Two `↑` rows stack top-down.
- **Blank payload = explicit.** Bare `|`, `↑`, or `↓` writes one blank line.
- **Line numbers are frozen.** Later anchors still reference pre-edit lines.
</semantics>

<examples>
# Replace line 1 with two lines; insert one line below the replacement.
```
¶a.ts#1a2b
1:
|const X = "b";
|export const Y = X;
↓const Z = Y;
```

# Insert above line 3. Line 3 survives because there is no `|` row.
```
¶a.ts#1a2b
3:
↑function helper() { return X; }
```

# Delete lines 5..7.
```
¶a.ts#1a2b
5-7:
```

# Replace line 5 with one blank line.
```
¶a.ts#1a2b
5:
|
```
</examples>

<common-failures>
- **NEVER use inline payload.** `5:content` is invalid; write `5:` then `|content`.
- **Do not repeat preserved lines.** If line 5 should survive, omit `|`.
- **`↑`/`↓` payloads are new bytes only.** Never echo the anchor or a neighbor line — that line already exists; copying it into a `↓` row appends a duplicate.
- **Do not echo read gutters.** `84:content` is not payload.
- **Do not replay past B.** Stop before B+1; widen the anchor if B+1 changes.
- **NEVER fabricate file hashes.** Missing? Re-`read`.
</common-failures>

<anti-pattern>
# WRONG — inline payload after anchor.
5:const X = "b";
# RIGHT
5:
|const X = "b";

# WRONG — replacing line 5 just to keep it while inserting above.
5:
↑const Y = X;
|const X = "a";
# RIGHT — no `|`; line 5 survives automatically.
5:
↑const Y = X;

# WRONG — echoing the anchor into a ↓ payload duplicates it.
# Line 5 already contains `const X = 1;`.
5:
↓const X = 1;
↓const Y = 2;
# RIGHT — payload is only the new line; the anchor survives automatically.
5:
↓const Y = 2;

# WRONG — read-output gutters inside payload.
5-6:
5:const X = "b";
6:export const Y = X;
# RIGHT
5-6:
|const X = "b";
|export const Y = X;

# WRONG — line numbers shifted mentally after the first block.
1:
↓new line
2:
↓another new line
# `2:` still targets original line 2, not `new line`.
</anti-pattern>

<critical>
- Anchor rows are bare ranges ending in `:`.
- Payload rows start with `|`, `↑`, or `↓`.
- `|` means replace anchored lines.
- Only `↑`/`↓` means preserve anchored lines.
- Payload is only new content; no context rows.
</critical>

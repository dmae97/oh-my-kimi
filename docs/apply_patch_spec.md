# `apply_patch`: Codex Patch Format Specification

This document is a full, reimplementation-quality specification of the `apply_patch`
tool used by the Codex coding harness. It covers:

1. How the tool is exposed to the model (schema + freeform grammar variants).
2. The exact prompt / instruction text shown to the model.
3. The patch format grammar.
4. The parser (lexical rules, lenient mode, streaming mode, errors).
5. The application algorithm (Add / Delete / Update / Move), including the
   `seek_sequence` fuzzy matcher.
6. Invocation forms the harness accepts (freeform args, JSON args, shell
   heredoc wrappers, stdin).
7. Result presentation and error reporting.
8. Test-derived edge cases.

All normative behavior below is drawn from the `codex-rs/apply-patch` crate
(the parser in `src/parser.rs`, the applier in `src/lib.rs`, the matcher in
`src/seek_sequence.rs`) and the tool registration in `codex-rs/tools`.

---

## 1. Tool registration

`apply_patch` is registered in the tool registry when the current model's
`apply_patch_tool_type` metadata is set (see
`codex-rs/models-manager/models.json` — GPT-5.x variants use `"freeform"`;
older / non-reasoning models use `"function"`). It is registered as
`supports_parallel_tool_calls = false`, meaning the harness will not issue
two concurrent `apply_patch` calls. (Registration in
`codex-rs/tools/src/tool_registry_plan.rs`.)

There are two wire formats for the same underlying command.

### 1.1 Freeform (GPT-5 and later)

The freeform variant uses OpenAI's custom-tool mechanism: the model emits a
single opaque string whose shape is constrained by a Lark grammar.

```jsonc
{
  "type": "custom",
  "name": "apply_patch",
  "description": "Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
  "format": {
    "type": "grammar",
    "syntax": "lark",
    "definition": "<see §3.2>"
  }
}
```

(See `codex-rs/tools/src/apply_patch_tool.rs::create_apply_patch_freeform_tool`.)

The freeform call payload is the patch text itself — no JSON envelope, no
wrapping quotes. Example (the model types this verbatim as the tool's
"input"):

```
*** Begin Patch
*** Add File: hello.txt
+Hello, world!
*** End Patch
```

### 1.2 JSON function (legacy / gpt-oss)

For providers that only support function-style tool calls, a JSON variant is
registered:

```jsonc
{
  "type": "function",
  "name": "apply_patch",
  "description": "<APPLY_PATCH_JSON_TOOL_DESCRIPTION, see §2>",
  "strict": false,
  "parameters": {
    "type": "object",
    "additionalProperties": false,
    "required": ["input"],
    "properties": {
      "input": {
        "type": "string",
        "description": "The entire contents of the apply_patch command"
      }
    }
  }
}
```

(See `codex-rs/tools/src/apply_patch_tool.rs::create_apply_patch_json_tool`.)

### 1.3 Handler dispatch

Both variants land in the same handler, which normalizes the arguments into
`ApplyPatchToolArgs { input: String }` and passes `input` to
`apply_patch::apply_patch(...)` (see
`codex-rs/core/src/tools/handlers/apply_patch.rs`). The `input` is the full
patch text, including the `*** Begin Patch` / `*** End Patch` envelope.

---

## 2. Agent prompt (verbatim)

The model is taught the format via two equivalent pieces of text: the
Markdown file `codex-rs/apply-patch/apply_patch_tool_instructions.md`
(embedded in system prompts), and the string constant
`APPLY_PATCH_JSON_TOOL_DESCRIPTION` in
`codex-rs/tools/src/apply_patch_tool.rs` which is used as the JSON tool's
`description`. They are identical in content.

A reimplementation SHOULD ship the following text verbatim (note: the
original uses Unicode curly quotes in a few places — they are reproduced
here; the final "smart quote" versus "typewriter quote" choice is not
semantic):

````markdown
## `apply_patch`

Use the `apply_patch` shell command to edit files.
Your patch language is a stripped‑down, file‑oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high‑level envelope:

*** Begin Patch
[ one or more file sections ]
*** End Patch

Within that envelope, you get a sequence of file operations.
You MUST include a header to specify the action you are taking.
Each operation starts with one of three headers:

*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).
*** Delete File: <path> - remove an existing file. Nothing follows.
*** Update File: <path> - patch an existing file in place (optionally with a rename).

May be immediately followed by *** Move to: <new path> if you want to rename the file.
Then one or more "hunks", each introduced by @@ (optionally followed by a hunk header).
Within a hunk each line starts with:

For instructions on [context_before] and [context_after]:
- By default, show 3 lines of code immediately above and 3 lines immediately below each change. If a change is within 3 lines of a previous change, do NOT duplicate the first change's [context_after] lines in the second change's [context_before] lines.
- If 3 lines of context is insufficient to uniquely identify the snippet of code within the file, use the @@ operator to indicate the class or function to which the snippet belongs. For instance, we might have:
@@ class BaseClass
[3 lines of pre-context]
- [old_code]
+ [new_code]
[3 lines of post-context]

- If a code block is repeated so many times in a class or function such that even a single `@@` statement and 3 lines of context cannot uniquely identify the snippet of code, you can use multiple `@@` statements to jump to the right context. For instance:

@@ class BaseClass
@@ 	 def method():
[3 lines of pre-context]
- [old_code]
+ [new_code]
[3 lines of post-context]

The full grammar definition is below:
Patch := Begin { FileOp } End
Begin := "*** Begin Patch" NEWLINE
End := "*** End Patch" NEWLINE
FileOp := AddFile | DeleteFile | UpdateFile
AddFile := "*** Add File: " path NEWLINE { "+" line NEWLINE }
DeleteFile := "*** Delete File: " path NEWLINE
UpdateFile := "*** Update File: " path NEWLINE [ MoveTo ] { Hunk }
MoveTo := "*** Move to: " newPath NEWLINE
Hunk := "@@" [ header ] NEWLINE { HunkLine } [ "*** End of File" NEWLINE ]
HunkLine := (" " | "-" | "+") text NEWLINE

A full patch can combine several operations:

*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch

It is important to remember:

- You must include a header with your intended action (Add/Delete/Update)
- You must prefix new lines with `+` even when creating a new file
- File references can only be relative, NEVER ABSOLUTE.

You can invoke apply_patch like:

```
shell {"command":["apply_patch","*** Begin Patch\n*** Add File: hello.txt\n+Hello, world!\n*** End Patch\n"]}
```
````

Notes for implementers:

- The "You can invoke apply_patch like ..." footer is only shown when the
  patch command is exposed as a `shell` command (the `codex` fallback path).
  When the freeform tool is registered, the model invokes the tool directly
  and the footer is redundant but harmless.
- The prompt asserts some things the parser is lenient about in practice:
  - *"File references can only be relative"* — the parser accepts absolute
    paths, but the model is instructed to produce relative ones.
  - *"+ line even when creating a new file"* — `+` MUST be the first
    character of every content line in an Add File section.

---

## 3. Patch grammar

### 3.1 EBNF (canonical)

```
Patch    := Begin { FileOp }+ End
Begin    := "*** Begin Patch" NEWLINE
End      := "*** End Patch" [NEWLINE]

FileOp   := AddFile | DeleteFile | UpdateFile
AddFile  := "*** Add File: " path NEWLINE { "+" text NEWLINE }+
DeleteFile := "*** Delete File: " path NEWLINE
UpdateFile := "*** Update File: " path NEWLINE
             [ "*** Move to: " path NEWLINE ]
             Change?

Change   := (ChangeContext | ChangeLine)+ EofLine?
ChangeContext := ("@@" | "@@ " text) NEWLINE
ChangeLine    := (" " | "-" | "+") text NEWLINE
EofLine       := "*** End of File" NEWLINE
```

The Lark grammar that the OpenAI freeform tool uses to constrain model
output is in `codex-rs/tools/src/tool_apply_patch.lark`:

```lark
start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
```

### 3.2 Reserved tokens

| Token                        | Meaning                                                         |
| ---------------------------- | --------------------------------------------------------------- |
| `*** Begin Patch`            | Required first significant line of the envelope.                |
| `*** End Patch`              | Required last significant line (trailing LF optional).          |
| `*** Add File: <path>`       | Start of an Add File section.                                   |
| `*** Delete File: <path>`    | Standalone Delete File directive.                               |
| `*** Update File: <path>`    | Start of an Update File section.                                |
| `*** Move to: <path>`        | Optional rename target, immediately after `*** Update File:`.   |
| `@@` or `@@ <header>`        | Starts a chunk inside an Update File.                           |
| `*** End of File`            | Terminates a chunk; asserts the chunk ended at EOF.             |
| `+<text>` / `-<text>` / ` <text>` | Added / deleted / context line inside a chunk.              |

Action headers match **with a trailing space**: the parser uses literal
`strip_prefix("*** Add File: ")` etc. Everything after the space is the
path; no escaping, no quoting.

### 3.3 Lines and newlines

- Input is split on `\n` (LF only). CRLF is not supported by the parser —
  producers MUST use LF. (Tool output goes through Rust string handling which
  preserves CRs as literal bytes on the content lines, which then fail to
  match.)
- Each content line in a hunk starts with exactly one byte (`+`, `-`, or
  space) followed by the line's text and then a newline. An empty ` `-prefixed
  line is representable as a single space followed by LF; a bare `+\n` is a
  one-character added empty line.
- A completely blank line (no prefix byte at all) inside an Update File
  section is **skipped**, and is used only for visual separation between
  chunks. This is a deliberate leniency; do not rely on blank lines to carry
  data.

---

## 4. Parser

Implementation: `codex-rs/apply-patch/src/parser.rs`.

### 4.1 Public entry points

- `parse_patch(text: &str) -> Result<ApplyPatchArgs, ParseError>` —
  production parse. Uses `ParseMode::Lenient` (see §4.3).
- `parse_patch_streaming(text: &str) -> Result<ApplyPatchArgs, ParseError>` —
  same format, but tolerates a missing `*** End Patch` (the harness calls
  this from a streaming response handler to show progress). Its output
  MUST NOT be used to actually apply the patch.

The result is:

```rust
pub struct ApplyPatchArgs {
    pub patch:   String,          // canonicalized patch text (heredoc stripped)
    pub hunks:   Vec<Hunk>,
    pub workdir: Option<String>,  // populated only when parsing a shell
                                  // invocation that begins with `cd <path> &&`
}
```

### 4.2 Lexical canonicalization

Before parsing, the input is `trim()`ed, then split into lines by `\n`.
Marker-line matching is done against `line.trim()`, so arbitrary
leading/trailing whitespace around the sentinel lines (`*** Begin Patch`,
etc.) is accepted. Content lines (those starting with `+`, `-`, ` `) are
NOT trimmed — their whitespace is significant.

### 4.3 Parse modes

The parser operates in one of three modes:

1. **Strict** — requires line 0 = `*** Begin Patch` and the last line to be
   `*** End Patch`. Not used by the harness today (`PARSE_IN_STRICT_MODE =
   false`); retained as a fallback.

2. **Lenient** (default). Tries strict first. If that fails, attempts to
   strip a heredoc wrapper: the first line must be exactly one of
   `<<EOF`, `<<'EOF'`, or `<<"EOF"`, and the last line must be `EOF`. The
   inner region is then parsed strictly. This was introduced to handle
   gpt-4.1, which insisted on wrapping the patch in a heredoc body.
   Mismatched quotes (e.g. `<<"EOF'`) are rejected.

3. **Streaming** — requires `*** Begin Patch` but does NOT require
   `*** End Patch`. Individual hunks are parsed on a best-effort basis; the
   last incomplete hunk is dropped. Used for progress UI only.

### 4.4 Hunk parsing state machine

```
loop:
    trim line[i]
    if line[i] starts with "*** End Patch":  break
    match line[i].strip_prefix(...):
        "*** Add File: "     -> parse AddFile
        "*** Delete File: "  -> parse DeleteFile
        "*** Update File: "  -> parse UpdateFile
        otherwise             -> InvalidHunkError at line i
```

**AddFile** consumes subsequent lines while they start with `+`. Each line
becomes one element of `contents`, with the leading `+` stripped. The lines
are joined with `\n`; an additional `\n` is appended after the join so the
resulting file ends with exactly one newline.

**DeleteFile** consumes only the header line; no content follows.

**UpdateFile** consumes the header, optionally a `*** Move to: <path>` line,
then zero or more chunks. The UpdateFile section ends when the next line
starts with `***` (the next hunk header, or `*** End Patch`) or input is
exhausted. An UpdateFile section with zero chunks is an error
(`"Update file hunk for path '<p>' is empty"`).

**Chunk** parsing within an UpdateFile:

```
chunk:
    optional context line:
      "@@"            -> change_context = None      (empty marker)
      "@@ <header>"   -> change_context = Some("<header>")
      otherwise       -> if this is the FIRST chunk of the hunk, fall through
                         (context-less first chunk); otherwise error.
    then:
      loop over lines:
        if line starts with "*"  -> stop (end of chunk; next hunk or end)
        if line == ""             -> append empty string to BOTH old_lines
                                     and new_lines (empty context line)
        if line starts with ' '   -> append line[1..] to BOTH old_lines and
                                     new_lines
        if line starts with '-'   -> append line[1..] to old_lines
        if line starts with '+'   -> append line[1..] to new_lines
        if line == "*** End of File" -> set is_end_of_file = true, stop
        otherwise                 -> error: unexpected line in update hunk
```

Invariants enforced by the parser:

- A chunk must contain at least one non-context line (pure context chunks
  are rejected).
- `*** End of File` cannot be the first line of a chunk.
- Chunks are stored in order and the applier relies on each chunk's match
  position being ≥ the previous chunk's match position.

### 4.5 Error taxonomy

```rust
pub enum ParseError {
    InvalidPatchError(String),                       // envelope errors
    InvalidHunkError { message: String, line_number: usize }, // content errors
}
```

Specific messages (implementers SHOULD match these literally so tests and
downstream tools keep working):

| Error                                | Condition                                                              |
| ------------------------------------ | ---------------------------------------------------------------------- |
| `The first line of the patch must be '*** Begin Patch'` | Missing/wrong `Begin` marker.                       |
| `The last line of the patch must be '*** End Patch'`    | Missing/wrong `End` marker (strict/lenient only).   |
| `'<line>' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'` | Unknown file-level directive. |
| `Update file hunk for path '<p>' is empty` | UpdateFile section has zero chunks.                              |
| `Expected update hunk to start with a @@ context marker, got: '<line>'` | Missing `@@` when required (non-first chunk). |
| `Update hunk does not contain any lines` | Chunk with a context but no +/-/space line before EOF/next chunk. |
| `Unexpected line found in update hunk: '<line>'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)` | Invalid diff prefix. |

---

## 5. Intermediate representation

```rust
pub enum Hunk {
    AddFile    { path: PathBuf, contents: String },
    DeleteFile { path: PathBuf },
    UpdateFile {
        path: PathBuf,
        move_path: Option<PathBuf>,
        chunks: Vec<UpdateFileChunk>,   // MUST be non-empty
    },
}

pub struct UpdateFileChunk {
    pub change_context: Option<String>, // text after "@@ "; None for bare "@@"
    pub old_lines:     Vec<String>,     // lines to match in the file
    pub new_lines:     Vec<String>,     // replacement lines
    pub is_end_of_file: bool,           // "*** End of File" present
}
```

Paths are stored exactly as the patch wrote them — no canonicalization.
Resolution to an absolute path happens at apply time via
`AbsolutePathBuf::resolve_path_against_base(path, cwd)`.

---

## 6. Application algorithm

Implementation: `codex-rs/apply-patch/src/lib.rs`.

### 6.1 Top-level flow

```
apply_patch(input, cwd, fs, sandbox):
    args := parse_patch(input)?
    if args.hunks is empty: error "No files were modified."
    affected := { added: [], modified: [], deleted: [] }
    for each hunk in args.hunks:
        apply_hunk(hunk, cwd, fs, sandbox, affected)?
    return affected
```

Hunks are applied **in the order they appear in the patch** and **not
atomically**: if hunk N fails, hunks `0..N-1` have already written to disk
and are not rolled back. Hunks `N+1..` are skipped. (Test scenario
`015_failure_after_partial_success_leaves_changes` pins this behavior.)

A reimplementation MAY add transactional semantics, but MUST document the
deviation — callers today rely on partial application being observable.

### 6.2 Add File

```
path_abs := resolve_path_against_base(hunk.path, cwd)
try: fs.write_file(path_abs, contents)
  on NotFound: fs.create_directory(parent(path_abs), { recursive: true })
               fs.write_file(path_abs, contents)
append hunk.path to affected.added
```

Characteristics:

- Parent directories are created on demand (recursive). This is done lazily
  — only after a first write fails with `NotFound`.
- An existing file at `path_abs` is **silently overwritten** (scenario
  `011_add_overwrites_existing_file`). No confirmation, no diff.
- `contents` is the literal joined string from the parser — the parser
  already terminates it with `\n`.

### 6.3 Delete File

```
path_abs := resolve_path_against_base(hunk.path, cwd)
meta := fs.get_metadata(path_abs)
if meta.is_directory: error "path is a directory"
fs.remove(path_abs, { recursive: false, force: false })
append hunk.path to affected.deleted
```

- If the file does not exist, the metadata call returns `NotFound` and the
  whole `apply_patch` fails with `Failed to delete file <p>: ...`.
- Deleting directories is explicitly rejected.

### 6.4 Update File

```
applied := derive_new_contents_from_chunks(path_abs, hunk.chunks, fs)?
if hunk.move_path.is_some():
    dest_abs := resolve_path_against_base(move_path, cwd)
    write_with_missing_parent_retry(dest_abs, applied.new_contents)
    ensure source isn't a directory; fs.remove(path_abs)
else:
    fs.write_file(path_abs, applied.new_contents)
append hunk.path to affected.modified
```

Note: a renamed file is reported as **modified** (`M`) with the original
path, not as `D` + `A`. This is intentional — it mirrors git's rename
detection.

`derive_new_contents_from_chunks`:

```
text := fs.read_file_text(path_abs)        // utf-8, error if missing
lines := text.split('\n')                  // retains trailing '' if text ends '\n'
if lines.last() == "": lines.pop()          // normalize off trailing-\n artifact

replacements := compute_replacements(lines, chunks)?
new_lines := apply_replacements(lines, replacements)
if new_lines.last() != "": new_lines.push("")  // re-add trailing newline
return new_lines.join('\n')
```

Postcondition: **every update produces a file ending in exactly one `\n`**,
regardless of whether the input had one. Reimplementations MAY choose to
preserve "no trailing newline" when present — doing so is a deliberate
deviation.

### 6.5 Computing replacements

```
line_index := 0
replacements := []
for each chunk:
    # 1. If the chunk has a "@@ ctx" marker, locate that line first.
    if chunk.change_context.is_some():
        idx := seek_sequence([ctx], lines, start=line_index, eof=false)?
        line_index := idx + 1        # search for old_lines AFTER ctx

    # 2. Pure-addition chunks (old_lines empty):
    if chunk.old_lines.is_empty():
        insertion_idx := (if lines.last() == "" then lines.len() - 1
                          else lines.len())
        replacements.push((insertion_idx, 0, chunk.new_lines))
        continue

    # 3. Normal replacement: match old_lines in the file.
    pattern := chunk.old_lines
    new_slc := chunk.new_lines
    found := seek_sequence(lines, pattern, line_index, chunk.is_end_of_file)
    if found.is_none() and pattern.last() == "":
        pattern := pattern[..pattern.len()-1]    # drop trailing empty sentinel
        if new_slc.last() == "":
            new_slc := new_slc[..new_slc.len()-1]
        found := seek_sequence(lines, pattern, line_index, chunk.is_end_of_file)
    match found:
        Some(start): replacements.push((start, pattern.len(), new_slc))
                     line_index := start + pattern.len()
        None: error "Failed to find expected lines in <path>:\n<old_lines joined>"

replacements.sort_by_start_index()
```

Key invariants:

- Context (`@@ ctx`) is matched by *one line*; it is a locator only and is
  never modified. After a successful context match, the old_lines search
  begins **immediately after** the context line.
- A chunk's `old_lines` search starts at `line_index` (the cursor after the
  previous chunk), so chunks must appear in file order.
- Pure-addition chunks (no `-` or ` ` lines, only `+`) append at the end of
  the file. They do NOT honor `line_index`; they always go to the end.
- The "trailing empty sentinel" retry exists because unified-diff-style
  tools often emit a blank line at the end of `old_lines` representing the
  file's terminal newline. Our line-splitting strips that element from the
  file, so a literal match fails; we retry with the sentinel removed.

Replacements are then applied **in reverse order of `start_index`** so
earlier edits do not shift later edits' indices:

```
apply_replacements(lines, replacements):
    for (start, old_len, new_seg) in replacements.reversed():
        delete lines[start .. start + old_len]
        insert new_seg at position start
```

### 6.6 `seek_sequence` — the fuzzy matcher

Implementation: `codex-rs/apply-patch/src/seek_sequence.rs`.

Signature:

```rust
fn seek_sequence(
    lines: &[String], pattern: &[String],
    start: usize, eof: bool,
) -> Option<usize>
```

Contract:

- Returns the smallest `i ≥ search_start` such that
  `lines[i..i + pattern.len()]` matches `pattern` under one of four match
  predicates (tried in order). `search_start = lines.len() - pattern.len()`
  if `eof` and the pattern fits, else `start`.
- Empty `pattern` → `Some(start)`.
- `pattern.len() > lines.len()` → `None` (MUST NOT panic).

The four match predicates, tried in order (first success wins):

1. **Exact**. `lines[i + k] == pattern[k]` for all k.
2. **Rstrip**. `lines[i + k].trim_end() == pattern[k].trim_end()`.
3. **Full trim**. `lines[i + k].trim() == pattern[k].trim()`.
4. **Unicode-normalized trim**. Trim, then fold common typographic
   punctuation to ASCII, then compare.

Normalization table (MUST be implemented identically):

| Folded to | Source code points |
| --------- | ------------------ |
| `-`       | U+2010 HYPHEN, U+2011 NON-BREAKING HYPHEN, U+2012 FIGURE DASH, U+2013 EN DASH, U+2014 EM DASH, U+2015 HORIZONTAL BAR, U+2212 MINUS SIGN |
| `'`       | U+2018, U+2019, U+201A, U+201B |
| `"`       | U+201C, U+201D, U+201E, U+201F |
| ` ` (space) | U+00A0 NBSP, U+2002, U+2003, U+2004, U+2005, U+2006, U+2007, U+2008, U+2009, U+200A, U+202F, U+205F, U+3000 |

All other code points are passed through unchanged. This lets the model
emit ASCII hyphens/quotes/spaces even when the source file contains
typographic variants (e.g. an em-dash pasted from a doc).

**Per-chunk EOF hint.** When `eof == true` (set from `is_end_of_file`), the
matcher first tries to match at the tail of the file
(`i = lines.len() - pattern.len()`) before falling through to the normal
forward search from `start`.

**What's deliberately not supported.**

- No "floating" / best-effort match. If all four passes fail, the chunk
  fails; there is no nearest-match heuristic.
- No matching across non-adjacent lines — the pattern must appear as a
  contiguous block.
- No multi-match disambiguation: the **first** match wins. Chunks must
  carry enough context (or a `@@ header`) that the first hit at or after
  `line_index` is the intended one.

---

## 7. Path resolution

- `cwd` is the `AbsolutePathBuf` passed to `apply_patch(...)`. In the CLI /
  harness it defaults to the process working directory, possibly further
  qualified by a workdir extracted from a `cd X && apply_patch <<EOF` shell
  invocation (§8.3).
- `resolve_path_against_base(path, cwd)`:
  - If `path` is absolute → `path` (cwd is ignored).
  - If `path` is relative → `cwd.join(path)`.
- The patch grammar does not define an escape mechanism. Paths containing
  spaces, tabs, or Unicode are supported as-is (the parser takes the full
  rest of the header line); paths containing literal newlines are
  unrepresentable by construction.
- A `FileSystemSandboxContext` MAY be passed in; when present, every
  filesystem call is routed through it. All of `read_file_text`,
  `write_file`, `remove`, `get_metadata`, `create_directory` receive the
  sandbox. The sandbox is responsible for enforcing path restrictions —
  the applier does no check of its own.

---

## 8. Invocation forms

The applier accepts the patch text through several transport layers. A
reimplementation only strictly needs §8.1 (tool arg) — the others exist for
historical compatibility.

### 8.1 Direct tool argument (freeform or JSON)

The preferred form. Either the freeform tool's `input` or the JSON tool's
`input` string is the full patch, e.g.:

```
*** Begin Patch
*** Add File: hello.txt
+Hello, world!
*** End Patch
```

### 8.2 Heredoc-wrapped

When the patch is invoked via `shell` (the legacy path), the model wraps
the patch in a heredoc. The parser's lenient mode strips the outermost
heredoc wrapper:

```
<<EOF
*** Begin Patch
...
*** End Patch
EOF
```

The opener must be one of `<<EOF`, `<<'EOF'`, `<<"EOF"`; the closer must be
`EOF` on its own line. Mismatched quoting (`<<"EOF'`) or a missing closer
is rejected.

### 8.3 Shell script with workdir

The harness also recognizes a `cd <path> && apply_patch <<'EOF' ... EOF`
shell invocation (parsed via Tree-sitter in
`codex-rs/apply-patch/src/invocation.rs`). The `<path>` is extracted into
`ApplyPatchArgs.workdir` and used to qualify `cwd` before applying hunks.
Any other pre- or post-commands cause the parse to fail over to "treat as
a regular shell command" rather than `apply_patch`.

### 8.4 stdin (standalone executable)

`codex-rs/apply-patch/src/standalone_executable.rs` lets the binary be
invoked as `apply_patch` with the patch on argv[1], OR with no args and the
patch piped on stdin.

---

## 9. Result presentation

### 9.1 Success

After a successful apply, the caller renders a git-style summary
(`codex-rs/apply-patch/src/lib.rs::print_summary`):

```
Success. Updated the following files:
A <added path 1>
A <added path 2>
M <modified or renamed path>
D <deleted path>
```

- Sections appear in the order Added / Modified / Deleted.
- Paths are the ones spelled in the patch (not canonicalized).
- Renamed files appear under `M` with the **original** path, not the
  destination.
- Exit status 0.

### 9.2 Failure

- Parse errors: written to stderr as
  `Invalid patch: <message>` or
  `Invalid patch hunk on line <N>: <message>`.
- Apply errors (context miss / old_lines miss / IO): written to stderr
  with the Rust `anyhow` chain, e.g.:
  - `Failed to find context '<ctx>' in <path>`
  - `Failed to find expected lines in <path>:\n<block>`
  - `Failed to read file to update <path>: <io err>`
  - `Failed to write file <path>: <io err>`
  - `Failed to delete file <path>: <io err>`
  - `Failed to remove original <path>: <io err>`
  - `Failed to create parent directories for <path>: <io err>`
- Exit status 1 (apply/parse failure) or 2 (argv usage error).

### 9.3 Harness-side tool call result

When invoked through the harness, the handler wraps the above in
`ExecToolCallOutput { exit_code, stdout, stderr, aggregated_output, duration,
timed_out }`. The model sees `aggregated_output`.

### 9.4 Progress events

The `PatchApplyUpdatedEvent` is emitted to the TUI as each hunk is applied
(only when the progress feature is on). This is a UX detail and is not part
of the observable patch semantics.

---

## 10. Edge cases (test-derived)

| Case                                                | Behavior |
| --------------------------------------------------- | -------- |
| Patch with zero hunks                               | Error: `No files were modified.` |
| Add File overwriting an existing file               | Silent overwrite. |
| Delete File on a directory                          | Error: `path is a directory`. |
| Delete File on a nonexistent file                   | Error propagated from `fs.get_metadata` / `fs.remove`. |
| Move to an existing destination                     | Destination overwritten; source removed. |
| Update File with 0 chunks                           | Parse error: `Update file hunk for path '<p>' is empty`. |
| Chunk with only `+` lines (pure addition)           | Inserts at end of file (before final empty line if any). |
| Chunk whose `old_lines` end in an empty string      | Retry without the trailing empty; lets EOF edits match. |
| Patch with `*** End of File` marker                 | `is_end_of_file = true`; matcher tries tail-of-file first. |
| Unicode dash/quote/NBSP mismatch between patch and file | Normalized-trim match (4th seek pass) matches. |
| Leading/trailing whitespace on a sentinel line      | Ignored (`line.trim()` before marker compare). |
| Blank line inside an Update File between chunks     | Ignored (used as visual separator). |
| Heredoc wrapper around the whole patch              | Stripped in Lenient mode. |
| Streaming: `*** End Patch` absent yet               | OK in `parse_patch_streaming`; last incomplete hunk is dropped. |
| First chunk of an Update File lacks `@@`            | Allowed (context-less first chunk). |
| Non-first chunk missing `@@`                        | Parse error. |
| Absolute path in patch                              | Accepted by parser; model is told not to emit these. |
| Multiple chunks touching the same file              | Applied in reverse start-order; must be in file-order in the patch. |
| One hunk of N fails                                 | Prior hunks remain applied; later hunks skipped. |
| File with no trailing newline as input              | Output gains one (post-condition). |

---

## 11. Reimplementation checklist

To reimplement this format end-to-end, a conforming implementation MUST:

- [ ] Accept the exact sentinel tokens in §3.2 with the trailing space
      where required; match marker lines after `trim()` only.
- [ ] Parse the grammar in §3.1 including the context-less first chunk
      allowance, the `*** End of File` terminator, blank-line separation
      between chunks, and the `*** Move to:` renames.
- [ ] Implement Lenient mode (heredoc strip) and Streaming mode as
      described in §4.3.
- [ ] Emit the error messages in §4.5 verbatim (test compatibility).
- [ ] For Update File, read the target with UTF-8, split on `\n`, drop the
      trailing empty element, apply chunks via the replacement machinery in
      §6.5, and re-add a trailing newline before writing.
- [ ] Implement `seek_sequence` with the four-pass strictness hierarchy and
      the exact Unicode normalization table in §6.6, including the
      pattern-longer-than-input → `None` guard and the `eof` tail-first
      search.
- [ ] Apply hunks sequentially and non-atomically; do not rollback on
      partial failure.
- [ ] Silently overwrite existing destinations for Add File and Move.
- [ ] Emit the `Success. Updated the following files:` / `A`/`M`/`D`
      summary in §9.1 on success, and stderr messages in §9.2 on failure.
- [ ] Register both freeform-grammar and JSON-function tool variants with
      `supports_parallel_tool_calls = false`.
- [ ] Ship the agent prompt in §2 verbatim.

Optional / harness features (not required for correctness):

- Heredoc `cd <dir> && apply_patch <<'EOF' ... EOF` shell-form detection
  with workdir extraction.
- Streaming progress events to the UI.
- Unified-diff rendering (`unified_diff_from_chunks`) for displaying a
  user-visible diff after apply.

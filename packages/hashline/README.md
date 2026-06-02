# @oh-my-pi/hashline

A compact, line-anchored patch language and applier.

Hashline is a diff format designed for LLM-driven file edits. It binds every
hunk to a file-content hash so stale anchors are rejected before they corrupt
code, and it abstracts over the filesystem so the same patcher works on disk,
in memory, over the network, or against any custom backend.

## Quick start

```ts
import {
	Filesystem,
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patcher,
	Patch,
} from "@oh-my-pi/hashline";

const fs = new InMemoryFilesystem();
const snapshots = new InMemorySnapshotStore();
const before = `const greeting = "hi";\nexport { greeting };\n`;
await fs.writeText("hello.ts", before);

const tag = snapshots.recordContiguous("hello.ts", 1, before.split("\n"), { fullText: before });
const patcher = new Patcher({ fs, snapshots });
const patch = Patch.parse(String.raw`¶hello.ts#${tag}
@@ 1..1 @@
+const greeting = "hello";`);
const result = await patcher.apply(patch);

console.log(result.sections[0].op); // "update"
console.log(await fs.readText("hello.ts"));
```

## Format

See [`src/prompt.md`](./src/prompt.md) for the user-facing description and
[`src/grammar.lark`](./src/grammar.lark) for the formal grammar.

Each file section starts with `¶PATH#TAG`. The tag is a 3-hex opaque
pointer into the `SnapshotStore` that minted it; it is not content-derived
and is not meaningful outside that store. The patcher protects against
stale anchors by resolving the tag, verifying the recorded snapshot lines
against live file content, and refusing or attempting session-aware
recovery on mismatch.

Inside a section:
- `@@ A..B @@` — open a hunk on lines A..B (use `@@ A,A @@` for a single line; bare `@@ A @@` is also accepted).
- `@@ BOF @@` / `@@ EOF @@` — virtual hunks at the beginning/end of file.
- `+TEXT` — literal body row (use `+` alone for a blank line).
- `&A..B` — repeat original file lines A..B inline (`&A` for one line).
- Empty body — delete the selected range.

## Abstractions

### `Filesystem`

Read and write text by path. The default implementations:

- `InMemoryFilesystem` — backed by a `Map`. Tests, sandboxes.
- `NodeFilesystem` — disk-backed via `Bun.file`/`Bun.write`. Default for CLIs.

Subclass `Filesystem` to wire hashline into any storage: VFS, S3, an LSP
text-document protocol, a Git tree, anything.

### `SnapshotStore`

Required. Hashline tags are opaque store pointers, so `Patcher` must receive
the store that minted them. Recovery replays edits against the cached pre-edit
snapshot and 3-way-merges onto current content when the live file diverged.

### `Patcher`

The orchestration class. Reads, normalizes line endings + BOM, applies edits,
restores line endings, and writes via the configured `Filesystem`. Multi-section
patches are preflighted up front so a partial batch never lands.

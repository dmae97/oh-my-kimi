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
await fs.writeText(
	"hello.ts",
	`const greeting = "hi";\nexport { greeting };\n`,
);

const patcher = new Patcher({ fs });
const patch = Patch.parse(String.raw`¶hello.ts
1:
|const greeting = "hello";`);
const result = await patcher.apply(patch);

console.log(result.sections[0].op); // "update"
console.log(await fs.readText("hello.ts"));
```

## Format

See [`src/prompt.md`](./src/prompt.md) for the user-facing description and
[`src/grammar.lark`](./src/grammar.lark) for the formal grammar.

Each hunk starts with a `¶PATH#HASH` header. The hash is a 4-hex-character
xxHash32 truncation of the file's LF-normalized content. The hash protects
against stale anchors: if the file changed between the read that produced the
hash and the edit, the patcher refuses (or, with a `SnapshotStore`, tries
session-aware recovery).

Inside a hunk:

- `A-B:` — anchor lines A..B (single-anchor `A:` is sugar for `A-A:`).
- `BOF:` / `EOF:` — virtual anchors at the beginning/end of file.
- `|TEXT` — replace-bucket payload. A non-empty replace bucket replaces A..B.
- `↑TEXT` — insert before A (`BOF:` treats `↑`/`↓` equivalently).
- `↓TEXT` — insert after B (`EOF:` treats `↑`/`↓` equivalently).

## Abstractions

### `Filesystem`

Read and write text by path. The default implementations:

- `InMemoryFilesystem` — backed by a `Map`. Tests, sandboxes.
- `NodeFilesystem` — disk-backed via `Bun.file`/`Bun.write`. Default for CLIs.

Subclass `Filesystem` to wire hashline into any storage: VFS, S3, an LSP
text-document protocol, a Git tree, anything.

### `SnapshotStore`

Optional. When provided to `Patcher`, hashline tries to recover from a stale
section hash by replaying the edit against a cached pre-edit snapshot of the
file and 3-way-merging onto the current content. See `recovery.ts`.

### `Patcher`

The orchestration class. Reads, normalizes line endings + BOM, applies edits,
restores line endings, and writes via the configured `Filesystem`. Multi-section
patches are preflighted up front so a partial batch never lands.

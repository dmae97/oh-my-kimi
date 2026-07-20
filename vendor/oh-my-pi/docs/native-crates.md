# Native Crates

Contributor-facing map of the Rust crates under `crates/`. These crates back
`@oh-my-pi/pi-natives` and the embedded shell/PTY runtime. They are intentionally
internal: end users see `@oh-my-pi/pi-natives` exports, not these crate APIs.

For the consumer-side runtime contract see
[`natives-architecture.md`](./natives-architecture.md). For inclusion policy
covering when a crate should be promoted to user-facing docs, see
[`user-facing-packages.md`](./user-facing-packages.md).

## Crate map

| Crate | Path | Role |
| --- | --- | --- |
| `pi-natives` | [`crates/pi-natives`](../crates/pi-natives) | Top-level N-API `cdylib`; aggregates the other crates and exposes the JS-visible API. |
| `pi-shell` | [`crates/pi-shell`](../crates/pi-shell) | Embedded shell / PTY / process management split out of `pi-natives` (wraps `brush-*`). |
| `pi-ast` | [`crates/pi-ast`](../crates/pi-ast) | tree-sitter-based code summarizer and AST utilities; 50+ language grammars. |
| `pi-iso` | [`crates/pi-iso`](../crates/pi-iso) | Task isolation backend resolver: APFS clones, btrfs/zfs reflinks, overlayfs, projfs, rcopy. |
| `pi-walker` | [`crates/pi-walker`](../crates/pi-walker) | Parallel filesystem walker (ignore + globset) shared by grep, glob, and fs-scan cache. |
| `pi_uu_grep` | [`crates/pi-uu-grep`](../crates/pi-uu-grep) | `grep` re-implemented on `grep-regex` / `grep-searcher`; runs in-process as a shell builtin. Entry: `pi_uu_grep::run`. |
| `pi-uutils-ctx` | [`crates/pi-uutils-ctx`](../crates/pi-uutils-ctx) | Thread-local stdio + cwd context shim for embedding vendored uutils as in-process shell builtins. |
| `brush-core` | [`crates/vendor/brush-core`](../crates/vendor/brush-core) | Vendored fork of [brush-shell](https://github.com/reubeno/brush) for embedded bash execution. |
| `brush-builtins` | [`crates/vendor/brush-builtins`](../crates/vendor/brush-builtins) | Vendored bash builtins (`cd`, `echo`, `test`, `printf`, `read`, `export`, ...). |

## What lives where

- Native API surface and loader (`@oh-my-pi/pi-natives`):
  [`natives-architecture.md`](./natives-architecture.md),
  [`natives-addon-loader-runtime.md`](./natives-addon-loader-runtime.md),
  [`natives-binding-contract.md`](./natives-binding-contract.md),
  [`natives-build-release-debugging.md`](./natives-build-release-debugging.md),
  [`natives-media-system-utils.md`](./natives-media-system-utils.md),
  [`natives-rust-task-cancellation.md`](./natives-rust-task-cancellation.md),
  [`natives-shell-pty-process.md`](./natives-shell-pty-process.md),
  [`natives-text-search-pipeline.md`](./natives-text-search-pipeline.md).
- Porting cross-references:
  [`porting-from-pi-mono.md`](./porting-from-pi-mono.md),
  [`porting-to-natives.md`](./porting-to-natives.md).
- Filesystem scan cache contract that consumes `pi-walker`:
  [`fs-scan-cache-architecture.md`](./fs-scan-cache-architecture.md).

## Policy

These crates are implementation details. End-user docs live with the consuming
package (`@oh-my-pi/pi-natives`) and the architecture pages above. Promote a
crate to a dedicated user-facing doc only when it grows a standalone CLI or
public API consumed outside `packages/natives`.

---
description: Use Future not std::future::Future - it's in the prelude
condition: "std::future::Future"
scope: "tool:edit(*.rs), tool:write(*.rs)"
---

Use `Future` directly instead of `std::future::Future` in type positions.

Rust 2024 includes `Future` in prelude. Older editions import once with `use std::future::Future;`. Repeating fully qualified path makes signatures harder to read without adding safety.

## Examples

```rust
// Bad — fully qualified in every signature.
fn fetch() -> impl std::future::Future<Output = Result<Data>> { ... }
fn poll(fut: Pin<&mut dyn std::future::Future<Output = i32>>) { ... }

// Good — use the prelude or one import.
fn fetch() -> impl Future<Output = Result<Data>> { ... }
fn poll(fut: Pin<&mut dyn Future<Output = i32>>) { ... }
```

Pre-2024 edition? Add `use std::future::Future;` at top.

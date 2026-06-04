---
description: Use parking_lot instead of std::sync for Mutex/RwLock
condition:
  - "\\.lock\\(\\)\\.unwrap\\(\\)"
  - "\\.read\\(\\)\\.unwrap\\(\\)"
  - "\\.write\\(\\)\\.unwrap\\(\\)"
scope: "tool:edit(*.rs), tool:write(*.rs)"
---

Use `parking_lot::{Mutex, RwLock}` instead of `std::sync::{Mutex, RwLock}` when code immediately unwraps lock results.

## Why

- `lock()`, `read()`, `write()` return guards directly.
- No poisoning error path to unwrap.
- Guards smaller, faster in common contention cases.
- Call site shows locking, not error handling boilerplate.

## Migration

```rust
// Before
use std::sync::Mutex;
let data = Mutex::new(Vec::new());
let guard = data.lock().unwrap();

// After
use parking_lot::Mutex;
let data = Mutex::new(Vec::new());
let guard = data.lock();
```

## Equivalents

| std::sync | parking_lot |
| --- | --- |
| `Mutex<T>` | `Mutex<T>` |
| `RwLock<T>` | `RwLock<T>` |
| `Condvar` | `Condvar` |
| `Once` | `Once` |

## Keep async locks async

Use `tokio::sync::Mutex` / `tokio::sync::RwLock` when guard held across `.await` or lock belongs to async coordination.

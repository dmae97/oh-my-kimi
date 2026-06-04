---
description: Result type aliases must include a defaulted error type parameter
condition: "type\\s+Result<[A-Za-z_]\\w*>\\s*="
scope: "tool:edit(*.rs), tool:write(*.rs)"
---

Need `Result` aliases expose error type as defaulted parameter.

```rust
pub type Result<T, E = anyhow::Error> = std::result::Result<T, E>;
```

Never write:

```rust
type Result<T> = std::result::Result<T, anyhow::Error>;
```

Default keeps common call sites short; preserves escape hatches for precise errors.

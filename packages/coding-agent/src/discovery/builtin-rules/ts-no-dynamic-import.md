---
description: "Do not use `await import()` — use static imports unless dynamic loading is unavoidable"
condition: "await import\\("
scope: "tool:edit(*.ts), tool:edit(*.tsx), tool:write(*.ts), tool:write(*.tsx)"
---

Use static imports for modules known at author time. Reach for `await import()` only when module specifier genuinely runtime-selected.

## Why

- Static imports fail during build, not under load.
- Bundlers, type checkers, tree shakers see them.
- Dependency graph stays reviewable.
- Consumers keep precise module types without casts.

## Avoid

```typescript
// Bad — the module path is a literal.
const { createClient } = await import("some-sdk");

// Bad — dynamic import followed by a shape assertion.
const mod = (await import("./known-module")) as { run?: unknown };
```

## Use

```typescript
import { createClient } from "some-sdk";
import { run } from "./known-module";
```

## Exceptions

- Plugin loading from runtime registry.
- Platform-specific modules; not everywhere.
- Test cases exercise module loading boundaries.

Exception? Add short comment naming why static import cannot work.

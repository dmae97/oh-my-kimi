---
description: "Do not leave `@deprecated` shims behind after refactors — update call sites and remove the old API"
condition: "@deprecated"
scope: "tool:edit(*.ts), tool:edit(*.tsx), tool:write(*.ts), tool:write(*.tsx)"
---

Do not use `@deprecated` as a substitute for finishing a refactor. If an API is obsolete inside the code you control, update every call site and remove the old name in the same change.

## Why

- Deprecated aliases keep two contracts alive.
- Future maintainers must preserve behavior nobody should call.
- Tests can pass while production code keeps using the old path.
- The next refactor has to unwind both the real API and the compatibility layer.

## Avoid

```typescript
// Bad — leaves a stale compatibility name instead of finishing the cutover.
/** @deprecated Use loadSettings instead. */
export const loadConfig = loadSettings;

// Bad — preserves an obsolete wrapper after callers can be updated.
/** @deprecated Use createClient instead. */
export function makeClient(options: ClientOptions): Client {
	return createClient(options);
}
```

## Use

```typescript
// Update all imports and call sites to the durable name.
export function loadSettings(path: string): Settings { ... }
export function createClient(options: ClientOptions): Client { ... }
```

## Exceptions

- Public package APIs with a documented migration window.
- Third-party declarations where the deprecated marker reflects an external contract.
- Tests that intentionally verify deprecated API behavior during a supported transition.

If an exception applies, state the external compatibility requirement. Otherwise, finish the refactor and delete the deprecated symbol.

---
description: "Do not leave `@deprecated` shims behind after refactors — update call sites and remove the old API"
condition: "@deprecated"
scope: "tool:edit(*.ts), tool:edit(*.tsx), tool:write(*.ts), tool:write(*.tsx)"
---

NEVER use `@deprecated` as substitute for finishing refactor. If API obsolete inside code you control, update every call site and remove old name in same change.

## Why

- Deprecated aliases keep two contracts alive.
- Future maintainers MUST preserve behavior nobody should call.
- Tests pass while production code uses old path.
- Next refactor unwinds real API plus compatibility layer.

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

- Public package APIs with documented migration window.
- Third-party declarations where deprecated marker reflects external contract.
- Tests intentionally verify deprecated API behavior during supported transition.

If exception applies, state external compatibility requirement. Otherwise finish refactor and delete deprecated symbol.

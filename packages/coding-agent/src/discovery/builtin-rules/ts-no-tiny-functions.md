---
description: "Do not extract 1-2 line functions that only wrap an expression — inline them"
condition: "\\{\\s*return [^;{}\\n]+;?\\s*\\}|\\b(?:const|let|var)\\s+[\\w$]+\\s*=\\s*(\\([^)]*\\)|[a-zA-Z_$][\\w$]*)\\s*=>\\s*[^{\\n]+$"
scope: "tool:edit(*.ts), tool:edit(*.tsx), tool:write(*.ts), tool:write(*.tsx)"
interruptMode: never
---

Do not extract a function whose whole body is one expression or one `return`. Inline it unless the name creates a durable contract.

## Why

- One-line wrappers hide no real behavior.
- Readers must jump to verify trivial code.
- The signature freezes a shape too early.
- Search and type flow work better with inline expressions.

## Avoid

```typescript
// Bad — pure rename, no behavior added.
function isEmpty(value: string): boolean {
	return value.length === 0;
}

const getDisplayName = (user: User) => user.profile.displayName;

function double(value: number) {
	return value * 2;
}

if (isEmpty(name)) { ... }
```

## Use

```typescript
if (name.length === 0) { ... }
const displayName = user.profile.displayName;
const doubled = value * 2;
```

## Allowed tiny functions

- Three or more call sites need lockstep behavior.
- Exported name represents a stable domain concept.
- Callback identity matters.
- Type guard preserves narrowing.
- Public API, test seam, or DI boundary needs indirection.

If none apply, inline it.

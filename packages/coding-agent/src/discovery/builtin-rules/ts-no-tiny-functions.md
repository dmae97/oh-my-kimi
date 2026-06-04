---
description: "Do not extract 1-2 line functions that only wrap an expression — inline them"
condition: "\\{\\s*return [^;{}\\n]+;?\\s*\\}|\\b(?:const|let|var)\\s+[\\w$]+\\s*=\\s*(\\([^)]*\\)|[a-zA-Z_$][\\w$]*)\\s*=>\\s*[^{\\n]+$"
scope: "tool:edit(*.ts), tool:edit(*.tsx), tool:write(*.ts), tool:write(*.tsx)"
interruptMode: never
---

NEVER extract function whose body is one expression or one `return`. Inline unless name creates durable contract.

## Why

- One-line wrappers hide no real behavior.
- Readers MUST jump to verify trivial code.
- Signature freezes shape too early.
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

- Three or more call sites Need lockstep behavior.
- Exported name represents stable domain concept.
- Callback identity matters.
- Type guard preserves narrowing.
- Need indirection if public API, test seam, or DI boundary.

If none apply, inline.

---
description: "Never use `any` in TypeScript annotations or assertions — use `unknown`, generics, or the actual type"
condition: ": any|as any"
scope: "tool:edit(*.ts), tool:edit(*.tsx), tool:write(*.ts), tool:write(*.tsx)"
---

NEVER use `: any` or `as any`. Disables type checking exactly where boundary needs precision.

## Use instead

- `unknown` for unvalidated input.
- Domain type when shape known.
- Generic when caller supplies shape.
- Type guard when runtime checks establish shape.
- `satisfies` for object literals MUST match contract.

## Parameters and returns

```typescript
// Bad
function readId(value: any): any {
	return value.id;
}

// Good — validate unknown input.
function readId(value: unknown): string | undefined {
	if (value && typeof value === "object" && "id" in value) {
		const candidate = (value as { id: unknown }).id;
		return typeof candidate === "string" ? candidate : undefined;
	}
}
```

## Assertions

```typescript
// Bad
const root = document.getElementById("root") as any;
root.innerText = "ready";

// Good
const root = document.getElementById("root") as HTMLElement | null;
root?.innerText = "ready";
```

## Object literals

```typescript
// Bad
const config = { port: 3000 } as any as ServerConfig;

// Good
const config = { port: 3000 } satisfies ServerConfig;
```

If library boundary truly requires unchecked cast, use `as unknown as T` with short reason. NEVER leave bare `any`.

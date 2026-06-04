---
description: Use bare `catch {` when the error binding is unused
condition: "catch \\(_"
scope: "tool:edit(*.ts), tool:edit(*.tsx), tool:write(*.ts), tool:write(*.tsx)"
---

Unused catch value? Bare `catch {}`. Underscore-prefixed binding adds noise, still allocates local name.

## Replace

```typescript
// Bad
try {
	await loadConfig();
} catch (_err) {
	return null;
}

// Good
try {
	await loadConfig();
} catch {
	return null;
}
```

## Keep a real name when used

```typescript
try {
	await saveConfig();
} catch (err) {
	logger.error("save failed", { err });
	throw err;
}
```

Unused error? Bare `catch`. Used error? Name for what it carries.

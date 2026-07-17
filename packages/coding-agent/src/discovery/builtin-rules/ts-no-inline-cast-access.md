---
description: "Don't assert an inline object type and immediately read a property — `(x as { y: T }).y` trusts an unchecked shape; validate with a schema parse at trust boundaries, narrow with `in`/`typeof`, or use a validated named type"
scope: "tool:edit(*.{ts,tsx,mts,cts}), tool:write(*.{ts,tsx,mts,cts})"
interruptMode: never
astCondition:
  - "($X as { $$$BODY }).$PROP"
  - "($X as { $$$BODY })?.$PROP"
  - "($X as { $$$BODY })[$IDX]"
---

**Don't assert an inline object type just to read a property.** `(value as { content: unknown }).content` fabricates a shape the compiler never verified, then trusts it for exactly one access. If `value` isn't that shape, the read is silently wrong and no type error ever fires.

## Why it's wrong

- The cast is an unchecked assertion — it suppresses the type error instead of proving the shape.
- It localizes the lie to one expression, so the next reader can't tell whether the value was ever validated.
- It almost always stands in for the real fix: runtime narrowing or a validated type at the boundary.

## Avoid

```ts
const content = (value as { content: unknown }).content;
const id = (resp as { data: { id: string } }).data.id;
const name = (payload as { name?: string })?.name;
const flag = (opts as { enabled: boolean })["enabled"];
```

## Use

Prefer a schema parse at the boundary when a validator is available (Zod, Valibot, …) — validate once, then read from a fully typed value. If Zod is already in the project (e.g. Zod v4):

```ts
import { z } from "zod/v4";

const Resp = z.object({ data: z.object({ id: z.string() }) });

const resp = Resp.parse(raw); // throws on bad input; resp.data.id is typed string
const id = resp.data.id;
```

For a one-off read of a single field, narrow with `in` / `typeof` so the access is actually checked — TypeScript infers `unknown` for the property after `"content" in value`:

```ts
if (value && typeof value === "object" && "content" in value) {
	const content = value.content; // unknown — validate before use
}
```

## Choosing: guard vs schema vs unchecked cast

| Situation | Reach for |
| --- | --- |
| Data from outside your control — network/RPC, parsed JSON, config files, env vars, CLI/IPC, persisted blobs — or a shape reused across the codebase | **Schema parse** (Zod/Valibot/…): runtime validation, typed output, and a clear error on bad shape |
| In-process value the compiler merely lost track of — an `unknown` from a generic, a union to discriminate, a one-off read of a field or two | **Type guard** (`in` / `typeof`): no dependency, but it only checks what you write, so keep the checked surface small |
| You genuinely know more than the compiler *and* a runtime check is impossible or meaningless — a well-known DOM node (`as HTMLElement`), structurally-identical types inference can't unify, a library type that's wrong or unexpressible, `as const` | **Unchecked cast** (`as`): assign to a named const with a one-line reason; never for raw external input, never inlined into a member access |

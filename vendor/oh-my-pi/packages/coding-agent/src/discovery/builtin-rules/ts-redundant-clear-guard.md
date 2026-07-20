---
description: Do not guard clearTimeout/clearInterval/clearImmediate with a truthiness or null/undefined check — they accept null and undefined
scope: "tool:edit(*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}), tool:write(*.{ts,tsx,js,jsx,mts,cts,mjs,cjs})"
interruptMode: never
astCondition:
  - "if ($X) clearTimeout($X)"
  - "if ($X) { clearTimeout($X) }"
  - "if ($X) clearInterval($X)"
  - "if ($X) { clearInterval($X) }"
  - "if ($X) clearImmediate($X)"
  - "if ($X) { clearImmediate($X) }"
  - "if ($X !== null) clearTimeout($X)"
  - "if ($X !== null) { clearTimeout($X) }"
  - "if ($X !== null) clearInterval($X)"
  - "if ($X !== null) { clearInterval($X) }"
  - "if ($X !== null) clearImmediate($X)"
  - "if ($X !== null) { clearImmediate($X) }"
  - "if ($X != null) clearTimeout($X)"
  - "if ($X != null) { clearTimeout($X) }"
  - "if ($X != null) clearInterval($X)"
  - "if ($X != null) { clearInterval($X) }"
  - "if ($X != null) clearImmediate($X)"
  - "if ($X != null) { clearImmediate($X) }"
  - "if ($X !== undefined) clearTimeout($X)"
  - "if ($X !== undefined) { clearTimeout($X) }"
  - "if ($X !== undefined) clearInterval($X)"
  - "if ($X !== undefined) { clearInterval($X) }"
  - "if ($X !== undefined) clearImmediate($X)"
  - "if ($X !== undefined) { clearImmediate($X) }"
  - "if ($X != undefined) clearTimeout($X)"
  - "if ($X != undefined) { clearTimeout($X) }"
  - "if ($X != undefined) clearInterval($X)"
  - "if ($X != undefined) { clearInterval($X) }"
  - "if ($X != undefined) clearImmediate($X)"
  - "if ($X != undefined) { clearImmediate($X) }"
---

**Do not guard `clearTimeout` / `clearInterval` / `clearImmediate` with a truthiness or `null`/`undefined` check.** Per the WHATWG/Node timers spec these functions are no-ops when handed `null`, `undefined`, or any value that doesn't correspond to a live timer. The guard adds a redundant branch that the reader must still reason about.

## Why it's wrong

- The branch can never change behavior — clearing a missing/`null`/`undefined` handle does nothing.
- Extra branches inflate the code and hide the one line that matters.
- It signals a misunderstanding of the timer API to future readers.

## Avoid

```ts
if (this.timer) clearTimeout(this.timer);
if (handle !== null) clearInterval(handle);
if (id != undefined) {
	clearImmediate(id);
}
```

## Use

```ts
clearTimeout(this.timer);
clearInterval(handle);
clearImmediate(id);
```

## When a guard *is* warranted

Keep the check only when the body does more than clear — e.g. it also reassigns the handle or runs other cleanup:

```ts
if (this.timer) {
	clearTimeout(this.timer);
	this.timer = undefined; // extra work → guard is not purely redundant
}
```

This rule only fires when the clear call is the sole statement in the guarded branch, so those legitimate cases are left alone.

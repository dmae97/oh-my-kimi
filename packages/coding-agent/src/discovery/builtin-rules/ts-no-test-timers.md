---
description: Do not use real timers (Bun.sleep, setTimeout, setInterval) in tests — drive time with fake timers instead
condition:
  - "Bun\\.sleep\\("
  - "\\bsetInterval\\("
  - "\\bsetTimeout\\("
scope: "tool:edit(*.test.ts), tool:write(*.test.ts)"
interruptMode: never
---

**Do not reach for real wall-clock timers in test files.** `Bun.sleep(...)`, `setTimeout(...)`, and `setInterval(...)` tie a test's duration to real time: they slow the suite on every run, and any delay tuned to "long enough" eventually races on a loaded machine and flakes.

## Why it's wrong

- Real delays add fixed latency to every invocation; CI pays it on every run.
- A sleep sized to mask a race is a guess — the race resurfaces under load.
- A fixed wait hides *what* you are waiting for, so a failure points at a timeout instead of the real cause.

## Avoid

```typescript
test("debounce fires once", async () => {
	const fn = debounce(handler, 100);
	fn();
	await Bun.sleep(150); // real delay — slow and timing-dependent
	expect(handler).toHaveBeenCalledTimes(1);
});
```

## Use

Drive time deterministically with fake timers:

```typescript
import { expect, test, vi } from "bun:test";

test("debounce fires once", () => {
	vi.useFakeTimers();
	const fn = debounce(handler, 100);
	fn();
	vi.advanceTimersByTime(150); // advance the clock, no real wait
	expect(handler).toHaveBeenCalledTimes(1);
});
```

When the code under test resolves a promise or emits an event, await that signal directly instead of guessing a duration:

```typescript
await once(emitter, "done"); // await the real event
const value = await pending; // await the promise the code already exposes
```

## Exceptions

An integration test that deliberately exercises real timer behavior against the platform clock may need a genuine delay. Keep it rare, and add a short comment naming why deterministic time control will not work.

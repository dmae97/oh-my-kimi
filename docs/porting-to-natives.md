# Porting to pi-natives (N-API) — Field Notes

This is a practical guide for moving hot paths into `crates/pi-natives` and wiring them through the JS bindings. It exists to avoid the same failures happening twice.

## When to port

Port when any of these are true:

- The hot path runs in render loops, tight UI updates, or large batches.
- JS allocations dominate (string churn, regex backtracking, large arrays).
- You already have a JS baseline and can benchmark both versions side by side.
- The work is CPU-bound or blocking I/O that can run on the libuv thread pool.
- The work is async I/O that can run on Tokio's runtime (e.g., shell execution).

Avoid ports that depend on JS-only state or dynamic imports. N-API exports should be pure, data-in/data-out. Long-running work should go through `task::blocking` (CPU-bound/blocking I/O) or `task::future` (async I/O) with cancellation.

## Anatomy of a native export

**Rust side:**

- Implementation lives in `crates/pi-natives/src/<module>.rs`. If you add a new module, register it in `crates/pi-natives/src/lib.rs`.
- Export with `#[napi]`; snake_case exports are converted to camelCase automatically. Use explicit `js_name` only for true aliases/non-default names. Use `#[napi(object)]` for structs.
- Use `task::blocking(tag, cancel_token, work)` (see `crates/pi-natives/src/task.rs`) for CPU-bound or blocking work. Use `task::future(env, tag, work)` for async work that needs Tokio (e.g., shell sessions). Pass a `CancelToken` when you expose `timeoutMs` or `AbortSignal`.

**JS side:**

- `packages/natives/src/bindings.ts` holds the base `NativeBindings` interface.
- `packages/natives/src/<module>/types.ts` defines TS types and augments `NativeBindings` via declaration merging.
- `packages/natives/src/native.ts` imports each `<module>/types.ts` file to activate the declarations.
- `packages/natives/src/<module>/index.ts` wraps the `native` binding from `packages/natives/src/native.ts`.
- `packages/natives/src/native.ts` loads the addon and `validateNative` enforces required exports.
- `packages/natives/src/index.ts` re-exports the wrapper for callers in `packages/*`.

## Porting checklist

1. **Add the Rust implementation**

- Put the core logic in a plain Rust function.
- If it’s a new module, add it to `crates/pi-natives/src/lib.rs`.
- Expose it with `#[napi]` so the default snake_case -> camelCase mapping stays consistent.
- Keep signatures owned and simple: `String`, `Vec<String>`, `Uint8Array`, or `Either<JsString, Uint8Array>` for large string/byte inputs.
- For CPU-bound or blocking work, use `task::blocking`; for async work, use `task::future`. Pass a `CancelToken` and call `heartbeat()` inside long loops.

2. **Wire JS bindings**

- Add the types and `NativeBindings` augmentation in `packages/natives/src/<module>/types.ts`.
- Import `./<module>/types` in `packages/natives/src/native.ts` to trigger declaration merging.
- Add a wrapper in `packages/natives/src/<module>/index.ts` that calls `native`.
- Re-export from `packages/natives/src/index.ts`.

3. **Update native validation**

- Add `checkFn("newExport")` in `validateNative` (`packages/natives/src/native.ts`).

4. **Add benchmarks**

- Put benchmarks next to the owning package (`packages/tui/bench`, `packages/natives/bench`, or `packages/coding-agent/bench`).
- Include a JS baseline and native version in the same run.
- Use `Bun.nanoseconds()` and a fixed iteration count.
- Keep the benchmark inputs small and realistic (actual data seen in the hot path).

5. **Build the native binary**

- `bun --cwd=packages/natives run build`

6. **Run the benchmark**

- `bun run packages/<pkg>/bench/<bench>.ts` (or `bun --cwd=packages/natives run bench`)

7. **Decide on usage**

- If native is slower, **keep JS** and leave the native export unused.
- If native is faster, switch call sites to the native wrapper.

## Pain points and how to avoid them

### 1) Stale `pi_natives.node` prevents new exports

The loader prefers the platform-tagged binary in `packages/natives/native` (`pi_natives.<platform>-<arch>.node`). There is also a fallback `pi_natives.node`. Compiled binaries extract to `~/.omp/natives/<version>/pi_natives.<platform>-<arch>.node`. If any of these are stale, exports won’t update.

**Fix:** remove the stale file before rebuilding.

```bash
rm packages/natives/native/pi_natives.linux-x64.node
rm packages/natives/native/pi_natives.node
bun --cwd=packages/natives run build
```

If you’re running a compiled binary, delete the cached addon directory:

```bash
rm -rf ~/.omp/natives/<version>
```

Then verify the export exists in the binary:

```bash
bun -e 'const tag = `${process.platform}-${process.arch}`; const mod = require(`./packages/natives/native/pi_natives.${tag}.node`); console.log(Object.keys(mod).includes("newExport"));'
```

### 2) “Missing exports” errors from `validateNative`

This is **good** — it prevents silent mismatches. When you see this:

```
Native addon missing exports ... Missing: visibleWidth
```

it means your binary is stale, the Rust export name (or explicit alias when used) doesn’t match the JS name, or the export never compiled in. Fix the build and the naming mismatch, don’t weaken validation.

### 3) Rust signature mismatch

Keep it simple and owned. `String`, `Vec<String>`, and `Uint8Array` work. Avoid references like `&str` in public exports. If you need structured data, wrap it in `#[napi(object)]` structs.

### 4) Benchmarking mistakes

- Don’t compare different inputs or allocations.
- Keep JS and native using identical input arrays.
- Run both in the same benchmark file to avoid skew.

## Benchmark template

```ts
const ITERATIONS = 2000;

function bench(name: string, fn: () => void): number {
	const start = Bun.nanoseconds();
	for (let i = 0; i < ITERATIONS; i++) fn();
	const elapsed = (Bun.nanoseconds() - start) / 1e6;
	console.log(`${name}: ${elapsed.toFixed(2)}ms total (${(elapsed / ITERATIONS).toFixed(6)}ms/op)`);
	return elapsed;
}

bench("feature/js", () => {
	jsImpl(sample);
});

bench("feature/native", () => {
	nativeImpl(sample);
});
```

## Verification checklist

- `validateNative` passes (no missing exports).
- `NativeBindings` is augmented in `packages/natives/src/<module>/types.ts` and the wrapper is re-exported in `packages/natives/src/index.ts`.
- `Object.keys(require(...))` includes your new export.
- Bench numbers recorded in the PR/notes.
- Call site updated **only if** native is faster or equal.

## Rule of thumb

- If native is slower, **do not switch**. Keep the export for future work, but the TUI should stay on the faster path.
- If native is faster, switch the call site and keep the benchmark in place to catch regressions.

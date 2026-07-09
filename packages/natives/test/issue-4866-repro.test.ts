/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/4866.
 *
 * "When bash command times out, it exits/crashes OMP as a whole" (WSL).
 *
 * Root cause: the native shell output bridge (`bridge_chunks` in
 * `crates/pi-natives/src/shell.rs` + `emit_chunk` in
 * `crates/pi-shell/src/shell.rs`) queued decoded output chunks into an
 * unbounded cross-thread channel and fired the JS threadsafe function
 * non-blocking, with no backpressure. A producer outrunning the JS consumer
 * (`yes | cat` runs as in-process uutils builtins at memory speed; any
 * output-heavy long task qualifies) ballooned the native queue by gigabytes
 * before the timeout fired, and the callback flood then kept the JS event
 * loop saturated so the deadline machinery ran tens of seconds late.
 * Measured on the pre-fix baseline (macOS arm64): a `timeoutMs: 1500` run
 * through the bash executor resolved after ~30-36 s having forwarded ~6.9 GB,
 * with process RSS pinned at ~7 GB. On WSL's memory-capped VM that backlog
 * trips the Linux OOM killer, which SIGKILLs the whole OMP process — the
 * reported "crashes OMP as a whole".
 *
 * This test models the real consumer (OutputSink sanitize/tail/render work)
 * with a deliberately slow `onChunk` (~1 ms per callback) and pins the fixed
 * contract for both the one-shot (`executeShell`) and persistent-session
 * (`Shell.run`) paths:
 *   1. The run resolves near its deadline (raced against a generous window)
 *      instead of being dragged out by an unbounded backlog drain. On the
 *      pre-fix bridge the drain alone needs minutes (tens of thousands of
 *      queued 64 KiB batches through a ~1 ms consumer).
 *   2. Native memory stays bounded: RSS growth over the run stays far under
 *      the gigabytes the unbounded queue accumulated (bounded(64) queue ×
 *      64 KiB batches plus JS churn).
 *   3. The run still reports `timedOut`, so timeout annotation and session
 *      quarantine behave as before.
 *
 * Bounds carry >4x headroom on both sides of every threshold (fixed path
 * measured: resolve ≈1 s, RSS delta ≈60 MiB; baseline: unresolved at 6 s,
 * RSS delta ≥2 GiB), so the test stays robust on slow CI hosts while the
 * failure mode overshoots by orders of magnitude.
 */
import { describe, expect, it } from "bun:test";
import { executeShell, Shell, type ShellRunResult } from "../native/index.js";

/** `yes` and `cat` are in-process uutils builtins: output is produced at
 * memory speed, which is what made the unbounded bridge lethal. */
const FAST_PRODUCER = "yes issue-4866-crash-line | cat";
const TIMEOUT_MS = 800;
/** Window the timed-out run must resolve within (fixed path: ~1 s; pre-fix
 * baseline is still draining its multi-GB backlog minutes later). */
const RESOLVE_WINDOW_MS = 8_000;
/** RSS growth budget. Fixed path: tens of MiB. Pre-fix: multiple GiB. */
const MAX_RSS_DELTA_BYTES = 512 * 1024 * 1024;
/** Per-callback consumer cost emulating OutputSink/TUI work. */
const CONSUMER_STALL_MS = 1;
const TEST_BUDGET_MS = 60_000;

const posixIt = process.platform === "win32" ? it.skip : it;

// Real-clock integration test (ts-no-test-timers exception): the run under
// test is a native tokio shell execution behind the N-API boundary — fake JS
// timers cannot advance the native runtime's clock, and the defect being
// pinned is precisely a real-time liveness failure (the JS event loop and
// deadline machinery starved by the callback flood). The stall emulates
// synchronous per-callback consumer cost (CPU work, not scheduling), and the
// resolve window is a liveness bound, not a synchronization guess.
async function runTimedOutFastProducer(
	run: (onChunk: (err: Error | null, chunk: string) => void) => Promise<ShellRunResult>,
): Promise<void> {
	const rssBefore = process.memoryUsage.rss();
	const slowConsumer = (_err: Error | null, chunk: string) => {
		if (chunk) Bun.sleepSync(CONSUMER_STALL_MS);
	};

	const settled = run(slowConsumer).then(result => ({ done: true as const, result }));
	const raced = await Promise.race([settled, Bun.sleep(RESOLVE_WINDOW_MS).then(() => ({ done: false as const }))]);
	const rssDelta = process.memoryUsage.rss() - rssBefore;

	// (2) Bounded native memory — the unbounded bridge queued gigabytes here.
	expect(rssDelta).toBeLessThan(MAX_RSS_DELTA_BYTES);
	// (1) Timely resolution — the unbounded bridge dragged the run out for
	// minutes past its deadline.
	expect(raced.done).toBe(true);
	if (raced.done) {
		// (3) Timeout is still reported as such.
		expect(raced.result.timedOut).toBe(true);
	}
}

describe("issue 4866: bash timeout must not flood the output bridge", () => {
	posixIt(
		"one-shot executeShell: fast producer with slow consumer times out near its deadline with bounded memory",
		async () => {
			await runTimedOutFastProducer(onChunk =>
				executeShell({ command: FAST_PRODUCER, timeoutMs: TIMEOUT_MS }, onChunk),
			);
		},
		TEST_BUDGET_MS,
	);

	posixIt(
		"persistent Shell.run: fast producer with slow consumer times out near its deadline with bounded memory",
		async () => {
			const shell = new Shell();
			await runTimedOutFastProducer(onChunk =>
				shell.run({ command: FAST_PRODUCER, timeoutMs: TIMEOUT_MS }, onChunk),
			);
		},
		TEST_BUDGET_MS,
	);
});

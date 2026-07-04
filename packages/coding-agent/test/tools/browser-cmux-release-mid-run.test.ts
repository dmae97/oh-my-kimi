/**
 * Regression test for issue #4499: closing a cmux-backend tab while a
 * `browser({ action: "run" })` call is in flight rejected an orphaned
 * `Promise.withResolvers()` promise created in `runInTabWithSnapshot`. The
 * cmux branch awaits `runCmuxCode(...)` directly and never awaits/`.catch`es
 * the local `promise`; only `pending.reject` was stashed on the tab so
 * `releaseTab` could signal in-flight runs. Zero consumers meant that
 * `reject(...)` surfaced as an unhandled rejection and the top-level
 * `unhandledRejection` handler tore the whole process down (killing sibling
 * tabs and subagents).
 *
 * The fix in `runInTabWithSnapshot` attaches a no-op `.catch(() => undefined)`
 * to that promise immediately after creation. This test drives real
 * `acquireBrowser` / `acquireTab` / `runInTab` / `releaseTab` against a
 * mocked `CmuxSocketClient` and asserts that racing `releaseTab` against an
 * in-flight cmux run never triggers `process.on("unhandledRejection", ...)`.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { CmuxKind } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/rpc";
import { CmuxSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/socket-client";
import { acquireBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import {
	acquireTab,
	getTabsMapForTest,
	releaseTab,
	runInTab,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

function makeKind(socketSuffix: string): CmuxKind {
	return {
		kind: "cmux",
		socketPath: `/tmp/omp-test-${socketSuffix}.sock`,
		surface: `surface-${socketSuffix}`,
	};
}

function makeSession(cwd: string): ToolSession {
	// Minimal shape: `runInTab` only reads `cwd`, `settings.get("browser.screenshotDir")`,
	// and `getActiveModel?.()`. Everything else on `ToolSession` is untouched by the
	// tab-supervisor flow we exercise.
	return {
		cwd,
		hasUI: false,
		settings: { get: () => undefined },
		getSessionFile: () => null,
	} as unknown as ToolSession;
}

async function drainAllTabs(): Promise<void> {
	for (const name of [...getTabsMapForTest().keys()]) {
		await releaseTab(name, { kill: false }).catch(() => undefined);
	}
}

describe("browser tab-supervisor — cmux tab close mid-run (#4499)", () => {
	afterEach(async () => {
		await drainAllTabs();
	});

	it("releaseTab() during an in-flight cmux run does not emit unhandledRejection", async () => {
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);

		// Signaled the first time the cmux client sees the stalling request
		// from the in-flight `runtime.run(code)` call. By the time the mock
		// enters this branch, tab-supervisor has already populated
		// `tab.pending` (it does so synchronously before invoking
		// `runCmuxCode`, which drives `runtime.run` -> `tab.goto` -> `#request`
		// -> this mock). This is the deterministic "the run is mid-flight" edge.
		const navStarted = Promise.withResolvers<void>();
		// Gate for the mocked `browser.navigate` response. Left pending across
		// the window we care about, then resolved during teardown so
		// `runCmuxCode` can settle and does not leak past the test.
		const navGate = Promise.withResolvers<Record<string, unknown>>();

		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string, _params: Record<string, unknown>): Promise<Record<string, unknown>> => {
				switch (method) {
					case "browser.open_split":
						return { surface_id: "surface-mid-run", url: "about:blank" };
					case "browser.url.get":
						return { url: "about:blank" };
					case "browser.snapshot":
						return { page: { html: "" } };
					case "browser.eval":
						// Used by `readyInfo()` for `document.title` and geometry
						// during `acquireCmuxTab` — return quickly so setup lands
						// and the run gets a chance to reach `tab.goto` below.
						return { value: "" };
					case "browser.navigate":
						navStarted.resolve();
						return await navGate.promise;
					case "browser.wait":
					case "surface.close":
						return {};
					default:
						return {};
				}
			},
		);

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);

		const runAc = new AbortController();
		let runPromise: Promise<unknown> | undefined;
		try {
			const kind = makeKind("close-mid-run");
			const browser = await acquireBrowser(kind, { cwd: "/tmp" });
			const acquired = await acquireTab("docfinal", browser, {
				timeoutMs: 5_000,
				ownerSessionId: "session-mid-run",
			});
			expect(acquired.tab.backend).toBe("cmux");

			const session = makeSession("/tmp");
			// Fire the run WITHOUT awaiting. `runtime.run` drives `tab.goto`,
			// which drives `browser.navigate`, which stalls on `navGate`. So
			// `runInTab` sits inside `runCmuxCode` with `tab.pending` holding
			// the orphaned promise. Attach a swallowing catch so the eventual
			// rejection from `runAc.abort()` in the finally block does not
			// itself become an unhandled rejection.
			runPromise = runInTab("docfinal", {
				code: 'await tab.goto("https://example.test");',
				timeoutMs: 60_000,
				session,
				signal: runAc.signal,
			});
			runPromise.catch(() => undefined);

			// Deterministic wait: proceed only once the cmux request is actually
			// mid-flight (and therefore `tab.pending` is populated).
			await navStarted.promise;
			const tabBeforeRelease = getTabsMapForTest().get("docfinal");
			expect(tabBeforeRelease?.pending.size).toBeGreaterThan(0);

			// This is the crash path from the reporter: `releaseTab` walks
			// `tab.pending` and calls `pending.reject(new ToolError("Tab ... was closed"))`.
			// Without the no-op catch on the orphaned promise, that rejection
			// would surface as an unhandled rejection on the next microtask tick.
			const released = await releaseTab("docfinal", { kill: false });
			expect(released).toBe(true);

			// Drain the microtask queue so any pending unhandled-rejection would
			// have fired by the time we assert. Two microtask ticks matches the
			// pattern in `ipc-safe-send.test.ts` (one for the rejection, one for
			// a downstream handler); a few extra loops cover chained handlers.
			for (let i = 0; i < 8; i++) await Promise.resolve();

			expect(unhandled).toEqual([]);
			// Sanity: the tab really did leave the map.
			expect(getTabsMapForTest().has("docfinal")).toBe(false);
		} finally {
			// Unblock the stalled `browser.navigate` and abort the run so
			// `runInTab` can settle. Drop the listener last so the drain in
			// `afterEach` does not accidentally trip a stray assertion in a
			// follow-up test.
			runAc.abort(new ToolAbortError("test cleanup"));
			navGate.resolve({ url: "https://example.test" });
			await runPromise?.catch(() => undefined);
			process.removeListener("unhandledRejection", onUnhandled);
		}
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { postmortem } from "@oh-my-pi/pi-utils";
import { JsRuntime, type RuntimeHooks } from "../../src/eval/js/shared/runtime";
import { bindBrowserRunFacade, markHandled, waitForBrowserRun } from "../../src/tools/browser/run-cancellation";
import { ToolAbortError } from "../../src/tools/tool-errors";

async function collectUnhandledRejections(action: () => void | Promise<void>): Promise<unknown[]> {
	const reasons: unknown[] = [];
	const onUnhandled = (reason: unknown) => reasons.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		await action();
		await Promise.resolve();
		await Promise.resolve();
		vi.advanceTimersByTime(0);
		await Promise.resolve();
		return reasons;
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
}

describe("browser run cancellation", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns the same promise while preserving awaited rejection", async () => {
		const rejection = new Error("browser run ended");
		const promise = Promise.reject(rejection);

		const handled = markHandled(promise);

		expect(handled).toBe(promise);
		await expect(handled).rejects.toBe(rejection);
	});

	it("resolves run-scoped wait when the run is not aborted", async () => {
		const controller = new AbortController();

		const wait = waitForBrowserRun(25, controller.signal);
		vi.advanceTimersByTime(25);

		await expect(wait).resolves.toBeUndefined();
	});

	it("rejects run-scoped wait when the run aborts mid-sleep", async () => {
		const controller = new AbortController();
		const wait = waitForBrowserRun(1000, controller.signal);

		controller.abort(new Error("browser run ended"));

		await expect(wait).rejects.toThrow("browser run ended");
	});

	it("resolves wait(predicate) with the first truthy value", async () => {
		vi.useRealTimers();
		const controller = new AbortController();
		let calls = 0;

		const wait = waitForBrowserRun(() => (++calls >= 3 ? "ready" : null), controller.signal, { interval: 10 });

		await expect(wait).resolves.toBe("ready");
		expect(calls).toBe(3);
	});

	it("fails wait(predicate) with a named timeout error instead of stalling", async () => {
		vi.useRealTimers();
		const controller = new AbortController();

		const wait = waitForBrowserRun(() => false, controller.signal, { timeout: 50, interval: 10 });

		await expect(wait).rejects.toThrow("wait(predicate) timed out after 50ms");
	});

	it("rejects wait(predicate) when the run aborts mid-poll", async () => {
		vi.useRealTimers();
		const controller = new AbortController();

		const wait = waitForBrowserRun(() => false, controller.signal, { timeout: 5000 });
		controller.abort(new Error("browser run ended"));

		await expect(wait).rejects.toThrow("browser run ended");
	});

	it("rejects wait() input that is neither milliseconds nor a predicate", async () => {
		const controller = new AbortController();

		await expect(waitForBrowserRun("soon" as never, controller.signal)).rejects.toThrow(
			"wait(...) expects milliseconds (number) or a predicate function to poll",
		);
	});

	it("does not emit unhandledRejection for an unawaited wait aborted by run teardown", async () => {
		const controller = new AbortController();

		const reasons = await collectUnhandledRejections(async () => {
			void waitForBrowserRun(1000, controller.signal);
			controller.abort(postmortem.markExpectedCleanupError(new Error("browser run ended")));
		});

		expect(reasons).toEqual([]);
	});

	it("does not emit unhandledRejection when an unawaited facade method settles after abort", async () => {
		const controller = new AbortController();
		const deferred = Promise.withResolvers<string>();
		const facade = bindBrowserRunFacade(
			{
				readTitle(): Promise<string> {
					return deferred.promise;
				},
			},
			controller.signal,
		);

		const reasons = await collectUnhandledRejections(async () => {
			void facade.readTitle();
			controller.abort(postmortem.markExpectedCleanupError(new Error("browser run ended")));
			deferred.resolve("late title");
		});

		expect(reasons).toEqual([]);
	});

	it("rejects awaited facade method calls that settle after abort", async () => {
		const controller = new AbortController();
		const deferred = Promise.withResolvers<string>();
		const facade = bindBrowserRunFacade(
			{
				readTitle(): Promise<string> {
					return deferred.promise;
				},
			},
			controller.signal,
		);

		const pending = facade.readTitle();
		controller.abort(new Error("browser run ended"));
		deferred.resolve("late title");

		await expect(pending).rejects.toBeInstanceOf(ToolAbortError);
	});

	it("aborts run-scoped wait() before a stale continuation can mutate the tab", async () => {
		const runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: "browser-run-cancellation-test" });
		const timeoutSignal = AbortSignal.timeout(20);
		const runAc = new AbortController();
		const signal = AbortSignal.any([timeoutSignal, runAc.signal]);
		const state: { lateNavigation?: string; displays: string[] } = { displays: [] };
		const { promise: cancelRejection, reject } = Promise.withResolvers<never>();
		const hooks: RuntimeHooks = {
			onText: chunk => state.displays.push(chunk),
			onDisplay: output => state.displays.push(JSON.stringify(output)),
			callTool: async () => undefined,
		};
		timeoutSignal.addEventListener("abort", () => reject(new Error("Browser code execution timed out after 20ms")), {
			once: true,
		});
		runtime.setRunScope({
			wait: (ms: number): Promise<unknown> => waitForBrowserRun(ms, signal),
			tab: bindBrowserRunFacade(
				{
					goto: async (url: string): Promise<void> => {
						state.lateNavigation = url;
					},
				},
				signal,
			),
		});

		const run = Promise.race([
			runtime.run(
				'try { await wait(60); } catch {} await tab.goto("https://late.example"); display("late display");',
				"browser-run-cancellation-test.js",
				hooks,
			),
			cancelRejection,
		]);
		vi.advanceTimersByTime(20);
		await expect(run).rejects.toThrow("Browser code execution timed out after 20ms");
		runAc.abort(new Error("Browser run ended"));
		vi.advanceTimersByTime(100);
		await Promise.resolve();
		await Promise.resolve();

		expect(state.lateNavigation).toBeUndefined();
		expect(state.displays).toEqual([]);
	});
});

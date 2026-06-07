import { afterEach, describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../config/settings";
import type { ToolSession } from "../../tools";
import { disposeAllVmContexts } from "../js/context-manager";
import { executeJs } from "../js/executor";

const originalWorker = globalThis.Worker;

interface FakeWorkerStats {
	closeRequests: number;
	terminateCalls: number;
}

interface FakeWorkerBehavior {
	exitOnClose: boolean;
	settleRuns: boolean;
}

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": false,
			"task.isolation.mode": "none",
			"task.enableLsp": true,
		}),
		taskDepth: 0,
		enableLsp: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModelString: () => "p/active",
		getModelString: () => "p/fallback",
		getArtifactsDir: () => null,
		getSessionId: () => "test-session",
		getEvalSessionId: () => "test-eval-session",
	};
}

function installFakeWorker(stats: FakeWorkerStats, behavior: FakeWorkerBehavior): void {
	class FakeWorker {
		#messageListeners = new Set<(event: MessageEvent) => void>();
		#closeListeners = new Set<(event: Event) => void>();
		#readyQueued = false;
		#exited = false;

		postMessage(message: unknown): void {
			if (!message || typeof message !== "object") return;
			const typed = message as { type?: string; runId?: string };
			if (typed.type === "run" && typed.runId && behavior.settleRuns) {
				queueMicrotask(() => this.#emitMessage({ type: "result", runId: typed.runId, ok: true }));
				return;
			}
			if (typed.type === "close") {
				stats.closeRequests++;
				queueMicrotask(() => {
					this.#emitMessage({ type: "closed" });
					if (behavior.exitOnClose) this.#emitClose();
				});
			}
		}

		addEventListener(type: string, listener: (event: MessageEvent | Event) => void): void {
			if (type === "close") {
				this.#closeListeners.add(listener as (event: Event) => void);
				return;
			}
			if (type !== "message") return;
			this.#messageListeners.add(listener as (event: MessageEvent) => void);
			if (!this.#readyQueued) {
				this.#readyQueued = true;
				queueMicrotask(() => this.#emitMessage({ type: "ready" }));
			}
		}

		removeEventListener(type: string, listener: (event: MessageEvent | Event) => void): void {
			if (type === "close") {
				this.#closeListeners.delete(listener as (event: Event) => void);
				return;
			}
			if (type !== "message") return;
			this.#messageListeners.delete(listener as (event: MessageEvent) => void);
		}

		terminate(): void {
			stats.terminateCalls++;
			this.#emitClose();
		}

		#emitMessage(data: unknown): void {
			const event = new MessageEvent("message", { data });
			for (const listener of this.#messageListeners) listener(event);
		}

		#emitClose(): void {
			if (this.#exited) return;
			this.#exited = true;
			const event = new Event("close");
			for (const listener of this.#closeListeners) listener(event);
		}
	}

	Object.defineProperty(globalThis, "Worker", {
		configurable: true,
		writable: true,
		value: FakeWorker as unknown as typeof Worker,
	});
}

describe("JavaScript eval worker lifecycle", () => {
	afterEach(async () => {
		await disposeAllVmContexts();
		Object.defineProperty(globalThis, "Worker", {
			configurable: true,
			writable: true,
			value: originalWorker,
		});
	});

	it("waits for the worker to close on reset instead of force-terminating it", async () => {
		using tempDir = TempDir.createSync("@omp-js-worker-close-");
		const stats: FakeWorkerStats = { closeRequests: 0, terminateCalls: 0 };
		installFakeWorker(stats, { exitOnClose: true, settleRuns: true });

		const session = makeSession(tempDir.path());
		const sessionId = `js-close:${crypto.randomUUID()}`;

		const first = await executeJs("globalThis.marker = 1;", { cwd: tempDir.path(), sessionId, session });
		expect(first.exitCode).toBe(0);

		const second = await executeJs("globalThis.marker = 2;", {
			cwd: tempDir.path(),
			sessionId,
			session,
			reset: true,
		});
		expect(second.exitCode).toBe(0);
		expect(stats.closeRequests).toBe(1);
		expect(stats.terminateCalls).toBe(0);
	});

	it("terminates when close is acknowledged but the worker does not exit", async () => {
		using tempDir = TempDir.createSync("@omp-js-worker-close-hung-");
		const stats: FakeWorkerStats = { closeRequests: 0, terminateCalls: 0 };
		installFakeWorker(stats, { exitOnClose: false, settleRuns: true });

		const session = makeSession(tempDir.path());
		const sessionId = `js-close-hung:${crypto.randomUUID()}`;

		const first = await executeJs("globalThis.marker = 1;", { cwd: tempDir.path(), sessionId, session });
		expect(first.exitCode).toBe(0);

		const second = await executeJs("globalThis.marker = 2;", {
			cwd: tempDir.path(),
			sessionId,
			session,
			reset: true,
		});
		expect(second.exitCode).toBe(0);
		expect(stats.closeRequests).toBe(1);
		expect(stats.terminateCalls).toBe(1);
	});

	it("force-terminates instead of closing when an in-flight run is aborted", async () => {
		using tempDir = TempDir.createSync("@omp-js-worker-abort-");
		const stats: FakeWorkerStats = { closeRequests: 0, terminateCalls: 0 };
		installFakeWorker(stats, { exitOnClose: true, settleRuns: false });

		const session = makeSession(tempDir.path());
		const sessionId = `js-abort:${crypto.randomUUID()}`;
		const controller = new AbortController();
		const resultPromise = executeJs("globalThis.neverFinishes = true;", {
			cwd: tempDir.path(),
			sessionId,
			session,
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(new DOMException("Execution aborted", "AbortError")), 0);

		const result = await resultPromise;
		expect(result.cancelled).toBe(true);
		expect(stats.closeRequests).toBe(0);
		expect(stats.terminateCalls).toBe(1);
	});
});

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

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timeout: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

async function waitForRealWorkerExitAfterClose(cwd: string): Promise<void> {
	const worker = new originalWorker(new URL("../js/worker-entry.ts", import.meta.url).href, { type: "module" });
	const ready = Promise.withResolvers<void>();
	const runComplete = Promise.withResolvers<void>();
	const closedAck = Promise.withResolvers<void>();
	const workerClosed = Promise.withResolvers<void>();
	const runId = `keep-alive:${crypto.randomUUID()}`;
	const snapshot = { cwd, sessionId: `worker-exit:${crypto.randomUUID()}` };

	worker.addEventListener("message", event => {
		const msg = event.data as { type?: string; runId?: string; ok?: boolean };
		if (msg.type === "ready") ready.resolve();
		else if (msg.type === "result" && msg.runId === runId && msg.ok) runComplete.resolve();
		else if (msg.type === "closed") closedAck.resolve();
	});
	worker.addEventListener("close", () => workerClosed.resolve());

	try {
		await withTimeout(ready.promise, 1_000, "worker ready");
		worker.postMessage({
			type: "run",
			runId,
			code: "globalThis.__keepAlive = setInterval(() => {}, 1000);\nundefined;",
			filename: "keep-alive.js",
			snapshot,
		});
		await withTimeout(runComplete.promise, 1_000, "worker run");
		worker.postMessage({ type: "close" });
		await withTimeout(closedAck.promise, 1_000, "worker closed ack");
		await withTimeout(workerClosed.promise, 1_000, "worker close event");
	} finally {
		worker.terminate();
	}
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

	it("exits a real worker on graceful close even with ref'ed user handles", async () => {
		using tempDir = TempDir.createSync("@omp-js-worker-real-close-");

		await waitForRealWorkerExitAfterClose(tempDir.path());
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

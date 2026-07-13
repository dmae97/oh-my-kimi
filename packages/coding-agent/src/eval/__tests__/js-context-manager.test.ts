import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../config/settings";
import type { ToolSession } from "../../tools";
import {
	disposeAllVmContexts,
	setJsEvalWorkerThreadForTests,
	setWorkerCloseTimeoutMsForTests,
} from "../js/context-manager";
import { executeJs } from "../js/executor";

const originalWorker = globalThis.Worker;

interface FakeWorkerStats {
	closeRequests: number;
	terminateCalls: number;
}

interface FakeWorkerBehavior {
	exitOnClose: boolean;
	settleRuns: boolean;
	errorOnStart?: boolean;
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
		worker.postMessage({ type: "init", snapshot });
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
		#errorListeners = new Set<(event: Event) => void>();
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
			if (type === "error") {
				this.#errorListeners.add(listener as (event: Event) => void);
				return;
			}
			if (type !== "message") return;
			this.#messageListeners.add(listener as (event: MessageEvent) => void);
			if (!this.#readyQueued) {
				this.#readyQueued = true;
				queueMicrotask(() => {
					if (behavior.errorOnStart) this.#emitError();
					else this.#emitMessage({ type: "ready" });
				});
			}
		}

		removeEventListener(type: string, listener: (event: MessageEvent | Event) => void): void {
			if (type === "close") {
				this.#closeListeners.delete(listener as (event: Event) => void);
				return;
			}
			if (type === "error") {
				this.#errorListeners.delete(listener as (event: Event) => void);
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

		#emitError(): void {
			const event = new ErrorEvent("error", {
				message: "fake worker failed to start",
				error: new Error("fake worker failed to start"),
			});
			for (const listener of this.#errorListeners) listener(event);
		}
	}

	Object.defineProperty(globalThis, "Worker", {
		configurable: true,
		writable: true,
		value: FakeWorker as unknown as typeof Worker,
	});
}

describe("JavaScript eval worker lifecycle", () => {
	let restoreCloseTimeoutMs = 0;
	let restoreWorkerThread = false;
	beforeEach(() => {
		restoreWorkerThread = setJsEvalWorkerThreadForTests(true);
		// Shrink the graceful-close grace period so the "close acked but the worker
		// never exits -> force terminate" contract is proven without a real 1s wait.
		restoreCloseTimeoutMs = setWorkerCloseTimeoutMsForTests(1);
	});

	afterEach(async () => {
		// Dispose while the shrunk timeout is still active so a hung worker's afterEach
		// close also force-terminates instantly, then restore the production default.
		await disposeAllVmContexts();
		setWorkerCloseTimeoutMsForTests(restoreCloseTimeoutMs);
		Object.defineProperty(globalThis, "Worker", {
			configurable: true,
			writable: true,
			value: originalWorker,
		});
		setJsEvalWorkerThreadForTests(restoreWorkerThread);
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

	it("falls back to a Bun Worker when the subprocess cannot spawn", async () => {
		using tempDir = TempDir.createSync("@omp-js-spawn-fallback-");
		// Exercise the production ladder (process -> worker -> inline), not the
		// worker-thread test seam the surrounding describe enables.
		setJsEvalWorkerThreadForTests(false);
		const stats: FakeWorkerStats = { closeRequests: 0, terminateCalls: 0 };
		installFakeWorker(stats, { exitOnClose: true, settleRuns: true });
		const originalSpawn = Bun.spawn;
		let spawnAttempts = 0;
		Bun.spawn = ((): never => {
			spawnAttempts++;
			throw new Error("subprocess spawn unavailable");
		}) as unknown as typeof Bun.spawn;

		try {
			const session = makeSession(tempDir.path());
			const sessionId = `js-spawn-fallback:${crypto.randomUUID()}`;
			// The fake Worker settles runs without executing the cell, so an empty
			// output proves the middle rung handled it — the inline fallback would
			// have actually evaluated the expression and printed 42.
			const result = await executeJs("return String(6 * 7);", { cwd: tempDir.path(), sessionId, session });
			expect(result.exitCode).toBe(0);
			expect(result.output.trim()).toBe("");
			expect(spawnAttempts).toBe(1);
		} finally {
			Bun.spawn = originalSpawn;
		}
	});

	it("falls back to a Bun Worker when the subprocess fails during initialization", async () => {
		using tempDir = TempDir.createSync("@omp-js-init-fallback-");
		// Exercise the production ladder (process -> worker -> inline), not the
		// worker-thread test seam the surrounding describe enables.
		setJsEvalWorkerThreadForTests(false);
		const stats: FakeWorkerStats = { closeRequests: 0, terminateCalls: 0 };
		installFakeWorker(stats, { exitOnClose: true, settleRuns: true });
		const originalSpawn = Bun.spawn;
		let spawnAttempts = 0;
		Bun.spawn = ((options: unknown) => {
			spawnAttempts++;
			const spawnOptions = options as {
				onExit?: (proc: unknown, exitCode: number | null, signalCode: string | null) => void;
			};
			const fakeProcess = {
				send: () => undefined,
				kill: () => undefined,
				unref: () => undefined,
			};
			queueMicrotask(() => spawnOptions.onExit?.(fakeProcess, 1, null));
			return fakeProcess;
		}) as unknown as typeof Bun.spawn;

		try {
			const session = makeSession(tempDir.path());
			const sessionId = `js-init-fallback:${crypto.randomUUID()}`;
			// The fake Worker settles runs without executing the cell, so empty
			// output proves the middle rung handled the retry. Inline execution
			// would evaluate the expression and print 42.
			const result = await executeJs("return String(6 * 7);", { cwd: tempDir.path(), sessionId, session });
			expect(result.exitCode).toBe(0);
			expect(result.output.trim()).toBe("");
			expect(spawnAttempts).toBe(1);
		} finally {
			Bun.spawn = originalSpawn;
		}
	});

	it("falls back to the inline worker when the spawned worker errors during startup", async () => {
		using tempDir = TempDir.createSync("@omp-js-worker-error-");
		const stats: FakeWorkerStats = { closeRequests: 0, terminateCalls: 0 };
		installFakeWorker(stats, { exitOnClose: true, settleRuns: true, errorOnStart: true });

		const session = makeSession(tempDir.path());
		const sessionId = `js-worker-error:${crypto.randomUUID()}`;

		// The spawned worker emits an `error` event instead of `ready`. Without fail-fast
		// error handling the handshake would stall until WORKER_INIT_TIMEOUT_MS (15s); with
		// it, the handshake rejects at once and the inline worker runs the cell.
		const result = await executeJs("return String(6 * 7);", { cwd: tempDir.path(), sessionId, session });
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("42");
		// The errored primary worker is torn down before the inline retry takes over.
		expect(stats.terminateCalls).toBe(1);
	});
});

describe.skipIf(process.platform === "win32")("JavaScript eval process isolation", () => {
	afterEach(async () => {
		await disposeAllVmContexts();
	});

	it("runs spawned commands under an isolated POSIX session", async () => {
		using tempDir = TempDir.createSync("@omp-js-process-isolation-");
		const session = makeSession(tempDir.path());
		const evalSessionId = `js-isolation:${crypto.randomUUID()}`;
		const result = await executeJs(
			[
				`const child = Bun.spawn(["/bin/sh", "-c", 'sid=$(ps -o sid= -p $$); printf "%s %s\\n" "$sid" "$PPID"'], { stdout: "pipe" });`,
				"return await new Response(child.stdout).text();",
			].join("\n"),
			{ cwd: tempDir.path(), sessionId: evalSessionId, session },
		);
		const [sessionId, parentProcessId] = result.output.trim().split(/\s+/).map(Number);
		expect(parentProcessId).not.toBe(process.pid);
		expect(sessionId).toBe(parentProcessId);

		await executeJs("var saved = 41; function increment(value) { return value + 1; }", {
			cwd: tempDir.path(),
			sessionId: evalSessionId,
			session,
		});
		const reused = await executeJs("return increment(saved);", {
			cwd: tempDir.path(),
			sessionId: evalSessionId,
			session,
		});
		expect(reused.output.trim()).toBe("42");
	});

	it("mirrors the session cwd onto the subprocess's real cwd", async () => {
		using tempDir = TempDir.createSync("@omp-js-process-cwd-");
		const session = makeSession(tempDir.path());
		const evalSessionId = `js-cwd:${crypto.randomUUID()}`;
		const result = await executeJs("return process.cwd();", {
			cwd: tempDir.path(),
			sessionId: evalSessionId,
			session,
		});
		// process.chdir resolves symlinks (macOS tempdirs live under /var ->
		// /private/var), so compare physical paths.
		expect(result.output.trim()).toBe(fs.realpathSync(tempDir.path()));
	});

	it("still runs cells when the session cwd does not exist", async () => {
		using tempDir = TempDir.createSync("@omp-js-process-cwd-missing-");
		const missingCwd = path.join(tempDir.path(), "deleted");
		const session = makeSession(missingCwd);
		const result = await executeJs("return String(6 * 7);", {
			cwd: missingCwd,
			sessionId: `js-cwd-missing:${crypto.randomUUID()}`,
			session,
		});
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("42");
	});

	it("keeps the isolated process alive after a stackless floated rejection", async () => {
		using tempDir = TempDir.createSync("@omp-js-process-rejection-");
		const session = makeSession(tempDir.path());
		const evalSessionId = `js-rejection:${crypto.randomUUID()}`;
		const rejected = await executeJs(
			'var savedAfterRejection = 41; Promise.reject("stackless rejection"); await Bun.sleep(10);',
			{ cwd: tempDir.path(), sessionId: evalSessionId, session },
		);
		expect(rejected.exitCode).toBe(1);
		expect(rejected.output).toContain("Unhandled rejection (missing await?): stackless rejection");

		const reused = await executeJs("return savedAfterRejection + 1;", {
			cwd: tempDir.path(),
			sessionId: evalSessionId,
			session,
		});
		expect(reused.exitCode).toBe(0);
		expect(reused.output.trim()).toBe("42");
	});
});

/**
 * Cleanup and postmortem handler utilities.
 *
 * This module provides a system for registering and running cleanup callbacks
 * in response to process exit, signals, or fatal exceptions. It is intended to
 * allow reliably releasing resources or shutting down subprocesses, files, sockets, etc.
 */
import inspector from "node:inspector";
import { isMainThread } from "node:worker_threads";
import { logger } from ".";

// Cleanup reasons, in order of priority/meaning.
export enum Reason {
	PRE_EXIT = "pre_exit", // Pre-exit phase (not used by default)
	EXIT = "exit", // Normal process exit
	SIGINT = "sigint", // Ctrl-C or SIGINT
	SIGTERM = "sigterm", // SIGTERM
	SIGHUP = "sighup", // SIGHUP
	UNCAUGHT_EXCEPTION = "uncaught_exception", // Fatal exception
	UNHANDLED_REJECTION = "unhandled_rejection", // Unhandled promise rejection
	MANUAL = "manual", // Manual cleanup (not triggered by process)
}

// Internal list of active cleanup callbacks (in registration order)
const callbackList: ((reason: Reason) => Promise<void> | void)[] = [];
// Tracks cleanup run state (to prevent recursion/reentry issues)
let cleanupStage: "idle" | "running" | "complete" = "idle";
const CLEANUP_DEADLINE_MS = 10_000;

/**
 * Internal: runs all registered cleanup callbacks for the given reason.
 * Ensures each callback is invoked at most once. Handles errors and prevents reentrancy.
 *
 * Returns a Promise that settles after all cleanups complete or error out.
 */
function runCleanup(reason: Reason): Promise<void> {
	switch (cleanupStage) {
		case "idle":
			cleanupStage = "running";
			break;
		case "running":
			return Promise.resolve();
		case "complete":
			return Promise.resolve();
	}

	// Call .cleanup() for each callback that is still "armed".
	// Use Promise.try to handle sync/async, but only those armed.
	const promises = callbackList.toReversed().map(callback => {
		return Promise.try(() => callback(reason));
	});

	const cleanupSettled = Promise.allSettled(promises).then(results => {
		for (const result of results) {
			if (result.status === "rejected") {
				const err = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
				logger.error("Cleanup callback failed", { err, stack: err.stack });
			}
		}
		cleanupStage = "complete";
	});
	const deadline = Promise.withResolvers<void>();
	const deadlineTimer = setTimeout(() => {
		logger.error("Cleanup deadline exceeded; proceeding with exit", { reason });
		cleanupStage = "complete";
		deadline.resolve();
	}, CLEANUP_DEADLINE_MS);
	deadlineTimer.unref();
	return Promise.race([cleanupSettled, deadline.promise]).finally(() => {
		clearTimeout(deadlineTimer);
	});
}

// Register signal and error event handlers to trigger cleanup before exit.
// Main thread: full signal handling (SIGINT, SIGTERM, SIGHUP) + exceptions + exit
// Worker thread: exit only (workers use self.addEventListener for exceptions)
let inspectorOpened = false;

/**
 * Detect an EPIPE rejection that originated from an IPC `send()` to a worker
 * subprocess (`syscall: "send"`), as opposed to a stdin/stdout pipe write
 * (`syscall: "write"`). Only the IPC-send path can break an optional worker
 * subsystem without affecting the main process, so only this shape is safe to
 * swallow at the global `unhandledRejection` level. See issue #2997.
 */
export function isIpcSendEpipe(err: Error): boolean {
	const code = (err as { code?: unknown }).code;
	const syscall = (err as { syscall?: unknown }).syscall;
	return code === "EPIPE" && syscall === "send";
}

// Well-known key marking an error as an *expected* teardown artifact (e.g. a
// browser run-scope abort at normal run end). `Symbol.for` so the marker
// survives duplicate module instances across bundles/realms.
const EXPECTED_CLEANUP = Symbol.for("omp.expectedCleanupError");

/**
 * Mark an error as expected cleanup fallout so the global fatal handlers
 * downgrade it to a log line instead of tearing down the process. Use for
 * abort reasons fired by routine resource teardown (browser run end, tab
 * close) whose rejections may surface on fire-and-forget promises with no
 * consumer. Returns the same error for inline use at the `abort()` callsite.
 */
export function markExpectedCleanupError<T extends object>(reason: T): T {
	(reason as Record<PropertyKey, unknown>)[EXPECTED_CLEANUP] = true;
	return reason;
}

/**
 * Whether `reason` (or any error in its `cause` chain) was marked via
 * {@link markExpectedCleanupError}. Walks the chain because the unhandled
 * reason is often a wrapper (`AbortError`) with the marked abort reason as
 * its `cause`.
 */
export function isExpectedCleanupError(reason: unknown): boolean {
	let current: unknown = reason;
	for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth++) {
		if ((current as Record<PropertyKey, unknown>)[EXPECTED_CLEANUP] === true) return true;
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

/**
 * Interceptors consulted by the global `unhandledRejection` handler before the
 * fatal path. See {@link interceptUnhandledRejections}.
 */
const rejectionInterceptors = new Set<(reason: unknown) => boolean>();

/**
 * Register an interceptor consulted before an unhandled rejection tears the
 * process down. Return `true` to consume the rejection — the interceptor owns
 * reporting and the process continues. Used by embedded script runtimes (JS
 * eval cells) whose user code can float rejections the host must not die for.
 * Returns an unregister function.
 */
export function interceptUnhandledRejections(interceptor: (reason: unknown) => boolean): () => void {
	rejectionInterceptors.add(interceptor);
	return () => rejectionInterceptors.delete(interceptor);
}

function formatFatalError(label: string, err: Error): string {
	const name = err.name || "Error";
	const message = err.message || "(no message)";
	const stack = err.stack || "";
	const stackLines = stack.split("\n").slice(1);
	const formattedStack = stackLines.length > 0 ? `\n${stackLines.join("\n")}` : "";
	return `\n[${label}] ${name}: ${message}${formattedStack}\n`;
}

if (isMainThread) {
	process
		.on("SIGINT", async () => {
			await runCleanup(Reason.SIGINT);
			process.exit(130); // 128 + SIGINT (2)
		})
		.on("SIGUSR1", () => {
			if (inspectorOpened) return;
			inspectorOpened = true;
			inspector.open(undefined, undefined, false);
			const url = inspector.url();
			process.stderr.write(`Inspector opened: ${url}\n`);
		})
		.on("uncaughtException", async err => {
			if (isExpectedCleanupError(err)) {
				logger.warn("Ignoring expected cleanup exception", { err });
				return;
			}
			process.stderr.write(formatFatalError("Uncaught Exception", err));
			logger.error("Uncaught exception", { err });
			await runCleanup(Reason.UNCAUGHT_EXCEPTION);
			process.exit(1);
		})
		.on("unhandledRejection", async reason => {
			const err = reason instanceof Error ? reason : new Error(String(reason));
			// EPIPE from an IPC `send()` (`syscall: "send"`) originates from a
			// worker subprocess whose pipe broke between the exit being observed
			// and the next `proc.send()` — a race window that Bun surfaces as an
			// async rejection rather than the synchronous "cannot be used after
			// the process has exited" guard. Every `send()` target is an optional
			// worker subsystem (TTS, STT, tiny-title, MCP servers), so a broken
			// send pipe must never take down the whole session. Log and continue
			// instead of exiting; the owning client detects the dead worker via
			// its own `onExit`/error path and respawns or disables it. See #2997.
			if (isIpcSendEpipe(err)) {
				logger.warn("Ignoring EPIPE from worker IPC send; optional subsystem will self-recover", { err });
				return;
			}
			if (isExpectedCleanupError(reason)) {
				logger.warn("Ignoring expected cleanup rejection", { err });
				return;
			}
			for (const interceptor of rejectionInterceptors) {
				try {
					if (interceptor(reason)) return;
				} catch (interceptorErr) {
					logger.warn("Unhandled-rejection interceptor threw; continuing with fatal path", {
						err: interceptorErr,
					});
				}
			}
			process.stderr.write(formatFatalError("Unhandled Rejection", err));
			logger.error("Unhandled rejection", { err });
			await runCleanup(Reason.UNHANDLED_REJECTION);
			process.exit(1);
		})
		.on("exit", async () => {
			void runCleanup(Reason.EXIT); // fire and forget (exit imminent)
		})
		.on("SIGTERM", async () => {
			await runCleanup(Reason.SIGTERM);
			process.exit(143); // 128 + SIGTERM (15)
		})
		.on("SIGHUP", async () => {
			await runCleanup(Reason.SIGHUP);
			process.exit(129); // 128 + SIGHUP (1)
		});
} else {
	// Worker thread: only register exit handler for cleanup.
	// DO NOT register uncaughtException/unhandledRejection handlers here -
	// they would swallow errors before the worker's own handlers (self.addEventListener)
	// can report failures back to the parent thread.
	process.on("exit", () => {
		void runCleanup(Reason.EXIT);
	});
}

/**
 * Register a process cleanup callback, to be run on shutdown, signal, or fatal error.
 *
 * Returns a Callback instance that can be used to cancel (unregister) or manually clean up.
 * If register is called after cleanup already began, invokes callback on a microtask.
 */
export function register(id: string, callback: (reason: Reason) => void | Promise<void>): () => void {
	let done = false;
	const exec = (reason: Reason) => {
		if (done) return;
		done = true;
		try {
			return callback(reason);
		} catch (e) {
			const err = e instanceof Error ? e : new Error(String(e));
			logger.error("Cleanup callback failed", { err, id, stack: err.stack });
		}
	};

	const cancel = () => {
		const index = callbackList.indexOf(exec);
		if (index >= 0) {
			callbackList.splice(index, 1);
		}
		done = true;
	};

	if (cleanupStage !== "idle") {
		// Cleanup is already in progress or complete; run late registrations once
		// without re-entering the global cleanup pass.
		logger.debug("Cleanup already started; running late callback once", { id });
		try {
			callback(Reason.MANUAL);
		} catch (e) {
			const err = e instanceof Error ? e : new Error(String(e));
			logger.error("Cleanup callback failed", { err, id, stack: err.stack });
		}
		return () => {};
	}

	// Register callback as "armed" (active).
	callbackList.push(exec);
	return cancel;
}

/**
 * Runs all cleanup callbacks without exiting.
 * Use this in workers or when you need to clean up but continue execution.
 */
export function cleanup(): Promise<void> {
	return runCleanup(Reason.MANUAL);
}

/**
 * Runs all cleanup callbacks and exits.
 *
 * In main thread: waits for stdout drain, then calls process.exit().
 * In workers: runs cleanup only (process.exit would kill entire process).
 */
export async function quit(code: number = 0): Promise<void> {
	await runCleanup(Reason.MANUAL);

	if (!isMainThread) {
		return; // Workers: cleanup done, let worker exit naturally
	}

	if (process.stdout.writableLength > 0) {
		const { promise, resolve } = Promise.withResolvers<void>();
		process.stdout.once("drain", resolve);
		await Promise.race([promise, Bun.sleep(5000)]);
	}
	process.exit(code);
}

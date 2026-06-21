/**
 * Subprocess-backed Julia runner.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $flag, logger, Snowflake } from "@oh-my-pi/pi-utils";
import { $, type Subprocess } from "bun";
import { Settings } from "../../config/settings";
import { type KernelDisplayOutput, renderKernelDisplay } from "../py/display";
import { hostHasInheritableConsole, shouldHideKernelWindow } from "../py/spawn-options";
import { JULIA_PRELUDE } from "./prelude";
import RUNNER_SCRIPT from "./runner.jl" with { type: "text" };
import {
	enumerateJuliaRuntimes,
	filterEnv,
	type JuliaRuntime,
	resolveExplicitJuliaRuntime,
	resolveJuliaRuntime,
} from "./runtime";

export type { KernelDisplayOutput };
export { renderKernelDisplay };

const TRACE_IPC = $flag("PI_JULIA_IPC_TRACE");

// Cache the runner script on disk so the subprocess loads it normally. Cached
// per script hash so installs don't race across versions.
const RUNNER_CACHE_DIR = path.join(os.tmpdir(), "omp-julia-runner");
let RUNNER_SCRIPT_PATH: string | null = null;

async function ensureRunnerScript(): Promise<string> {
	if (RUNNER_SCRIPT_PATH) return RUNNER_SCRIPT_PATH;
	await fs.promises.mkdir(RUNNER_CACHE_DIR, { recursive: true });
	const hash = Bun.hash(RUNNER_SCRIPT).toString(36);
	const target = path.join(RUNNER_CACHE_DIR, `runner-${hash}.jl`);
	if (!fs.existsSync(target)) {
		await Bun.write(target, RUNNER_SCRIPT);
	}
	RUNNER_SCRIPT_PATH = target;
	return target;
}

const SHUTDOWN_GRACE_MS = 1_000;
const STARTUP_TIMEOUT_MS = 15_000; // Julia compile/warmup can be slightly slower
const INTERRUPT_ESCALATION_MS = 5_000;

export type KernelRuntimeEnv = Record<string, string | null>;

export interface KernelExecuteOptions {
	id?: string;
	cwd?: string;
	env?: Record<string, string | undefined>;
	silent?: boolean;
	storeHistory?: boolean;
	timeoutMs?: number;
	signal?: AbortSignal;
	onChunk?: (text: string) => void | Promise<void>;
	onDisplay?: (output: KernelDisplayOutput) => void | Promise<void>;
}

export interface KernelExecuteResult {
	status: "ok" | "error";
	executionCount?: number;
	error?: {
		name: string;
		value: string;
		traceback: string[];
	};
	cancelled: boolean;
	timedOut: boolean;
	stdinRequested: boolean;
	kernelKilled: boolean;
}

interface KernelLifecycleOptions {
	cwd: string;
	signal?: AbortSignal;
	deadlineMs?: number;
}

interface KernelStartOptions extends KernelLifecycleOptions {
	interpreter?: string;
	env?: Record<string, string | undefined>;
}

interface KernelShutdownOptions {
	timeoutMs?: number;
}

export interface JuliaKernelAvailability {
	ok: boolean;
	juliaPath?: string;
	runtime?: JuliaRuntime;
	reason?: string;
}

function getRemainingTimeMs(deadlineMs?: number): number | undefined {
	if (deadlineMs === undefined) return undefined;
	return Math.max(0, deadlineMs - Date.now());
}

function createAbortError(name: "AbortError" | "TimeoutError", message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

function throwIfAborted(signal: AbortSignal | undefined, fallbackReason: string): void {
	if (signal?.aborted) {
		throw signal.reason ?? createAbortError("AbortError", fallbackReason);
	}
}

// Cache successful probes per resolved cwd + explicit interpreter. Failures are
// not cached so installing Julia mid-session is picked up on the next attempt.
const availabilityCache = new Map<string, Promise<JuliaKernelAvailability>>();

export async function checkJuliaKernelAvailability(
	cwd: string,
	interpreter?: string,
): Promise<JuliaKernelAvailability> {
	const cacheKey = `${path.resolve(cwd)}::${interpreter ?? ""}`;
	let cached = availabilityCache.get(cacheKey);
	if (!cached) {
		cached = probeJuliaKernelAvailability(cwd, interpreter);
		availabilityCache.set(cacheKey, cached);
	}
	const result = await cached;
	if (!result.ok) {
		availabilityCache.delete(cacheKey);
	}
	return result;
}

async function probeJuliaKernelAvailability(cwd: string, interpreter?: string): Promise<JuliaKernelAvailability> {
	const { env: shellEnv } = (await Settings.init()).getShellConfig();
	const baseEnv = filterEnv(shellEnv);
	const runtimes = enumerateJuliaRuntimes(cwd, baseEnv, interpreter);

	if (runtimes.length === 0) {
		return {
			ok: false,
			reason: "Julia executable not found on PATH. Please install Julia (https://julialang.org/).",
		};
	}

	const failures: string[] = [];
	for (const runtime of runtimes) {
		try {
			const probe = await $`${runtime.juliaPath} -e "exit(0)"`.quiet().nothrow().cwd(cwd).env(runtime.env);
			if (probe.exitCode === 0) {
				return { ok: true, juliaPath: runtime.juliaPath, runtime };
			}
			failures.push(`${runtime.juliaPath} (exit code ${probe.exitCode})`);
		} catch (err) {
			failures.push(`${runtime.juliaPath} (${err instanceof Error ? err.message : String(err)})`);
		}
	}

	return {
		ok: false,
		juliaPath: runtimes[0].juliaPath,
		reason: `No working Julia interpreter found. Tried: ${failures.join("; ")}`,
	};
}

type FrameType = "started" | "stdout" | "stderr" | "display" | "result" | "error" | "done";

interface Frame {
	type: FrameType;
	id?: string;
	data?: string;
	bundle?: Record<string, unknown>;
	ename?: string;
	evalue?: string;
	traceback?: string[];
	status?: "ok" | "error";
	executionCount?: number;
	cancelled?: boolean;
}

interface PendingExecution {
	resolve: (value: KernelExecuteResult) => void;
	options?: KernelExecuteOptions;
	status: "ok" | "error";
	cancelled: boolean;
	timedOut: boolean;
	stdinRequested: boolean;
	settled: boolean;
	kernelKilled: boolean;
	executionCount?: number;
	error?: {
		name: string;
		value: string;
		traceback: string[];
	};
	escalationTimer?: NodeJS.Timeout;
}

export class JuliaKernel {
	readonly id: string;
	#proc: Subprocess | null = null;
	#stdin: Bun.FileSink | null = null;
	#alive = true;
	#disposed = false;
	#shutdownConfirmed = false;
	#exitedPromise: Promise<number> | null = null;
	#pending = new Map<string, PendingExecution>();
	#readBuffer = "";

	private constructor(id: string) {
		this.id = id;
	}

	static async start(options: KernelStartOptions): Promise<JuliaKernel> {
		const availability = await checkJuliaKernelAvailability(options.cwd, options.interpreter);
		if (!availability.ok) {
			throw new Error(availability.reason ?? "Julia kernel unavailable");
		}

		let runtime = availability.runtime;
		if (!runtime) {
			const { env: shellEnv } = (await Settings.init()).getShellConfig();
			runtime = options.interpreter
				? resolveExplicitJuliaRuntime(options.interpreter, options.cwd, filterEnv(shellEnv))
				: resolveJuliaRuntime(options.cwd, filterEnv(shellEnv));
		}
		const spawnEnv: Record<string, string> = {};
		for (const key in runtime.env) {
			const value = runtime.env[key];
			if (typeof value === "string") spawnEnv[key] = value;
		}
		for (const key in options.env) {
			const value = options.env[key];
			if (typeof value === "string") spawnEnv[key] = value;
		}

		const scriptPath = await ensureRunnerScript();
		const kernel = new JuliaKernel(Snowflake.next());

		const proc = Bun.spawn(
			[runtime.juliaPath, "--startup-file=no", "--history-file=no", "--color=no", "--project=@.", scriptPath],
			{
				cwd: options.cwd,
				env: spawnEnv,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: shouldHideKernelWindow({
					platform: process.platform,
					hostHasInheritableConsole: hostHasInheritableConsole(),
				}),
			},
		);
		kernel.#proc = proc;
		kernel.#stdin = proc.stdin;
		kernel.#exitedPromise = proc.exited;
		void kernel.#exitedPromise.then(code => {
			kernel.#alive = false;
			kernel.#abortPendingExecutions(`Julia kernel exited with code ${code}`, { kernelKilled: true });
		});

		kernel.#startReader(proc.stdout as ReadableStream<Uint8Array>);
		kernel.#startStderrDrain(proc.stderr as ReadableStream<Uint8Array>);

		const startup = { signal: options.signal, deadlineMs: options.deadlineMs };
		const startupBudget = Math.min(getRemainingTimeMs(startup.deadlineMs) ?? STARTUP_TIMEOUT_MS, STARTUP_TIMEOUT_MS);

		try {
			const initScript = buildInitScript(options.cwd, options.env);
			await kernel.#executeWithBudget(initScript, startup.signal, startupBudget, "Julia kernel init");
			await kernel.#executeWithBudget(JULIA_PRELUDE, startup.signal, startupBudget, "Julia kernel prelude");
			return kernel;
		} catch (err) {
			await kernel.shutdown({ timeoutMs: SHUTDOWN_GRACE_MS }).catch(() => {});
			throw err;
		}
	}

	isAlive(): boolean {
		return this.#alive && !this.#disposed;
	}

	async execute(code: string, options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		if (!this.isAlive()) {
			throw new Error("Julia kernel is not running");
		}

		const msgId = options?.id ?? Snowflake.next();
		const { promise, resolve } = Promise.withResolvers<KernelExecuteResult>();
		const pending: PendingExecution = {
			resolve,
			options,
			status: "ok",
			cancelled: false,
			timedOut: false,
			stdinRequested: false,
			settled: false,
			kernelKilled: false,
		};
		this.#pending.set(msgId, pending);

		const finalize = () => {
			if (pending.settled) return;
			pending.settled = true;
			this.#pending.delete(msgId);
			cleanup();
			resolve({
				status: pending.status,
				executionCount: pending.executionCount,
				error: pending.error,
				cancelled: pending.cancelled,
				timedOut: pending.timedOut,
				stdinRequested: pending.stdinRequested,
				kernelKilled: pending.kernelKilled,
			});
		};

		const requestCancel = () => {
			if (pending.settled || pending.escalationTimer) return;
			void this.interrupt();
			const escalation = setTimeout(() => {
				if (pending.settled) return;
				logger.warn("Julia runner did not respond to SIGINT; terminating subprocess", {
					kernelId: this.id,
				});
				pending.kernelKilled = true;
				void this.shutdown();
			}, INTERRUPT_ESCALATION_MS);
			escalation.unref?.();
			pending.escalationTimer = escalation;
		};

		const onAbort = () => {
			pending.cancelled = true;
			pending.timedOut = pending.timedOut || isTimeoutReason(options?.signal?.reason);
			requestCancel();
		};
		const timeoutId =
			typeof options?.timeoutMs === "number" && options.timeoutMs > 0
				? setTimeout(() => {
						pending.timedOut = true;
						pending.cancelled = true;
						requestCancel();
					}, options.timeoutMs)
				: undefined;

		const cleanup = () => {
			clearTimeout(timeoutId);
			clearTimeout(pending.escalationTimer);
			pending.escalationTimer = undefined;
			options?.signal?.removeEventListener("abort", onAbort);
		};

		if (options?.signal) {
			if (options.signal.aborted) {
				onAbort();
			} else {
				options.signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		(pending as PendingExecution & { finalize: () => void }).finalize = finalize;

		// Convert arguments into TSV / Base64 payload
		const cwdB64 = Buffer.from(options?.cwd ?? "").toString("base64");
		const silentVal = options?.silent ? "1" : "0";
		const storeHistVal = options?.storeHistory !== false && !options?.silent ? "1" : "0";

		// Format environment variables as key1_b64=val1_b64 key2_b64=val2_b64
		const envPairs: string[] = [];
		if (options?.env) {
			for (const key in options.env) {
				const val = options.env[key];
				if (val !== undefined) {
					const k_b64 = Buffer.from(key).toString("base64");
					const v_b64 = Buffer.from(val).toString("base64");
					envPairs.push(`${k_b64}:${v_b64}`);
				}
			}
		}
		const envPairsStr = envPairs.join(" ");
		const codeB64 = Buffer.from(code).toString("base64");

		const payload = `run\t${msgId}\t${cwdB64}\t${silentVal}\t${storeHistVal}\t${envPairsStr}\t${codeB64}`;

		try {
			await this.#writeLine(payload);
		} catch (err) {
			pending.cancelled = true;
			pending.error = {
				name: "TransportError",
				value: err instanceof Error ? err.message : String(err),
				traceback: [],
			};
			finalize();
		}

		return promise;
	}

	async interrupt(): Promise<void> {
		if (!this.#proc || this.#disposed) return;
		try {
			this.#proc.kill("SIGINT");
		} catch (err) {
			logger.warn("Failed to interrupt Julia runner", { error: err instanceof Error ? err.message : String(err) });
		}
	}

	async shutdown(options?: KernelShutdownOptions): Promise<{ confirmed: boolean }> {
		if (this.#shutdownConfirmed) return { confirmed: true };

		this.#alive = false;
		this.#abortPendingExecutions("Julia kernel shutdown", { kernelKilled: true });

		const timeoutMs = options?.timeoutMs ?? SHUTDOWN_GRACE_MS;
		const proc = this.#proc;
		if (!proc) {
			this.#shutdownConfirmed = true;
			this.#disposed = true;
			return { confirmed: true };
		}

		try {
			await this.#writeLine("exit").catch(() => {});
		} catch {
			/* writer may already be closed */
		}

		try {
			this.#stdin?.end();
		} catch {
			/* ignore */
		}

		const exited = this.#waitForExitWithTimeout(timeoutMs);
		let result = await exited;
		if (!result) {
			try {
				proc.kill("SIGTERM");
			} catch {
				/* ignore */
			}
			result = await this.#waitForExitWithTimeout(timeoutMs);
		}
		if (!result) {
			try {
				proc.kill("SIGKILL");
			} catch {
				/* ignore */
			}
			result = await this.#waitForExitWithTimeout(timeoutMs);
		}

		const confirmed = !!result;
		this.#shutdownConfirmed = confirmed;
		this.#disposed = true;
		return { confirmed };
	}

	#abortPendingExecutions(reason: string, options?: { kernelKilled?: boolean }): void {
		if (this.#pending.size === 0) return;
		const pending = Array.from(this.#pending.values());
		this.#pending.clear();
		const kernelKilledDefault = options?.kernelKilled ?? false;
		for (const entry of pending) {
			if (entry.settled) continue;
			entry.settled = true;
			void entry.options?.onChunk?.(`[kernel] ${reason}\n`);
			entry.resolve({
				status: "error",
				cancelled: true,
				timedOut: entry.timedOut,
				stdinRequested: entry.stdinRequested,
				executionCount: entry.executionCount,
				error: entry.error,
				kernelKilled: entry.kernelKilled || kernelKilledDefault,
			});
		}
	}

	async #writeLine(line: string): Promise<void> {
		if (!this.#stdin) {
			throw new Error("Julia kernel stdin is not open");
		}
		if (TRACE_IPC) {
			logger.debug("JuliaKernel send", { preview: line.slice(0, 120) });
		}
		this.#stdin.write(`${line}\n`);
		this.#stdin.flush();
	}

	#startReader(stream: ReadableStream<Uint8Array>): void {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		const loop = async () => {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					this.#readBuffer += decoder.decode(value, { stream: true });
					await this.#flushFrames();
				}
				this.#readBuffer += decoder.decode();
				await this.#flushFrames();
			} catch (err) {
				logger.warn("Julia kernel reader failed", { error: err instanceof Error ? err.message : String(err) });
			} finally {
				try {
					reader.releaseLock();
				} catch {
					/* ignore */
				}
			}
		};
		void loop();
	}

	#startStderrDrain(stream: ReadableStream<Uint8Array>): void {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		const loop = async () => {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					const text = decoder.decode(value);
					if (text.trim()) {
						logger.warn("Julia runner stderr", { text });
					}
				}
			} catch {
				/* ignore */
			} finally {
				try {
					reader.releaseLock();
				} catch {
					/* ignore */
				}
			}
		};
		void loop();
	}

	async #flushFrames(): Promise<void> {
		while (true) {
			const nl = this.#readBuffer.indexOf("\n");
			if (nl < 0) return;
			const line = this.#readBuffer.slice(0, nl);
			this.#readBuffer = this.#readBuffer.slice(nl + 1);
			if (!line.trim()) continue;
			let frame: Frame;
			try {
				frame = JSON.parse(line) as Frame;
			} catch (err) {
				logger.warn("Julia runner emitted invalid JSON", {
					line: line.slice(0, 200),
					error: err instanceof Error ? err.message : String(err),
				});
				continue;
			}
			if (TRACE_IPC) {
				logger.debug("JuliaKernel recv", { type: frame.type, id: frame.id });
			}
			await this.#handleFrame(frame);
		}
	}

	async #handleFrame(frame: Frame): Promise<void> {
		const rid = frame.id;
		if (!rid) return;
		const pending = this.#pending.get(rid) as (PendingExecution & { finalize?: () => void }) | undefined;
		if (!pending) return;

		switch (frame.type) {
			case "started":
				return;
			case "stdout":
			case "stderr": {
				const text = frame.data ?? "";
				if (text && pending.options?.onChunk) {
					await pending.options.onChunk(text);
				}
				return;
			}
			case "display":
			case "result": {
				const bundle = frame.bundle ?? {};
				const { text, outputs } = await renderKernelDisplay(bundle);
				if (text && pending.options?.onChunk) {
					await pending.options.onChunk(text);
				}
				if (outputs.length > 0 && pending.options?.onDisplay) {
					for (const output of outputs) {
						await pending.options.onDisplay(output);
					}
				}
				return;
			}
			case "error": {
				const traceback = Array.isArray(frame.traceback) ? frame.traceback.map(String) : [];
				pending.status = "error";
				pending.error = {
					name: String(frame.ename ?? "Error"),
					value: String(frame.evalue ?? ""),
					traceback,
				};
				const message =
					traceback.length > 0 ? `${traceback.join("\n")}\n` : `${pending.error.name}: ${pending.error.value}\n`;
				if (pending.options?.onChunk) {
					await pending.options.onChunk(message);
				}
				return;
			}
			case "done": {
				if (typeof frame.executionCount === "number") {
					pending.executionCount = frame.executionCount;
				}
				if (frame.status === "error" && pending.status === "ok") {
					pending.status = "error";
				}
				if (frame.cancelled) {
					pending.cancelled = true;
				}
				pending.finalize?.();
				return;
			}
		}
	}

	async #executeWithBudget(
		code: string,
		signal: AbortSignal | undefined,
		timeoutMs: number,
		label: string,
	): Promise<void> {
		const controller = new AbortController();
		const cleanups: Array<() => void> = [];
		if (signal) {
			if (signal.aborted) {
				controller.abort(signal.reason);
			} else {
				const onAbort = () => controller.abort(signal.reason);
				signal.addEventListener("abort", onAbort, { once: true });
				cleanups.push(() => signal.removeEventListener("abort", onAbort));
			}
		}
		const timer =
			timeoutMs > 0
				? setTimeout(() => controller.abort(createAbortError("TimeoutError", `${label} timed out`)), timeoutMs)
				: undefined;
		if (timer) cleanups.push(() => clearTimeout(timer));
		try {
			throwIfAborted(controller.signal, label);
			const result = await this.execute(code, {
				signal: controller.signal,
				silent: true,
				storeHistory: false,
			});
			if (result.cancelled) {
				throw createAbortError(result.timedOut ? "TimeoutError" : "AbortError", `${label} cancelled`);
			}
			if (result.status === "error") {
				const reason = result.error?.value ?? "Julia kernel init failed";
				throw new Error(`${label} failed: ${reason}`);
			}
		} finally {
			for (const cleanup of cleanups) cleanup();
		}
	}

	#waitForExitWithTimeout(timeoutMs: number): Promise<number | null> {
		if (!this.#exitedPromise) return Promise.resolve(0);
		const exitedPromise = this.#exitedPromise;
		const timeout = new Promise<null>(resolve => {
			const timer = setTimeout(() => resolve(null), Math.max(0, timeoutMs));
			timer.unref?.();
		});
		return Promise.race([exitedPromise.then(code => code as number | null), timeout]);
	}
}

function isTimeoutReason(reason: unknown): boolean {
	if (reason instanceof DOMException) return reason.name === "TimeoutError";
	if (reason instanceof Error) return reason.name === "TimeoutError";
	return false;
}

function buildInitScript(cwd: string, env?: Record<string, string | undefined>): string {
	const envPayload: Record<string, string> = {};
	for (const key in env) {
		const value = env[key];
		if (value !== undefined) envPayload[key] = value;
	}
	const lines = [
		`__omp_init_cwd = String(Base64.base64decode("${Buffer.from(cwd).toString("base64")}"))`,
		"try cd(__omp_init_cwd) catch; end",
	];
	for (const key in envPayload) {
		const k_b64 = Buffer.from(key).toString("base64");
		const v_b64 = Buffer.from(envPayload[key]).toString("base64");
		lines.push(`ENV[String(Base64.base64decode("${k_b64}"))] = String(Base64.base64decode("${v_b64}"))`);
	}
	// Avoid modifying LOAD_PATH if not necessary, but if needed, prepend cwd
	lines.push("if !(__omp_init_cwd in LOAD_PATH); pushfirst!(LOAD_PATH, __omp_init_cwd); end");
	return lines.join("\n");
}

import * as path from "node:path";
import { $env, isBunTestRuntime, isCompiledBinary, logger, workerHostEntry } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import { settings } from "../config/settings";
import { tinyModelDeviceSettingToEnv } from "./device";
import { tinyModelDtypeSettingToEnv } from "./dtype";
import {
	isTinyLocalModelKey,
	isTinyMemoryLocalModelKey,
	isTinyTitleLocalModelKey,
	type TinyLocalModelKey,
	type TinyMemoryLocalModelKey,
	type TinyTitleLocalModelKey,
} from "./models";
import type { TinyTitleProgressEvent, TinyTitleWorkerInbound, TinyTitleWorkerOutbound } from "./title-protocol";

/**
 * Abstraction over the tiny-model subprocess. Modelled as a worker interface
 * so existing callers (titles, memory completions, downloads) compose the
 * same way; the runtime implementation is a Bun child process so
 * `onnxruntime-node`'s NAPI finalizer never runs inside the main agent
 * address space — that destructor segfaults Bun on Windows during shutdown
 * (issue #1606).
 */
interface WorkerHandle {
	send(message: TinyTitleWorkerInbound): void;
	onMessage(handler: (message: TinyTitleWorkerOutbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	terminate(): Promise<void>;
}

type PendingRequest =
	| { kind: "generate"; modelKey: TinyTitleLocalModelKey; resolve: (title: string | null) => void }
	| { kind: "complete"; modelKey: TinyMemoryLocalModelKey; resolve: (text: string | null) => void }
	| { kind: "download"; modelKey: TinyLocalModelKey; resolve: (ok: boolean) => void };

export interface TinyTitleDownloadOptions {
	signal?: AbortSignal;
	onProgress?: (event: TinyTitleProgressEvent) => void;
}

/**
 * Per-request controls for {@link TinyTitleClient.generate}.
 *
 * Carries the optional abort signal and title-system-prompt override used by
 * callers that customize automatic session-title generation.
 */
export interface TinyTitleGenerateOptions {
	signal?: AbortSignal;
	systemPrompt?: string;
}

// Cold-starting the worker subprocess from a compiled binary (decompress + module
// graph load) is slow on contended CI runners — the macos-15-intel release smoke
// blew past 5s while arm64/linux/win passed. The probe only needs to prove the
// worker spawns and ponges at all (a dead worker never ponges regardless), so a
// generous bound removes the flake without weakening the check.
const SMOKE_TEST_TIMEOUT_MS = 30_000;

function normalizeTinyTitleGenerateOptions(
	options: AbortSignal | TinyTitleGenerateOptions | undefined,
): TinyTitleGenerateOptions {
	if (!options) return {};
	if ("aborted" in options && "addEventListener" in options) return { signal: options };
	return options;
}

/**
 * Hidden subcommand on the main CLI that boots the tiny-model worker in the
 * spawned subprocess. Kept in sync with the dispatch in `cli.ts`.
 */
export const TINY_WORKER_ARG = "__omp_worker_tiny_inference";

function readTinyModelSetting(path: "providers.tinyModelDevice" | "providers.tinyModelDtype"): string | undefined {
	try {
		const value = settings.get(path);
		return typeof value === "string" ? value : undefined;
	} catch {
		// Settings may be uninitialized (e.g. `omp --smoke-test`); fall back to env/default.
		return undefined;
	}
}

/**
 * Decide which `PI_TINY_DEVICE` / `PI_TINY_DTYPE` vars to overlay onto the worker
 * env. A present env var wins (left untouched); otherwise the mapped persisted
 * setting is used. Returns only the keys to add — never the default sentinel.
 * Pure for testability; see {@link tinyWorkerEnv} for the spawn-time glue.
 * @internal
 */
export function tinyWorkerEnvOverlay(
	env: Record<string, string | undefined>,
	deviceSetting: string | undefined,
	dtypeSetting: string | undefined,
): Record<string, string> {
	const overlay: Record<string, string> = {};
	if (!env.PI_TINY_DEVICE) {
		const device = tinyModelDeviceSettingToEnv(deviceSetting);
		if (device) overlay.PI_TINY_DEVICE = device;
	}
	if (!env.PI_TINY_DTYPE) {
		const dtype = tinyModelDtypeSettingToEnv(dtypeSetting);
		if (dtype) overlay.PI_TINY_DTYPE = dtype;
	}
	return overlay;
}

/**
 * Env handed to the tiny-model subprocess. The `PI_TINY_DEVICE` / `PI_TINY_DTYPE`
 * env vars win; otherwise the persisted `providers.tinyModelDevice` /
 * `providers.tinyModelDtype` settings are mapped onto those vars so the
 * subprocess's env-based resolution picks them up. Resolved once at spawn
 * (pipelines are cached for the lifetime of the subprocess).
 */
function tinyWorkerEnv(): Record<string, string> {
	const overlay = tinyWorkerEnvOverlay(
		$env,
		readTinyModelSetting("providers.tinyModelDevice"),
		readTinyModelSetting("providers.tinyModelDtype"),
	);
	const base = $env as Record<string, string | undefined>;
	const merged: Record<string, string> = {};
	for (const key in base) {
		const value = base[key];
		if (typeof value === "string") merged[key] = value;
	}
	for (const key in overlay) merged[key] = overlay[key];
	return merged;
}
interface TinyWorkerSpawnCommand {
	cmd: string[];
	cwd?: string;
}

/**
 * Resolve the command used to relaunch the agent CLI into tiny-worker mode.
 * In a compiled binary the entry point is the binary itself (no script arg).
 * Otherwise re-enter the declared worker-host entry (source cli.ts or
 * npm-bundle cli.js) with a cwd-relative script path — Bun's subprocess IPC
 * is more reliable that way than with an absolute `.ts` entry under
 * `bun test` — and fall back to this package's own `src/cli.ts` when no host
 * entry is declared (bun test, SDK embedding).
 */
function tinyWorkerSpawnCmd(): TinyWorkerSpawnCommand {
	if (isCompiledBinary()) return { cmd: [process.execPath, TINY_WORKER_ARG] };
	const hostEntry = workerHostEntry();
	if (hostEntry) {
		return { cmd: [process.execPath, path.basename(hostEntry), TINY_WORKER_ARG], cwd: path.dirname(hostEntry) };
	}
	const packageRoot = path.resolve(import.meta.dir, "..", "..");
	return { cmd: [process.execPath, "src/cli.ts", TINY_WORKER_ARG], cwd: packageRoot };
}

interface SpawnedSubprocess {
	proc: Subprocess<"ignore", "ignore", "ignore">;
	inbound: Set<(message: TinyTitleWorkerOutbound) => void>;
	errors: Set<(error: Error) => void>;
	/**
	 * Flipped to `true` by {@link wrapSubprocess}'s `terminate()` right
	 * before it SIGKILLs the child so `onExit` can distinguish the
	 * expected hard-kill from a crash/OOM/external signal. Only the
	 * latter is surfaced as a worker error.
	 */
	intentionalExit: { value: boolean };
}

/**
 * Spawn the tiny-model worker as a subprocess. Exported for tests and the
 * smoke probe; production callers go through {@link spawnTinyTitleWorker}
 * which wraps the result in a {@link WorkerHandle}.
 */
export function createTinyTitleSubprocess(): SpawnedSubprocess {
	const inbound = new Set<(message: TinyTitleWorkerOutbound) => void>();
	const errors = new Set<(error: Error) => void>();
	const intentionalExit = { value: false };
	const spawnCommand = tinyWorkerSpawnCmd();
	const proc = Bun.spawn({
		cmd: spawnCommand.cmd,
		cwd: spawnCommand.cwd,
		env: tinyWorkerEnv(),
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		serialization: "advanced",
		windowsHide: true,
		// The worker is an implementation detail of the interactive TUI. Native
		// model runtimes may print progress or decoded text directly; never let
		// those bytes inherit the terminal and corrupt the chat scrollback.
		ipc(message) {
			for (const handler of inbound) handler(message as TinyTitleWorkerOutbound);
		},
		onExit(_proc, exitCode, signalCode) {
			// Clean exit. The child only exits via SIGKILL in practice, but
			// treat code 0 as a no-op for symmetry.
			if (exitCode === 0) return;
			// `exitCode === null` + non-null `signalCode` covers both the
			// expected SIGKILL from `terminate()` AND external kills
			// (SIGSEGV from a native crash, SIGKILL from the OOM killer, an
			// operator `kill -9`, etc.). Swallow only the expected one;
			// every other signal exit is a real worker death that must
			// fault every in-flight request so callers don't await forever.
			if (exitCode === null && intentionalExit.value) return;
			const reason = exitCode !== null ? `code ${exitCode}` : `signal ${signalCode ?? "unknown"}`;
			const err = new Error(`tiny model subprocess exited with ${reason}`);
			for (const handler of errors) handler(err);
		},
	});
	// Don't keep the parent event loop alive on account of an idle worker; the
	// agent dispose path calls `terminate()` explicitly when shutting down.
	// Bun's test runner can starve IPC delivery for unref'd subprocesses, so
	// keep it referenced only under tests that assert the ping/pong contract.
	if (!isBunTestRuntime()) proc.unref();
	return { proc, inbound, errors, intentionalExit };
}

function wrapSubprocess({ proc, inbound, errors, intentionalExit }: SpawnedSubprocess): WorkerHandle {
	return {
		send(message) {
			try {
				proc.send(message);
			} catch (error) {
				logger.debug("tiny-title: send to subprocess failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		},
		onMessage(handler) {
			inbound.add(handler);
			return () => inbound.delete(handler);
		},
		onError(handler) {
			errors.add(handler);
			return () => errors.delete(handler);
		},
		async terminate() {
			// SIGKILL: the whole point of the subprocess isolation is that the
			// parent never runs `onnxruntime-node`'s NAPI finalizer. A polite
			// SIGTERM lets the subprocess try to clean up, which is exactly the
			// codepath that crashes Bun on Windows. Hard-kill instead — the
			// model lives in process memory and the OS reclaims everything.
			// Flip the intentional-exit flag *before* killing so `onExit` can
			// tell this apart from a crash or external SIGKILL.
			intentionalExit.value = true;
			try {
				proc.kill("SIGKILL");
			} catch {
				// Already gone.
			}
		},
	};
}

function spawnInlineUnavailableWorker(error: unknown): WorkerHandle {
	const listeners = new Set<(message: TinyTitleWorkerOutbound) => void>();
	const errorMessage = error instanceof Error ? error.message : String(error);
	const emit = (message: TinyTitleWorkerOutbound): void => {
		for (const listener of listeners) listener(message);
	};
	return {
		send(message) {
			queueMicrotask(() => {
				if (message.type === "ping") {
					emit({ type: "pong", id: message.id });
					return;
				}
				emit({ type: "error", id: message.id, error: errorMessage });
			});
		},
		onMessage(handler) {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		onError() {
			return () => {};
		},
		async terminate() {
			listeners.clear();
		},
	};
}

function spawnTinyTitleWorker(): WorkerHandle {
	try {
		return wrapSubprocess(createTinyTitleSubprocess());
	} catch (error) {
		logger.warn("Tiny title worker spawn failed; local titles disabled", {
			error: error instanceof Error ? error.message : String(error),
		});
		return spawnInlineUnavailableWorker(error);
	}
}

function logWorkerMessage(message: Extract<TinyTitleWorkerOutbound, { type: "log" }>): void {
	if (message.level === "debug") logger.debug(message.msg, message.meta);
	else if (message.level === "warn") logger.warn(message.msg, message.meta);
	else logger.error(message.msg, message.meta);
}

export class TinyTitleClient {
	#worker: WorkerHandle | null = null;
	#unsubscribeMessage: (() => void) | null = null;
	#unsubscribeError: (() => void) | null = null;
	#pending = new Map<string, PendingRequest>();
	#progressListeners = new Set<(event: TinyTitleProgressEvent) => void>();
	#nextRequestId = 0;
	#spawnWorker: () => WorkerHandle;

	constructor(spawnWorker: () => WorkerHandle = spawnTinyTitleWorker) {
		this.#spawnWorker = spawnWorker;
	}

	onProgress(listener: (event: TinyTitleProgressEvent) => void): () => void {
		this.#progressListeners.add(listener);
		return () => this.#progressListeners.delete(listener);
	}

	async generate(modelKey: string, message: string, signal?: AbortSignal): Promise<string | null>;
	async generate(modelKey: string, message: string, options?: TinyTitleGenerateOptions): Promise<string | null>;
	async generate(
		modelKey: string,
		message: string,
		optionsOrSignal?: AbortSignal | TinyTitleGenerateOptions,
	): Promise<string | null> {
		const options = normalizeTinyTitleGenerateOptions(optionsOrSignal);
		if (!isTinyTitleLocalModelKey(modelKey)) return null;
		if (options.signal?.aborted) return null;

		try {
			const worker = this.#ensureWorker();
			const id = String(++this.#nextRequestId);
			const { promise, resolve } = Promise.withResolvers<string | null>();
			this.#pending.set(id, { kind: "generate", modelKey, resolve });
			const abort = (): void => {
				const pending = this.#pending.get(id);
				if (pending?.kind !== "generate") return;
				this.#pending.delete(id);
				pending.resolve(null);
			};
			options.signal?.addEventListener("abort", abort, { once: true });
			try {
				const request: TinyTitleWorkerInbound = options.systemPrompt
					? { type: "generate", id, modelKey, message, systemPrompt: options.systemPrompt }
					: { type: "generate", id, modelKey, message };
				worker.send(request);
				return await promise;
			} finally {
				options.signal?.removeEventListener("abort", abort);
				this.#pending.delete(id);
			}
		} catch (error) {
			logger.debug("tiny-title: local generation failed", {
				modelKey,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	async complete(
		modelKey: string,
		prompt: string,
		options: { maxTokens?: number; signal?: AbortSignal } = {},
	): Promise<string | null> {
		if (!isTinyMemoryLocalModelKey(modelKey)) return null;
		if (options.signal?.aborted) return null;

		try {
			const worker = this.#ensureWorker();
			const id = String(++this.#nextRequestId);
			const { promise, resolve } = Promise.withResolvers<string | null>();
			this.#pending.set(id, { kind: "complete", modelKey, resolve });
			const abort = (): void => {
				const pending = this.#pending.get(id);
				if (pending?.kind !== "complete") return;
				this.#pending.delete(id);
				pending.resolve(null);
			};
			options.signal?.addEventListener("abort", abort, { once: true });
			try {
				worker.send({ type: "complete", id, modelKey, prompt, maxTokens: options.maxTokens });
				return await promise;
			} finally {
				options.signal?.removeEventListener("abort", abort);
				this.#pending.delete(id);
			}
		} catch (error) {
			logger.debug("tiny-model: local completion failed", {
				modelKey,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	async downloadModel(modelKey: string, options: TinyTitleDownloadOptions = {}): Promise<boolean> {
		if (!isTinyLocalModelKey(modelKey)) return false;
		if (options.signal?.aborted) return false;

		const unsubscribe = options.onProgress ? this.onProgress(options.onProgress) : undefined;
		try {
			const worker = this.#ensureWorker();
			const id = String(++this.#nextRequestId);
			const { promise, resolve } = Promise.withResolvers<boolean>();
			this.#pending.set(id, { kind: "download", modelKey, resolve });
			const abort = (): void => {
				const pending = this.#pending.get(id);
				if (pending?.kind !== "download") return;
				this.#pending.delete(id);
				pending.resolve(false);
			};
			options.signal?.addEventListener("abort", abort, { once: true });
			try {
				worker.send({ type: "download", id, modelKey });
				return await promise;
			} finally {
				options.signal?.removeEventListener("abort", abort);
				this.#pending.delete(id);
			}
		} catch (error) {
			logger.debug("tiny-title: local model download failed", {
				modelKey,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		} finally {
			unsubscribe?.();
		}
	}

	async terminate(): Promise<void> {
		const worker = this.#worker;
		this.#worker = null;
		this.#unsubscribeMessage?.();
		this.#unsubscribeMessage = null;
		this.#unsubscribeError?.();
		this.#unsubscribeError = null;
		for (const pending of this.#pending.values()) {
			this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
			if (pending.kind === "generate" || pending.kind === "complete") pending.resolve(null);
			else pending.resolve(false);
		}
		this.#pending.clear();
		try {
			await worker?.terminate();
		} catch {
			// Already gone.
		}
	}

	#ensureWorker(): WorkerHandle {
		if (this.#worker) return this.#worker;
		const worker = this.#spawnWorker();
		this.#worker = worker;
		this.#unsubscribeMessage = worker.onMessage(message => this.#handleMessage(message));
		this.#unsubscribeError = worker.onError(error => this.#handleWorkerError(error));
		return worker;
	}

	#handleMessage(message: TinyTitleWorkerOutbound): void {
		if (message.type === "log") {
			logWorkerMessage(message);
			return;
		}
		if (message.type === "progress") {
			this.#emitProgress(message.event);
			return;
		}
		if (message.type === "pong") return;

		const pending = this.#pending.get(message.id);
		if (!pending) return;
		this.#pending.delete(message.id);
		if (message.type === "title") {
			if (pending.kind === "generate") pending.resolve(message.title);
			return;
		}
		if (message.type === "downloaded") {
			if (pending.kind === "download") pending.resolve(true);
			return;
		}
		if (message.type === "completion") {
			if (pending.kind === "complete") pending.resolve(message.text);
			return;
		}
		logger.debug("tiny-title: worker returned error", { error: message.error });
		this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
		if (pending.kind === "generate" || pending.kind === "complete") pending.resolve(null);
		else pending.resolve(false);
		void this.terminate();
	}

	#emitProgress(event: TinyTitleProgressEvent): void {
		for (const listener of this.#progressListeners) listener(event);
	}

	#handleWorkerError(error: Error): void {
		logger.warn("tiny-title: worker error", { error: error.message });
		for (const pending of this.#pending.values()) {
			this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
			if (pending.kind === "generate" || pending.kind === "complete") pending.resolve(null);
			else pending.resolve(false);
		}
		this.#pending.clear();
		void this.terminate();
	}
}

export const tinyTitleClient = new TinyTitleClient();

/** Alias for the shared tiny-model worker client (titles + memory completions). */
export const tinyModelClient = tinyTitleClient;

export async function shutdownTinyTitleClient(): Promise<void> {
	await tinyTitleClient.terminate();
}

export async function smokeTestTinyTitleWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	const handle = wrapSubprocess(createTinyTitleSubprocess());
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(() => reject(new Error(`tiny title worker did not pong within ${timeoutMs}ms`)), timeoutMs);
	const unsubscribeMessage = handle.onMessage(message => {
		if (message.type === "pong") {
			resolve();
			return;
		}
		if (message.type === "log") return;
		reject(new Error(`tiny title worker: expected pong, got ${JSON.stringify(message)}`));
	});
	const unsubscribeError = handle.onError(reject);
	try {
		handle.send({ type: "ping", id: "smoke" } satisfies TinyTitleWorkerInbound);
		await promise;
	} finally {
		clearTimeout(timer);
		unsubscribeMessage();
		unsubscribeError();
		await handle.terminate();
	}
}

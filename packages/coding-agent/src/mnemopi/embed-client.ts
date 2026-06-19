import * as path from "node:path";
import { $env, isBunTestRuntime, isCompiledBinary, logger, workerHostEntry } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import type { MnemopiEmbedModelId, MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound } from "./embed-protocol";

/**
 * Abstraction over the mnemopi embeddings subprocess. The runtime
 * implementation is a Bun child process so `onnxruntime-node`'s NAPI
 * constructor + finalizer never run inside the main agent address space —
 * those destructors segfault Bun on Windows when mnemopi's local embedding
 * provider loads fastembed in the main process (issue #3031; the mnemopi
 * sibling of the tiny-model fix from #1606 / #1607).
 */
export interface MnemopiEmbedWorkerHandle {
	send(message: MnemopiEmbedWorkerInbound): void;
	onMessage(handler: (message: MnemopiEmbedWorkerOutbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	terminate(): Promise<void>;
}

type PendingRequest =
	| { kind: "init"; model: MnemopiEmbedModelId; resolve: (ok: boolean) => void }
	| { kind: "embed"; model: MnemopiEmbedModelId; resolve: (vectors: number[][] | Error) => void };

// Cold-starting the worker from a compiled binary (decompress + module graph load)
// is slow on contended CI runners; the probe only proves the worker spawns and
// ponges, so a generous bound removes flakes without weakening the check.
const SMOKE_TEST_TIMEOUT_MS = 30_000;

/**
 * Hidden subcommand on the main CLI that boots the mnemopi embeddings worker
 * in the spawned subprocess. Kept in sync with the dispatch in `cli.ts`.
 */
export const MNEMOPI_EMBED_WORKER_ARG = "__omp_worker_mnemopi_embed";

/**
 * Env handed to the embeddings subprocess. The child inherits the parent's
 * environment verbatim — fastembed honours `HF_HUB_*`, `HTTPS_PROXY`, etc.,
 * and our `loadFastembed()` reads the same `OMP_*` runtime-install knobs the
 * parent uses. `process.env` carries `undefined` slots that Bun.spawn rejects;
 * filter them out.
 */
function mnemopiEmbedWorkerEnv(): Record<string, string> {
	const base = $env as Record<string, string | undefined>;
	const merged: Record<string, string> = {};
	for (const key in base) {
		const value = base[key];
		if (typeof value === "string") merged[key] = value;
	}
	return merged;
}

interface MnemopiEmbedWorkerSpawnCommand {
	cmd: string[];
	cwd?: string;
}

/**
 * Resolve the command used to relaunch the agent CLI into mnemopi-embed-worker
 * mode. In a compiled binary the entry point is the binary itself; otherwise
 * re-enter the declared worker-host entry (cwd-relative for reliable Bun IPC),
 * falling back to this package's own `src/cli.ts` when no host entry is
 * declared (bun test, SDK embedding).
 */
function mnemopiEmbedWorkerSpawnCmd(): MnemopiEmbedWorkerSpawnCommand {
	if (isCompiledBinary()) return { cmd: [process.execPath, MNEMOPI_EMBED_WORKER_ARG] };
	const hostEntry = workerHostEntry();
	if (hostEntry) {
		return {
			cmd: [process.execPath, path.basename(hostEntry), MNEMOPI_EMBED_WORKER_ARG],
			cwd: path.dirname(hostEntry),
		};
	}
	const packageRoot = path.resolve(import.meta.dir, "..", "..");
	return { cmd: [process.execPath, "src/cli.ts", MNEMOPI_EMBED_WORKER_ARG], cwd: packageRoot };
}

interface SpawnedSubprocess {
	proc: Subprocess<"ignore", "ignore", "ignore">;
	inbound: Set<(message: MnemopiEmbedWorkerOutbound) => void>;
	errors: Set<(error: Error) => void>;
	/**
	 * Flipped to `true` right before the deliberate SIGKILL so `onExit` can
	 * distinguish the expected hard-kill from a crash (SIGSEGV from a native
	 * fault, OOM SIGKILL, operator `kill -9`). Only the latter surfaces as a
	 * worker error so callers don't await forever.
	 */
	intentionalExit: { value: boolean };
}

/**
 * Spawn the mnemopi embeddings worker as a subprocess. Exported for tests and
 * the smoke probe; production callers go through {@link spawnMnemopiEmbedWorker}.
 */
export function createMnemopiEmbedSubprocess(): SpawnedSubprocess {
	const inbound = new Set<(message: MnemopiEmbedWorkerOutbound) => void>();
	const errors = new Set<(error: Error) => void>();
	const intentionalExit = { value: false };
	const spawnCommand = mnemopiEmbedWorkerSpawnCmd();
	const proc = Bun.spawn({
		cmd: spawnCommand.cmd,
		cwd: spawnCommand.cwd,
		env: mnemopiEmbedWorkerEnv(),
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		serialization: "advanced",
		windowsHide: true,
		ipc(message) {
			for (const handler of inbound) handler(message as MnemopiEmbedWorkerOutbound);
		},
		onExit(_proc, exitCode, signalCode) {
			if (exitCode === 0) return;
			if (exitCode === null && intentionalExit.value) return;
			const reason = exitCode !== null ? `code ${exitCode}` : `signal ${signalCode ?? "unknown"}`;
			const err = new Error(`mnemopi embed subprocess exited with ${reason}`);
			for (const handler of errors) handler(err);
		},
	});
	// Don't keep the parent event loop alive on an idle worker; the agent
	// dispose path calls `terminate()` explicitly. Bun's test runner starves
	// IPC for unref'd subprocesses, so keep it referenced only under tests.
	if (!isBunTestRuntime()) proc.unref();
	return { proc, inbound, errors, intentionalExit };
}

function wrapSubprocess({ proc, inbound, errors, intentionalExit }: SpawnedSubprocess): MnemopiEmbedWorkerHandle {
	return {
		send(message) {
			try {
				proc.send(message);
			} catch (error) {
				logger.debug("mnemopi-embed: send to subprocess failed", {
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
			// SIGKILL: the point of subprocess isolation is that the parent
			// never runs `onnxruntime-node`'s NAPI finalizer (it crashes Bun
			// on Windows). Hard-kill instead; the OS reclaims the model
			// memory. Flip the intentional-exit flag *before* killing so
			// `onExit` can tell this apart from a native crash.
			intentionalExit.value = true;
			try {
				proc.kill("SIGKILL");
			} catch {
				// Already gone.
			}
		},
	};
}

function spawnInlineUnavailableWorker(error: unknown): MnemopiEmbedWorkerHandle {
	const listeners = new Set<(message: MnemopiEmbedWorkerOutbound) => void>();
	const errorMessage = error instanceof Error ? error.message : String(error);
	const emit = (message: MnemopiEmbedWorkerOutbound): void => {
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

function spawnMnemopiEmbedWorker(): MnemopiEmbedWorkerHandle {
	try {
		return wrapSubprocess(createMnemopiEmbedSubprocess());
	} catch (error) {
		logger.warn("mnemopi embed worker spawn failed; local embeddings disabled", {
			error: error instanceof Error ? error.message : String(error),
		});
		return spawnInlineUnavailableWorker(error);
	}
}

function logWorkerMessage(message: Extract<MnemopiEmbedWorkerOutbound, { type: "log" }>): void {
	if (message.level === "debug") logger.debug(message.msg, message.meta);
	else if (message.level === "warn") logger.warn(message.msg, message.meta);
	else logger.error(message.msg, message.meta);
}

/**
 * Per-model wrapper produced by {@link MnemopiEmbedClient.initialize}.
 * `embed()` round-trips one batch of texts through the worker subprocess and
 * yields the resulting vectors in a single asynchronous batch — fastembed's
 * own iterator was emitting batches that we collect on the child side anyway,
 * and serializing per-batch over IPC would not improve throughput.
 */
export interface MnemopiSubprocessEmbeddingModel {
	embed(texts: string[], batchSize?: number): AsyncIterable<number[][]>;
}

export class MnemopiEmbedClient {
	#worker: MnemopiEmbedWorkerHandle | null = null;
	#unsubscribeMessage: (() => void) | null = null;
	#unsubscribeError: (() => void) | null = null;
	#pending = new Map<string, PendingRequest>();
	#nextRequestId = 0;
	#spawnWorker: () => MnemopiEmbedWorkerHandle;

	constructor(spawnWorker: () => MnemopiEmbedWorkerHandle = spawnMnemopiEmbedWorker) {
		this.#spawnWorker = spawnWorker;
	}

	/**
	 * Load the named fastembed model inside the subprocess. Resolves to a
	 * thin wrapper whose `embed()` round-trips through the same worker, or
	 * `null` when the worker cannot init the model (missing peer, native
	 * load failure, etc.). Multiple calls with the same model reuse the
	 * single in-flight worker; calling with a different model loads it on
	 * the child without restarting the process.
	 */
	async initialize(
		model: MnemopiEmbedModelId,
		cacheDir: string | undefined,
	): Promise<MnemopiSubprocessEmbeddingModel | null> {
		try {
			const worker = this.#ensureWorker();
			const id = String(++this.#nextRequestId);
			const { promise, resolve } = Promise.withResolvers<boolean>();
			this.#pending.set(id, { kind: "init", model, resolve });
			try {
				worker.send({ type: "init", id, model, cacheDir });
				const ok = await promise;
				if (!ok) return null;
			} finally {
				this.#pending.delete(id);
			}
		} catch (error) {
			logger.debug("mnemopi-embed: init failed", {
				model,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
		return { embed: (texts, batchSize) => this.#streamEmbed(model, cacheDir, texts, batchSize) };
	}

	async terminate(): Promise<void> {
		const worker = this.#worker;
		this.#worker = null;
		this.#unsubscribeMessage?.();
		this.#unsubscribeMessage = null;
		this.#unsubscribeError?.();
		this.#unsubscribeError = null;
		for (const pending of this.#pending.values()) {
			if (pending.kind === "init") pending.resolve(false);
			else pending.resolve(new Error("mnemopi embed worker terminated"));
		}
		this.#pending.clear();
		try {
			await worker?.terminate();
		} catch {
			// Already gone.
		}
	}

	async #embed(
		model: MnemopiEmbedModelId,
		cacheDir: string | undefined,
		texts: string[],
		batchSize: number | undefined,
	): Promise<number[][]> {
		const worker = this.#ensureWorker();
		const id = String(++this.#nextRequestId);
		const { promise, resolve } = Promise.withResolvers<number[][] | Error>();
		this.#pending.set(id, { kind: "embed", model, resolve });
		try {
			// Carry the (model, cacheDir) the wrapper was bound to in every
			// embed message: dispose + respawn between two embeds on the same
			// `LocalEmbeddingModel` handle would otherwise hit a fresh
			// worker's "embed before init" guard. Worker `ensureLoaded` is
			// idempotent so steady-state embeds pay no extra cost.
			worker.send({ type: "embed", id, model, cacheDir, texts, batchSize });
			const result = await promise;
			if (result instanceof Error) throw result;
			return result;
		} finally {
			this.#pending.delete(id);
		}
	}

	async *#streamEmbed(
		model: MnemopiEmbedModelId,
		cacheDir: string | undefined,
		texts: string[],
		batchSize: number | undefined,
	): AsyncIterable<number[][]> {
		const vectors = await this.#embed(model, cacheDir, texts, batchSize);
		// Mnemopi's `collectMatrix` re-batches via async iteration anyway; yield
		// a single batch carrying the full result so the caller's drain loop
		// behaves identically to the in-process fastembed iterator (one yield
		// per `embed()` call) without paying extra IPC round-trips.
		yield vectors;
	}

	#ensureWorker(): MnemopiEmbedWorkerHandle {
		if (this.#worker) return this.#worker;
		const worker = this.#spawnWorker();
		this.#worker = worker;
		this.#unsubscribeMessage = worker.onMessage(message => this.#handleMessage(message));
		this.#unsubscribeError = worker.onError(error => this.#handleWorkerError(error));
		return worker;
	}

	#handleMessage(message: MnemopiEmbedWorkerOutbound): void {
		if (message.type === "log") {
			logWorkerMessage(message);
			return;
		}
		if (message.type === "pong") return;

		const pending = this.#pending.get(message.id);
		if (!pending) return;
		this.#pending.delete(message.id);
		if (message.type === "ready") {
			if (pending.kind === "init") pending.resolve(true);
			return;
		}
		if (message.type === "vectors") {
			if (pending.kind === "embed") pending.resolve(message.vectors);
			return;
		}
		logger.debug("mnemopi-embed: worker returned error", { error: message.error });
		if (pending.kind === "init") pending.resolve(false);
		else pending.resolve(new Error(message.error));
	}

	#handleWorkerError(error: Error): void {
		logger.warn("mnemopi-embed: worker error", { error: error.message });
		for (const pending of this.#pending.values()) {
			if (pending.kind === "init") pending.resolve(false);
			else pending.resolve(error);
		}
		this.#pending.clear();
		void this.terminate();
	}
}

export const mnemopiEmbedClient = new MnemopiEmbedClient();

export async function shutdownMnemopiEmbedClient(): Promise<void> {
	await mnemopiEmbedClient.terminate();
}

export async function smokeTestMnemopiEmbedWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	const handle = wrapSubprocess(createMnemopiEmbedSubprocess());
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(
		() => reject(new Error(`mnemopi embed worker did not pong within ${timeoutMs}ms`)),
		timeoutMs,
	);
	const unsubscribeMessage = handle.onMessage(message => {
		if (message.type === "pong") {
			resolve();
			return;
		}
		if (message.type === "log") return;
		reject(new Error(`mnemopi embed worker: expected pong, got ${JSON.stringify(message)}`));
	});
	const unsubscribeError = handle.onError(reject);
	try {
		handle.send({ type: "ping", id: "smoke" } satisfies MnemopiEmbedWorkerInbound);
		await promise;
	} finally {
		clearTimeout(timer);
		unsubscribeMessage();
		unsubscribeError();
		await handle.terminate();
	}
}

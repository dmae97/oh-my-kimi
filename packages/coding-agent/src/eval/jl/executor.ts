import * as path from "node:path";
import { getProjectDir, logger } from "@oh-my-pi/pi-utils";
import { Settings } from "../../config/settings";
import { OutputSink } from "../../session/streaming-output";
import type { ToolSession } from "../../tools";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../../tools/output-meta";
import { ensurePyToolBridge, type PyToolBridgeInfo, registerPyToolBridge } from "../py/tool-bridge";
import type { EvalDisplayOutput, EvalStatusEvent } from "../types";
import {
	checkJuliaKernelAvailability,
	JuliaKernel,
	type KernelDisplayOutput,
	type KernelExecuteOptions,
	type KernelExecuteResult,
} from "./kernel";
import { resolveExplicitJuliaRuntime } from "./runtime";

const SHUTDOWN_GRACE_MS = 1_000;

export interface JuliaExecutorOptions {
	cwd?: string;
	sessionId?: string;
	sessionFile?: string;
	artifactsDir?: string;
	localRoots?: Record<string, string>;
	interpreter?: string;
	onChunk?: (text: string) => void | Promise<void>;
	onStatus?: (event: EvalStatusEvent) => void;
	signal?: AbortSignal;
	timeoutMs?: number;
	deadlineMs?: number;
	idleTimeoutMs?: number;
	kernelOwnerId?: string;
	reset?: boolean;
	toolSession?: ToolSession;
	bridge?: PyToolBridgeInfo;
	bridgeSessionId?: string;
	artifactId?: string;
}

export interface JuliaKernelExecutor {
	execute: (code: string, options?: KernelExecuteOptions) => Promise<KernelExecuteResult>;
}

export interface JuliaResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	artifactId: string | undefined;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	displayOutputs: EvalDisplayOutput[];
	stdinRequested: boolean;
}

interface JuliaSession {
	sessionKey: string;
	sessionId: string;
	kernel: JuliaKernel;
	owners: Set<string>;
}

class JuliaExecutionCancelledError extends Error {
	constructor(readonly timedOut: boolean) {
		super(timedOut ? "Julia execution timed out" : "Julia execution cancelled");
		this.name = "JuliaExecutionCancelledError";
	}
}

const sessions = new Map<string, JuliaSession>();
const startingSessions = new Map<string, Promise<JuliaSession>>();
const resettingSessions = new Map<string, Promise<void>>();

function normalizeSessionCwd(cwd: string): string {
	return path.resolve(cwd);
}

function normalizeExplicitInterpreter(cwd: string, interpreter: string | undefined): string {
	if (interpreter === undefined) return "";
	const resolved = resolveExplicitJuliaRuntime(interpreter, cwd, {}).juliaPath;
	try {
		return path.resolve(resolved);
	} catch {
		return resolved;
	}
}

function buildSessionKey(sessionId: string, cwd: string, interpreter: string | undefined): string {
	const normalizedCwd = normalizeSessionCwd(cwd);
	const normalizedInterpreter = normalizeExplicitInterpreter(normalizedCwd, interpreter);
	return `${sessionId}::${normalizedCwd}::${normalizedInterpreter}`;
}

function isCancellationError(error: unknown): boolean {
	if (error instanceof JuliaExecutionCancelledError) return true;
	if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return true;
	if (
		error &&
		typeof error === "object" &&
		"name" in error &&
		(error.name === "AbortError" || error.name === "TimeoutError")
	)
		return true;
	return false;
}

function isTimedOutCancellation(error: unknown, signal?: AbortSignal): boolean {
	if (error instanceof JuliaExecutionCancelledError) return error.timedOut;
	if (error instanceof Error && error.name === "TimeoutError") return true;
	if (error && typeof error === "object" && "name" in error && error.name === "TimeoutError") return true;
	if (signal?.reason instanceof Error && signal.reason.name === "TimeoutError") return true;
	return false;
}

function getExecutionDeadlineMs(options?: Pick<JuliaExecutorOptions, "deadlineMs" | "timeoutMs">): number | undefined {
	if (options?.deadlineMs !== undefined) return options.deadlineMs;
	if (options?.timeoutMs !== undefined && options.timeoutMs > 0) return Date.now() + options.timeoutMs;
	return undefined;
}

function getRemainingTimeoutMs(deadlineMs?: number): number | undefined {
	if (deadlineMs === undefined) return undefined;
	return Math.max(0, deadlineMs - Date.now());
}

function requireRemainingTimeoutMs(deadlineMs?: number): number | undefined {
	if (deadlineMs === undefined) return undefined;
	const remaining = getRemainingTimeoutMs(deadlineMs);
	if (remaining !== undefined && remaining <= 0) {
		throw new JuliaExecutionCancelledError(true);
	}
	return remaining;
}

async function waitForPromiseWithCancellation<T>(
	promise: Promise<T>,
	options: Pick<JuliaExecutorOptions, "signal" | "deadlineMs">,
): Promise<T> {
	if (options.signal?.aborted) {
		throw new JuliaExecutionCancelledError(isTimedOutCancellation(options.signal.reason, options.signal));
	}
	const cleanups: Array<() => void> = [];
	const { promise: cancelPromise, reject } = Promise.withResolvers<never>();

	if (options.signal) {
		const onAbort = () => {
			reject(new JuliaExecutionCancelledError(isTimedOutCancellation(options.signal?.reason, options.signal)));
		};
		options.signal.addEventListener("abort", onAbort, { once: true });
		cleanups.push(() => options.signal?.removeEventListener("abort", onAbort));
	}

	const deadlineMs = options.deadlineMs;
	if (typeof deadlineMs === "number" && deadlineMs > Date.now()) {
		const timeout = setTimeout(() => {
			reject(new JuliaExecutionCancelledError(true));
		}, deadlineMs - Date.now());
		timeout.unref?.();
		cleanups.push(() => clearTimeout(timeout));
	}

	try {
		return await Promise.race([promise, cancelPromise]);
	} finally {
		for (const cleanup of cleanups) cleanup();
	}
}

function formatTimeoutAnnotation(timeoutMs?: number): string | undefined {
	if (timeoutMs === undefined) return undefined;
	const rounded = (timeoutMs / 1000).toFixed(0);
	return `[cell timed out after ${rounded}s]`;
}

function formatKernelTimeoutAnnotation(timeoutMs: number | undefined, kernelKilled: boolean): string {
	const explanation = kernelKilled ? "; active subprocess terminated to recover" : "; kernel is still running";
	if (timeoutMs === undefined) return `[execution timed out${explanation}]`;
	const rounded = (timeoutMs / 1000).toFixed(0);
	return `[execution timed out after ${rounded}s${explanation}]`;
}

function createCancelledJuliaResult(_timedOut: boolean, timeoutMs?: number): JuliaResult {
	const output = formatTimeoutAnnotation(timeoutMs) ?? "[execution cancelled]\n";
	return {
		output,
		exitCode: undefined,
		cancelled: true,
		truncated: false,
		artifactId: undefined,
		totalLines: 1,
		totalBytes: Buffer.byteLength(output),
		outputLines: 1,
		outputBytes: Buffer.byteLength(output),
		displayOutputs: [],
		stdinRequested: false,
	};
}

function buildKernelEnvPatch(options: {
	sessionFile?: string;
	artifactsDir?: string;
	bridge?: PyToolBridgeInfo;
	bridgeSessionId?: string;
	localRoots?: Record<string, string>;
}): Record<string, string | undefined> {
	const patch: Record<string, string | undefined> = {};
	if (options.sessionFile) patch.PI_SESSION_FILE = options.sessionFile;
	if (options.artifactsDir) patch.PI_ARTIFACTS_DIR = options.artifactsDir;
	if (options.bridge) {
		patch.PI_TOOL_BRIDGE_URL = options.bridge.url;
		patch.PI_TOOL_BRIDGE_TOKEN = options.bridge.token;
		patch.PI_TOOL_BRIDGE_SESSION = options.bridgeSessionId ?? "";
	}
	if (options.localRoots) {
		patch.PI_EVAL_LOCAL_ROOTS = JSON.stringify(options.localRoots);
	}
	return patch;
}

function buildKernelEnv(options: {
	sessionFile?: string;
	artifactsDir?: string;
	bridge?: PyToolBridgeInfo;
	bridgeSessionId?: string;
	localRoots?: Record<string, string>;
}): Record<string, string> | undefined {
	const patch = buildKernelEnvPatch(options);
	const keys = Object.keys(patch);
	if (keys.length === 0) return undefined;
	const realEnv: Record<string, string> = {};
	for (const key in patch) {
		const val = patch[key];
		if (typeof val === "string") realEnv[key] = val;
	}
	return realEnv;
}

async function startKernel(cwd: string, options: JuliaExecutorOptions): Promise<JuliaKernel> {
	const env: Record<string, string | undefined> = {};
	const patch = buildKernelEnv(options);
	if (patch) {
		for (const key in patch) {
			const value = patch[key];
			if (typeof value === "string") env[key] = value;
		}
	}
	return await JuliaKernel.start({
		cwd,
		interpreter: options.interpreter,
		env,
		signal: options.signal,
		deadlineMs: options.deadlineMs,
	});
}

function attachOwner(session: JuliaSession, sessionId: string, ownerId: string | undefined): void {
	if (ownerId) {
		session.owners.add(ownerId);
	} else {
		session.owners.add(`unmanaged:${sessionId}`);
	}
}

async function acquireSession(
	sessionKey: string,
	sessionId: string,
	cwd: string,
	options: JuliaExecutorOptions,
): Promise<JuliaSession> {
	const existing = sessions.get(sessionKey);
	if (existing) {
		attachOwner(existing, sessionId, options.kernelOwnerId);
		return existing;
	}

	const inFlight = startingSessions.get(sessionKey);
	if (inFlight) {
		const session = await waitForPromiseWithCancellation(inFlight, options);
		attachOwner(session, sessionId, options.kernelOwnerId);
		return session;
	}

	const startPromise = (async () => {
		try {
			const kernel = await startKernel(cwd, options);
			const session: JuliaSession = {
				sessionKey,
				sessionId,
				kernel,
				owners: new Set<string>(),
			};
			sessions.set(sessionKey, session);
			return session;
		} finally {
			startingSessions.delete(sessionKey);
		}
	})();

	startingSessions.set(sessionKey, startPromise);
	const session = await waitForPromiseWithCancellation(startPromise, options);
	attachOwner(session, sessionId, options.kernelOwnerId);
	return session;
}

async function replaceSessionKernel(session: JuliaSession, cwd: string, options: JuliaExecutorOptions): Promise<void> {
	logger.warn("Julia subprocess died or is unresponsive; spawning fresh process", {
		sessionKey: session.sessionKey,
	});
	const oldKernel = session.kernel;
	void oldKernel.shutdown({ timeoutMs: SHUTDOWN_GRACE_MS }).catch(() => {});

	const kernelPromise = startKernel(cwd, options);
	const kernel = await waitForPromiseWithCancellation(kernelPromise, options);
	session.kernel = kernel;
}

async function resetSession(sessionKey: string): Promise<void> {
	const session = sessions.get(sessionKey);
	if (!session) return;
	sessions.delete(sessionKey);
	await session.kernel.shutdown({ timeoutMs: SHUTDOWN_GRACE_MS }).catch(() => {});
}

export async function disposeAllJuliaKernelSessions(): Promise<void> {
	const active = Array.from(sessions.values());
	sessions.clear();
	startingSessions.clear();
	resettingSessions.clear();
	await Promise.all(active.map(s => s.kernel.shutdown({ timeoutMs: SHUTDOWN_GRACE_MS }).catch(() => {})));
}

export async function disposeJuliaKernelSessionsByOwner(ownerId: string): Promise<void> {
	const victims: JuliaSession[] = [];
	for (const [key, session] of sessions) {
		session.owners.delete(ownerId);
		if (session.owners.size === 0) {
			sessions.delete(key);
			victims.push(session);
		}
	}
	await Promise.all(victims.map(s => s.kernel.shutdown({ timeoutMs: SHUTDOWN_GRACE_MS }).catch(() => {})));
}

async function executeWithKernel(
	kernel: JuliaKernel,
	code: string,
	options: JuliaExecutorOptions | undefined,
): Promise<JuliaResult> {
	const displayOutputs: EvalDisplayOutput[] = [];
	const collectDisplay = (output: KernelDisplayOutput) => {
		if (output.type === "status") {
			options?.onStatus?.(output.event);
		}
		displayOutputs.push(output);
	};

	const settings = await Settings.init();
	const sink = new OutputSink({
		onChunk: options?.onChunk,
		headBytes: resolveOutputSinkHeadBytes(settings),
		maxColumns: resolveOutputMaxColumns(settings),
	});

	const deadlineMs = options?.deadlineMs;
	let executionTimeoutMs: number | undefined;
	const runId = `jl-${crypto.randomUUID()}`;

	const emitStatus = (event: EvalStatusEvent) => collectDisplay({ type: "status", event });
	const unregisterBridge =
		options?.toolSession && options?.bridgeSessionId
			? registerPyToolBridge(options.bridgeSessionId, runId, {
					toolSession: options.toolSession,
					signal: options.signal,
					emitStatus,
				})
			: null;

	try {
		executionTimeoutMs = requireRemainingTimeoutMs(deadlineMs);
		const result = await kernel.execute(code, {
			cwd: options?.cwd,
			env: buildKernelEnvPatch(options ?? {}),
			id: runId,
			signal: options?.signal,
			timeoutMs: executionTimeoutMs,
			onChunk: text => sink.push(text),
			onDisplay: output => collectDisplay(output),
		});

		if (result.cancelled) {
			const annotation = result.timedOut
				? formatKernelTimeoutAnnotation(executionTimeoutMs ?? options?.idleTimeoutMs, result.kernelKilled ?? false)
				: undefined;
			const dumped = await sink.dump(annotation);
			return {
				exitCode: undefined,
				cancelled: true,
				truncated: dumped.truncated,
				output: dumped.output,
				artifactId: dumped.artifactId ?? undefined,
				totalLines: dumped.totalLines,
				totalBytes: dumped.totalBytes,
				outputLines: dumped.outputLines,
				outputBytes: dumped.outputBytes,
				displayOutputs,
				stdinRequested: result.stdinRequested,
			};
		}

		if (result.stdinRequested) {
			const dumped = await sink.dump("Kernel requested stdin; interactive input is not supported.");
			return {
				exitCode: 1,
				cancelled: false,
				truncated: dumped.truncated,
				output: dumped.output,
				artifactId: dumped.artifactId ?? undefined,
				totalLines: dumped.totalLines,
				totalBytes: dumped.totalBytes,
				outputLines: dumped.outputLines,
				outputBytes: dumped.outputBytes,
				displayOutputs,
				stdinRequested: true,
			};
		}

		const exitCode = result.status === "ok" ? 0 : 1;
		const dumped = await sink.dump();
		return {
			exitCode,
			cancelled: false,
			truncated: dumped.truncated,
			output: dumped.output,
			artifactId: dumped.artifactId ?? undefined,
			totalLines: dumped.totalLines,
			totalBytes: dumped.totalBytes,
			outputLines: dumped.outputLines,
			outputBytes: dumped.outputBytes,
			displayOutputs,
			stdinRequested: false,
		};
	} catch (err) {
		if (isCancellationError(err) || options?.signal?.aborted) {
			const timedOut = isTimedOutCancellation(err, options?.signal);
			const annotation = timedOut
				? formatTimeoutAnnotation(executionTimeoutMs ?? options?.idleTimeoutMs)
				: undefined;
			const dumped = await sink.dump(annotation);
			return {
				exitCode: undefined,
				cancelled: true,
				truncated: dumped.truncated,
				output: dumped.output,
				artifactId: dumped.artifactId ?? undefined,
				totalLines: dumped.totalLines,
				totalBytes: dumped.totalBytes,
				outputLines: dumped.outputLines,
				outputBytes: dumped.outputBytes,
				displayOutputs,
				stdinRequested: false,
			};
		}
		const error = err instanceof Error ? err : new Error(String(err));
		logger.error("Julia execution failed", { error: error.message });
		throw error;
	} finally {
		unregisterBridge?.();
	}
}

async function ensureKernelAvailable(cwd: string, options: JuliaExecutorOptions): Promise<void> {
	const availability = await waitForPromiseWithCancellation(
		checkJuliaKernelAvailability(cwd, options.interpreter),
		options,
	);
	if (!availability.ok) {
		throw new Error(availability.reason ?? "Julia kernel unavailable");
	}
}

async function ensureToolBridge(options: JuliaExecutorOptions): Promise<void> {
	if (!options.toolSession || options.bridge) return;
	try {
		options.bridge = await ensurePyToolBridge();
	} catch (err) {
		logger.warn("Failed to start Julia tool bridge", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

async function executeOnSession(code: string, cwd: string, options: JuliaExecutorOptions): Promise<JuliaResult> {
	const sessionId = options.sessionId ?? `session:${cwd}`;
	const sessionKey = buildSessionKey(sessionId, cwd, options.interpreter);
	if (options.bridge && !options.bridgeSessionId) {
		options.bridgeSessionId = sessionId;
	}
	if (options.reset) {
		const inFlight = resettingSessions.get(sessionKey);
		if (inFlight) await inFlight.catch(() => undefined);
		else {
			const resetPromise = resetSession(sessionKey);
			resettingSessions.set(
				sessionKey,
				resetPromise.then(() => undefined),
			);
			try {
				await resetPromise;
			} finally {
				resettingSessions.delete(sessionKey);
			}
		}
	} else {
		const inFlight = resettingSessions.get(sessionKey);
		if (inFlight) await inFlight.catch(() => undefined);
	}
	const session = await acquireSession(sessionKey, sessionId, cwd, options);
	if (options.signal?.aborted) {
		throw new JuliaExecutionCancelledError(isTimedOutCancellation(options.signal.reason, options.signal));
	}
	if (sessions.get(session.sessionKey) !== session) {
		throw new JuliaExecutionCancelledError(false);
	}
	if (!session.kernel.isAlive()) {
		await replaceSessionKernel(session, cwd, options);
		if (sessions.get(session.sessionKey) !== session) {
			throw new JuliaExecutionCancelledError(false);
		}
	}
	const runOptions = { ...options, cwd };
	try {
		return await executeWithKernel(session.kernel, code, runOptions);
	} catch (err) {
		if (isCancellationError(err) || options.signal?.aborted) throw err;
		if (session.kernel.isAlive()) throw err;
		if (sessions.get(session.sessionKey) !== session) {
			throw new JuliaExecutionCancelledError(false);
		}
		await replaceSessionKernel(session, cwd, options);
		if (sessions.get(session.sessionKey) !== session) {
			throw new JuliaExecutionCancelledError(false);
		}
		return await executeWithKernel(session.kernel, code, runOptions);
	}
}

export async function executeJuliaWithKernel(
	kernel: JuliaKernel,
	code: string,
	options?: JuliaExecutorOptions,
): Promise<JuliaResult> {
	return await executeWithKernel(kernel, code, options);
}

export async function executeJulia(code: string, options?: JuliaExecutorOptions): Promise<JuliaResult> {
	const cwd = normalizeSessionCwd(options?.cwd ?? getProjectDir());
	const deadlineMs = getExecutionDeadlineMs(options);
	const executionOptions: JuliaExecutorOptions = {
		...(options ?? {}),
		cwd,
		deadlineMs,
	};

	try {
		requireRemainingTimeoutMs(deadlineMs);
		if (executionOptions.signal?.aborted) {
			throw new JuliaExecutionCancelledError(
				isTimedOutCancellation(executionOptions.signal.reason, executionOptions.signal),
			);
		}
		await ensureKernelAvailable(cwd, executionOptions);
		await ensureToolBridge(executionOptions);
		return await executeOnSession(code, cwd, executionOptions);
	} catch (err) {
		if (isCancellationError(err) || executionOptions.signal?.aborted) {
			return createCancelledJuliaResult(isTimedOutCancellation(err, executionOptions.signal));
		}
		throw err;
	}
}

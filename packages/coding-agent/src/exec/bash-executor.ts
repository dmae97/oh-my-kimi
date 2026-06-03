/**
 * Bash command execution with streaming support and cancellation.
 *
 * Uses brush-core via native bindings for shell execution.
 */
import * as fs from "node:fs/promises";
import { ExponentialYield } from "@oh-my-pi/pi-agent-core/utils/yield";
import { executeShell, type MinimizerOptions, Shell, type ShellRunResult } from "@oh-my-pi/pi-natives";
import { Settings, type ShellMinimizerSettings } from "../config/settings";
import { OutputSink } from "../session/streaming-output";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../tools/output-meta";
import { getOrCreateSnapshot } from "../utils/shell-snapshot";
import { NON_INTERACTIVE_ENV } from "./non-interactive-env";

export interface BashExecutorOptions {
	cwd?: string;
	timeout?: number;
	onChunk?: (chunk: string) => void;
	chunkThrottleMs?: number;
	signal?: AbortSignal;
	/** Session key suffix to isolate shell sessions per agent */
	sessionKey?: string;
	/** Additional environment variables to inject */
	env?: Record<string, string>;
	/** Artifact path/id for full output storage */
	artifactPath?: string;
	artifactId?: string;
	/**
	 * Invoked when the native minimizer rewrote the command's output, giving
	 * the caller a chance to persist the lossless original capture (typically
	 * via the session's `ArtifactManager`). The returned id is spliced into
	 * the sink output as `artifact://<id>` so the agent can retrieve the raw
	 * bytes. Return `undefined` to skip the footer.
	 */
	onMinimizedSave?: (
		originalText: string,
		info: { filter: string; inputBytes: number; outputBytes: number },
	) => Promise<string | undefined>;
}

export interface BashResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	artifactId?: string;
}

const shellSessions = new Map<string, Shell>();
const brokenShellSessions = new Set<string>();
const shellSessionQuarantines = new Map<string, Promise<unknown>>();

function quarantineShellSession(
	sessionKey: string,
	runPromise: Promise<ShellRunResult>,
	abortCleanupPromise: Promise<void> | undefined,
): void {
	brokenShellSessions.add(sessionKey);
	const cleanup = abortCleanupPromise
		? Promise.allSettled([runPromise, abortCleanupPromise])
		: Promise.allSettled([runPromise]);
	shellSessionQuarantines.set(sessionKey, cleanup);
	void cleanup
		.finally(() => {
			if (shellSessionQuarantines.get(sessionKey) === cleanup) {
				shellSessionQuarantines.delete(sessionKey);
				brokenShellSessions.delete(sessionKey);
			}
		})
		.catch(() => undefined);
}

async function resolveShellCwd(cwd: string | undefined): Promise<string | undefined> {
	if (!cwd) return undefined;

	try {
		// Brush preserves the working directory string verbatim, so resolve symlinks
		// up front to keep `pwd` aligned with tools like `git worktree list`.
		return await fs.realpath(cwd);
	} catch {
		return cwd;
	}
}

/** Translate `ShellMinimizerSettings` into native `MinimizerOptions`, or `undefined` when disabled. */
export function buildMinimizerOptions(group: ShellMinimizerSettings): MinimizerOptions | undefined {
	if (!group.enabled) return undefined;
	return {
		enabled: true,
		settingsPath: group.settingsPath || undefined,
		only: group.only.length > 0 ? group.only : undefined,
		except: group.except.length > 0 ? group.except : undefined,
		maxCaptureBytes: group.maxCaptureBytes,
	};
}

export async function executeBash(command: string, options?: BashExecutorOptions): Promise<BashResult> {
	const settings = await Settings.init();
	const { shell, env: shellEnv, prefix } = settings.getShellConfig();
	const snapshotPath = shell.includes("bash") ? await getOrCreateSnapshot(shell, shellEnv) : null;

	const minimizer = buildMinimizerOptions(settings.getGroup("shellMinimizer"));

	const commandCwd = await resolveShellCwd(options?.cwd);
	const commandEnv = options?.env ? { ...NON_INTERACTIVE_ENV, ...options.env } : NON_INTERACTIVE_ENV;

	// Apply command prefix if configured
	const prefixedCommand = prefix ? `${prefix} ${command}` : command;
	const finalCommand = prefixedCommand;

	// Create output sink for truncation and artifact handling
	const sink = new OutputSink({
		onChunk: options?.onChunk,
		artifactPath: options?.artifactPath,
		artifactId: options?.artifactId,
		headBytes: resolveOutputSinkHeadBytes(settings),
		maxColumns: resolveOutputMaxColumns(settings),
		chunkThrottleMs: options?.onChunk ? (options.chunkThrottleMs ?? 50) : 0,
	});

	// sink.push() is synchronous — buffer management, counters, and onChunk
	// all run inline. File writes (artifact path) are handled asynchronously
	// inside the sink. No promise chain needed.
	let acceptingChunks = true;
	const enqueueChunk = (chunk: string) => {
		if (acceptingChunks) sink.push(chunk);
	};

	if (options?.signal?.aborted) {
		return {
			exitCode: undefined,
			cancelled: true,
			...(await sink.dump("Command cancelled")),
		};
	}

	const sessionKey = buildSessionKey(shell, prefix, snapshotPath, shellEnv, options?.sessionKey, minimizer);
	const persistentSessionBroken = brokenShellSessions.has(sessionKey);
	if (persistentSessionBroken) {
		shellSessions.delete(sessionKey);
	}

	let shellSession = persistentSessionBroken ? undefined : shellSessions.get(sessionKey);
	if (!shellSession && !persistentSessionBroken) {
		shellSession = new Shell({
			sessionEnv: shellEnv,
			snapshotPath: snapshotPath ?? undefined,
			minimizer,
		});
		shellSessions.set(sessionKey, shellSession);
	}
	const userSignal = options?.signal;
	const runAbortController = new AbortController();
	let abortCleanupPromise: Promise<void> | undefined;
	const abortCurrentExecution = () => {
		if (!runAbortController.signal.aborted) {
			runAbortController.abort();
		}
		if (shellSession && !abortCleanupPromise) {
			abortCleanupPromise = shellSession.abort().catch(() => undefined);
		}
	};
	const abortDeferred = Promise.withResolvers<"abort">();
	const abortHandler = () => {
		abortCurrentExecution();
		abortDeferred.resolve("abort");
	};
	if (userSignal) {
		userSignal.addEventListener("abort", abortHandler, { once: true });
	}

	let timeoutTimer: NodeJS.Timeout | undefined;
	const timeoutDeferred = Promise.withResolvers<"timeout">();
	const baseTimeoutMs = Math.max(1_000, options?.timeout ?? 300_000);
	timeoutTimer = setTimeout(() => {
		abortCurrentExecution();
		timeoutDeferred.resolve("timeout");
	}, baseTimeoutMs);

	let resetSession = false;

	try {
		const runPromise = shellSession
			? shellSession.run(
					{
						command: finalCommand,
						cwd: commandCwd,
						env: commandEnv,
						timeoutMs: options?.timeout,
						signal: runAbortController.signal,
					},
					(err, chunk) => {
						if (!err) {
							enqueueChunk(chunk);
						}
					},
				)
			: executeShell(
					{
						command: finalCommand,
						cwd: commandCwd,
						env: commandEnv,
						sessionEnv: shellEnv,
						snapshotPath: snapshotPath ?? undefined,
						minimizer,
						timeoutMs: options?.timeout,
						signal: runAbortController.signal,
					},
					(err, chunk) => {
						if (!err) {
							enqueueChunk(chunk);
						}
					},
				);

		const ey = new ExponentialYield();
		const winner = await ey.race<
			{ kind: "result"; result: ShellRunResult } | { kind: "timeout" } | { kind: "abort" }
		>([
			runPromise.then(result => ({ kind: "result" as const, result })),
			timeoutDeferred.promise.then(kind => ({ kind })),
			abortDeferred.promise.then(kind => ({ kind })),
		]);

		if (winner.kind === "timeout" || winner.kind === "abort") {
			acceptingChunks = false;
			if (shellSession) {
				resetSession = true;
				quarantineShellSession(sessionKey, runPromise, abortCleanupPromise);
			} else {
				void runPromise.catch(() => undefined);
			}
			return {
				exitCode: undefined,
				cancelled: true,
				...(await sink.dump(
					winner.kind === "timeout"
						? `Command timed out after ${Math.round(baseTimeoutMs / 1000)} seconds`
						: "Command cancelled",
				)),
			};
		}
		if (timeoutTimer) {
			clearTimeout(timeoutTimer);
			timeoutTimer = undefined;
		}

		// Handle timeout
		if (winner.result.timedOut) {
			const annotation = options?.timeout
				? `Command timed out after ${Math.round(options.timeout / 1000)} seconds`
				: "Command timed out";
			resetSession = true;
			if (shellSession) {
				quarantineShellSession(sessionKey, runPromise, abortCleanupPromise);
			}
			return {
				exitCode: undefined,
				cancelled: true,
				...(await sink.dump(annotation)),
			};
		}

		// Handle cancellation
		if (winner.result.cancelled) {
			resetSession = true;
			if (shellSession) {
				quarantineShellSession(sessionKey, runPromise, abortCleanupPromise);
			}
			return {
				exitCode: undefined,
				cancelled: true,
				...(await sink.dump("Command cancelled")),
			};
		}

		// When the native minimizer rewrote the output, swap the sink's accumulated
		// raw stream for the minimized text, persist the original as a session
		// artifact, and splice an `artifact://<id>` footer into the visible text so
		// the agent can retrieve the raw bytes losslessly.
		const minimized = winner.result.minimized;
		if (minimized && minimized.text !== minimized.originalText) {
			sink.replace(minimized.text);
			if (options?.onMinimizedSave) {
				const artifactId = await options.onMinimizedSave(minimized.originalText, {
					filter: minimized.filter,
					inputBytes: minimized.inputBytes,
					outputBytes: minimized.outputBytes,
				});
				if (artifactId) {
					const sep = minimized.text.endsWith("\n") ? "" : "\n";
					sink.push(`${sep}[raw output: artifact://${artifactId}]\n`);
				}
			}
		}

		// Normal completion
		return {
			exitCode: winner.result.exitCode,
			cancelled: false,
			...(await sink.dump()),
		};
	} catch (err) {
		resetSession = true;
		throw err;
	} finally {
		if (timeoutTimer) {
			clearTimeout(timeoutTimer);
		}
		if (userSignal) {
			userSignal.removeEventListener("abort", abortHandler);
		}
		if (resetSession) {
			shellSessions.delete(sessionKey);
		}
	}
}

function buildSessionKey(
	shell: string,
	prefix: string | undefined,
	snapshotPath: string | null,
	env: Record<string, string>,
	agentSessionKey?: string,
	minimizer?: MinimizerOptions,
): string {
	const entries = Object.entries(env);
	entries.sort(([a], [b]) => a.localeCompare(b));
	const envSerialized = entries.map(([key, value]) => `${key}=${value}`).join("\n");
	const minimizerSerialized = minimizer ? JSON.stringify(minimizer) : "";
	return [agentSessionKey ?? "", shell, prefix ?? "", snapshotPath ?? "", envSerialized, minimizerSerialized].join(
		"\n",
	);
}

import {
	type ChildProcessByStdio,
	type SpawnOptionsWithStdioTuple,
	type StdioNull,
	type StdioPipe,
	spawn,
} from "node:child_process";
import type { Readable } from "node:stream";

type ManagedChild = ChildProcessByStdio<null, Readable, Readable>;
type ManagedSpawnOptions = SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>;

export type ManagedProcessReason = "completed" | "cutoff" | "aborted" | "spawn-error";

export interface ManagedProcessCleanup {
	readonly termSent: boolean;
	readonly killSent: boolean;
	readonly processGroup: boolean;
}

export interface ManagedProcessResult {
	readonly pid: number;
	readonly exitCode: number;
	readonly signal: NodeJS.Signals | null;
	readonly reason: ManagedProcessReason;
	readonly elapsedMs: number;
	readonly cleanup: ManagedProcessCleanup;
	readonly errorMessage?: string;
}

export interface RunManagedProcessOptions {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly cutoffMs: number;
	readonly terminationGraceMs?: number;
	readonly forceSettleMs?: number;
	readonly signal?: AbortSignal;
	readonly onStdout?: (chunk: string) => void;
	readonly onStderr?: (chunk: string) => void;
	readonly spawnProcess?: (command: string, args: readonly string[], options: ManagedSpawnOptions) => ManagedChild;
}

const DEFAULT_TERMINATION_GRACE_MS = 1_500;
const DEFAULT_FORCE_SETTLE_MS = 2_000;

export async function runManagedProcess(options: RunManagedProcessOptions): Promise<ManagedProcessResult> {
	const startedAtMs = Date.now();
	const processGroup = process.platform !== "win32";
	if (options.signal?.aborted) return withoutChild("aborted", startedAtMs, processGroup);
	const spawnProcess = options.spawnProcess ?? defaultSpawn;
	let child: ManagedChild;
	try {
		child = spawnProcess(options.command, options.args, {
			cwd: options.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			detached: processGroup,
			windowsHide: true,
		});
	} catch (error) {
		return withoutChild(
			"spawn-error",
			startedAtMs,
			processGroup,
			error instanceof Error ? error.message : String(error),
		);
	}
	const pid = child.pid ?? -1;

	return await new Promise<ManagedProcessResult>((resolve) => {
		let settled = false;
		let reason: ManagedProcessReason = "completed";
		let errorMessage: string | undefined;
		let termSent = false;
		let killSent = false;
		let cutoffTimer: NodeJS.Timeout | undefined;
		let escalationTimer: NodeJS.Timeout | undefined;
		let forceSettleTimer: NodeJS.Timeout | undefined;

		const cleanup = (): void => {
			if (cutoffTimer !== undefined) clearTimeout(cutoffTimer);
			if (escalationTimer !== undefined) clearTimeout(escalationTimer);
			if (forceSettleTimer !== undefined) clearTimeout(forceSettleTimer);
			options.signal?.removeEventListener("abort", onAbort);
		};

		const settle = (exitCode: number | null, processSignal: NodeJS.Signals | null): void => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout.destroy();
			child.stderr.destroy();
			resolve({
				pid,
				exitCode: normalizeExitCode(exitCode, reason),
				signal: processSignal,
				reason,
				elapsedMs: Date.now() - startedAtMs,
				cleanup: { termSent, killSent, processGroup },
				...(errorMessage === undefined ? {} : { errorMessage }),
			});
		};

		const requestTermination = (nextReason: "cutoff" | "aborted"): void => {
			if (settled || reason !== "completed") return;
			reason = nextReason;
			termSent = true;
			signalProcessTree(child, "SIGTERM", processGroup);
			const graceMs = Math.max(0, options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS);
			escalationTimer = setTimeout(() => {
				if (settled) return;
				killSent = true;
				signalProcessTree(child, "SIGKILL", processGroup);
			}, graceMs);
			forceSettleTimer = setTimeout(
				() => settle(null, null),
				graceMs + Math.max(1, options.forceSettleMs ?? DEFAULT_FORCE_SETTLE_MS),
			);
		};

		function onAbort(): void {
			requestTermination("aborted");
		}

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => options.onStdout?.(chunk));
		child.stderr.on("data", (chunk: string) => options.onStderr?.(chunk));
		child.once("error", (error: Error) => {
			if (reason === "completed") reason = "spawn-error";
			errorMessage = error.message;
			settle(1, null);
		});
		child.once("close", (code: number | null, processSignal: NodeJS.Signals | null) => {
			if ((reason === "cutoff" || reason === "aborted") && termSent && !killSent) {
				killSent = true;
				signalProcessTree(child, "SIGKILL", processGroup);
				settle(code, processSignal);
				return;
			}
			if (reason === "completed" && processGroupExists(pid)) {
				if (cutoffTimer !== undefined) clearTimeout(cutoffTimer);
				options.signal?.removeEventListener("abort", onAbort);
				termSent = true;
				signalProcessTree(child, "SIGTERM", processGroup);
				const graceMs = Math.max(0, options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS);
				escalationTimer = setTimeout(() => {
					if (processGroupExists(pid)) {
						killSent = true;
						signalProcessTree(child, "SIGKILL", processGroup);
					}
					settle(code, processSignal);
				}, graceMs);
				return;
			}
			settle(code, processSignal);
		});

		if (options.cutoffMs > 0) {
			cutoffTimer = setTimeout(() => requestTermination("cutoff"), options.cutoffMs);
		}
		if (options.signal?.aborted) onAbort();
		else options.signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function withoutChild(
	reason: "aborted" | "spawn-error",
	startedAtMs: number,
	processGroup: boolean,
	errorMessage?: string,
): ManagedProcessResult {
	return {
		pid: -1,
		exitCode: reason === "aborted" ? 130 : 1,
		signal: null,
		reason,
		elapsedMs: Date.now() - startedAtMs,
		cleanup: { termSent: false, killSent: false, processGroup },
		...(errorMessage === undefined ? {} : { errorMessage }),
	};
}

function defaultSpawn(command: string, args: readonly string[], options: ManagedSpawnOptions): ManagedChild {
	return spawn(command, [...args], options);
}

function processGroupExists(pid: number): boolean {
	if (process.platform === "win32" || pid < 1) return false;
	try {
		process.kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
}

function signalProcessTree(child: ManagedChild, signal: "SIGTERM" | "SIGKILL", processGroup: boolean): void {
	const pid = child.pid;
	if (pid === undefined) return;
	if (process.platform === "win32") {
		if (signal === "SIGKILL") {
			try {
				spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
					detached: true,
					stdio: "ignore",
					windowsHide: true,
				}).unref();
				return;
			} catch {
				child.kill(signal);
				return;
			}
		}
		child.kill(signal);
		return;
	}
	try {
		process.kill(processGroup ? -pid : pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			return;
		}
	}
}

function normalizeExitCode(exitCode: number | null, reason: ManagedProcessReason): number {
	if (exitCode !== null) return exitCode;
	if (reason === "completed") return 0;
	if (reason === "cutoff") return 124;
	if (reason === "aborted") return 130;
	return 1;
}

import type { ToolSession } from "../tools";
import type { EvalDisplayOutput, EvalLanguage, EvalStatusEvent } from "./types";

/** Per-cell execute() options. */
export interface ExecutorBackendExecOptions {
	cwd: string;
	sessionId: string;
	sessionFile: string | undefined;
	kernelOwnerId: string | undefined;
	signal?: AbortSignal;
	session: ToolSession;
	/**
	 * Inactivity budget in milliseconds (the cell's `timeout`). Cancellation is
	 * driven entirely by `signal`, which the eval tool arms as an idle watchdog
	 * that fires a `TimeoutError` reason after this much time with no progress
	 * (status) events. Backends use this value only for timeout-annotation text
	 * and as cold-start headroom; they MUST NOT derive a competing wall-clock
	 * timer from it.
	 */
	idleTimeoutMs: number;
	reset: boolean;
	artifactPath: string | undefined;
	artifactId: string | undefined;
	onChunk: (chunk: string) => void;
	/**
	 * Live status events (read/write/agent/…) delivered as they are emitted,
	 * before the cell finishes. The same events are also returned in
	 * `displayOutputs`; this channel exists so callers can stream long-running
	 * progress (e.g. `agent()` subagents) into the UI mid-execution.
	 */
	onStatus?: (event: EvalStatusEvent) => void;
}

/** Result returned by a backend's execute(). */
export interface ExecutorBackendResult {
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
}

/** Pluggable language backend for the eval tool. */
export interface ExecutorBackend {
	readonly id: EvalLanguage;
	readonly label: string;
	/** Source language identifier passed to the syntax highlighter (e.g. "python", "javascript"). */
	readonly highlightLang: string;
	/** Cheap availability check. Used by fallback resolution. */
	isAvailable(session: ToolSession): Promise<boolean>;
	/** Execute one cell. Caller invokes once per cell and aggregates results. */
	execute(code: string, opts: ExecutorBackendExecOptions): Promise<ExecutorBackendResult>;
}

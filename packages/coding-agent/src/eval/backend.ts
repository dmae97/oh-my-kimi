import type { ToolSession } from "../tools";
import type { EvalDisplayOutput, EvalLanguage } from "./types";

/** Per-cell execute() options. */
export interface ExecutorBackendExecOptions {
	cwd: string;
	sessionId: string;
	sessionFile: string | undefined;
	kernelOwnerId: string | undefined;
	signal?: AbortSignal;
	session: ToolSession;
	deadlineMs: number;
	reset: boolean;
	artifactPath: string | undefined;
	artifactId: string | undefined;
	onChunk: (chunk: string) => void;
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

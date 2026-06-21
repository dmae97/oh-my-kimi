import type { ToolSession } from "../../tools";
import {
	type ExecutorBackend,
	type ExecutorBackendExecOptions,
	type ExecutorBackendResult,
	resolveEvalUrlRoots,
} from "../backend";
import { executeJulia } from "./executor";
import { checkJuliaKernelAvailability } from "./kernel";

const JULIA_SESSION_PREFIX = "julia:";

export function namespaceSessionId(sessionId: string): string {
	return sessionId.startsWith(JULIA_SESSION_PREFIX) ? sessionId : `${JULIA_SESSION_PREFIX}${sessionId}`;
}

function readInterpreterSetting(session: ToolSession): string | undefined {
	const settings = session.settings as { get?: (key: string) => unknown } | undefined;
	const value = settings?.get?.("julia.interpreter");
	return typeof value === "string" ? value.trim() || undefined : undefined;
}

export default {
	id: "julia",
	label: "Julia",
	highlightLang: "julia",

	async isAvailable(session: ToolSession): Promise<boolean> {
		const availability = await checkJuliaKernelAvailability(session.cwd, readInterpreterSetting(session));
		return availability.ok;
	},

	async execute(code: string, opts: ExecutorBackendExecOptions): Promise<ExecutorBackendResult> {
		const result = await executeJulia(code, {
			cwd: opts.cwd,
			idleTimeoutMs: opts.idleTimeoutMs,
			signal: opts.signal,
			sessionId: namespaceSessionId(opts.sessionId),
			interpreter: readInterpreterSetting(opts.session),
			sessionFile: opts.sessionFile,
			artifactsDir: opts.session.getArtifactsDir?.() ?? undefined,
			localRoots: resolveEvalUrlRoots(opts.session),
			kernelOwnerId: opts.kernelOwnerId,
			reset: opts.reset,
			onChunk: opts.onChunk,
			onStatus: opts.onStatus,
			toolSession: opts.session,
		});
		return {
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			artifactId: result.artifactId,
			totalLines: result.totalLines,
			totalBytes: result.totalBytes,
			outputLines: result.outputLines,
			outputBytes: result.outputBytes,
			displayOutputs: result.displayOutputs,
		};
	},
} satisfies ExecutorBackend;

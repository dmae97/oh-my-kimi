import type { ToolSession } from "../../tools";
import {
	type ExecutorBackend,
	type ExecutorBackendExecOptions,
	type ExecutorBackendResult,
	resolveEvalUrlRoots,
} from "../backend";
import { executeRuby } from "./executor";
import { checkRubyKernelAvailability } from "./kernel";

const RUBY_SESSION_PREFIX = "ruby:";

export function namespaceSessionId(sessionId: string): string {
	return sessionId.startsWith(RUBY_SESSION_PREFIX) ? sessionId : `${RUBY_SESSION_PREFIX}${sessionId}`;
}

function readInterpreterSetting(session: ToolSession): string | undefined {
	const settings = session.settings as { get?: (key: string) => unknown } | undefined;
	const value = settings?.get?.("ruby.interpreter");
	return typeof value === "string" ? value.trim() || undefined : undefined;
}

export default {
	id: "ruby",
	label: "Ruby",
	highlightLang: "ruby",

	async isAvailable(session: ToolSession): Promise<boolean> {
		const availability = await checkRubyKernelAvailability(session.cwd, readInterpreterSetting(session));
		return availability.ok;
	},

	async execute(code: string, opts: ExecutorBackendExecOptions): Promise<ExecutorBackendResult> {
		const result = await executeRuby(code, {
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

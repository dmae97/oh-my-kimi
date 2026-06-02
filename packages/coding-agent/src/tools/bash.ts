import * as fs from "node:fs";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { ImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";
import { getProjectDir, isEnoent, logger, prompt } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";
import { AsyncJobManager } from "../async";
import { type BashResult, executeBash } from "../exec/bash-executor";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { InternalUrlRouter } from "../internal-urls";
import { truncateToVisualLines } from "../modes/components/visual-truncate";
import { shimmerEnabled } from "../modes/theme/shimmer";
import { highlightCode, type Theme } from "../modes/theme/theme";
import bashDescription from "../prompts/tools/bash.md" with { type: "text" };
import type { ClientBridgeTerminalExitStatus, ClientBridgeTerminalOutput } from "../session/client-bridge";
import { DEFAULT_MAX_BYTES, streamTailUpdates, TailBuffer } from "../session/streaming-output";
import { renderStatusLine } from "../tui";
import { CachedOutputBlock } from "../tui/output-block";
import { getSixelLineMask } from "../utils/sixel";
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import { applyBashFixups } from "./bash-command-fixup";
import { type BashInteractiveResult, runInteractiveBashPty } from "./bash-interactive";
import { checkBashInterception } from "./bash-interceptor";
import { canUseInteractiveBashPty } from "./bash-pty-selection";
import { expandInternalUrls, type InternalUrlExpansionOptions } from "./bash-skill-urls";
import { formatStyledTruncationWarning, type OutputMeta, stripOutputNotice } from "./output-meta";
import { resolveToCwd } from "./path-utils";
import { formatToolWorkingDirectory, replaceTabs } from "./render-utils";
import { ToolAbortError, ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout, TOOL_TIMEOUTS } from "./tool-timeouts";

export const BASH_DEFAULT_PREVIEW_LINES = 10;

const BASH_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS = 60_000;

/**
 * Bash patterns flagged as safety critical for approval policy.
 *
 * Kept intentionally tight — the cost of a false negative is data loss or a compromised host,
 * while false positives remain actionable through user policy control.
 * New patterns should target shapes that are virtually never legitimate in automation.
 */
export const CRITICAL_BASH_PATTERNS = [
	// Recursive destruction.
	/\brm\s+-[a-z]*[rRfF][a-z]*\s+\//i, // rm -rf /, rm -fr /, rm -r /, rm -f /…
	/\bsudo\s+rm\b/i, // any `sudo rm`.
	/\bchmod\s+-R\s+[0-7]+\s+\//i, // `chmod -R 777 /`.
	/\bchmod\s+-R\s+[ugoa+\-=rwxXst,]+\s+\//, // `chmod -R u+x /`, `chmod -R u+rwx,o+w /etc` (symbolic mode, root target).
	/\bchown\s+-R\s+\S+\s+\//i, // `chown -R user /`.

	// Fork bomb (a few common spacings).
	/:\(\)\s*\{\s*:\s*\|\s*:/i,

	// Disk / filesystem destruction.
	/>\s*\/dev\/sd[a-z]/i, // write to disk device.
	/\bmkfs(\.|\b)/i, // format filesystem.
	/\bdd\s+if=.+of=\/dev\//i, // dd to a device.
	/\bshred\s+\/dev\//i,
	/\bcryptsetup\b/i,

	// System-config destruction.
	/>\s*\/etc\/(?:passwd|shadow|sudoers)\b/i,
	/\btee\s+(?:-a\s+)?\/etc\/(?:passwd|shadow|sudoers)\b/i, // `tee /etc/passwd`, `tee -a /etc/sudoers`.

	// Remote-fetch-then-execute (curl/wget piped to a shell or process-subbed).
	/\b(?:curl|wget|fetch)\b[^|]*\|\s*(?:bash|sh|zsh|fish)\b/i,
	// Process-sub variants — `bash <(curl …)`, `source <(curl …)`, `. <(curl …)`. `.` and `source` are
	// anchored to a command boundary so `find . -name` and similar don't false-positive.
	/(?:^|[\s;&|(])(?:bash|sh|zsh|source|\.)\s+<\(\s*(?:curl|wget|fetch)\b/i,
	// `eval "$(curl …)"` / `eval $(curl …)` / `eval \`curl …\``.
	/\beval\s+["'`]?\$\(\s*(?:curl|wget|fetch)\b|\beval\s+`\s*(?:curl|wget|fetch)\b/i,

	// Process/host control.
	/\bkill\s+-9\s+1\b/, // kill PID 1.
	// Process/host control — must sit at command position so `npm run reboot-tests`
	// or `echo 'shutdown the queue'` don't false-positive.
	/(?:^|[\s;&|(])(?:shutdown|poweroff|reboot|halt)(?:\s|$|[;|&])/i,
	/(?:^|[\s;&|(])init\s+0\b/i,

	// Network-shell exfil.
	/\bnc\b[^|;]*\s-[a-zA-Z]*[ec][a-zA-Z]*\s/i, // `nc -e` / `nc -c`.
] as const;

async function saveBashOriginalArtifact(session: ToolSession, originalText: string): Promise<string | undefined> {
	try {
		const alloc = await session.allocateOutputArtifact?.("bash-original");
		if (!alloc?.path || !alloc.id) return undefined;
		await Bun.write(alloc.path, originalText);
		return alloc.id;
	} catch {
		return undefined;
	}
}

const bashSchemaBase = z.object({
	command: z.string().describe("command to execute"),
	env: z.record(z.string().regex(BASH_ENV_NAME_PATTERN), z.string()).optional().describe("extra env vars"),
	timeout: z.number().default(300).describe("timeout in seconds").optional(),
	cwd: z.string().describe("working directory").optional(),
	pty: z.boolean().describe("run in pty mode").optional(),
});

const bashSchemaWithAsync = bashSchemaBase.extend({
	async: z.boolean().describe("run in background").optional(),
});

type BashToolSchema = typeof bashSchemaBase | typeof bashSchemaWithAsync;

export interface BashToolInput {
	command: string;
	env?: Record<string, string>;
	timeout?: number;
	cwd?: string;

	async?: boolean;
	pty?: boolean;
}

export interface BashToolDetails {
	meta?: OutputMeta;
	timeoutSeconds?: number;
	requestedTimeoutSeconds?: number;
	wallTimeMs?: number;
	/** Exit code of a command that ran to completion but failed (non-zero). */
	exitCode?: number;
	terminalId?: string;
	async?: {
		state: "running" | "completed" | "failed";
		jobId: string;
		type: "bash";
	};
}

export interface BashToolOptions {}

type ManagedBashJobCompletion =
	| {
			kind: "completed";
			result: AgentToolResult<BashToolDetails>;
	  }
	| {
			kind: "failed";
			error: unknown;
	  };

interface ManagedBashJobHandle {
	jobId: string;
	label: string;
	completion: Promise<ManagedBashJobCompletion>;
	getLatestText: () => string;
	setBackgrounded: (backgrounded: boolean) => void;
}

function normalizeResultOutput(result: BashResult | BashInteractiveResult): string {
	return result.output || "";
}

function isInteractiveResult(result: BashResult | BashInteractiveResult): result is BashInteractiveResult {
	return "timedOut" in result;
}

function normalizeBashEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!env || Object.keys(env).length === 0) return undefined;
	const normalized: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (!BASH_ENV_NAME_PATTERN.test(key)) {
			throw new ToolError(`Invalid bash env name: ${key}`);
		}
		normalized[key] = value;
	}
	return normalized;
}

function escapeBashEnvValueForDisplay(value: string): string {
	return value
		.replaceAll("\\", "\\\\")
		.replaceAll("\n", "\\n")
		.replaceAll("\r", "\\r")
		.replaceAll("\t", "\\t")
		.replaceAll('"', '\\"')
		.replaceAll("$", "\\$")
		.replaceAll("`", "\\`");
}

function formatBashEnvAssignments(env: Record<string, string> | undefined): string {
	if (!env || Object.keys(env).length === 0) return "";
	return Object.entries(env)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => `${key}="${escapeBashEnvValueForDisplay(value)}"`)
		.join(" ");
}

function unescapePartialJsonString(value: string): string {
	let output = "";
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if (char !== "\\") {
			output += char;
			continue;
		}
		const next = value[index + 1];
		if (!next) {
			output += "\\";
			break;
		}
		index += 1;
		switch (next) {
			case '"':
				output += '"';
				break;
			case "\\":
				output += "\\";
				break;
			case "/":
				output += "/";
				break;
			case "b":
				output += "\b";
				break;
			case "f":
				output += "\f";
				break;
			case "n":
				output += "\n";
				break;
			case "r":
				output += "\r";
				break;
			case "t":
				output += "\t";
				break;
			case "u": {
				const hex = value.slice(index + 1, index + 5);
				if (/^[0-9a-fA-F]{4}$/u.test(hex)) {
					output += String.fromCharCode(Number.parseInt(hex, 16));
					index += 4;
				} else {
					output += "\\u";
				}
				break;
			}
			default:
				output += next;
		}
	}
	return output;
}

function extractPartialBashEnv(partialJson: string | undefined): Record<string, string> | undefined {
	if (!partialJson) return undefined;
	const envStart = partialJson.search(/"env"\s*:\s*\{/u);
	if (envStart === -1) return undefined;
	const objectStart = partialJson.indexOf("{", envStart);
	if (objectStart === -1) return undefined;
	const envBody = partialJson.slice(objectStart + 1);
	const env: Record<string, string> = {};
	const matcher = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"((?:\\.|[^"\\])*)(?:"|$)/gu;
	for (const match of envBody.matchAll(matcher)) {
		env[match[1]!] = unescapePartialJsonString(match[2]!);
	}
	return Object.keys(env).length > 0 ? env : undefined;
}

function formatTimeoutClampNotice(requestedTimeoutSec: number, effectiveTimeoutSec: number): string | undefined {
	return requestedTimeoutSec !== effectiveTimeoutSec
		? `Timeout clamped to ${effectiveTimeoutSec}s (requested ${requestedTimeoutSec}s; allowed range ${TOOL_TIMEOUTS.bash.min}-${TOOL_TIMEOUTS.bash.max}s).`
		: undefined;
}

function formatWallTimeSeconds(wallTimeMs: number): string {
	return (wallTimeMs / 1000).toFixed(2);
}

function formatWallTimeNotice(wallTimeMs: number): string {
	return `Wall time: ${formatWallTimeSeconds(wallTimeMs)} seconds`;
}

function formatExitCodeNotice(exitCode: number): string {
	return `Command exited with code ${exitCode}`;
}

/**
 * Strip the trailing occurrence of `notice` (plus a single surrounding newline
 * on each side) so the TUI can echo the value via a styled footer label
 * instead of repeating it verbatim in the output pane. The notice is
 * reconstructed from the same value the result was tagged with, so a literal
 * sub-string match never strips a coincidental in-output token — only the
 * exact line we appended in #buildCompletedResult.
 */
function stripTrailingNotice(text: string, notice: string): string {
	const idx = text.lastIndexOf(notice);
	if (idx === -1) return text;
	let start = idx;
	let end = idx + notice.length;
	if (text[start - 1] === "\n") start -= 1;
	if (text[end] === "\n") end += 1;
	return (text.slice(0, start) + text.slice(end)).trimEnd();
}

function stripWallTimeNotice(text: string, wallTimeMs: number | undefined): string {
	if (wallTimeMs === undefined) return text;
	return stripTrailingNotice(text, formatWallTimeNotice(wallTimeMs));
}

function stripExitCodeNotice(text: string, exitCode: number | undefined): string {
	if (exitCode === undefined) return text;
	return stripTrailingNotice(text, formatExitCodeNotice(exitCode));
}

/**
 * Bash tool implementation.
 *
 * Executes bash commands with optional timeout and working directory.
 */
export class BashTool implements AgentTool<BashToolSchema, BashToolDetails> {
	readonly name = "bash";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const rawCommand = (args as Partial<BashToolInput>).command;
		const command = typeof rawCommand === "string" ? rawCommand : "";
		if (command !== "" && CRITICAL_BASH_PATTERNS.some(pattern => pattern.test(command))) {
			return { tier: "exec", override: true, reason: "Critical pattern detected" };
		}
		return "exec";
	};
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const rawCommand = (args as Partial<BashToolInput>).command;
		const command = typeof rawCommand === "string" ? rawCommand : "(missing)";
		return [`Command: ${truncateForPrompt(command)}`];
	};
	readonly label = "Bash";
	readonly loadMode = "essential";
	readonly description: string;
	readonly parameters: BashToolSchema;
	readonly concurrency = "exclusive";
	readonly strict = true;
	readonly #asyncEnabled: boolean;
	readonly #autoBackgroundEnabled: boolean;
	readonly #autoBackgroundThresholdMs: number;

	constructor(private readonly session: ToolSession) {
		this.#asyncEnabled = this.session.settings.get("async.enabled");
		this.#autoBackgroundEnabled = this.session.settings.get("bash.autoBackground.enabled");
		this.#autoBackgroundThresholdMs = Math.max(
			0,
			Math.floor(
				this.session.settings.get("bash.autoBackground.thresholdMs") ?? DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS,
			),
		);
		this.parameters = this.#asyncEnabled ? bashSchemaWithAsync : bashSchemaBase;
		this.description = prompt.render(bashDescription, {
			asyncEnabled: this.#asyncEnabled,
			autoBackgroundEnabled: this.#autoBackgroundEnabled,
			autoBackgroundThresholdSeconds: Math.max(0, Math.floor(this.#autoBackgroundThresholdMs / 1000)),
			hasAstGrep: this.session.settings.get("astGrep.enabled"),
			hasAstEdit: this.session.settings.get("astEdit.enabled"),
			hasSearch: this.session.settings.get("search.enabled"),
			hasFind: this.session.settings.get("find.enabled"),
		});
	}

	#formatResultOutput(result: BashResult | BashInteractiveResult): string {
		const outputText = normalizeResultOutput(result);
		return outputText || "(no output)";
	}

	/**
	 * Throw for outcomes that are *not* a completed command: user/timeout
	 * aborts and a missing exit status. The foreground and bridge callers plus
	 * the async job manager rely on these throwing so cancellations surface as
	 * aborts and jobs are recorded as failed. A definite non-zero exit is a
	 * completed command that failed; #buildCompletedResult surfaces it as an
	 * error *result* (carrying execution details) rather than a throw.
	 */
	#throwIfUnfinished(result: BashResult | BashInteractiveResult, timeoutSec: number, outputText: string): void {
		if (result.cancelled) {
			throw new ToolError(normalizeResultOutput(result) || "Command aborted");
		}
		if (isInteractiveResult(result) && result.timedOut) {
			throw new ToolError(normalizeResultOutput(result) || `Command timed out after ${timeoutSec} seconds`);
		}
		if (result.exitCode === undefined) {
			throw new ToolError(`${outputText}\n\nCommand failed: missing exit status`);
		}
	}

	#buildCompletedResult(
		result: BashResult | BashInteractiveResult,
		timeoutSec: number,
		options: {
			requestedTimeoutSec?: number;
			notices?: readonly string[];
			terminalId?: string;
			wallTimeMs?: number;
		} = {},
	): AgentToolResult<BashToolDetails> {
		const exitCode = result.exitCode;
		const failedExit = exitCode !== undefined && exitCode !== 0;

		const outputLines = [this.#formatResultOutput(result)];
		const notices: string[] = [];
		if (options.wallTimeMs !== undefined) {
			notices.push(formatWallTimeNotice(options.wallTimeMs));
		}
		if (options.notices) {
			for (const notice of options.notices) {
				if (notice) notices.push(notice);
			}
		}
		if (notices.length > 0) outputLines.push("", ...notices);
		if (failedExit) outputLines.push("", formatExitCodeNotice(exitCode));
		const outputText = outputLines.join("\n");

		// Aborts / timeouts / missing-status still propagate as thrown errors.
		this.#throwIfUnfinished(result, timeoutSec, outputText);

		const details: BashToolDetails = { timeoutSeconds: timeoutSec };
		if (options.requestedTimeoutSec !== undefined && options.requestedTimeoutSec !== timeoutSec) {
			details.requestedTimeoutSeconds = options.requestedTimeoutSec;
		}
		if (options.terminalId !== undefined) {
			details.terminalId = options.terminalId;
		}
		if (options.wallTimeMs !== undefined) {
			details.wallTimeMs = options.wallTimeMs;
		}
		if (failedExit) {
			details.exitCode = exitCode;
		}
		const resultBuilder = toolResult(details).text(outputText).truncationFromSummary(result, { direction: "tail" });
		if (failedExit) resultBuilder.error();
		return resultBuilder.done();
	}

	#buildBackgroundStartResult(
		jobId: string,
		label: string,
		previewText: string,
		timeoutSec: number,
		options: { requestedTimeoutSec?: number; notices?: readonly string[] } = {},
	): AgentToolResult<BashToolDetails> {
		const details: BashToolDetails = {
			timeoutSeconds: timeoutSec,
			async: { state: "running", jobId, type: "bash" },
		};
		if (options.requestedTimeoutSec !== undefined && options.requestedTimeoutSec !== timeoutSec) {
			details.requestedTimeoutSeconds = options.requestedTimeoutSec;
		}
		const lines: string[] = [];
		const trimmedPreview = previewText.trimEnd();
		if (trimmedPreview.length > 0) {
			lines.push(trimmedPreview, "");
		}
		if (options.notices?.length) {
			lines.push(...options.notices, "");
		}
		lines.push(`Background job ${jobId} started: ${label}`);
		lines.push("Result will be delivered automatically when complete.");
		lines.push(
			`You can use \`job\` to poll until complete, but prefer to continue with another task in the meanwhile if it's not blocking.`,
		);
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details,
		};
	}

	#extractTextResult(result: AgentToolResult<BashToolDetails>): string {
		return result.content.find(block => block.type === "text")?.text ?? "";
	}

	#startManagedBashJob(options: {
		command: string;
		commandCwd: string;
		timeoutMs: number;
		timeoutSec: number;
		requestedTimeoutSec?: number;
		notices?: readonly string[];

		resolvedEnv?: Record<string, string>;
		onUpdate?: AgentToolUpdateCallback<BashToolDetails>;
		startBackgrounded: boolean;
	}): ManagedBashJobHandle {
		const manager = AsyncJobManager.instance();
		if (!manager) {
			throw new ToolError("Background job manager unavailable for this session.");
		}

		const label = options.command.length > 120 ? `${options.command.slice(0, 117)}...` : options.command;
		let latestText = "";
		let backgrounded = options.startBackgrounded;
		const completion = Promise.withResolvers<ManagedBashJobCompletion>();

		const jobId = manager.register(
			"bash",
			label,
			async ({ jobId, signal: runSignal, reportProgress }) => {
				const { path: artifactPath, id: artifactId } = (await this.session.allocateOutputArtifact?.("bash")) ?? {};
				const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES);
				const wallTimeStart = performance.now();
				try {
					const result = await executeBash(options.command, {
						cwd: options.commandCwd,
						sessionKey: `${this.session.getSessionId?.() ?? ""}:async:${jobId}`,
						timeout: options.timeoutMs,
						signal: runSignal,
						env: options.resolvedEnv,
						artifactPath,
						artifactId,
						onChunk: chunk => {
							tailBuffer.append(chunk);
							latestText = tailBuffer.text();
							void reportProgress(latestText, { async: { state: "running", jobId, type: "bash" } });
						},
						onMinimizedSave: originalText => saveBashOriginalArtifact(this.session, originalText),
					});
					const wallTimeMs = performance.now() - wallTimeStart;
					const finalResult = this.#buildCompletedResult(result, options.timeoutSec, {
						requestedTimeoutSec: options.requestedTimeoutSec,
						notices: options.notices ?? [],
						wallTimeMs,
					});
					const finalText = this.#extractTextResult(finalResult);
					latestText = finalText;
					// Hand the detailed result to the foreground auto-background
					// waiter (which renders it, footer included) before deciding
					// the job's terminal state.
					completion.resolve({ kind: "completed", result: finalResult });
					if (finalResult.isError === true) {
						// A non-zero exit is a completed command that failed. Re-enter
						// the failure path so the job manager records it as failed and
						// delivers the error text, matching prior throw-based behavior.
						throw new ToolError(finalText);
					}
					await reportProgress(finalText, { async: { state: "completed", jobId, type: "bash" } });
					return finalText;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					latestText = message;
					completion.resolve({ kind: "failed", error });
					await reportProgress(message, { async: { state: "failed", jobId, type: "bash" } });
					throw error;
				}
			},
			{
				ownerId: this.session.getAgentId?.() ?? undefined,
				onProgress: async (text, details) => {
					latestText = text;
					await options.onUpdate?.({
						content: [{ type: "text", text }],
						details: backgrounded ? ((details ?? {}) as BashToolDetails) : {},
					});
				},
			},
		);

		return {
			jobId,
			label,
			completion: completion.promise,
			getLatestText: () => latestText,
			setBackgrounded: (nextBackgrounded: boolean) => {
				backgrounded = nextBackgrounded;
			},
		};
	}

	async #waitForManagedBashJob(
		job: ManagedBashJobHandle,
		thresholdMs: number,
		signal?: AbortSignal,
	): Promise<ManagedBashJobCompletion | { kind: "running" } | { kind: "aborted" }> {
		if (signal?.aborted) {
			return { kind: "aborted" };
		}

		const waiters: Array<Promise<ManagedBashJobCompletion | { kind: "running" } | { kind: "aborted" }>> = [
			job.completion,
			Bun.sleep(thresholdMs).then(() => ({ kind: "running" as const })),
		];

		if (!signal) {
			return await Promise.race(waiters);
		}

		const { promise: abortedPromise, resolve: resolveAborted } = Promise.withResolvers<{ kind: "aborted" }>();
		const onAbort = () => resolveAborted({ kind: "aborted" });
		signal.addEventListener("abort", onAbort, { once: true });
		waiters.push(abortedPromise);
		try {
			return await Promise.race(waiters);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	#resolveAutoBackgroundWaitMs(timeoutMs: number): number {
		if (this.#autoBackgroundThresholdMs <= 0) return 0;
		const timeoutBufferMs = 1_000;
		return Math.max(0, Math.min(this.#autoBackgroundThresholdMs, timeoutMs - timeoutBufferMs));
	}

	async execute(
		_toolCallId: string,
		{
			command: rawCommand,
			env: rawEnv,
			timeout: rawTimeout = 300,
			cwd,

			async: asyncRequested = false,
			pty = false,
		}: BashToolInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<BashToolDetails>,
		ctx?: AgentToolContext,
	): Promise<AgentToolResult<BashToolDetails>> {
		let command = rawCommand;
		const env = normalizeBashEnv(rawEnv);

		// Apply conservative bash fixups (strip trailing `| head|tail` and redundant
		// `2>&1`). The helper is single-line only and refuses anything that could
		// change semantics.
		if (this.session.settings.get("bash.stripTrailingHeadTail")) {
			const fixup = applyBashFixups(command);
			if (fixup.stripped.length > 0) {
				command = fixup.command;
			}
		}

		// Extract leading `cd <path> && ...` into cwd when the model ignores the cwd parameter.
		// Constrained to a single line so a `&&` that sits on a later line of a multiline
		// script can't pull the entire script into the "cwd" capture.
		if (!cwd) {
			const cdMatch = command.match(/^cd[ \t]+((?:[^&\\\n\r]|\\.)+?)[ \t]*&&[ \t]*/);
			if (cdMatch) {
				cwd = cdMatch[1].trim().replace(/^["']|["']$/g, "");
				command = command.slice(cdMatch[0].length);
			}
		}
		if (asyncRequested && !this.#asyncEnabled) {
			throw new ToolError("Async bash execution is disabled. Enable async.enabled to use async mode.");
		}

		// Check both the original command and the cwd-normalized command so
		// leading `cd ... &&` wrappers do not hide either shell-navigation rules
		// or the dedicated-tool command that follows the directory change.
		if (this.session.settings.get("bashInterceptor.enabled")) {
			const rules = this.session.settings.getBashInterceptorRules();
			const commandsToCheck = rawCommand === command ? [command] : [rawCommand, command];
			for (const commandToCheck of commandsToCheck) {
				const interception = checkBashInterception(commandToCheck, ctx?.toolNames ?? [], rules);
				if (interception.block) {
					throw new ToolError(interception.message ?? "Command blocked");
				}
			}
		}

		const internalUrlOptions: InternalUrlExpansionOptions = {
			skills: this.session.skills ?? [],
			internalRouter: InternalUrlRouter.instance(),
			localOptions: {
				getArtifactsDir: this.session.getArtifactsDir,
				getSessionId: this.session.getSessionId,
			},
		};
		command = await expandInternalUrls(command, { ...internalUrlOptions, ensureLocalParentDirs: true });
		const resolvedEnv = env
			? Object.fromEntries(
					await Promise.all(
						Object.entries(env).map(async ([key, value]) => [
							key,
							await expandInternalUrls(value, {
								...internalUrlOptions,
								ensureLocalParentDirs: true,
								noEscape: true,
							}),
						]),
					),
				)
			: undefined;

		// Resolve protocol URLs (skill://, agent://, etc.) in extracted cwd.
		if (cwd?.includes("://") || cwd?.includes("local:/")) {
			cwd = await expandInternalUrls(cwd, { ...internalUrlOptions, noEscape: true });
		}

		const commandCwd = cwd ? resolveToCwd(cwd, this.session.cwd) : this.session.cwd;
		let cwdStat: fs.Stats;
		try {
			cwdStat = await fs.promises.stat(commandCwd);
		} catch (err) {
			if (isEnoent(err)) {
				throw new ToolError(`Working directory does not exist: ${commandCwd}`);
			}
			throw err;
		}
		if (!cwdStat.isDirectory()) {
			throw new ToolError(`Working directory is not a directory: ${commandCwd}`);
		}

		// Clamp to reasonable range: 1s - 3600s (1 hour)
		const requestedTimeoutSec = rawTimeout;
		const timeoutSec = clampTimeout("bash", requestedTimeoutSec);
		const timeoutMs = timeoutSec * 1000;
		const pendingNotices: string[] = [];
		const timeoutClampNotice = formatTimeoutClampNotice(requestedTimeoutSec, timeoutSec);
		if (timeoutClampNotice) pendingNotices.push(timeoutClampNotice);

		if (asyncRequested) {
			if (!AsyncJobManager.instance()) {
				throw new ToolError("Async job manager unavailable for this session.");
			}
			const job = this.#startManagedBashJob({
				command,
				commandCwd,
				timeoutMs,
				timeoutSec,
				requestedTimeoutSec,
				notices: pendingNotices,

				resolvedEnv,
				onUpdate,
				startBackgrounded: true,
			});
			return this.#buildBackgroundStartResult(job.jobId, job.label, "", timeoutSec, {
				requestedTimeoutSec,
				notices: pendingNotices,
			});
		}

		const autoBgManager = AsyncJobManager.instance();
		if (this.#autoBackgroundEnabled && !pty && autoBgManager) {
			const autoBackgroundWaitMs = this.#resolveAutoBackgroundWaitMs(timeoutMs);
			const startBackgrounded = autoBackgroundWaitMs === 0;
			const job = this.#startManagedBashJob({
				command,
				commandCwd,
				timeoutMs,
				timeoutSec,
				requestedTimeoutSec,
				notices: pendingNotices,

				resolvedEnv,
				onUpdate,
				startBackgrounded,
			});
			if (startBackgrounded) {
				return this.#buildBackgroundStartResult(job.jobId, job.label, "", timeoutSec, {
					requestedTimeoutSec,
					notices: pendingNotices,
				});
			}
			const waitResult = await this.#waitForManagedBashJob(job, autoBackgroundWaitMs, signal);
			if (waitResult.kind === "completed") {
				autoBgManager.acknowledgeDeliveries([job.jobId]);
				return waitResult.result;
			}
			if (waitResult.kind === "failed") {
				autoBgManager.acknowledgeDeliveries([job.jobId]);
				throw waitResult.error;
			}
			if (waitResult.kind === "aborted") {
				autoBgManager.cancel(job.jobId);
				autoBgManager.acknowledgeDeliveries([job.jobId]);
				throw new ToolAbortError(job.getLatestText() || "Command aborted");
			}
			job.setBackgrounded(true);
			return this.#buildBackgroundStartResult(job.jobId, job.label, job.getLatestText(), timeoutSec, {
				requestedTimeoutSec,
				notices: pendingNotices,
			});
		}

		// Route through the client terminal when the client advertises the terminal capability.
		// Skip when pty=true (PTY needs the local terminal UI).
		const clientBridge = this.session.getClientBridge?.();
		if (clientBridge?.capabilities.terminal && clientBridge.createTerminal && !pty) {
			const bridgeWallTimeStart = performance.now();
			const handle = await clientBridge.createTerminal({
				command,
				cwd: commandCwd,
				env: resolvedEnv
					? Object.entries(resolvedEnv).map(([name, value]) => ({ name, value: value as string }))
					: undefined,
				outputByteLimit: DEFAULT_MAX_BYTES,
			});

			// Emit partial update so the editor can embed the live terminal card.
			onUpdate?.({ content: [], details: { terminalId: handle.terminalId } });

			const exitPromise = handle.waitForExit();
			let exitStatus!: ClientBridgeTerminalExitStatus;

			type BridgeRaceResult =
				| { kind: "exit"; status: ClientBridgeTerminalExitStatus }
				| { kind: "poll" }
				| { kind: "timeout" }
				| { kind: "aborted" };

			// Set up abort listener before entering the poll loop. The listener
			// kicks off `handle.kill()` synchronously so a `session/cancel`
			// arriving mid-poll terminates the remote command immediately,
			// instead of waiting for the next `currentOutput()` to return.
			const { promise: abortedP, resolve: resolveAborted } = Promise.withResolvers<void>();
			let killStarted = false;
			const fireKill = (): Promise<void> => {
				if (killStarted) return Promise.resolve();
				killStarted = true;
				return handle.kill().catch((error: unknown) => {
					logger.warn("ACP terminal kill failed", { terminalId: handle.terminalId, error });
				});
			};
			const onAbortSignal = () => {
				resolveAborted();
				void fireKill();
			};
			signal?.addEventListener("abort", onAbortSignal, { once: true });

			try {
				try {
					if (signal?.aborted) {
						await fireKill();
						throw new ToolAbortError("Command aborted");
					}

					const timeoutPromise = Bun.sleep(timeoutMs).then(() => ({ kind: "timeout" as const }));
					// Poll until the process exits, times out, or the caller aborts.
					for (;;) {
						const racers: Array<Promise<BridgeRaceResult>> = [
							exitPromise.then(s => ({ kind: "exit" as const, status: s })),
							timeoutPromise,
							Bun.sleep(250).then(() => ({ kind: "poll" as const })),
						];
						if (signal) {
							racers.push(abortedP.then(() => ({ kind: "aborted" as const })));
						}
						const raced = await Promise.race(racers);

						if (raced.kind === "aborted" || signal?.aborted) {
							await fireKill();
							throw new ToolAbortError("Command aborted");
						}

						if (raced.kind === "timeout") {
							// Kill before reading final output so a slow `terminal/output`
							// RPC cannot let a timed-out command keep running past the
							// enforced timeout. The handle stays valid post-kill so the
							// buffered output is still readable.
							await fireKill();
							let current = { output: "", truncated: false };
							try {
								current = await handle.currentOutput();
							} catch (error) {
								logger.warn("ACP terminal final output read failed", {
									terminalId: handle.terminalId,
									error,
								});
							}
							const timedOutResult: BashInteractiveResult = {
								output: current.output,
								exitCode: undefined,
								cancelled: false,
								timedOut: true,
								truncated: current.truncated,
								totalLines: current.output.length > 0 ? current.output.split("\n").length : 0,
								totalBytes: current.output.length,
								outputLines: current.output.length > 0 ? current.output.split("\n").length : 0,
								outputBytes: current.output.length,
							};
							return this.#buildCompletedResult(timedOutResult, timeoutSec, {
								requestedTimeoutSec,
								notices: pendingNotices,
								terminalId: handle.terminalId,
								wallTimeMs: performance.now() - bridgeWallTimeStart,
							});
						}

						if (raced.kind === "exit") {
							exitStatus = raced.status;
							break;
						}

						// Poll tick: push current output so agent-loop transcript stays consistent.
						// Race the read against abort so a stuck `terminal/output` RPC does not
						// delay cancellation.
						const pollOutput = await Promise.race([
							handle.currentOutput(),
							abortedP.then(() => undefined as ClientBridgeTerminalOutput | undefined),
						]);
						if (pollOutput === undefined) {
							// Abort fired during the poll-tick read; let the next loop iteration
							// observe `signal?.aborted` and exit via the abort branch.
							continue;
						}
						onUpdate?.({
							content: [{ type: "text", text: pollOutput.output }],
							details: { terminalId: handle.terminalId },
						});
					}
				} finally {
					signal?.removeEventListener("abort", onAbortSignal);
				}

				// Fetch final output; the terminal is released in the outer finally.
				const finalOutput = await handle.currentOutput();

				// Map exit status: null exitCode with a signal → treat as signal kill (137).
				const rawExitCode = exitStatus.exitCode;
				const exitCode: number | undefined =
					rawExitCode != null ? rawExitCode : exitStatus.signal ? 137 : undefined;

				const outputText = finalOutput.output;
				const outputByteLen = outputText.length;
				const outputLineCount = outputText.length > 0 ? outputText.split("\n").length : 0;

				const bridgeResult: BashResult = {
					output: outputText,
					exitCode,
					cancelled: false,
					truncated: finalOutput.truncated,
					totalLines: outputLineCount,
					totalBytes: outputByteLen,
					outputLines: outputLineCount,
					outputBytes: outputByteLen,
				};

				const bridgeNotices: string[] = [];
				if (finalOutput.truncated) bridgeNotices.push("(output truncated)");
				for (const notice of pendingNotices) bridgeNotices.push(notice);

				return this.#buildCompletedResult(bridgeResult, timeoutSec, {
					requestedTimeoutSec,
					notices: bridgeNotices,
					terminalId: handle.terminalId,
					wallTimeMs: performance.now() - bridgeWallTimeStart,
				});
			} finally {
				try {
					await handle.release();
				} catch (error) {
					logger.warn("ACP terminal release failed", { terminalId: handle.terminalId, error });
				}
			}
		}

		// Track output for streaming updates (tail only)
		const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES);

		// Allocate artifact for truncated output storage
		const { path: artifactPath, id: artifactId } = (await this.session.allocateOutputArtifact?.("bash")) ?? {};

		const interactiveUi = canUseInteractiveBashPty(pty, ctx) ? ctx?.ui : undefined;
		const wallTimeStart = performance.now();
		const result: BashResult | BashInteractiveResult = interactiveUi
			? await runInteractiveBashPty(interactiveUi, {
					command,
					cwd: commandCwd,
					timeoutMs,
					signal,
					env: resolvedEnv,
					artifactPath,
					artifactId,
				})
			: await executeBash(command, {
					cwd: commandCwd,
					sessionKey: this.session.getSessionId?.() ?? undefined,
					timeout: timeoutMs,
					signal,
					env: resolvedEnv,
					artifactPath,
					artifactId,
					onChunk: streamTailUpdates(tailBuffer, onUpdate),
					onMinimizedSave: originalText => saveBashOriginalArtifact(this.session, originalText),
				});
		const wallTimeMs = performance.now() - wallTimeStart;
		if (result.cancelled) {
			if (signal?.aborted) {
				throw new ToolAbortError(normalizeResultOutput(result) || "Command aborted");
			}
			throw new ToolError(normalizeResultOutput(result) || "Command aborted");
		}
		if (isInteractiveResult(result) && result.timedOut) {
			throw new ToolError(normalizeResultOutput(result) || `Command timed out after ${timeoutSec} seconds`);
		}
		return this.#buildCompletedResult(result, timeoutSec, {
			requestedTimeoutSec,
			notices: pendingNotices,
			wallTimeMs,
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================
export interface BashRenderArgs {
	command?: string;
	env?: Record<string, string>;
	timeout?: number;
	cwd?: string;
	__partialJson?: string;
	[key: string]: unknown;
}

export interface BashRenderContext {
	/** Raw output text */
	output?: string;
	/** Whether output came from artifact storage */
	isFullOutput?: boolean;
	/** Whether output is expanded */
	expanded?: boolean;
	/** Number of preview lines when collapsed */
	previewLines?: number;
	/** Timeout in seconds */
	timeout?: number;
}

export interface ShellRendererConfig<TArgs> {
	resolveTitle: (args: TArgs | undefined, options: RenderResultOptions) => string;
	resolveCommand?: (args: TArgs | undefined) => string | undefined;
	resolveCwd?: (args: TArgs | undefined) => string | undefined;
	resolveEnv?: (args: TArgs | undefined) => Record<string, string> | undefined;
}

function getPartialJson<TArgs>(args: TArgs | undefined): string | undefined {
	if (!args || typeof args !== "object" || !("__partialJson" in args)) return undefined;
	const value = (args as { __partialJson?: unknown }).__partialJson;
	return typeof value === "string" ? value : undefined;
}

export function getBashEnvForDisplay(args: BashRenderArgs): Record<string, string> | undefined {
	// During streaming, partial-json parsing often does not surface env values until the object closes.
	// Recover them from the raw JSON buffer so the pending bash preview can show `NAME="..." cmd` immediately,
	// instead of rendering only the command and making the env assignment appear at the very end.
	const partialEnv = extractPartialBashEnv(args.__partialJson);
	if (partialEnv && args.env) return { ...partialEnv, ...args.env };
	return args.env ?? partialEnv;
}

/**
 * Returns the bash command formatted for the result body: the dim `$ cd … &&`
 * prefix joined with syntax-highlighted command lines. The prefix is applied
 * only to the first line so multi-line commands display cleanly — terminals
 * reset SGR state at line boundaries, which made the previous single-string
 * `theme.fg("dim", ...)` form render only the first line as dim.
 */
export function formatBashCommandLines(args: BashRenderArgs, uiTheme: Theme): string[] {
	const command = replaceTabs(args.command || "…");
	const cwd = getProjectDir();
	const displayWorkdir = formatToolWorkingDirectory(args.cwd, cwd);
	const envAssignments = formatBashEnvAssignments(getBashEnvForDisplay(args));
	const prefixParts = ["$"];
	if (displayWorkdir) prefixParts.push(`cd ${displayWorkdir} &&`);
	if (envAssignments) prefixParts.push(envAssignments);
	const prefix = uiTheme.fg("dim", `${prefixParts.join(" ")} `);
	const highlightedLines = highlightCode(command, "bash");
	if (highlightedLines.length === 0) return [prefix.trimEnd()];
	return highlightedLines.map((line, i) => (i === 0 ? `${prefix}${line}` : line));
}

function toBashRenderArgs<TArgs>(args: TArgs | undefined, config: ShellRendererConfig<TArgs>): BashRenderArgs {
	return {
		command: config.resolveCommand?.(args),
		cwd: config.resolveCwd?.(args),
		env: config.resolveEnv?.(args),
		__partialJson: getPartialJson(args),
	};
}

export function createShellRenderer<TArgs>(config: ShellRendererConfig<TArgs>) {
	return {
		renderCall(args: TArgs, options: RenderResultOptions, uiTheme: Theme): Component {
			const renderArgs = toBashRenderArgs(args, config);
			const title = config.resolveTitle(args, options);
			const cmdLines = formatBashCommandLines(renderArgs, uiTheme);
			const header = renderStatusLine({ icon: "pending", title }, uiTheme);
			const outputBlock = new CachedOutputBlock();
			return {
				render: (width: number): string[] =>
					outputBlock.render(
						{ header, state: "pending", sections: [{ lines: cmdLines }], width, animate: true },
						uiTheme,
					),
				invalidate: () => {
					outputBlock.invalidate();
				},
			};
		},

		renderResult(
			result: {
				content: Array<{ type: string; text?: string }>;
				details?: BashToolDetails;
				isError?: boolean;
			},
			options: RenderResultOptions & { renderContext?: BashRenderContext },
			uiTheme: Theme,
			args?: TArgs,
		): Component {
			const renderArgs = toBashRenderArgs(args, config);
			const cmdLines = args ? formatBashCommandLines(renderArgs, uiTheme) : undefined;
			const isError = result.isError === true;
			const icon = options.isPartial ? "pending" : isError ? "error" : "success";
			const title = config.resolveTitle(args, options);
			const header = renderStatusLine({ icon, title }, uiTheme);
			const details = result.details;
			const outputBlock = new CachedOutputBlock();

			return {
				render: (width: number): string[] => {
					// REACTIVE: read mutable options at render time
					const { renderContext } = options;
					const expanded = renderContext?.expanded ?? options.expanded;
					const previewLines = renderContext?.previewLines ?? BASH_DEFAULT_PREVIEW_LINES;

					// Get output from context (preferred) or fall back to result content.
					// Strip the LLM-facing notice appended by wrappedExecute so we don't
					// double-print it alongside the styled warning line below.
					const rawOutput = renderContext?.output ?? result.content?.find(c => c.type === "text")?.text ?? "";
					const strippedOutput = stripOutputNotice(rawOutput, details?.meta);
					const withoutExit = stripExitCodeNotice(strippedOutput, details?.exitCode);
					const output = stripWallTimeNotice(withoutExit, details?.wallTimeMs);
					const displayOutput = output.trimEnd();
					const showingFullOutput = expanded && renderContext?.isFullOutput === true;

					// Build truncation warning
					const timeoutSeconds = details?.timeoutSeconds ?? renderContext?.timeout;
					const requestedTimeoutSeconds = details?.requestedTimeoutSeconds;
					const wallTimeMs = details?.wallTimeMs;
					const statsParts: string[] = [];
					if (wallTimeMs !== undefined) {
						statsParts.push(`Wall: ${formatWallTimeSeconds(wallTimeMs)}s`);
					}
					if (typeof timeoutSeconds === "number") {
						statsParts.push(
							requestedTimeoutSeconds !== undefined && requestedTimeoutSeconds !== timeoutSeconds
								? `Timeout: ${timeoutSeconds}s (requested ${requestedTimeoutSeconds}s clamped)`
								: `Timeout: ${timeoutSeconds}s`,
						);
					}
					if (isError && typeof details?.exitCode === "number") {
						statsParts.push(`Exit: ${details.exitCode}`);
					}
					const timeoutLine =
						statsParts.length > 0
							? uiTheme.fg(
									"dim",
									`${uiTheme.format.bracketLeft}${statsParts.join(" | ")}${uiTheme.format.bracketRight}`,
								)
							: undefined;
					let warningLine: string | undefined;
					if (details?.meta?.truncation && !showingFullOutput) {
						warningLine = formatStyledTruncationWarning(details.meta, uiTheme) ?? undefined;
					}

					const outputLines: string[] = [];
					const hasOutput = displayOutput.trim().length > 0;
					const rawOutputLines = displayOutput.split("\n");
					const sixelLineMask =
						TERMINAL.imageProtocol === ImageProtocol.Sixel ? getSixelLineMask(rawOutputLines) : undefined;
					const hasSixelOutput = sixelLineMask?.some(Boolean) ?? false;
					if (hasOutput) {
						if (hasSixelOutput) {
							outputLines.push(
								...rawOutputLines.map((line, index) =>
									sixelLineMask?.[index] ? line : uiTheme.fg("toolOutput", replaceTabs(line)),
								),
							);
						} else if (expanded) {
							outputLines.push(...rawOutputLines.map(line => uiTheme.fg("toolOutput", replaceTabs(line))));
						} else {
							const styledOutput = rawOutputLines
								.map(line => uiTheme.fg("toolOutput", replaceTabs(line)))
								.join("\n");
							const textContent = styledOutput;
							const result = truncateToVisualLines(textContent, previewLines, width);
							if (result.skippedCount > 0) {
								outputLines.push(
									uiTheme.fg(
										"dim",
										`… (${result.skippedCount} earlier lines, showing ${result.visualLines.length} of ${result.skippedCount + result.visualLines.length}) (ctrl+o to expand)`,
									),
								);
							}
							outputLines.push(...result.visualLines);
						}
					}
					if (timeoutLine) outputLines.push(timeoutLine);
					if (warningLine) outputLines.push(warningLine);

					return outputBlock.render(
						{
							header,
							state: options.isPartial ? "pending" : isError ? "error" : "success",
							sections: [
								{ lines: cmdLines ?? [] },
								{ label: uiTheme.fg("toolTitle", "Output"), lines: outputLines },
							],
							width,
							animate: options.isPartial && shimmerEnabled(),
						},
						uiTheme,
					);
				},
				invalidate: () => {
					outputBlock.invalidate();
				},
			};
		},
		mergeCallAndResult: true,
		inline: true,
	};
}

export const bashToolRenderer = createShellRenderer<BashRenderArgs>({
	resolveTitle: () => "Bash",
	resolveCommand: args => args?.command,
	resolveCwd: args => args?.cwd,
	resolveEnv: args => args?.env,
});

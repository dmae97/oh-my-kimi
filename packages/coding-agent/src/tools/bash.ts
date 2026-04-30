import * as fs from "node:fs";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { ImageProtocol, TERMINAL, Text } from "@oh-my-pi/pi-tui";
import { $env, getProjectDir, isEnoent, prompt } from "@oh-my-pi/pi-utils";
import { Type } from "@sinclair/typebox";
import { type BashResult, executeBash } from "../exec/bash-executor";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { truncateToVisualLines } from "../modes/components/visual-truncate";
import type { Theme } from "../modes/theme/theme";
import bashDescription from "../prompts/tools/bash.md" with { type: "text" };
import { DEFAULT_MAX_BYTES, streamTailUpdates, TailBuffer } from "../session/streaming-output";
import { renderStatusLine } from "../tui";
import { CachedOutputBlock } from "../tui/output-block";
import { getSixelLineMask } from "../utils/sixel";
import type { ToolSession } from ".";
import { type BashInteractiveResult, runInteractiveBashPty } from "./bash-interactive";
import { checkBashInterception } from "./bash-interceptor";
import { applyHeadTail } from "./bash-normalize";
import { expandInternalUrls, type InternalUrlExpansionOptions } from "./bash-skill-urls";
import { formatStyledTruncationWarning, type OutputMeta } from "./output-meta";
import { resolveToCwd } from "./path-utils";
import { formatToolWorkingDirectory, replaceTabs } from "./render-utils";
import { ToolAbortError, ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout, TOOL_TIMEOUTS } from "./tool-timeouts";

export const BASH_DEFAULT_PREVIEW_LINES = 10;

const BASH_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS = 60_000;

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

const bashSchemaBase = Type.Object({
	command: Type.String({ description: "command to execute", examples: ["ls -la", "echo hi"] }),
	env: Type.Optional(
		Type.Record(Type.String({ pattern: BASH_ENV_NAME_PATTERN.source }), Type.String(), {
			description: "extra env vars",
		}),
	),
	timeout: Type.Optional(Type.Number({ description: "timeout in seconds", default: 300 })),
	cwd: Type.Optional(Type.String({ description: "working directory", examples: ["src/", "/tmp"] })),
	head: Type.Optional(Type.Number({ description: "first n lines of output" })),
	tail: Type.Optional(Type.Number({ description: "last n lines of output" })),
	pty: Type.Optional(
		Type.Boolean({
			description: "run in pty mode",
		}),
	),
});

const bashSchemaWithAsync = Type.Object({
	...bashSchemaBase.properties,
	async: Type.Optional(
		Type.Boolean({
			description: "run in background",
		}),
	),
});

type BashToolSchema = typeof bashSchemaBase | typeof bashSchemaWithAsync;

export interface BashToolInput {
	command: string;
	env?: Record<string, string>;
	timeout?: number;
	cwd?: string;
	head?: number;
	tail?: number;
	async?: boolean;
	pty?: boolean;
}

export interface BashToolDetails {
	meta?: OutputMeta;
	timeoutSeconds?: number;
	requestedTimeoutSeconds?: number;
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

/**
 * Bash tool implementation.
 *
 * Executes bash commands with optional timeout and working directory.
 */
export class BashTool implements AgentTool<BashToolSchema, BashToolDetails> {
	readonly name = "bash";
	readonly label = "Bash";
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

	#formatResultOutput(result: BashResult | BashInteractiveResult, headLines?: number, tailLines?: number): string {
		let outputText = normalizeResultOutput(result);
		const headTailResult = applyHeadTail(outputText, headLines, tailLines);
		if (headTailResult.applied) {
			outputText = headTailResult.text;
		}
		if (!outputText) {
			outputText = "(no output)";
		}
		return outputText;
	}

	#buildResultText(result: BashResult | BashInteractiveResult, timeoutSec: number, outputText: string): string {
		if (result.cancelled) {
			throw new ToolError(normalizeResultOutput(result) || "Command aborted");
		}
		if (isInteractiveResult(result) && result.timedOut) {
			throw new ToolError(normalizeResultOutput(result) || `Command timed out after ${timeoutSec} seconds`);
		}
		if (result.exitCode === undefined) {
			throw new ToolError(`${outputText}\n\nCommand failed: missing exit status`);
		}
		if (result.exitCode !== 0) {
			throw new ToolError(`${outputText}\n\nCommand exited with code ${result.exitCode}`);
		}
		return outputText;
	}

	#buildCompletedResult(
		result: BashResult | BashInteractiveResult,
		timeoutSec: number,
		headLines?: number,
		tailLines?: number,
		options: { requestedTimeoutSec?: number; notices?: string[] } = {},
	): AgentToolResult<BashToolDetails> {
		const outputLines = [this.#formatResultOutput(result, headLines, tailLines)];
		const notices = options.notices?.filter(Boolean) ?? [];
		if (notices.length > 0) outputLines.push("", ...notices);
		const outputText = outputLines.join("\n");
		const details: BashToolDetails = { timeoutSeconds: timeoutSec };
		if (options.requestedTimeoutSec !== undefined && options.requestedTimeoutSec !== timeoutSec) {
			details.requestedTimeoutSeconds = options.requestedTimeoutSec;
		}
		const resultBuilder = toolResult(details).text(outputText).truncationFromSummary(result, { direction: "tail" });
		this.#buildResultText(result, timeoutSec, outputText);
		return resultBuilder.done();
	}

	#buildBackgroundStartResult(
		jobId: string,
		label: string,
		previewText: string,
		timeoutSec: number,
		options: { requestedTimeoutSec?: number; notices?: string[] } = {},
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
		lines.push(`Use \`job\` (with \`poll\` or \`cancel\`) or \`read jobs://${jobId}\` if needed.`);
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
		timeoutClampNotice?: string;
		headLines?: number;
		tailLines?: number;
		resolvedEnv?: Record<string, string>;
		onUpdate?: AgentToolUpdateCallback<BashToolDetails>;
		startBackgrounded: boolean;
	}): ManagedBashJobHandle {
		const manager = this.session.asyncJobManager;
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
					const finalResult = this.#buildCompletedResult(
						result,
						options.timeoutSec,
						options.headLines,
						options.tailLines,
						{
							requestedTimeoutSec: options.requestedTimeoutSec,
							notices: [options.timeoutClampNotice].filter((notice): notice is string => Boolean(notice)),
						},
					);
					const finalText = this.#extractTextResult(finalResult);
					latestText = finalText;
					completion.resolve({ kind: "completed", result: finalResult });
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
			head,
			tail,
			async: asyncRequested = false,
			pty = false,
		}: BashToolInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<BashToolDetails>,
		ctx?: AgentToolContext,
	): Promise<AgentToolResult<BashToolDetails>> {
		let command = rawCommand;
		const env = normalizeBashEnv(rawEnv);

		// Extract leading `cd <path> && ...` into cwd when the model ignores the cwd parameter.
		if (!cwd) {
			const cdMatch = command.match(/^cd\s+((?:[^&\\]|\\.)+?)\s*&&\s*/);
			if (cdMatch) {
				cwd = cdMatch[1].trim().replace(/^["']|["']$/g, "");
				command = command.slice(cdMatch[0].length);
			}
		}
		if (asyncRequested && !this.#asyncEnabled) {
			throw new ToolError("Async bash execution is disabled. Enable async.enabled to use async mode.");
		}

		// Only apply explicit head/tail params from tool input.
		const headLines = head;
		const tailLines = tail;

		// Check interception if enabled and available tools are known
		if (this.session.settings.get("bashInterceptor.enabled")) {
			const rules = this.session.settings.getBashInterceptorRules();
			const interception = checkBashInterception(command, ctx?.toolNames ?? [], rules);
			if (interception.block) {
				throw new ToolError(interception.message ?? "Command blocked");
			}
		}

		const internalUrlOptions: InternalUrlExpansionOptions = {
			skills: this.session.skills ?? [],
			internalRouter: this.session.internalRouter,
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
		const timeoutClampNotice = formatTimeoutClampNotice(requestedTimeoutSec, timeoutSec);

		if (asyncRequested) {
			if (!this.session.asyncJobManager) {
				throw new ToolError("Async job manager unavailable for this session.");
			}
			const job = this.#startManagedBashJob({
				command,
				commandCwd,
				timeoutMs,
				timeoutSec,
				requestedTimeoutSec,
				timeoutClampNotice,
				headLines,
				tailLines,
				resolvedEnv,
				onUpdate,
				startBackgrounded: true,
			});
			return this.#buildBackgroundStartResult(job.jobId, job.label, "", timeoutSec, {
				requestedTimeoutSec,
				notices: [timeoutClampNotice].filter((notice): notice is string => Boolean(notice)),
			});
		}

		if (this.#autoBackgroundEnabled && !pty && this.session.asyncJobManager) {
			const autoBackgroundWaitMs = this.#resolveAutoBackgroundWaitMs(timeoutMs);
			const startBackgrounded = autoBackgroundWaitMs === 0;
			const job = this.#startManagedBashJob({
				command,
				commandCwd,
				timeoutMs,
				timeoutSec,
				requestedTimeoutSec,
				timeoutClampNotice,
				headLines,
				tailLines,
				resolvedEnv,
				onUpdate,
				startBackgrounded,
			});
			if (startBackgrounded) {
				return this.#buildBackgroundStartResult(job.jobId, job.label, "", timeoutSec, {
					requestedTimeoutSec,
					notices: [timeoutClampNotice].filter((notice): notice is string => Boolean(notice)),
				});
			}
			const waitResult = await this.#waitForManagedBashJob(job, autoBackgroundWaitMs, signal);
			if (waitResult.kind === "completed") {
				this.session.asyncJobManager.acknowledgeDeliveries([job.jobId]);
				return waitResult.result;
			}
			if (waitResult.kind === "failed") {
				this.session.asyncJobManager.acknowledgeDeliveries([job.jobId]);
				throw waitResult.error;
			}
			if (waitResult.kind === "aborted") {
				this.session.asyncJobManager.cancel(job.jobId);
				this.session.asyncJobManager.acknowledgeDeliveries([job.jobId]);
				throw new ToolAbortError(job.getLatestText() || "Command aborted");
			}
			job.setBackgrounded(true);
			return this.#buildBackgroundStartResult(job.jobId, job.label, job.getLatestText(), timeoutSec, {
				requestedTimeoutSec,
				notices: [timeoutClampNotice].filter((notice): notice is string => Boolean(notice)),
			});
		}

		// Track output for streaming updates (tail only)
		const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES);

		// Allocate artifact for truncated output storage
		const { path: artifactPath, id: artifactId } = (await this.session.allocateOutputArtifact?.("bash")) ?? {};

		const usePty = pty && $env.PI_NO_PTY !== "1" && ctx?.hasUI === true && ctx.ui !== undefined;
		const result: BashResult | BashInteractiveResult = usePty
			? await runInteractiveBashPty(ctx.ui!, {
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
		if (result.cancelled) {
			if (signal?.aborted) {
				throw new ToolAbortError(normalizeResultOutput(result) || "Command aborted");
			}
			throw new ToolError(normalizeResultOutput(result) || "Command aborted");
		}
		if (isInteractiveResult(result) && result.timedOut) {
			throw new ToolError(normalizeResultOutput(result) || `Command timed out after ${timeoutSec} seconds`);
		}
		return this.#buildCompletedResult(result, timeoutSec, headLines, tailLines, {
			requestedTimeoutSec,
			notices: [timeoutClampNotice].filter((notice): notice is string => Boolean(notice)),
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

export function formatBashCommand(args: BashRenderArgs): string {
	const command = replaceTabs(args.command || "…");
	const prompt = "$";
	const cwd = getProjectDir();
	const displayWorkdir = formatToolWorkingDirectory(args.cwd, cwd);
	const renderedCommand = [formatBashEnvAssignments(getBashEnvForDisplay(args)), command].filter(Boolean).join(" ");
	return displayWorkdir ? `${prompt} cd ${displayWorkdir} && ${renderedCommand}` : `${prompt} ${renderedCommand}`;
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
			const cmdText = formatBashCommand(renderArgs);
			const title = config.resolveTitle(args, options);
			const text = renderStatusLine({ icon: "pending", title, description: cmdText }, uiTheme);
			return new Text(text, 0, 0);
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
			const cmdText = args ? formatBashCommand(renderArgs) : undefined;
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

					// Get output from context (preferred) or fall back to result content
					const output = renderContext?.output ?? result.content?.find(c => c.type === "text")?.text ?? "";
					const displayOutput = output.trimEnd();
					const showingFullOutput = expanded && renderContext?.isFullOutput === true;

					// Build truncation warning
					const timeoutSeconds = details?.timeoutSeconds ?? renderContext?.timeout;
					const requestedTimeoutSeconds = details?.requestedTimeoutSeconds;
					const timeoutLabel =
						typeof timeoutSeconds === "number"
							? requestedTimeoutSeconds !== undefined && requestedTimeoutSeconds !== timeoutSeconds
								? `Timeout: ${timeoutSeconds}s (requested ${requestedTimeoutSeconds}s clamped)`
								: `Timeout: ${timeoutSeconds}s`
							: undefined;
					const timeoutLine =
						timeoutLabel !== undefined
							? uiTheme.fg("dim", `${uiTheme.format.bracketLeft}${timeoutLabel}${uiTheme.format.bracketRight}`)
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
								{ lines: cmdText ? [uiTheme.fg("dim", cmdText)] : [] },
								{ label: uiTheme.fg("toolTitle", "Output"), lines: outputLines },
							],
							width,
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

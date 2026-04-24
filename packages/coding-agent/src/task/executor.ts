/**
 * In-process execution for subagents.
 *
 * Runs each subagent on the main thread and forwards AgentEvents for progress tracking.
 */
import path from "node:path";
import type { AgentEvent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { logger, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import type { TSchema } from "@sinclair/typebox";
import Ajv, { type ValidateFunction } from "ajv";
import { ModelRegistry } from "../config/model-registry";
import { resolveModelOverride } from "../config/model-resolver";
import type { PromptTemplate } from "../config/prompt-templates";
import { Settings } from "../config/settings";
import { SETTINGS_SCHEMA, type SettingPath } from "../config/settings-schema";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { runExtensionCompact, runExtensionSetModel } from "../extensibility/extensions/compact-handler";
import type { Skill } from "../extensibility/skills";
import { callTool } from "../mcp/client";
import type { MCPManager } from "../mcp/manager";
import submitReminderTemplate from "../prompts/system/subagent-submit-reminder.md" with { type: "text" };
import subagentSystemPromptTemplate from "../prompts/system/subagent-system-prompt.md" with { type: "text" };
import { createAgentSession, discoverAuthStorage } from "../sdk";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import type { AuthStorage } from "../session/auth-storage";
import { SessionManager } from "../session/session-manager";
import { type ContextFileEntry, truncateTail } from "../tools";
import { jtdToJsonSchema, normalizeSchema } from "../tools/jtd-to-json-schema";
import { ToolAbortError } from "../tools/tool-errors";
import type { EventBus } from "../utils/event-bus";
import { buildNamedToolChoice } from "../utils/tool-choice";
import { subprocessToolRegistry } from "./subprocess-tool-registry";
import {
	type AgentDefinition,
	type AgentProgress,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	type ReviewFinding,
	type SingleResult,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "./types";

const MCP_CALL_TIMEOUT_MS = 60_000;
const ajv = new Ajv({ allErrors: true, strict: false, logger: false });

/** Agent event types to forward for progress tracking. */
const agentEventTypes = new Set<AgentEvent["type"]>([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

const isAgentEvent = (event: AgentSessionEvent): event is AgentEvent =>
	agentEventTypes.has(event.type as AgentEvent["type"]);

function normalizeModelPatterns(value: string | string[] | undefined): string[] {
	if (!value) return [];
	if (Array.isArray(value)) {
		return value.map(entry => entry.trim()).filter(Boolean);
	}
	return value
		.split(",")
		.map(entry => entry.trim())
		.filter(Boolean);
}

function withAbortTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
	if (signal?.aborted) {
		return Promise.reject(new ToolAbortError());
	}

	const { promise: wrappedPromise, resolve, reject } = Promise.withResolvers<T>();
	let settled = false;
	const timeoutId = setTimeout(() => {
		if (settled) return;
		settled = true;
		reject(new Error(`MCP tool call timed out after ${timeoutMs}ms`));
	}, timeoutMs);

	const onAbort = () => {
		if (settled) return;
		settled = true;
		clearTimeout(timeoutId);
		reject(new ToolAbortError());
	};

	if (signal) {
		signal.addEventListener("abort", onAbort, { once: true });
	}

	promise.then(resolve, reject).finally(() => {
		if (signal) signal.removeEventListener("abort", onAbort);
		clearTimeout(timeoutId);
	});

	return wrappedPromise;
}

function getReportFindingKey(value: unknown): string | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const title = typeof record.title === "string" ? record.title : null;
	const filePath = typeof record.file_path === "string" ? record.file_path : null;
	const lineStart = typeof record.line_start === "number" ? record.line_start : null;
	const lineEnd = typeof record.line_end === "number" ? record.line_end : null;
	const priority = typeof record.priority === "string" ? record.priority : null;
	if (!title || !filePath || lineStart === null || lineEnd === null) {
		return null;
	}
	return `${filePath}:${lineStart}:${lineEnd}:${priority ?? ""}:${title}`;
}

/** Options for subagent execution */
export interface ExecutorOptions {
	cwd: string;
	worktree?: string;
	agent: AgentDefinition;
	task: string;
	assignment?: string;
	description?: string;
	index: number;
	id: string;
	modelOverride?: string | string[];
	thinkingLevel?: ThinkingLevel;
	outputSchema?: unknown;
	/** Parent task recursion depth (0 = top-level, 1 = first child, etc.) */
	taskDepth?: number;
	enableLsp?: boolean;
	signal?: AbortSignal;
	onProgress?: (progress: AgentProgress) => void;
	sessionFile?: string | null;
	persistArtifacts?: boolean;
	artifactsDir?: string;
	/** Path to parent conversation context file */
	contextFile?: string;
	eventBus?: EventBus;
	contextFiles?: ContextFileEntry[];
	skills?: Skill[];
	promptTemplates?: PromptTemplate[];
	mcpManager?: MCPManager;
	authStorage?: AuthStorage;
	modelRegistry?: ModelRegistry;
	settings?: Settings;
}

function parseStringifiedJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (!trimmed) return value;
	if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return value;
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

function buildOutputValidator(schema: unknown): { validate?: ValidateFunction; error?: string } {
	const { normalized, error } = normalizeSchema(schema);
	if (error) return { error };
	if (normalized === undefined) return {};
	const jsonSchema = jtdToJsonSchema(normalized);
	try {
		return { validate: ajv.compile(jsonSchema as any) };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

function tryParseJsonOutput(text: string): unknown | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

function extractCompletionData(parsed: unknown): unknown {
	if (!parsed || typeof parsed !== "object") return parsed;
	const record = parsed as Record<string, unknown>;
	if ("data" in record) {
		return record.data;
	}
	return parsed;
}

function normalizeCompleteData(data: unknown, reportFindings?: ReviewFinding[]): unknown {
	let normalized = parseStringifiedJson(data ?? null);
	if (
		Array.isArray(reportFindings) &&
		reportFindings.length > 0 &&
		normalized &&
		typeof normalized === "object" &&
		!Array.isArray(normalized)
	) {
		const record = normalized as Record<string, unknown>;
		if (!("findings" in record)) {
			normalized = { ...record, findings: reportFindings };
		}
	}
	return normalized;
}

function resolveFallbackCompletion(rawOutput: string, outputSchema: unknown): { data: unknown } | null {
	const parsed = tryParseJsonOutput(rawOutput);
	if (parsed === undefined) return null;
	const candidate = parseStringifiedJson(extractCompletionData(parsed));
	if (candidate === undefined) return null;
	const { validate, error } = buildOutputValidator(outputSchema);
	if (error) return null;
	if (validate && !validate(candidate)) return null;
	return { data: candidate };
}

export interface SubmitResultItem {
	data?: unknown;
	status?: "success" | "aborted";
	error?: string;
}

interface FinalizeSubprocessOutputArgs {
	rawOutput: string;
	exitCode: number;
	stderr: string;
	doneAborted: boolean;
	signalAborted: boolean;
	submitResultItems?: SubmitResultItem[];
	reportFindings?: ReviewFinding[];
	outputSchema: unknown;
}

interface FinalizeSubprocessOutputResult {
	rawOutput: string;
	exitCode: number;
	stderr: string;
	abortedViaSubmitResult: boolean;
	hasSubmitResult: boolean;
}

export const SUBAGENT_WARNING_NULL_SUBMIT_RESULT = "SYSTEM WARNING: Subagent called submit_result with null data.";
export const SUBAGENT_WARNING_MISSING_SUBMIT_RESULT =
	"SYSTEM WARNING: Subagent exited without calling submit_result tool after 3 reminders.";

export function finalizeSubprocessOutput(args: FinalizeSubprocessOutputArgs): FinalizeSubprocessOutputResult {
	let { rawOutput, exitCode, stderr } = args;
	const { submitResultItems, reportFindings, doneAborted, signalAborted, outputSchema } = args;
	let abortedViaSubmitResult = false;
	const hasSubmitResult = Array.isArray(submitResultItems) && submitResultItems.length > 0;

	if (hasSubmitResult) {
		const lastSubmitResult = submitResultItems[submitResultItems.length - 1];
		if (lastSubmitResult?.status === "aborted") {
			abortedViaSubmitResult = true;
			exitCode = 0;
			stderr = lastSubmitResult.error || "Subagent aborted task";
			try {
				rawOutput = JSON.stringify({ aborted: true, error: lastSubmitResult.error }, null, 2);
			} catch {
				rawOutput = `{"aborted":true,"error":"${lastSubmitResult.error || "Unknown error"}"}`;
			}
		} else {
			const submitData = lastSubmitResult?.data;
			if (submitData === null || submitData === undefined) {
				rawOutput = rawOutput
					? `${SUBAGENT_WARNING_NULL_SUBMIT_RESULT}\n\n${rawOutput}`
					: SUBAGENT_WARNING_NULL_SUBMIT_RESULT;
			} else {
				const completeData = normalizeCompleteData(submitData, reportFindings);
				try {
					rawOutput = JSON.stringify(completeData, null, 2) ?? "null";
				} catch (err) {
					const errorMessage = err instanceof Error ? err.message : String(err);
					rawOutput = `{"error":"Failed to serialize submit_result data: ${errorMessage}"}`;
				}
				exitCode = 0;
				stderr = "";
			}
		}
	} else {
		const allowFallback = exitCode === 0 && !doneAborted && !signalAborted;
		const { normalized: normalizedSchema, error: schemaError } = normalizeSchema(outputSchema);
		const hasOutputSchema = normalizedSchema !== undefined && !schemaError;
		const fallback = allowFallback ? resolveFallbackCompletion(rawOutput, outputSchema) : null;
		if (fallback) {
			const completeData = normalizeCompleteData(fallback.data, reportFindings);
			try {
				rawOutput = JSON.stringify(completeData, null, 2) ?? "null";
			} catch (err) {
				const errorMessage = err instanceof Error ? err.message : String(err);
				rawOutput = `{"error":"Failed to serialize fallback completion: ${errorMessage}"}`;
			}
			exitCode = 0;
			stderr = "";
		} else if (!hasOutputSchema && allowFallback && rawOutput.trim().length > 0) {
			exitCode = 0;
			stderr = "";
		} else if (exitCode === 0) {
			const hasRawOutput = rawOutput.trim().length > 0;
			rawOutput = rawOutput
				? `${SUBAGENT_WARNING_MISSING_SUBMIT_RESULT}\n\n${rawOutput}`
				: SUBAGENT_WARNING_MISSING_SUBMIT_RESULT;
			if (hasOutputSchema || !hasRawOutput) {
				exitCode = 1;
				stderr = SUBAGENT_WARNING_MISSING_SUBMIT_RESULT;
			}
		}
	}

	return { rawOutput, exitCode, stderr, abortedViaSubmitResult, hasSubmitResult };
}

/**
 * Extract a short preview from tool args for display.
 */
function extractToolArgsPreview(args: Record<string, unknown>): string {
	// Priority order for preview
	const previewKeys = ["command", "file_path", "path", "pattern", "query", "url", "task", "prompt"];

	for (const key of previewKeys) {
		if (args[key] && typeof args[key] === "string") {
			const value = args[key] as string;
			return value.length > 60 ? `${value.slice(0, 59)}…` : value;
		}
	}

	return "";
}

function getNumberField(record: Record<string, unknown>, key: string): number | undefined {
	if (!Object.hasOwn(record, key)) return undefined;
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function firstNumberField(record: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = getNumberField(record, key);
		if (value !== undefined) return value;
	}
	return undefined;
}

/**
 * Normalize usage objects from different event formats.
 */
function getUsageTokens(usage: unknown): number {
	if (!usage || typeof usage !== "object") return 0;
	const record = usage as Record<string, unknown>;

	const totalTokens = firstNumberField(record, ["totalTokens", "total_tokens"]);
	if (totalTokens !== undefined && totalTokens > 0) return totalTokens;

	const input = firstNumberField(record, ["input", "input_tokens", "inputTokens"]) ?? 0;
	const output = firstNumberField(record, ["output", "output_tokens", "outputTokens"]) ?? 0;
	const cacheRead = firstNumberField(record, ["cacheRead", "cache_read", "cacheReadTokens"]) ?? 0;
	const cacheWrite = firstNumberField(record, ["cacheWrite", "cache_write", "cacheWriteTokens"]) ?? 0;

	return input + output + cacheRead + cacheWrite;
}

/**
 * Create proxy tools that reuse the parent's MCP connections.
 */
function createMCPProxyTools(mcpManager: MCPManager): CustomTool<TSchema>[] {
	return mcpManager.getTools().map(tool => {
		const mcpTool = tool as { mcpToolName?: string; mcpServerName?: string };
		return {
			name: tool.name,
			label: tool.label ?? tool.name,
			description: tool.description ?? "",
			parameters: tool.parameters as TSchema,
			execute: async (_toolCallId, params, _onUpdate, _ctx, signal) => {
				if (signal?.aborted) {
					throw new ToolAbortError();
				}
				const serverName = mcpTool.mcpServerName ?? "";
				const mcpToolName = mcpTool.mcpToolName ?? "";
				try {
					const result = await withAbortTimeout(
						(async () => {
							const connection = await mcpManager.waitForConnection(serverName);
							return callTool(connection, mcpToolName, params as Record<string, unknown>, { signal });
						})(),
						MCP_CALL_TIMEOUT_MS,
						signal,
					);
					return {
						content: (result.content ?? []).map(item =>
							item.type === "text"
								? { type: "text" as const, text: item.text ?? "" }
								: { type: "text" as const, text: JSON.stringify(item) },
						),
						details: { serverName, mcpToolName, isError: result.isError },
					};
				} catch (error) {
					if (error instanceof ToolAbortError) {
						throw error;
					}
					return {
						content: [
							{
								type: "text" as const,
								text: `MCP error: ${error instanceof Error ? error.message : String(error)}`,
							},
						],
						details: { serverName, mcpToolName, isError: true },
					};
				}
			},
		};
	});
}

function createSubagentSettings(baseSettings: Settings): Settings {
	const snapshot: Partial<Record<SettingPath, unknown>> = {};
	for (const key of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
		snapshot[key] = baseSettings.get(key);
	}
	return Settings.isolated({
		...snapshot,
		"async.enabled": false,
		"bash.autoBackground.enabled": false,
	});
}

/**
 * Run a single agent in-process.
 */
export async function runSubprocess(options: ExecutorOptions): Promise<SingleResult> {
	const {
		cwd,
		agent,
		task,
		assignment,
		index,
		id,
		worktree,
		modelOverride,
		thinkingLevel,
		outputSchema,
		enableLsp,
		signal,
		onProgress,
	} = options;
	const startTime = Date.now();

	// Initialize progress
	const progress: AgentProgress = {
		index,
		id,
		agent: agent.name,
		agentSource: agent.source,
		status: "running",
		task,
		assignment,
		description: options.description,
		lastIntent: undefined,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
		modelOverride,
	};

	// Check if already aborted
	if (signal?.aborted) {
		return {
			index,
			id,
			agent: agent.name,
			agentSource: agent.source,
			task,
			assignment,
			description: options.description,
			exitCode: 1,
			output: "",
			stderr: "Cancelled before start",
			truncated: false,
			durationMs: 0,
			tokens: 0,
			modelOverride,
			error: "Cancelled before start",
			aborted: true,
			abortReason: "Cancelled before start",
		};
	}

	// Set up artifact paths and write input file upfront if artifacts dir provided
	let subtaskSessionFile: string | undefined;
	if (options.artifactsDir) {
		subtaskSessionFile = path.join(options.artifactsDir, `${id}.jsonl`);
	}

	const settings = options.settings ?? Settings.isolated();
	const subagentSettings = createSubagentSettings(settings);
	const maxRecursionDepth = settings.get("task.maxRecursionDepth") ?? 2;
	const parentDepth = options.taskDepth ?? 0;
	const childDepth = parentDepth + 1;
	const atMaxDepth = maxRecursionDepth >= 0 && childDepth >= maxRecursionDepth;

	// Add tools if specified
	let toolNames: string[] | undefined;
	if (agent.tools && agent.tools.length > 0) {
		toolNames = agent.tools;
		// Auto-include task tool if spawns defined but task not in tools
		if (agent.spawns !== undefined && !toolNames.includes("task") && !atMaxDepth) {
			toolNames = [...toolNames, "task"];
		}
	}

	if (atMaxDepth && toolNames?.includes("task")) {
		toolNames = toolNames.filter(name => name !== "task");
	}
	const pythonToolMode = settings.get("python.toolMode") ?? "both";
	if (toolNames?.includes("exec")) {
		const expanded = toolNames.filter(name => name !== "exec");
		if (pythonToolMode === "bash-only") {
			expanded.push("bash");
		} else if (pythonToolMode === "ipy-only") {
			expanded.push("python");
		} else {
			expanded.push("python", "bash");
		}
		toolNames = Array.from(new Set(expanded));
	}

	const modelPatterns = normalizeModelPatterns(modelOverride ?? agent.model);
	const sessionFile = subtaskSessionFile ?? null;
	const spawnsEnv = atMaxDepth
		? ""
		: agent.spawns === undefined
			? ""
			: agent.spawns === "*"
				? "*"
				: agent.spawns.join(",");

	const lspEnabled = enableLsp ?? true;
	const skipPythonPreflight = Array.isArray(toolNames) && !toolNames.includes("python");

	const outputChunks: string[] = [];
	const finalOutputChunks: string[] = [];
	const RECENT_OUTPUT_TAIL_BYTES = 8 * 1024;
	let recentOutputTail = "";
	let stderr = "";
	let resolved = false;
	type AbortReason = "signal" | "terminate";
	let abortSent = false;
	let abortReason: AbortReason | undefined;
	const listenerController = new AbortController();
	const listenerSignal = listenerController.signal;
	const abortController = new AbortController();
	const abortSignal = abortController.signal;
	let activeSession: AgentSession | null = null;
	let unsubscribe: (() => void) | null = null;
	let submitResultCalled = false;

	// Accumulate usage incrementally from message_end events (no memory for streaming events)
	const accumulatedUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	let hasUsage = false;

	const requestAbort = (reason: AbortReason) => {
		if (abortSent) {
			if (reason === "signal" && abortReason !== "signal") {
				abortReason = "signal";
			}
			return;
		}
		if (resolved) return;
		abortSent = true;
		abortReason = reason;
		abortController.abort();
		if (activeSession) {
			void activeSession.abort();
		}
	};

	// Handle abort signal
	const onAbort = () => {
		if (!resolved) requestAbort("signal");
	};
	if (signal) {
		signal.addEventListener("abort", onAbort, { once: true, signal: listenerSignal });
	}

	const resolveSignalAbortReason = (): string => {
		const reason = signal?.reason;
		if (reason instanceof Error) {
			const message = reason.message.trim();
			if (message.length > 0) return message;
		} else if (typeof reason === "string") {
			const message = reason.trim();
			if (message.length > 0) return message;
		}
		return "Cancelled by caller";
	};
	const PROGRESS_COALESCE_MS = 150;
	let lastProgressEmitMs = 0;
	let progressTimeoutId: NodeJS.Timeout | null = null;

	const emitProgressNow = () => {
		progress.durationMs = Date.now() - startTime;
		onProgress?.({ ...progress });
		if (options.eventBus) {
			options.eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
				index,
				agent: agent.name,
				agentSource: agent.source,
				task,
				assignment,
				progress: { ...progress },
				sessionFile: subtaskSessionFile,
			});
		}
		lastProgressEmitMs = Date.now();
	};

	const scheduleProgress = (flush = false) => {
		if (flush) {
			if (progressTimeoutId) {
				clearTimeout(progressTimeoutId);
				progressTimeoutId = null;
			}
			emitProgressNow();
			return;
		}
		const now = Date.now();
		const elapsed = now - lastProgressEmitMs;
		if (lastProgressEmitMs === 0 || elapsed >= PROGRESS_COALESCE_MS) {
			if (progressTimeoutId) {
				clearTimeout(progressTimeoutId);
				progressTimeoutId = null;
			}
			emitProgressNow();
			return;
		}
		if (progressTimeoutId) return;
		progressTimeoutId = setTimeout(() => {
			progressTimeoutId = null;
			emitProgressNow();
		}, PROGRESS_COALESCE_MS - elapsed);
	};

	const getMessageContent = (message: unknown): unknown => {
		if (message && typeof message === "object" && "content" in message) {
			return (message as { content?: unknown }).content;
		}
		return undefined;
	};

	const getMessageUsage = (message: unknown): unknown => {
		if (message && typeof message === "object" && "usage" in message) {
			return (message as { usage?: unknown }).usage;
		}
		return undefined;
	};

	const updateRecentOutputLines = () => {
		const lines = recentOutputTail.split("\n").filter(line => line.trim());
		progress.recentOutput = lines.slice(-8).reverse();
	};

	const appendRecentOutputTail = (text: string) => {
		if (!text) return;
		recentOutputTail += text;
		if (recentOutputTail.length > RECENT_OUTPUT_TAIL_BYTES) {
			recentOutputTail = recentOutputTail.slice(-RECENT_OUTPUT_TAIL_BYTES);
		}
		updateRecentOutputLines();
	};

	const replaceRecentOutputFromContent = (content: unknown[]) => {
		recentOutputTail = "";
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const record = block as { type?: unknown; text?: unknown };
			if (record.type !== "text" || typeof record.text !== "string") continue;
			if (!record.text) continue;
			recentOutputTail += record.text;
			if (recentOutputTail.length > RECENT_OUTPUT_TAIL_BYTES) {
				recentOutputTail = recentOutputTail.slice(-RECENT_OUTPUT_TAIL_BYTES);
			}
		}
		updateRecentOutputLines();
	};

	const resetRecentOutput = () => {
		recentOutputTail = "";
		progress.recentOutput = [];
	};

	const processEvent = (event: AgentEvent) => {
		if (resolved) return;

		if (options.eventBus) {
			options.eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
				index,
				agent: agent.name,
				agentSource: agent.source,
				task,
				assignment,
				event,
			});
		}

		const now = Date.now();
		let flushProgress = false;

		switch (event.type) {
			case "message_start":
				if (event.message?.role === "assistant") {
					resetRecentOutput();
				}
				break;

			case "tool_execution_start": {
				progress.toolCount++;
				progress.currentTool = event.toolName;
				progress.currentToolArgs = extractToolArgsPreview(
					(event as { toolArgs?: Record<string, unknown> }).toolArgs || event.args || {},
				);
				progress.currentToolStartMs = now;
				const intent = event.intent?.trim();
				if (intent) {
					progress.lastIntent = intent;
				}
				break;
			}

			case "tool_execution_end": {
				if (progress.currentTool) {
					progress.recentTools.unshift({
						tool: progress.currentTool,
						args: progress.currentToolArgs || "",
						endMs: now,
					});
					// Keep only last 5
					if (progress.recentTools.length > 5) {
						progress.recentTools.pop();
					}
				}
				progress.currentTool = undefined;
				progress.currentToolArgs = undefined;
				progress.currentToolStartMs = undefined;

				// Check for registered subagent tool handler
				const handler = subprocessToolRegistry.getHandler(event.toolName);
				const eventArgs = (event as { args?: Record<string, unknown> }).args ?? {};
				if (handler) {
					// Extract data using handler
					if (handler.extractData) {
						const data = handler.extractData({
							toolName: event.toolName,
							toolCallId: event.toolCallId,
							args: eventArgs,
							result: event.result,
							isError: event.isError,
						});
						if (data !== undefined) {
							progress.extractedToolData = progress.extractedToolData || {};
							const existing = progress.extractedToolData[event.toolName] || [];
							const findingKey = event.toolName === "report_finding" ? getReportFindingKey(data) : null;
							if (findingKey) {
								const existingIndex = existing.findIndex(item => getReportFindingKey(item) === findingKey);
								if (existingIndex >= 0) {
									existing[existingIndex] = data;
								} else {
									existing.push(data);
								}
							} else {
								existing.push(data);
							}
							progress.extractedToolData[event.toolName] = existing;
							if (event.toolName === "submit_result") {
								submitResultCalled = true;
							}
						}
					}

					// Check if handler wants to terminate the session
					if (
						handler.shouldTerminate?.({
							toolName: event.toolName,
							toolCallId: event.toolCallId,
							args: eventArgs,
							result: event.result,
							isError: event.isError,
						})
					) {
						requestAbort("terminate");
					}
				}
				flushProgress = true;
				break;
			}

			case "message_update": {
				if (event.message?.role !== "assistant") break;
				const assistantEvent = (
					event as AgentEvent & {
						assistantMessageEvent?: { type?: string; delta?: string };
					}
				).assistantMessageEvent;
				if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
					appendRecentOutputTail(assistantEvent.delta);
					break;
				}
				if (assistantEvent && assistantEvent.type !== "text_delta") {
					break;
				}
				const updateContent =
					getMessageContent(event.message) || (event as AgentEvent & { content?: unknown }).content;
				if (updateContent && Array.isArray(updateContent)) {
					replaceRecentOutputFromContent(updateContent);
				}
				break;
			}

			case "message_end": {
				// Extract text from assistant and toolResult messages (not user prompts)
				const role = event.message?.role;
				if (role === "assistant") {
					const messageContent =
						getMessageContent(event.message) || (event as AgentEvent & { content?: unknown }).content;
					if (messageContent && Array.isArray(messageContent)) {
						for (const block of messageContent) {
							if (block.type === "text" && block.text) {
								outputChunks.push(block.text);
							}
						}
					}
				}
				// Extract and accumulate usage (prefer message.usage, fallback to event.usage)
				const messageUsage = getMessageUsage(event.message) || (event as AgentEvent & { usage?: unknown }).usage;
				if (messageUsage && typeof messageUsage === "object") {
					// Only count assistant messages (not tool results, etc.)
					if (role === "assistant") {
						const usageRecord = messageUsage as Record<string, unknown>;
						const costRecord = (messageUsage as { cost?: Record<string, unknown> }).cost;
						hasUsage = true;
						accumulatedUsage.input += getNumberField(usageRecord, "input") ?? 0;
						accumulatedUsage.output += getNumberField(usageRecord, "output") ?? 0;
						accumulatedUsage.cacheRead += getNumberField(usageRecord, "cacheRead") ?? 0;
						accumulatedUsage.cacheWrite += getNumberField(usageRecord, "cacheWrite") ?? 0;
						accumulatedUsage.totalTokens += getNumberField(usageRecord, "totalTokens") ?? 0;
						if (costRecord) {
							accumulatedUsage.cost.input += getNumberField(costRecord, "input") ?? 0;
							accumulatedUsage.cost.output += getNumberField(costRecord, "output") ?? 0;
							accumulatedUsage.cost.cacheRead += getNumberField(costRecord, "cacheRead") ?? 0;
							accumulatedUsage.cost.cacheWrite += getNumberField(costRecord, "cacheWrite") ?? 0;
							accumulatedUsage.cost.total += getNumberField(costRecord, "total") ?? 0;
						}
					}
					// Accumulate tokens for progress display
					progress.tokens += getUsageTokens(messageUsage);
				}
				break;
			}

			case "agent_end":
				// Extract final content from assistant messages only (not user prompts)
				if (event.messages && Array.isArray(event.messages)) {
					for (const msg of event.messages) {
						if ((msg as { role?: string })?.role !== "assistant") continue;
						const messageContent = getMessageContent(msg);
						if (messageContent && Array.isArray(messageContent)) {
							for (const block of messageContent) {
								if (block.type === "text" && block.text) {
									finalOutputChunks.push(block.text);
								}
							}
						}
					}
				}
				flushProgress = true;
				break;
		}

		scheduleProgress(flushProgress);
	};

	const runSubagent = async (): Promise<{
		exitCode: number;
		error?: string;
		aborted?: boolean;
		abortReason?: string;
		durationMs: number;
	}> => {
		const sessionAbortController = new AbortController();
		let exitCode = 0;
		let error: string | undefined;
		let aborted = false;
		let abortReasonText: string | undefined;
		const checkAbort = () => {
			if (abortSignal.aborted) {
				aborted = abortReason === "signal" || abortReason === undefined;
				if (aborted) {
					abortReasonText ??= resolveSignalAbortReason();
				}
				exitCode = 1;
				throw new ToolAbortError();
			}
		};

		try {
			checkAbort();
			const authStorage = options.authStorage ?? (await discoverAuthStorage());
			checkAbort();
			const modelRegistry = options.modelRegistry ?? new ModelRegistry(authStorage);
			await modelRegistry.refresh();
			checkAbort();

			const {
				model,
				thinkingLevel: resolvedThinkingLevel,
				explicitThinkingLevel,
			} = resolveModelOverride(modelPatterns, modelRegistry, settings);
			const effectiveThinkingLevel = explicitThinkingLevel
				? resolvedThinkingLevel
				: (thinkingLevel ?? resolvedThinkingLevel);

			const sessionManager = sessionFile
				? await SessionManager.open(sessionFile)
				: SessionManager.inMemory(worktree ?? cwd);

			const mcpProxyTools = options.mcpManager ? createMCPProxyTools(options.mcpManager) : [];
			const enableMCP = !options.mcpManager;

			const { normalized: normalizedOutputSchema } = normalizeSchema(outputSchema);

			const { session } = await createAgentSession({
				cwd: worktree ?? cwd,
				authStorage,
				modelRegistry,
				settings: subagentSettings,
				model,
				thinkingLevel: effectiveThinkingLevel,
				toolNames,
				outputSchema,
				requireSubmitResultTool: true,
				contextFiles: options.contextFiles,
				skills: options.skills,
				promptTemplates: options.promptTemplates,
				systemPrompt: defaultPrompt =>
					prompt.render(subagentSystemPromptTemplate, {
						base: defaultPrompt,
						agent: agent.systemPrompt,
						worktree: worktree ?? "",
						outputSchema: normalizedOutputSchema,
						contextFile: options.contextFile,
					}),
				sessionManager,
				hasUI: false,
				spawns: spawnsEnv,
				taskDepth: childDepth,
				parentTaskPrefix: id,
				enableLsp: lspEnabled,
				skipPythonPreflight,
				enableMCP,
				customTools: mcpProxyTools.length > 0 ? mcpProxyTools : undefined,
			});

			activeSession = session;

			// Emit lifecycle start event
			if (options.eventBus) {
				options.eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
					id,
					agent: agent.name,
					agentSource: agent.source,
					description: options.description,
					status: "started",
					sessionFile: subtaskSessionFile,
					index,
				});
			}

			const subagentToolNames = session.getActiveToolNames();
			const parentOwnedToolNames = new Set(["todo_write"]);
			const filteredSubagentTools = subagentToolNames.filter(name => !parentOwnedToolNames.has(name));
			if (filteredSubagentTools.length !== subagentToolNames.length) {
				await session.setActiveToolsByName(filteredSubagentTools);
			}

			session.sessionManager.appendSessionInit({
				systemPrompt: session.agent.state.systemPrompt,
				task,
				tools: session.getActiveToolNames(),
				outputSchema,
			});

			abortSignal.addEventListener(
				"abort",
				() => {
					void session.abort();
				},
				{ once: true, signal: sessionAbortController.signal },
			);

			const extensionRunner = session.extensionRunner;
			if (extensionRunner) {
				extensionRunner.initialize(
					{
						sendMessage: (message, options) => {
							session.sendCustomMessage(message, options).catch(e => {
								logger.error("Extension sendMessage failed", {
									error: e instanceof Error ? e.message : String(e),
								});
							});
						},
						sendUserMessage: (content, options) => {
							session.sendUserMessage(content, options).catch(e => {
								logger.error("Extension sendUserMessage failed", {
									error: e instanceof Error ? e.message : String(e),
								});
							});
						},
						appendEntry: (customType, data) => {
							session.sessionManager.appendCustomEntry(customType, data);
						},
						setLabel: (targetId, label) => {
							session.sessionManager.appendLabelChange(targetId, label);
						},
						getActiveTools: () => session.getActiveToolNames(),
						getAllTools: () => session.getAllToolNames(),
						setActiveTools: (toolNames: string[]) =>
							session.setActiveToolsByName(toolNames.filter(name => !parentOwnedToolNames.has(name))),
						getCommands: () => [],
						setModel: model => runExtensionSetModel(session, model),
						getThinkingLevel: () => session.thinkingLevel,
						setThinkingLevel: level => session.setThinkingLevel(level),
						getSessionName: () => session.sessionManager.getSessionName(),
						setSessionName: async name => {
							await session.sessionManager.setSessionName(name, "user");
						},
					},
					{
						getModel: () => session.model,
						isIdle: () => !session.isStreaming,
						abort: () => session.abort(),
						hasPendingMessages: () => session.queuedMessageCount > 0,
						shutdown: () => {},
						getContextUsage: () => session.getContextUsage(),
						getSystemPrompt: () => session.systemPrompt,
						compact: instructionsOrOptions => runExtensionCompact(session, instructionsOrOptions),
					},
				);
				extensionRunner.onError(err => {
					logger.error("Extension error", { path: err.extensionPath, error: err.error });
				});
				await extensionRunner.emit({ type: "session_start" });
			}

			const MAX_SUBMIT_RESULT_RETRIES = 3;
			unsubscribe = session.subscribe(event => {
				if (isAgentEvent(event)) {
					try {
						processEvent(event);
					} catch (err) {
						logger.error("Subagent event processing failed", {
							error: err instanceof Error ? err.message : String(err),
						});
						requestAbort("terminate");
					}
				}
			});

			await session.prompt(task, { attribution: "agent" });
			await session.waitForIdle();

			const reminderToolChoice = buildNamedToolChoice("submit_result", session.model);

			let retryCount = 0;
			while (!submitResultCalled && retryCount < MAX_SUBMIT_RESULT_RETRIES && !abortSignal.aborted) {
				try {
					retryCount++;
					const reminder = prompt.render(submitReminderTemplate, {
						retryCount,
						maxRetries: MAX_SUBMIT_RESULT_RETRIES,
					});

					await session.prompt(reminder, {
						attribution: "agent",
						...(reminderToolChoice ? { toolChoice: reminderToolChoice } : {}),
					});
					await session.waitForIdle();
				} catch (err) {
					logger.error("Subagent prompt failed", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}

			await session.waitForIdle();
			if (!submitResultCalled && !abortSignal.aborted) {
				exitCode = 0;
			}

			const lastAssistant = session.getLastAssistantMessage();
			if (lastAssistant) {
				if (lastAssistant.stopReason === "aborted") {
					aborted = abortReason === "signal" || abortReason === undefined;
					if (aborted) {
						abortReasonText ??= resolveSignalAbortReason();
					}
					exitCode = 1;
				} else if (lastAssistant.stopReason === "error") {
					exitCode = 1;
					error ??= lastAssistant.errorMessage || "Subagent failed";
				}
			}
		} catch (err) {
			exitCode = 1;
			if (!abortSignal.aborted) {
				error = err instanceof Error ? err.stack || err.message : String(err);
			}
		} finally {
			if (abortSignal.aborted) {
				aborted = abortReason === "signal" || abortReason === undefined;
				if (aborted) {
					abortReasonText ??= resolveSignalAbortReason();
				}
				if (exitCode === 0) exitCode = 1;
			}
			sessionAbortController.abort();
			if (unsubscribe) {
				try {
					unsubscribe();
				} catch {
					// Ignore unsubscribe errors
				}
				unsubscribe = null;
			}
			if (activeSession) {
				const session = activeSession;
				activeSession = null;
				try {
					await untilAborted(AbortSignal.timeout(5000), () => session.dispose());
				} catch {
					// Ignore cleanup errors
				}
			}
		}

		return {
			exitCode,
			error,
			aborted,
			abortReason: aborted ? abortReasonText : undefined,
			durationMs: Date.now() - startTime,
		};
	};

	const done = await runSubagent();
	resolved = true;
	listenerController.abort();

	if (progressTimeoutId) {
		clearTimeout(progressTimeoutId);
		progressTimeoutId = null;
	}

	let exitCode = done.exitCode;
	if (done.error) {
		stderr = done.error;
	}

	// Use final output if available, otherwise accumulated output
	let rawOutput = finalOutputChunks.length > 0 ? finalOutputChunks.join("") : outputChunks.join("");
	const submitResultItems = progress.extractedToolData?.submit_result as SubmitResultItem[] | undefined;
	const reportFindings = progress.extractedToolData?.report_finding as ReviewFinding[] | undefined;
	const finalized = finalizeSubprocessOutput({
		rawOutput,
		exitCode,
		stderr,
		doneAborted: Boolean(done.aborted),
		signalAborted: Boolean(signal?.aborted),
		submitResultItems,
		reportFindings,
		outputSchema,
	});
	rawOutput = finalized.rawOutput;
	exitCode = finalized.exitCode;
	stderr = finalized.stderr;
	const lastSubmitResult = submitResultItems?.[submitResultItems.length - 1];
	const submitResultAbortReason =
		lastSubmitResult?.status === "aborted" ? lastSubmitResult.error || "Subagent aborted task" : undefined;
	const { abortedViaSubmitResult, hasSubmitResult } = finalized;
	const { content: truncatedOutput, truncated } = truncateTail(rawOutput, {
		maxBytes: MAX_OUTPUT_BYTES,
		maxLines: MAX_OUTPUT_LINES,
	});

	// Write output artifact (input and jsonl already written in real-time)
	// Compute output metadata for agent:// URL integration
	let outputMeta: { lineCount: number; charCount: number } | undefined;
	let outputPath: string | undefined;
	if (options.artifactsDir) {
		outputPath = path.join(options.artifactsDir, `${id}.md`);
		try {
			await Bun.write(outputPath, rawOutput);
			outputMeta = {
				lineCount: rawOutput.split("\n").length,
				charCount: rawOutput.length,
			};
		} catch {
			// Non-fatal
		}
	}

	// Update final progress
	const wasAborted = abortedViaSubmitResult || (!hasSubmitResult && (done.aborted || signal?.aborted || false));
	const finalAbortReason = wasAborted
		? abortedViaSubmitResult
			? submitResultAbortReason
			: (done.abortReason ?? (signal?.aborted ? resolveSignalAbortReason() : "Subagent aborted task"))
		: undefined;
	progress.status = wasAborted ? "aborted" : exitCode === 0 ? "completed" : "failed";
	scheduleProgress(true);

	// Emit lifecycle end event after finalization so submit_result status is reflected
	if (options.eventBus) {
		options.eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id,
			agent: agent.name,
			agentSource: agent.source,
			description: options.description,
			status: progress.status as "completed" | "failed" | "aborted",
			sessionFile: subtaskSessionFile,
			index,
		});
	}

	return {
		index,
		id,
		agent: agent.name,
		agentSource: agent.source,
		task,
		assignment,
		description: options.description,
		lastIntent: progress.lastIntent,
		exitCode,
		output: truncatedOutput,
		stderr,
		truncated: Boolean(truncated),
		durationMs: Date.now() - startTime,
		tokens: progress.tokens,
		modelOverride,
		error: exitCode !== 0 && stderr ? stderr : undefined,
		aborted: wasAborted,
		abortReason: finalAbortReason,
		usage: hasUsage ? accumulatedUsage : undefined,
		outputPath,
		extractedToolData: progress.extractedToolData,
		outputMeta,
	};
}

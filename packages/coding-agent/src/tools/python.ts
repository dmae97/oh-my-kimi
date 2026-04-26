import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { Markdown, Text } from "@oh-my-pi/pi-tui";
import { getProjectDir, prompt } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { executePython, getPreludeDocs, type PythonExecutorOptions, warmPythonEnvironment } from "../ipy/executor";
import type { PreludeHelper, PythonStatusEvent } from "../ipy/kernel";
import { truncateToVisualLines } from "../modes/components/visual-truncate";
import { getMarkdownTheme, type Theme } from "../modes/theme/theme";
import pythonDescription from "../prompts/tools/python.md" with { type: "text" };
import { DEFAULT_MAX_BYTES, OutputSink, type OutputSummary, TailBuffer } from "../session/streaming-output";
import { getTreeBranch, getTreeContinuePrefix, renderCodeCell } from "../tui";
import type { ToolSession } from ".";
import { formatStyledTruncationWarning, type OutputMeta } from "./output-meta";
import { formatTitle, replaceTabs, shortenPath, truncateToWidth, wrapBrackets } from "./render-utils";
import { ToolAbortError, ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

export const PYTHON_DEFAULT_PREVIEW_LINES = 10;

type PreludeCategory = {
	name: string;
	functions: PreludeHelper[];
};

function groupPreludeHelpers(helpers: PreludeHelper[]): PreludeCategory[] {
	const categories: PreludeCategory[] = [];
	const byName = new Map<string, PreludeHelper[]>();
	for (const helper of helpers) {
		let bucket = byName.get(helper.category);
		if (!bucket) {
			bucket = [];
			byName.set(helper.category, bucket);
			categories.push({ name: helper.category, functions: bucket });
		}
		bucket.push(helper);
	}
	return categories;
}

export const pythonSchema = Type.Object({
	cells: Type.Array(
		Type.Object({
			code: Type.String({ description: "python code", examples: ["print('hello')", "import json"] }),
			title: Type.String({ description: "cell label", examples: ["imports", "helper"] }),
		}),
		{ description: "cells to execute" },
	),
	timeout: Type.Optional(Type.Number({ description: "timeout in seconds", default: 30 })),
	reset: Type.Optional(Type.Boolean({ description: "restart kernel" })),
});
export type PythonToolParams = Static<typeof pythonSchema>;

export type PythonToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: PythonToolDetails | undefined;
};

export type PythonProxyExecutor = (params: PythonToolParams, signal?: AbortSignal) => Promise<PythonToolResult>;

export interface PythonCellResult {
	index: number;
	title?: string;
	code: string;
	output: string;
	status: "pending" | "running" | "complete" | "error";
	durationMs?: number;
	exitCode?: number;
	statusEvents?: PythonStatusEvent[];
	hasMarkdown?: boolean;
}

export interface PythonToolDetails {
	cells?: PythonCellResult[];
	jsonOutputs?: unknown[];
	images?: ImageContent[];
	/** Structured status events from prelude helpers */
	statusEvents?: PythonStatusEvent[];
	isError?: boolean;
	/** Structured output metadata for notices */
	meta?: OutputMeta;
}

function formatJsonScalar(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
	if (typeof value === "function") return "[function]";
	return "[object]";
}

function renderJsonTree(value: unknown, theme: Theme, expanded: boolean, maxDepth = expanded ? 6 : 2): string[] {
	const maxItems = expanded ? 20 : 5;

	const renderNode = (node: unknown, prefix: string, depth: number, isLast: boolean, label?: string): string[] => {
		const branch = getTreeBranch(isLast, theme);
		const displayLabel = label ? `${label}: ` : "";

		if (depth >= maxDepth || node === null || typeof node !== "object") {
			return [`${prefix}${branch} ${displayLabel}${formatJsonScalar(node)}`];
		}

		const isArray = Array.isArray(node);
		const entries = isArray
			? node.map((val, index) => [String(index), val] as const)
			: Object.entries(node as object);
		const header = `${prefix}${branch} ${displayLabel}${isArray ? `Array(${entries.length})` : `Object(${entries.length})`}`;
		const lines = [header];

		const childPrefix = prefix + getTreeContinuePrefix(isLast, theme);
		const visible = entries.slice(0, maxItems);
		for (let i = 0; i < visible.length; i++) {
			const [key, val] = visible[i];
			const childLast = i === visible.length - 1 && (expanded || entries.length <= maxItems);
			lines.push(...renderNode(val, childPrefix, depth + 1, childLast, isArray ? `[${key}]` : key));
		}
		if (!expanded && entries.length > maxItems) {
			const moreBranch = theme.tree.last;
			lines.push(`${childPrefix}${moreBranch} ${entries.length - maxItems} more item(s)`);
		}
		return lines;
	};

	return renderNode(value, "", 0, true);
}

export function getPythonToolDescription(): string {
	const helpers = getPreludeDocs();
	const categories = groupPreludeHelpers(helpers);
	return prompt.render(pythonDescription, { categories });
}

export interface PythonToolOptions {
	proxyExecutor?: PythonProxyExecutor;
}

export class PythonTool implements AgentTool<typeof pythonSchema> {
	readonly name = "python";
	readonly label = "Python";
	get description(): string {
		return getPythonToolDescription();
	}
	readonly parameters = pythonSchema;
	readonly concurrency = "exclusive";
	readonly strict = true;

	readonly #proxyExecutor?: PythonProxyExecutor;

	constructor(
		private readonly session: ToolSession | null,
		options?: PythonToolOptions,
	) {
		this.#proxyExecutor = options?.proxyExecutor;
	}

	async execute(
		_toolCallId: string,
		params: Static<typeof pythonSchema>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback,
		_ctx?: AgentToolContext,
	): Promise<AgentToolResult<PythonToolDetails | undefined>> {
		if (this.#proxyExecutor) {
			return this.#proxyExecutor(params, signal);
		}

		if (!this.session) {
			throw new ToolError("Python tool requires a session when not using proxy executor");
		}
		const session = this.session;

		const { cells, timeout: rawTimeout = 30, reset } = params;
		// Clamp to reasonable range: 1s - 600s (10 min)
		const timeoutSec = clampTimeout("python", rawTimeout);
		const timeoutMs = timeoutSec * 1000;
		const deadlineMs = Date.now() + timeoutMs;
		const timeoutSignal = AbortSignal.timeout(Math.max(0, deadlineMs - Date.now()));
		const sessionAbortController = new AbortController();
		const combinedSignal = signal
			? AbortSignal.any([signal, timeoutSignal, sessionAbortController.signal])
			: AbortSignal.any([timeoutSignal, sessionAbortController.signal]);
		let outputSink: OutputSink | undefined;
		let outputSummary: OutputSummary | undefined;
		let outputDumped = false;
		const finalizeOutput = async (): Promise<OutputSummary | undefined> => {
			if (outputDumped || !outputSink) return outputSummary;
			outputSummary = await outputSink.dump();
			outputDumped = true;
			return outputSummary;
		};

		const execution = (async (): Promise<AgentToolResult<PythonToolDetails | undefined>> => {
			try {
				if (signal?.aborted) {
					throw new ToolAbortError();
				}
				session.assertPythonExecutionAllowed?.();

				const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES * 2);
				const jsonOutputs: unknown[] = [];
				const images: ImageContent[] = [];
				const statusEvents: PythonStatusEvent[] = [];

				const cellResults: PythonCellResult[] = cells.map((cell, index) => ({
					index,
					title: cell.title,
					code: cell.code,
					output: "",
					status: "pending",
				}));
				const cellOutputs: string[] = [];

				const appendTail = (text: string) => {
					tailBuffer.append(text);
				};

				const buildUpdateDetails = (): PythonToolDetails => {
					const details: PythonToolDetails = {
						cells: cellResults.map(cell => ({
							...cell,
							statusEvents: cell.statusEvents ? [...cell.statusEvents] : undefined,
						})),
					};
					if (jsonOutputs.length > 0) {
						details.jsonOutputs = jsonOutputs;
					}
					if (images.length > 0) {
						details.images = images;
					}
					if (statusEvents.length > 0) {
						details.statusEvents = statusEvents;
					}
					return details;
				};

				const pushUpdate = () => {
					if (!onUpdate) return;
					const tailText = tailBuffer.text();
					onUpdate({
						content: [{ type: "text", text: tailText }],
						details: buildUpdateDetails(),
					});
				};

				const sessionFile = session.getSessionFile?.() ?? undefined;
				const kernelOwnerId = session.getPythonKernelOwnerId?.() ?? undefined;
				const { path: artifactPath, id: artifactId } = (await session.allocateOutputArtifact?.("python")) ?? {};
				session.assertPythonExecutionAllowed?.();
				outputSink = new OutputSink({
					artifactPath,
					artifactId,
					onChunk: chunk => {
						appendTail(chunk);
						pushUpdate();
					},
				});
				const sessionId = sessionFile ? `session:${sessionFile}:cwd:${session.cwd}` : `cwd:${session.cwd}`;

				if (getPreludeDocs().length === 0) {
					const warmup = await warmPythonEnvironment(
						session.cwd,
						sessionId,
						session.settings.get("python.sharedGateway"),
						sessionFile ?? undefined,
						kernelOwnerId,
						combinedSignal,
					);
					if (!warmup.ok) {
						if (combinedSignal.aborted) throw new ToolAbortError();
						throw new ToolError(warmup.reason ?? "Python prelude helpers unavailable");
					}
					session.assertPythonExecutionAllowed?.();
				}

				const baseExecutorOptions = {
					cwd: session.cwd,
					deadlineMs,
					signal: combinedSignal,
					sessionId,
					kernelMode: session.settings.get("python.kernelMode"),
					useSharedGateway: session.settings.get("python.sharedGateway"),
					sessionFile: sessionFile ?? undefined,
					kernelOwnerId,
				};

				for (let i = 0; i < cells.length; i++) {
					const cell = cells[i];
					const isFirstCell = i === 0;
					const cellResult = cellResults[i];
					cellResult.status = "running";
					cellResult.output = "";
					cellResult.statusEvents = undefined;
					cellResult.exitCode = undefined;
					cellResult.durationMs = undefined;
					pushUpdate();

					const executorOptions: PythonExecutorOptions = {
						...baseExecutorOptions,
						reset: isFirstCell ? reset : false,
						onChunk: chunk => {
							outputSink!.push(chunk);
						},
					};

					const startTime = Date.now();
					const result = await executePython(cell.code, executorOptions);
					const durationMs = Date.now() - startTime;

					const cellStatusEvents: PythonStatusEvent[] = [];
					let cellHasMarkdown = false;
					for (const output of result.displayOutputs) {
						if (output.type === "json") {
							jsonOutputs.push(output.data);
						}
						if (output.type === "image") {
							images.push({ type: "image", data: output.data, mimeType: output.mimeType });
						}
						if (output.type === "status") {
							statusEvents.push(output.event);
							cellStatusEvents.push(output.event);
						}
						if (output.type === "markdown") {
							cellHasMarkdown = true;
						}
					}

					const cellOutput = result.output.trim();
					cellResult.output = cellOutput;
					cellResult.exitCode = result.exitCode;
					cellResult.durationMs = durationMs;
					cellResult.statusEvents = cellStatusEvents.length > 0 ? cellStatusEvents : undefined;
					cellResult.hasMarkdown = cellHasMarkdown || undefined;

					let combinedCellOutput = "";
					if (cells.length > 1) {
						const cellHeader = `[${i + 1}/${cells.length}]`;
						const cellTitle = cell.title ? ` ${cell.title}` : "";
						if (cellOutput) {
							combinedCellOutput = `${cellHeader}${cellTitle}\n${cellOutput}`;
						} else {
							combinedCellOutput = `${cellHeader}${cellTitle} (ok)`;
						}
						cellOutputs.push(combinedCellOutput);
					} else if (cellOutput) {
						combinedCellOutput = cellOutput;
						cellOutputs.push(combinedCellOutput);
					}

					if (combinedCellOutput) {
						const prefix = cellOutputs.length > 1 ? "\n\n" : "";
						appendTail(`${prefix}${combinedCellOutput}`);
					}

					if (result.cancelled) {
						cellResult.status = "error";
						pushUpdate();
						const errorMsg = result.output || "Command aborted";
						const combinedOutput = cellOutputs.join("\n\n");
						const outputText =
							cells.length > 1
								? `${combinedOutput}\n\nCell ${i + 1} aborted: ${errorMsg}`
								: combinedOutput || errorMsg;

						const rawSummary = (await finalizeOutput()) ?? {
							output: "",
							truncated: false,
							totalLines: 0,
							totalBytes: 0,
							outputLines: 0,
							outputBytes: 0,
						};
						const outputLines = combinedOutput.length > 0 ? combinedOutput.split("\n").length : 0;
						const outputBytes = Buffer.byteLength(combinedOutput, "utf-8");
						const missingLines = Math.max(0, rawSummary.totalLines - rawSummary.outputLines);
						const missingBytes = Math.max(0, rawSummary.totalBytes - rawSummary.outputBytes);
						const summaryForMeta: OutputSummary = {
							output: combinedOutput,
							truncated: rawSummary.truncated,
							totalLines: outputLines + missingLines,
							totalBytes: outputBytes + missingBytes,
							outputLines,
							outputBytes,
							artifactId: rawSummary.artifactId,
						};

						const details: PythonToolDetails = {
							cells: cellResults,
							jsonOutputs: jsonOutputs.length > 0 ? jsonOutputs : undefined,
							images: images.length > 0 ? images : undefined,
							statusEvents: statusEvents.length > 0 ? statusEvents : undefined,
							isError: true,
						};

						return toolResult(details)
							.text(outputText)
							.truncationFromSummary(summaryForMeta, { direction: "tail" })
							.done();
					}

					if (result.exitCode !== 0 && result.exitCode !== undefined) {
						cellResult.status = "error";
						pushUpdate();
						const combinedOutput = cellOutputs.join("\n\n");
						const outputText =
							cells.length > 1
								? `${combinedOutput}\n\nCell ${i + 1} failed (exit code ${result.exitCode}). Earlier cells succeeded—their state persists. Fix only cell ${i + 1}.`
								: combinedOutput
									? `${combinedOutput}\n\nCommand exited with code ${result.exitCode}`
									: `Command exited with code ${result.exitCode}`;

						const rawSummary = (await finalizeOutput()) ?? {
							output: "",
							truncated: false,
							totalLines: 0,
							totalBytes: 0,
							outputLines: 0,
							outputBytes: 0,
						};
						const outputLines = combinedOutput.length > 0 ? combinedOutput.split("\n").length : 0;
						const outputBytes = Buffer.byteLength(combinedOutput, "utf-8");
						const missingLines = Math.max(0, rawSummary.totalLines - rawSummary.outputLines);
						const missingBytes = Math.max(0, rawSummary.totalBytes - rawSummary.outputBytes);
						const summaryForMeta: OutputSummary = {
							output: combinedOutput,
							truncated: rawSummary.truncated,
							totalLines: outputLines + missingLines,
							totalBytes: outputBytes + missingBytes,
							outputLines,
							outputBytes,
							artifactId: rawSummary.artifactId,
						};

						const details: PythonToolDetails = {
							cells: cellResults,
							jsonOutputs: jsonOutputs.length > 0 ? jsonOutputs : undefined,
							images: images.length > 0 ? images : undefined,
							statusEvents: statusEvents.length > 0 ? statusEvents : undefined,
							isError: true,
						};

						return toolResult(details)
							.text(outputText)
							.truncationFromSummary(summaryForMeta, { direction: "tail" })
							.done();
					}

					cellResult.status = "complete";
					pushUpdate();
				}

				const combinedOutput = cellOutputs.join("\n\n");
				const outputText =
					combinedOutput || (jsonOutputs.length > 0 || images.length > 0 ? "(no text output)" : "(no output)");
				const rawSummary = (await finalizeOutput()) ?? {
					output: "",
					truncated: false,
					totalLines: 0,
					totalBytes: 0,
					outputLines: 0,
					outputBytes: 0,
				};
				const outputLines = combinedOutput.length > 0 ? combinedOutput.split("\n").length : 0;
				const outputBytes = Buffer.byteLength(combinedOutput, "utf-8");
				const missingLines = Math.max(0, rawSummary.totalLines - rawSummary.outputLines);
				const missingBytes = Math.max(0, rawSummary.totalBytes - rawSummary.outputBytes);
				const summaryForMeta: OutputSummary = {
					output: combinedOutput,
					truncated: rawSummary.truncated,
					totalLines: outputLines + missingLines,
					totalBytes: outputBytes + missingBytes,
					outputLines,
					outputBytes,
					artifactId: rawSummary.artifactId,
				};

				const details: PythonToolDetails = {
					cells: cellResults,
					jsonOutputs: jsonOutputs.length > 0 ? jsonOutputs : undefined,
					images: images.length > 0 ? images : undefined,
					statusEvents: statusEvents.length > 0 ? statusEvents : undefined,
				};

				const resultBuilder = toolResult(details)
					.text(outputText)
					.truncationFromSummary(summaryForMeta, { direction: "tail" });

				return resultBuilder.done();
			} finally {
				if (!outputDumped) {
					try {
						await finalizeOutput();
					} catch {}
				}
			}
		})();
		return await (session.trackPythonExecution?.(execution, sessionAbortController) ?? execution);
	}
}

interface PythonRenderArgs {
	cells?: Array<{ code: string; title?: string }>;
	timeout?: number;
	cwd?: string;
}

interface PythonRenderContext {
	output?: string;
	expanded?: boolean;
	previewLines?: number;
	timeout?: number;
}

/** Format a status event as a single line for display. */
function formatStatusEvent(event: PythonStatusEvent, theme: Theme): string {
	const { op, ...data } = event;

	// Map operations to available theme icons
	type AvailableIcon = "icon.file" | "icon.folder" | "icon.git" | "icon.package";
	const opIcons: Record<string, AvailableIcon> = {
		// File I/O
		read: "icon.file",
		write: "icon.file",
		append: "icon.file",
		cat: "icon.file",
		touch: "icon.file",
		lines: "icon.file",
		// Navigation/Directory
		ls: "icon.folder",
		cd: "icon.folder",
		pwd: "icon.folder",
		mkdir: "icon.folder",
		tree: "icon.folder",
		stat: "icon.folder",
		// Search (use file icon since no search icon)
		find: "icon.file",
		grep: "icon.file",
		rgrep: "icon.file",
		glob: "icon.file",
		// Edit operations (use file icon)
		replace: "icon.file",
		sed: "icon.file",
		rsed: "icon.file",
		delete_lines: "icon.file",
		delete_matching: "icon.file",
		insert_at: "icon.file",
		// Git
		git_status: "icon.git",
		git_diff: "icon.git",
		git_log: "icon.git",
		git_show: "icon.git",
		git_branch: "icon.git",
		git_file_at: "icon.git",
		git_has_changes: "icon.git",
		// Shell/batch (use package icon)
		run: "icon.package",
		sh: "icon.package",
		env: "icon.package",
		batch: "icon.package",
	};

	const iconKey = opIcons[op] ?? "icon.file";
	const icon = theme.styledSymbol(iconKey, "muted");

	// Format the status message based on operation type
	const parts: string[] = [];

	// Error handling
	if (data.error) {
		return `${icon} ${theme.fg("warning", op)}: ${theme.fg("dim", String(data.error))}`;
	}

	// Build description based on common fields
	switch (op) {
		case "read":
			parts.push(`${data.chars} chars`);
			if (data.path) parts.push(`from ${shortenPath(String(data.path))}`);
			break;
		case "write":
		case "append":
			parts.push(`${data.chars} chars`);
			if (data.path) parts.push(`to ${shortenPath(String(data.path))}`);
			break;
		case "cat":
			parts.push(`${data.files} file${(data.files as number) !== 1 ? "s" : ""}`);
			parts.push(`${data.chars} chars`);
			break;
		case "find":
		case "glob":
			parts.push(`${data.count} match${(data.count as number) !== 1 ? "es" : ""}`);
			if (data.pattern) parts.push(`for "${truncateToWidth(String(data.pattern), 20)}"`);
			break;
		case "grep":
			parts.push(`${data.count} match${(data.count as number) !== 1 ? "es" : ""}`);
			if (data.path) parts.push(`in ${shortenPath(String(data.path))}`);
			break;
		case "rgrep":
			parts.push(`${data.count} match${(data.count as number) !== 1 ? "es" : ""}`);
			if (data.pattern) parts.push(`for "${truncateToWidth(String(data.pattern), 20)}"`);
			break;
		case "ls":
			parts.push(`${data.count} entr${(data.count as number) !== 1 ? "ies" : "y"}`);
			break;
		case "env":
			if (data.action === "set") {
				parts.push(`set ${data.key}=${truncateToWidth(String(data.value ?? ""), 30)}`);
			} else if (data.action === "get") {
				parts.push(`${data.key}=${truncateToWidth(String(data.value ?? ""), 30)}`);
			} else {
				parts.push(`${data.count} variable${(data.count as number) !== 1 ? "s" : ""}`);
			}
			break;
		case "stat":
			if (data.is_dir) {
				parts.push("directory");
			} else {
				parts.push(`${data.size} bytes`);
			}
			if (data.path) parts.push(shortenPath(String(data.path)));
			break;
		case "replace":
		case "sed":
			parts.push(`${data.count} replacement${(data.count as number) !== 1 ? "s" : ""}`);
			if (data.path) parts.push(`in ${shortenPath(String(data.path))}`);
			break;
		case "rsed":
			parts.push(`${data.count} replacement${(data.count as number) !== 1 ? "s" : ""}`);
			if (data.files) parts.push(`in ${data.files} file${(data.files as number) !== 1 ? "s" : ""}`);
			break;
		case "git_status":
			if (data.clean) {
				parts.push("clean");
			} else {
				const statusParts: string[] = [];
				if (data.staged) statusParts.push(`${data.staged} staged`);
				if (data.modified) statusParts.push(`${data.modified} modified`);
				if (data.untracked) statusParts.push(`${data.untracked} untracked`);
				parts.push(statusParts.join(", ") || "unknown");
			}
			if (data.branch) parts.push(`on ${data.branch}`);
			break;
		case "git_log":
			parts.push(`${data.commits} commit${(data.commits as number) !== 1 ? "s" : ""}`);
			break;
		case "git_diff":
			parts.push(`${data.lines} line${(data.lines as number) !== 1 ? "s" : ""}`);
			if (data.staged) parts.push("(staged)");
			break;
		case "diff":
			if (data.identical) {
				parts.push("files identical");
			} else {
				parts.push("files differ");
			}
			break;
		case "batch":
			parts.push(`${data.files} file${(data.files as number) !== 1 ? "s" : ""} processed`);
			break;
		case "wc":
			parts.push(`${data.lines}L ${data.words}W ${data.chars}C`);
			break;
		case "lines":
			parts.push(`${data.count} line${(data.count as number) !== 1 ? "s" : ""}`);
			if (data.start && data.end) parts.push(`(${data.start}-${data.end})`);
			break;
		case "delete_lines":
		case "delete_matching":
			parts.push(`${data.count} line${(data.count as number) !== 1 ? "s" : ""} deleted`);
			break;
		case "insert_at":
			parts.push(`${data.lines_inserted} line${(data.lines_inserted as number) !== 1 ? "s" : ""} inserted`);
			break;
		case "cd":
		case "pwd":
		case "mkdir":
		case "touch":
			if (data.path) parts.push(shortenPath(String(data.path)));
			break;
		case "rm":
		case "mv":
		case "cp":
			if (data.src) parts.push(`${shortenPath(String(data.src))} → ${shortenPath(String(data.dst))}`);
			else if (data.path) parts.push(shortenPath(String(data.path)));
			break;
		default:
			// Generic formatting for other operations
			if (data.count !== undefined) {
				parts.push(String(data.count));
			}
			if (data.path) {
				parts.push(shortenPath(String(data.path)));
			}
	}

	const desc = parts.length > 0 ? parts.join(" · ") : "";
	return `${icon} ${theme.fg("muted", op)}${desc ? ` ${theme.fg("dim", desc)}` : ""}`;
}

/** Format status event with expanded detail lines. */
function formatStatusEventExpanded(event: PythonStatusEvent, theme: Theme): string[] {
	const lines: string[] = [];
	const { op, ...data } = event;

	// Main status line
	lines.push(formatStatusEvent(event, theme));

	// Add detail lines for operations with list data
	const addItems = (items: unknown[], formatter: (item: unknown) => string, max = 5) => {
		const arr = Array.isArray(items) ? items : [];
		for (let i = 0; i < Math.min(arr.length, max); i++) {
			lines.push(`   ${theme.fg("dim", formatter(arr[i]))}`);
		}
		if (arr.length > max) {
			lines.push(`   ${theme.fg("dim", `… ${arr.length - max} more`)}`);
		}
	};

	// Add preview lines (truncated content)
	const addPreview = (preview: string, maxLines = 3) => {
		const previewLines = String(preview).split("\n").slice(0, maxLines);
		for (const line of previewLines) {
			lines.push(`   ${theme.fg("toolOutput", truncateToWidth(replaceTabs(line), 80))}`);
		}
		const totalLines = String(preview).split("\n").length;
		if (totalLines > maxLines) {
			lines.push(`   ${theme.fg("dim", `… ${totalLines - maxLines} more lines`)}`);
		}
	};

	switch (op) {
		case "find":
		case "glob":
			if (data.matches) addItems(data.matches as unknown[], m => String(m));
			break;
		case "ls":
			if (data.items) addItems(data.items as unknown[], m => String(m));
			break;
		case "grep":
			if (data.hits) {
				addItems(data.hits as unknown[], h => {
					const hit = h as { line: number; text: string };
					return `${hit.line}: ${truncateToWidth(hit.text, 60)}`;
				});
			}
			break;
		case "rgrep":
			if (data.hits) {
				addItems(data.hits as unknown[], h => {
					const hit = h as { file: string; line: number; text: string };
					return `${shortenPath(hit.file)}:${hit.line}: ${truncateToWidth(hit.text, 50)}`;
				});
			}
			break;
		case "rsed":
			if (data.changed) {
				addItems(data.changed as unknown[], c => {
					const change = c as { file: string; count: number };
					return `${shortenPath(change.file)}: ${change.count} replacement${change.count !== 1 ? "s" : ""}`;
				});
			}
			break;
		case "env":
			if (data.keys) addItems(data.keys as unknown[], k => String(k), 10);
			break;
		case "git_log":
			if (data.entries) {
				addItems(data.entries as unknown[], e => {
					const entry = e as { sha: string; subject: string };
					return `${entry.sha} ${truncateToWidth(entry.subject, 50)}`;
				});
			}
			break;
		case "git_status":
			if (data.files) addItems(data.files as unknown[], f => String(f));
			break;
		case "git_branch":
			if (data.branches) addItems(data.branches as unknown[], b => String(b));
			break;
		case "read":
		case "cat":
		case "head":
		case "tail":
		case "tree":
		case "diff":
		case "lines":
		case "git_diff":
		case "sh":
			if (data.preview) addPreview(String(data.preview));
			break;
	}

	return lines;
}

/** Render status events as tree lines. */
function renderStatusEvents(events: PythonStatusEvent[], theme: Theme, expanded: boolean): string[] {
	if (events.length === 0) return [];

	const maxCollapsed = 3;
	const maxExpanded = 10;
	const displayCount = expanded ? Math.min(events.length, maxExpanded) : Math.min(events.length, maxCollapsed);

	const lines: string[] = [];
	for (let i = 0; i < displayCount; i++) {
		const isLast = i === displayCount - 1 && (expanded || events.length <= maxCollapsed);
		const branch = isLast ? theme.tree.last : theme.tree.branch;

		if (expanded) {
			// Show expanded details for each event
			const eventLines = formatStatusEventExpanded(events[i], theme);
			lines.push(`${theme.fg("dim", branch)} ${eventLines[0]}`);
			const continueBranch = isLast ? "   " : `${theme.tree.vertical}  `;
			for (let j = 1; j < eventLines.length; j++) {
				lines.push(`${theme.fg("dim", continueBranch)}${eventLines[j]}`);
			}
		} else {
			lines.push(`${theme.fg("dim", branch)} ${formatStatusEvent(events[i], theme)}`);
		}
	}

	if (!expanded && events.length > maxCollapsed) {
		lines.push(`${theme.fg("dim", theme.tree.last)} ${theme.fg("dim", `… ${events.length - maxCollapsed} more`)}`);
	} else if (expanded && events.length > maxExpanded) {
		lines.push(`${theme.fg("dim", theme.tree.last)} ${theme.fg("dim", `… ${events.length - maxExpanded} more`)}`);
	}

	return lines;
}

function formatCellOutputLines(
	cell: PythonCellResult,
	expanded: boolean,
	previewLines: number,
	theme: Theme,
	width: number,
): { lines: string[]; hiddenCount: number } {
	if (!cell.output) {
		return { lines: [], hiddenCount: 0 };
	}

	if (cell.hasMarkdown && cell.status !== "error") {
		const md = new Markdown(cell.output, 0, 0, getMarkdownTheme());
		const allLines = md.render(width);
		const displayLines = expanded ? allLines : allLines.slice(-previewLines);
		const hiddenCount = allLines.length - displayLines.length;
		return { lines: displayLines, hiddenCount };
	}

	const rawLines = cell.output.split("\n");
	const displayLines = expanded ? rawLines : rawLines.slice(-previewLines);
	const hiddenCount = rawLines.length - displayLines.length;
	const outputLines = displayLines.map(line => {
		const cleaned = replaceTabs(line);
		return cell.status === "error" ? theme.fg("error", cleaned) : theme.fg("toolOutput", cleaned);
	});

	return { lines: outputLines, hiddenCount };
}

export const pythonToolRenderer = {
	renderCall(args: PythonRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const cells = args.cells ?? [];
		const cwd = getProjectDir();
		let displayWorkdir = args.cwd;

		if (displayWorkdir) {
			const resolvedCwd = path.resolve(cwd);
			const resolvedWorkdir = path.resolve(displayWorkdir);
			if (resolvedWorkdir === resolvedCwd) {
				displayWorkdir = undefined;
			} else {
				const relativePath = path.relative(resolvedCwd, resolvedWorkdir);
				const isWithinCwd =
					relativePath && !relativePath.startsWith("..") && !relativePath.startsWith(`..${path.sep}`);
				if (isWithinCwd) {
					displayWorkdir = relativePath;
				}
			}
		}

		const workdirLabel = displayWorkdir ? `cd ${displayWorkdir}` : undefined;
		if (cells.length === 0) {
			const prompt = uiTheme.fg("accent", ">>>");
			const prefix = workdirLabel ? `${uiTheme.fg("dim", `${workdirLabel} && `)}` : "";
			const text = formatTitle(`${prompt} ${prefix}…`, uiTheme);
			return new Text(text, 0, 0);
		}

		// Cache state - cells don't change, only width varies
		let cached: { width: number; result: string[] } | undefined;

		return {
			render: (width: number): string[] => {
				if (cached && cached.width === width) {
					return cached.result;
				}

				const lines: string[] = [];
				for (let i = 0; i < cells.length; i++) {
					const cell = cells[i];
					const cellTitle = cell.title;
					const combinedTitle =
						cellTitle && workdirLabel ? `${workdirLabel} · ${cellTitle}` : (cellTitle ?? workdirLabel);
					const cellLines = renderCodeCell(
						{
							code: cell.code,
							language: "python",
							index: i,
							total: cells.length,
							title: combinedTitle,
							status: "pending",
							width,
							codeMaxLines: PYTHON_DEFAULT_PREVIEW_LINES,
							expanded: true,
						},
						uiTheme,
					);
					lines.push(...cellLines);
					if (i < cells.length - 1) {
						lines.push("");
					}
				}
				cached = { width, result: lines };
				return lines;
			},
			invalidate: () => {
				cached = undefined;
			},
		};
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: PythonToolDetails },
		options: RenderResultOptions & { renderContext?: PythonRenderContext },
		uiTheme: Theme,
	): Component {
		const details = result.details;

		const output =
			options.renderContext?.output ?? (result.content?.find(c => c.type === "text")?.text ?? "").trimEnd();

		const jsonOutputs = details?.jsonOutputs ?? [];
		const jsonLines = jsonOutputs.flatMap((value, index) => {
			const header = `JSON output ${index + 1}`;
			const treeLines = renderJsonTree(value, uiTheme, options.renderContext?.expanded ?? options.expanded);
			return [header, ...treeLines];
		});

		const timeoutSeconds = options.renderContext?.timeout;
		const timeoutLine =
			typeof timeoutSeconds === "number"
				? uiTheme.fg("dim", wrapBrackets(`Timeout: ${timeoutSeconds}s`, uiTheme))
				: undefined;
		let warningLine: string | undefined;
		if (details?.meta?.truncation) {
			warningLine = formatStyledTruncationWarning(details.meta, uiTheme) ?? undefined;
		}

		const cellResults = details?.cells;
		if (cellResults && cellResults.length > 0) {
			// Cache state following Box pattern
			let cached: { key: string; width: number; result: string[] } | undefined;

			return {
				render: (width: number): string[] => {
					// Read mutable state at render time
					const expanded = options.renderContext?.expanded ?? options.expanded;
					const previewLines = options.renderContext?.previewLines ?? PYTHON_DEFAULT_PREVIEW_LINES;
					const key = `${expanded}|${previewLines}|${options.spinnerFrame}`;
					if (cached && cached.key === key && cached.width === width) {
						return cached.result;
					}

					const lines: string[] = [];
					for (let i = 0; i < cellResults.length; i++) {
						const cell = cellResults[i];
						const statusLines = renderStatusEvents(cell.statusEvents ?? [], uiTheme, expanded);
						const outputContent = formatCellOutputLines(cell, expanded, previewLines, uiTheme, width);
						const outputLines = [...outputContent.lines];
						if (!expanded && outputContent.hiddenCount > 0) {
							outputLines.push(
								uiTheme.fg("dim", `… ${outputContent.hiddenCount} more lines (ctrl+o to expand)`),
							);
						}
						if (statusLines.length > 0) {
							if (outputLines.length > 0) {
								outputLines.push(uiTheme.fg("dim", "Status"));
							}
							outputLines.push(...statusLines);
						}
						const cellLines = renderCodeCell(
							{
								code: cell.code,
								language: "python",
								index: i,
								total: cellResults.length,
								title: cell.title,
								status: cell.status,
								spinnerFrame: options.spinnerFrame,
								duration: cell.durationMs,
								output: outputLines.length > 0 ? outputLines.join("\n") : undefined,
								outputMaxLines: outputLines.length,
								codeMaxLines: expanded ? Number.POSITIVE_INFINITY : PYTHON_DEFAULT_PREVIEW_LINES,
								expanded,
								width,
							},
							uiTheme,
						);
						lines.push(...cellLines);
						if (i < cellResults.length - 1) {
							lines.push("");
						}
					}
					if (jsonLines.length > 0) {
						if (lines.length > 0) {
							lines.push("");
						}
						lines.push(...jsonLines);
					}
					if (timeoutLine) {
						lines.push(timeoutLine);
					}
					if (warningLine) {
						lines.push(warningLine);
					}
					cached = { key, width, result: lines };
					return lines;
				},
				invalidate: () => {
					cached = undefined;
				},
			};
		}

		const displayOutput = output;
		const combinedOutput = [displayOutput, ...jsonLines].filter(Boolean).join("\n");

		const statusEvents = details?.statusEvents ?? [];
		const statusLines = renderStatusEvents(
			statusEvents,
			uiTheme,
			options.renderContext?.expanded ?? options.expanded,
		);

		if (!combinedOutput && statusLines.length === 0) {
			const lines = [timeoutLine, warningLine].filter(Boolean) as string[];
			return new Text(lines.join("\n"), 0, 0);
		}

		if (!combinedOutput && statusLines.length > 0) {
			const lines = [uiTheme.fg("dim", "Status"), ...statusLines, timeoutLine, warningLine].filter(
				Boolean,
			) as string[];
			return new Text(lines.join("\n"), 0, 0);
		}

		if (options.renderContext?.expanded ?? options.expanded) {
			const styledOutput = combinedOutput
				.split("\n")
				.map(line => uiTheme.fg("toolOutput", line))
				.join("\n");
			const lines = [
				styledOutput,
				...(statusLines.length > 0 ? [uiTheme.fg("dim", "Status"), ...statusLines] : []),
				timeoutLine,
				warningLine,
			].filter(Boolean) as string[];
			return new Text(lines.join("\n"), 0, 0);
		}

		const styledOutput = combinedOutput
			.split("\n")
			.map(line => uiTheme.fg("toolOutput", line))
			.join("\n");
		const textContent = `\n${styledOutput}`;

		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;
		let cachedSkipped: number | undefined;
		let cachedPreviewLines: number | undefined;

		return {
			render: (width: number): string[] => {
				// Read mutable state at render time
				const previewLines = options.renderContext?.previewLines ?? PYTHON_DEFAULT_PREVIEW_LINES;
				if (cachedLines === undefined || cachedWidth !== width || cachedPreviewLines !== previewLines) {
					const result = truncateToVisualLines(textContent, previewLines, width);
					cachedLines = result.visualLines;
					cachedSkipped = result.skippedCount;
					cachedWidth = width;
					cachedPreviewLines = previewLines;
				}
				const outputLines: string[] = [];
				if (cachedSkipped && cachedSkipped > 0) {
					outputLines.push("");
					const skippedLine = uiTheme.fg(
						"dim",
						`… (${cachedSkipped} earlier lines, showing ${cachedLines.length} of ${cachedSkipped + cachedLines.length}) (ctrl+o to expand)`,
					);
					outputLines.push(truncateToWidth(skippedLine, width));
				}
				outputLines.push(...cachedLines);
				if (statusLines.length > 0) {
					outputLines.push(truncateToWidth(uiTheme.fg("dim", "Status"), width));
					for (const statusLine of statusLines) {
						outputLines.push(truncateToWidth(statusLine, width));
					}
				}
				if (timeoutLine) {
					outputLines.push(truncateToWidth(timeoutLine, width));
				}
				if (warningLine) {
					outputLines.push(truncateToWidth(warningLine, width));
				}
				return outputLines;
			},
			invalidate: () => {
				cachedWidth = undefined;
				cachedLines = undefined;
				cachedSkipped = undefined;
				cachedPreviewLines = undefined;
			},
		};
	},
	mergeCallAndResult: true,
	inline: true,
};

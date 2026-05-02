import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { Markdown, Text } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import { jsBackend, parseEvalInput, pythonBackend } from "../eval";
import type { ExecutorBackend } from "../eval/backend";
import evalGrammar from "../eval/eval.lark" with { type: "text" };
import type { ParsedEvalCell } from "../eval/parse";
import type { EvalCellResult, EvalLanguage, EvalStatusEvent, EvalToolDetails } from "../eval/types";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { truncateToVisualLines } from "../modes/components/visual-truncate";
import { getMarkdownTheme, type Theme } from "../modes/theme/theme";
import evalDescription from "../prompts/tools/eval.md" with { type: "text" };
import { DEFAULT_MAX_BYTES, OutputSink, type OutputSummary, TailBuffer } from "../session/streaming-output";
import { getTreeBranch, getTreeContinuePrefix, renderCodeCell } from "../tui";
import { resolveEvalBackends, type ToolSession } from ".";
import { formatStyledTruncationWarning } from "./output-meta";
import { formatTitle, replaceTabs, shortenPath, truncateToWidth, wrapBrackets } from "./render-utils";
import { ToolAbortError, ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

export const EVAL_DEFAULT_PREVIEW_LINES = 10;

export const evalSchema = Type.Object({
	input: Type.String({
		description: "atom-style eval input containing CELL sections, fenced code, and optional RESET directive",
	}),
});
export type EvalToolParams = Static<typeof evalSchema>;

export type EvalToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: EvalToolDetails | undefined;
};

export type EvalProxyExecutor = (params: EvalToolParams, signal?: AbortSignal) => Promise<EvalToolResult>;

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

export interface EvalToolDescriptionOptions {
	py?: boolean;
	js?: boolean;
}

export function getEvalToolDescription(options: EvalToolDescriptionOptions = {}): string {
	const py = options.py ?? true;
	const js = options.js ?? true;
	return prompt.render(evalDescription, { py, js });
}

export interface EvalToolOptions {
	proxyExecutor?: EvalProxyExecutor;
}

interface ResolvedBackend {
	backend: ExecutorBackend;
	fallback: boolean;
	notice?: string;
}

interface ResolvedEvalCell {
	index: number;
	title?: string;
	code: string;
	timeoutMs: number;
	reset: boolean;
	resolved: ResolvedBackend;
}

function uniqueEvalLanguages(cells: ResolvedEvalCell[]): EvalLanguage[] {
	return [...new Set(cells.map(cell => cell.resolved.backend.id))];
}

function detailsNotice(cells: ResolvedEvalCell[]): string | undefined {
	const notices = [
		...new Set(cells.map(cell => cell.resolved.notice).filter((notice): notice is string => Boolean(notice))),
	];
	return notices.length > 0 ? notices.join(" ") : undefined;
}

function languageForHighlighter(language: EvalLanguage | undefined): "python" | "javascript" {
	return language === "js" ? "javascript" : "python";
}

function timeoutSecondsFromMs(timeoutMs: number): number {
	return clampTimeout("eval", timeoutMs / 1000);
}

/**
 * Best-effort language sniff for cells with no explicit `language`.
 *
 * Order:
 * 1. Shebang on first line (`#!/usr/bin/env python`, `#!/usr/bin/env node`, etc.)
 * 2. Strong syntactic markers unique to one language. We bias false negatives over
 *    false positives — anything ambiguous returns `undefined` and the caller falls
 *    back to the default-backend rules.
 */
function sniffLanguage(code: string): EvalLanguage | undefined {
	const stripped = code.replace(/^\s+/, "");
	if (stripped.startsWith("#!")) {
		const firstLine = stripped.split("\n", 1)[0]!.toLowerCase();
		if (/(\bpython\d?\b|\bipython\b)/.test(firstLine)) return "python";
		if (/(\bnode\b|\bbun\b|\bdeno\b|\bjavascript\b|\bjs\b)/.test(firstLine)) return "js";
	}
	const jsMarkers =
		/(^|\n)\s*(const|let|var|async\s+function|function\s*\*?\s*[\w$]*\s*\(|import\s+[^\n]+\sfrom\s|export\s+(default|const|let|function|class|async)|require\s*\(|console\.\w+\s*\(|=>|;\s*$)/m;
	const pyMarkers =
		/(^|\n)\s*(def\s+\w+\s*\(|from\s+[\w.]+\s+import|import\s+\w+(\s+as\s+\w+)?\s*$|class\s+\w+\s*[(:]|print\s*\(|elif\s+[^\n]*:|with\s+[^\n]+:\s*$|@[\w.]+\s*$)/m;
	const hasJs = jsMarkers.test(code);
	const hasPy = pyMarkers.test(code);
	if (hasJs && !hasPy) return "js";
	if (hasPy && !hasJs) return "python";
	return undefined;
}

async function resolveBackend(
	session: ToolSession,
	requested: EvalLanguage | undefined,
	code: string,
): Promise<ResolvedBackend> {
	const allowPy = (session.settings.get("eval.py") as boolean | undefined) ?? true;
	const allowJs = (session.settings.get("eval.js") as boolean | undefined) ?? true;

	if (requested === "python") {
		if (!allowPy) throw new ToolError("Python backend is disabled (eval.py = false).");
		if (!(await pythonBackend.isAvailable(session))) {
			throw new ToolError(
				'Python backend is unavailable in this session. Pass language: "js" or install the python kernel.',
			);
		}
		return { backend: pythonBackend, fallback: false };
	}
	if (requested === "js") {
		if (!allowJs) throw new ToolError("JavaScript backend is disabled (eval.js = false).");
		return { backend: jsBackend, fallback: false };
	}
	// Auto-detect.
	const sniffed = sniffLanguage(code);
	if (sniffed === "python" && allowPy && (await pythonBackend.isAvailable(session))) {
		return { backend: pythonBackend, fallback: false };
	}
	if (sniffed === "js" && allowJs) {
		return { backend: jsBackend, fallback: false };
	}

	// Sniffer returned undefined or the preferred backend was disabled. Prefer
	// python when its kernel is up, else fall back to js.
	if (allowPy && (await pythonBackend.isAvailable(session))) {
		const notice =
			sniffed === "js" ? "JavaScript markers detected but eval.js is disabled; using Python." : undefined;
		return { backend: pythonBackend, fallback: false, notice };
	}
	if (allowJs) {
		const notice =
			sniffed === "python"
				? "Python markers detected but the python kernel is unavailable; using JavaScript."
				: undefined;
		return { backend: jsBackend, fallback: true, notice };
	}
	throw new ToolError("No eval backend is available; enable eval.py or eval.js.");
}

export class EvalTool implements AgentTool<typeof evalSchema> {
	readonly name = "eval";
	readonly label = "Eval";
	get description(): string {
		if (!this.session) return getEvalToolDescription();
		const backends = resolveEvalBackends(this.session);
		return getEvalToolDescription({ py: backends.python, js: backends.js });
	}
	readonly parameters = evalSchema;
	readonly concurrency = "exclusive";
	readonly strict = true;

	get customFormat(): { syntax: "lark"; definition: string } {
		return { syntax: "lark", definition: evalGrammar };
	}

	readonly #proxyExecutor?: EvalProxyExecutor;

	constructor(
		private readonly session: ToolSession | null,
		options?: EvalToolOptions,
	) {
		this.#proxyExecutor = options?.proxyExecutor;
	}

	async execute(
		_toolCallId: string,
		params: Static<typeof evalSchema>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback,
		_ctx?: AgentToolContext,
	): Promise<AgentToolResult<EvalToolDetails | undefined>> {
		if (this.#proxyExecutor) {
			return this.#proxyExecutor(params, signal);
		}

		if (!this.session) {
			throw new ToolError("Eval tool requires a session when not using proxy executor");
		}
		const session = this.session;

		const parsedInput = parseEvalInput(params.input);
		let previousRuntimeLanguage: EvalLanguage | undefined;
		const cells: ResolvedEvalCell[] = [];
		for (const cell of parsedInput.cells) {
			const requested = cell.languageOrigin === "fence" ? cell.language : (previousRuntimeLanguage ?? undefined);
			const resolved = await resolveBackend(session, requested, cell.code);
			previousRuntimeLanguage = resolved.backend.id;
			cells.push({
				index: cell.index,
				title: cell.title,
				code: cell.code,
				timeoutMs: cell.timeoutMs,
				reset: cell.reset,
				resolved,
			});
		}
		const languages = uniqueEvalLanguages(cells);
		const notice = detailsNotice(cells);
		const sessionAbortController = new AbortController();
		let outputSink: OutputSink | undefined;
		let outputSummary: OutputSummary | undefined;
		let outputDumped = false;
		const finalizeOutput = async (): Promise<OutputSummary | undefined> => {
			if (outputDumped || !outputSink) return outputSummary;
			outputSummary = await outputSink.dump();
			outputDumped = true;
			return outputSummary;
		};

		const execution = (async (): Promise<AgentToolResult<EvalToolDetails | undefined>> => {
			try {
				if (signal?.aborted) {
					throw new ToolAbortError();
				}
				session.assertEvalExecutionAllowed?.();

				const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES * 2);
				const jsonOutputs: unknown[] = [];
				const images: ImageContent[] = [];
				const statusEvents: EvalStatusEvent[] = [];

				const cellResults: EvalCellResult[] = cells.map(cell => ({
					index: cell.index,
					title: cell.title,
					code: cell.code,
					language: cell.resolved.backend.id,
					output: "",
					status: "pending",
				}));
				const cellOutputs: string[] = [];

				const appendTail = (text: string) => {
					tailBuffer.append(text);
				};

				const buildUpdateDetails = (): EvalToolDetails => {
					const details: EvalToolDetails = {
						language: languages[0],
						languages,
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
					if (notice) {
						details.notice = notice;
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
				const kernelOwnerId = session.getEvalKernelOwnerId?.() ?? undefined;
				const { path: artifactPath, id: artifactId } = (await session.allocateOutputArtifact?.("eval")) ?? {};
				session.assertEvalExecutionAllowed?.();
				outputSink = new OutputSink({
					artifactPath,
					artifactId,
					onChunk: chunk => {
						appendTail(chunk);
						pushUpdate();
					},
				});
				const sessionId = sessionFile ? `session:${sessionFile}:cwd:${session.cwd}` : `cwd:${session.cwd}`;

				for (let i = 0; i < cells.length; i++) {
					const cell = cells[i];
					const backend = cell.resolved.backend;
					const timeoutSec = timeoutSecondsFromMs(cell.timeoutMs);
					const deadlineMs = Date.now() + timeoutSec * 1000;
					const timeoutSignal = AbortSignal.timeout(Math.max(0, deadlineMs - Date.now()));
					const combinedSignal = signal
						? AbortSignal.any([signal, timeoutSignal, sessionAbortController.signal])
						: AbortSignal.any([timeoutSignal, sessionAbortController.signal]);

					const cellResult = cellResults[i];
					cellResult.status = "running";
					cellResult.output = "";
					cellResult.statusEvents = undefined;
					cellResult.exitCode = undefined;
					cellResult.durationMs = undefined;
					pushUpdate();

					const startTime = Date.now();
					const result = await backend.execute(cell.code, {
						cwd: session.cwd,
						sessionId,
						sessionFile: sessionFile ?? undefined,
						kernelOwnerId,
						signal: combinedSignal,
						session,
						deadlineMs,
						reset: cell.reset,
						artifactPath,
						artifactId,
						onChunk: chunk => {
							outputSink!.push(chunk);
						},
					});
					const durationMs = Date.now() - startTime;

					const cellStatusEvents: EvalStatusEvent[] = [];
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

						const summaryForMeta = await summarizeFinal(combinedOutput, finalizeOutput);
						const details: EvalToolDetails = {
							language: languages[0],
							languages,
							cells: cellResults,
							jsonOutputs: jsonOutputs.length > 0 ? jsonOutputs : undefined,
							images: images.length > 0 ? images : undefined,
							statusEvents: statusEvents.length > 0 ? statusEvents : undefined,
							isError: true,
						};
						if (notice) details.notice = notice;

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

						const summaryForMeta = await summarizeFinal(combinedOutput, finalizeOutput);
						const details: EvalToolDetails = {
							language: languages[0],
							languages,
							cells: cellResults,
							jsonOutputs: jsonOutputs.length > 0 ? jsonOutputs : undefined,
							images: images.length > 0 ? images : undefined,
							statusEvents: statusEvents.length > 0 ? statusEvents : undefined,
							isError: true,
						};
						if (notice) details.notice = notice;

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
				const summaryForMeta = await summarizeFinal(combinedOutput, finalizeOutput);

				const details: EvalToolDetails = {
					language: languages[0],
					languages,
					cells: cellResults,
					jsonOutputs: jsonOutputs.length > 0 ? jsonOutputs : undefined,
					images: images.length > 0 ? images : undefined,
					statusEvents: statusEvents.length > 0 ? statusEvents : undefined,
				};
				if (notice) details.notice = notice;

				return toolResult(details)
					.text(outputText)
					.truncationFromSummary(summaryForMeta, { direction: "tail" })
					.done();
			} finally {
				if (!outputDumped) {
					try {
						await finalizeOutput();
					} catch {}
				}
			}
		})();

		return await (session.trackEvalExecution?.(execution, sessionAbortController) ?? execution);
	}
}

async function summarizeFinal(
	combinedOutput: string,
	finalizeOutput: () => Promise<OutputSummary | undefined>,
): Promise<OutputSummary> {
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
	return {
		output: combinedOutput,
		truncated: rawSummary.truncated,
		totalLines: outputLines + missingLines,
		totalBytes: outputBytes + missingBytes,
		outputLines,
		outputBytes,
		artifactId: rawSummary.artifactId,
	};
}

interface EvalRenderArgs {
	input?: string;
	__partialJson?: string;
}

interface EvalRenderContext {
	output?: string;
	expanded?: boolean;
	previewLines?: number;
	timeout?: number;
}

function decodePartialJsonStringFragment(fragment: string): string {
	let text = fragment.replace(/\\u[0-9a-fA-F]{0,3}$/, "");
	const trailingBackslashes = text.match(/\\+$/)?.[0].length ?? 0;
	if (trailingBackslashes % 2 === 1) text = text.slice(0, -1);
	try {
		return JSON.parse(`"${text}"`) as string;
	} catch {
		return text;
	}
}

function extractPartialJsonString(partialJson: string | undefined, key: string): string | undefined {
	if (!partialJson) return undefined;
	const pattern = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`, "u");
	const match = pattern.exec(partialJson);
	if (!match) return undefined;
	return decodePartialJsonStringFragment(match[1]);
}

function getRenderInput(args: EvalRenderArgs | undefined): string | undefined {
	return args?.input ?? extractPartialJsonString(args?.__partialJson, "input");
}

/** Format a status event as a single line for display. */
function formatStatusEvent(event: EvalStatusEvent, theme: Theme): string {
	const { op, ...data } = event;

	type AvailableIcon = "icon.file" | "icon.folder" | "icon.git" | "icon.package";
	const opIcons: Record<string, AvailableIcon> = {
		read: "icon.file",
		write: "icon.file",
		append: "icon.file",
		cat: "icon.file",
		touch: "icon.file",
		ls: "icon.folder",
		cd: "icon.folder",
		pwd: "icon.folder",
		mkdir: "icon.folder",
		tree: "icon.folder",
		git_status: "icon.git",
		git_diff: "icon.git",
		git_log: "icon.git",
		git_show: "icon.git",
		git_branch: "icon.git",
		git_file_at: "icon.git",
		git_has_changes: "icon.git",
		run: "icon.package",
		sh: "icon.package",
		env: "icon.package",
		batch: "icon.package",
	};

	const iconKey = opIcons[op] ?? "icon.file";
	const icon = theme.styledSymbol(iconKey, "muted");

	const parts: string[] = [];

	if (data.error) {
		return `${icon} ${theme.fg("warning", op)}: ${theme.fg("dim", String(data.error))}`;
	}

	switch (op) {
		case "read":
			parts.push(`${data.chars ?? data.bytes ?? 0} chars`);
			if (data.path) parts.push(`from ${shortenPath(String(data.path))}`);
			break;
		case "write":
		case "append":
			parts.push(`${data.chars ?? data.bytes ?? 0} chars`);
			if (data.path) parts.push(`to ${shortenPath(String(data.path))}`);
			break;
		case "cat":
			parts.push(`${data.files} file${(data.files as number) !== 1 ? "s" : ""}`);
			parts.push(`${data.chars} chars`);
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
		case "cd":
		case "pwd":
		case "mkdir":
		case "touch":
			if (data.path) parts.push(shortenPath(String(data.path)));
			break;
		default:
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
function formatStatusEventExpanded(event: EvalStatusEvent, theme: Theme): string[] {
	const lines: string[] = [];
	const { op, ...data } = event;

	lines.push(formatStatusEvent(event, theme));

	const addItems = (items: unknown[], formatter: (item: unknown) => string, max = 5) => {
		const arr = Array.isArray(items) ? items : [];
		for (let i = 0; i < Math.min(arr.length, max); i++) {
			lines.push(`   ${theme.fg("dim", formatter(arr[i]))}`);
		}
		if (arr.length > max) {
			lines.push(`   ${theme.fg("dim", `… ${arr.length - max} more`)}`);
		}
	};

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
		case "ls":
			if (data.items) addItems(data.items as unknown[], m => String(m));
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
		case "git_diff":
		case "sh":
			if (data.preview) addPreview(String(data.preview));
			break;
	}

	return lines;
}

/** Render status events as tree lines. */
function renderStatusEvents(events: EvalStatusEvent[], theme: Theme, expanded: boolean): string[] {
	if (events.length === 0) return [];

	const maxCollapsed = 3;
	const maxExpanded = 10;
	const displayCount = expanded ? Math.min(events.length, maxExpanded) : Math.min(events.length, maxCollapsed);

	const lines: string[] = [];
	for (let i = 0; i < displayCount; i++) {
		const isLast = i === displayCount - 1 && (expanded || events.length <= maxCollapsed);
		const branch = isLast ? theme.tree.last : theme.tree.branch;

		if (expanded) {
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
	cell: EvalCellResult,
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

export const evalToolRenderer = {
	renderCall(args: EvalRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const input = getRenderInput(args);
		let cells: ParsedEvalCell[] = [];
		if (input) {
			try {
				cells = parseEvalInput(input).cells;
			} catch {
				cells = [];
			}
		}

		if (cells.length === 0) {
			const promptSym = uiTheme.fg("accent", ">>>");
			const text = formatTitle(`${promptSym} …`, uiTheme);
			return new Text(text, 0, 0);
		}

		let cached: { key: string; width: number; result: string[] } | undefined;

		return {
			render: (width: number): string[] => {
				const key = `${input?.length ?? 0}`;
				if (cached && cached.key === key && cached.width === width) {
					return cached.result;
				}

				const lines: string[] = [];
				for (let i = 0; i < cells.length; i++) {
					const cell = cells[i];
					const cellLines = renderCodeCell(
						{
							code: cell.code,
							language: languageForHighlighter(cell.language),
							index: i,
							total: cells.length,
							title: cell.title,
							status: "pending",
							width,
							codeMaxLines: EVAL_DEFAULT_PREVIEW_LINES,
							expanded: true,
						},
						uiTheme,
					);
					lines.push(...cellLines);
					if (i < cells.length - 1) {
						lines.push("");
					}
				}
				cached = { key, width, result: lines };
				return lines;
			},
			invalidate: () => {
				cached = undefined;
			},
		};
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: EvalToolDetails },
		options: RenderResultOptions & { renderContext?: EvalRenderContext },
		uiTheme: Theme,
		_args?: EvalRenderArgs,
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
		const noticeLine = details?.notice ? uiTheme.fg("dim", wrapBrackets(details.notice, uiTheme)) : undefined;

		const cellResults = details?.cells;
		if (cellResults && cellResults.length > 0) {
			let cached: { key: string; width: number; result: string[] } | undefined;

			return {
				render: (width: number): string[] => {
					const expanded = options.renderContext?.expanded ?? options.expanded;
					const previewLines = options.renderContext?.previewLines ?? EVAL_DEFAULT_PREVIEW_LINES;
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
								language: languageForHighlighter(cell.language ?? details?.language),
								index: i,
								total: cellResults.length,
								title: cell.title,
								status: cell.status,
								spinnerFrame: options.spinnerFrame,
								duration: cell.durationMs,
								output: outputLines.length > 0 ? outputLines.join("\n") : undefined,
								outputMaxLines: outputLines.length,
								codeMaxLines: expanded ? Number.POSITIVE_INFINITY : EVAL_DEFAULT_PREVIEW_LINES,
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
					if (noticeLine) {
						lines.push(noticeLine);
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
			const lines = [timeoutLine, noticeLine, warningLine].filter(Boolean) as string[];
			return new Text(lines.join("\n"), 0, 0);
		}

		if (!combinedOutput && statusLines.length > 0) {
			const lines = [uiTheme.fg("dim", "Status"), ...statusLines, timeoutLine, noticeLine, warningLine].filter(
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
				noticeLine,
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
				const previewLines = options.renderContext?.previewLines ?? EVAL_DEFAULT_PREVIEW_LINES;
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
				if (noticeLine) {
					outputLines.push(truncateToWidth(noticeLine, width));
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

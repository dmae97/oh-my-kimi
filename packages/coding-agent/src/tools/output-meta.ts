/**
 * Structured metadata for tool outputs.
 *
 * Tools populate details.meta using the fluent OutputMetaBuilder.
 * The tool wrapper automatically formats and appends notices at message boundary.
 */
import type {
	AgentTool,
	AgentToolContext,
	AgentToolExecFn,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { getDefault, type Settings } from "../config/settings";
import { formatGroupedDiagnosticMessages } from "../lsp/utils";
import type { Theme } from "../modes/theme/theme";
import { type OutputSummary, type TruncationResult, truncateTail } from "../session/streaming-output";
import { formatBytes, wrapBrackets } from "./render-utils";
import { renderError } from "./tool-errors";

/**
 * Truncation metadata for the output notice.
 */
export interface TruncationMeta {
	direction: "head" | "tail";
	truncatedBy: "lines" | "bytes";
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	maxBytes?: number;
	/** Line range shown (1-indexed, inclusive) */
	shownRange?: { start: number; end: number };
	/** Artifact ID if full output was saved */
	artifactId?: string;
	/** Next offset for pagination (head truncation only) */
	nextOffset?: number;
}

/**
 * Source resolution info for the output.
 */
export type SourceMeta =
	| { type: "path"; value: string }
	| { type: "url"; value: string }
	| { type: "internal"; value: string };

/**
 * LSP diagnostic info (for edit/write tools).
 */
export interface DiagnosticMeta {
	summary: string;
	messages: string[];
}

/**
 * Limit-specific notices.
 */
export interface LimitsMeta {
	matchLimit?: { reached: number; suggestion: number };
	resultLimit?: { reached: number; suggestion: number };
	headLimit?: { reached: number; suggestion: number };
	columnTruncated?: { maxColumn: number };
}

/**
 * Structured metadata for tool outputs.
 */
export interface OutputMeta {
	truncation?: TruncationMeta;
	source?: SourceMeta;
	diagnostics?: DiagnosticMeta;
	limits?: LimitsMeta;
}

// =============================================================================
// OutputMetaBuilder - Fluent API for building OutputMeta
// =============================================================================

export interface TruncationOptions {
	direction: "head" | "tail";
	startLine?: number;
	totalFileLines?: number;
	artifactId?: string;
}

export interface TruncationSummaryOptions {
	direction: "head" | "tail";
	startLine?: number;
	totalFileLines?: number;
}

export interface TruncationTextOptions {
	direction: "head" | "tail";
	totalLines?: number;
	totalBytes?: number;
	maxBytes?: number;
}

/**
 * Fluent builder for OutputMeta.
 *
 * @example
 * ```ts
 * details.meta = outputMeta()
 *   .truncation(truncation, { direction: "head" })
 *   .matchLimit(limitReached ? effectiveLimit : 0)
 *   .columnTruncated(linesTruncated ? DEFAULT_MAX_COLUMN : 0)
 *   .get();
 * ```
 */
export class OutputMetaBuilder {
	#meta: OutputMeta = {};

	/** Add truncation info from TruncationResult. No-op if not truncated. */
	truncation(result: TruncationResult, options: TruncationOptions): this {
		if (!result.truncated) return this;

		const { direction, startLine = 1, totalFileLines, artifactId } = options;
		const outputLines = result.outputLines ?? result.totalLines;
		const outputBytes = result.outputBytes ?? result.totalBytes;
		const truncatedBy: "lines" | "bytes" = result.truncatedBy === "lines" ? "lines" : "bytes";

		let shownStart: number;
		let shownEnd: number;

		if (direction === "tail") {
			shownStart = result.totalLines - outputLines + 1;
			shownEnd = result.totalLines;
		} else {
			shownStart = startLine;
			shownEnd = startLine + outputLines - 1;
		}

		this.#meta.truncation = {
			direction,
			truncatedBy,
			totalLines: totalFileLines ?? result.totalLines,
			totalBytes: result.totalBytes,
			outputLines,
			outputBytes,
			shownRange: { start: shownStart, end: shownEnd },
			artifactId,
			nextOffset: direction === "head" ? shownEnd + 1 : undefined,
		};

		return this;
	}

	/** Add truncation info from OutputSummary. No-op if not truncated. */
	truncationFromSummary(summary: OutputSummary, options: TruncationSummaryOptions): this {
		if (!summary.truncated) return this;

		const { direction, startLine = 1, totalFileLines } = options;
		const totalLines = totalFileLines ?? summary.totalLines;
		const truncatedBy: "lines" | "bytes" =
			summary.outputBytes < summary.totalBytes
				? "bytes"
				: summary.outputLines < summary.totalLines
					? "lines"
					: "bytes";

		let shownStart: number;
		let shownEnd: number;

		if (direction === "tail") {
			shownStart = totalLines - summary.outputLines + 1;
			shownEnd = totalLines;
		} else {
			shownStart = startLine;
			shownEnd = startLine + summary.outputLines - 1;
		}

		this.#meta.truncation = {
			direction,
			truncatedBy,
			totalLines,
			totalBytes: summary.totalBytes,
			outputLines: summary.outputLines,
			outputBytes: summary.outputBytes,
			shownRange: { start: shownStart, end: shownEnd },
			artifactId: summary.artifactId,
			nextOffset: direction === "head" ? shownEnd + 1 : undefined,
		};

		return this;
	}

	/** Add truncation info from truncated output text. No-op if truncation not detected. */
	truncationFromText(text: string, options: TruncationTextOptions): this {
		const outputLines = text.length > 0 ? text.split("\n").length : 0;
		const outputBytes = Buffer.byteLength(text, "utf-8");
		const totalLines = options.totalLines ?? outputLines;
		const totalBytes = options.totalBytes ?? outputBytes;

		const truncated = totalLines > outputLines || totalBytes > outputBytes || false;
		if (!truncated) return this;

		const truncatedBy: "lines" | "bytes" =
			options.maxBytes && outputBytes >= options.maxBytes
				? "bytes"
				: totalBytes > outputBytes
					? "bytes"
					: totalLines > outputLines
						? "lines"
						: "bytes";

		let shownStart: number;
		let shownEnd: number;

		if (options.direction === "tail") {
			shownStart = totalLines - outputLines + 1;
			shownEnd = totalLines;
		} else {
			shownStart = 1;
			shownEnd = outputLines;
		}

		this.#meta.truncation = {
			direction: options.direction,
			truncatedBy,
			totalLines,
			totalBytes,
			outputLines,
			outputBytes,
			maxBytes: options.maxBytes,
			shownRange: { start: shownStart, end: shownEnd },
			nextOffset: options.direction === "head" ? shownEnd + 1 : undefined,
		};

		return this;
	}

	/** Add match limit notice. No-op if reached <= 0. */
	matchLimit(reached: number, suggestion = reached * 2): this {
		if (reached <= 0) return this;
		this.#meta.limits = { ...this.#meta.limits, matchLimit: { reached, suggestion } };
		return this;
	}

	/** Add limit notices in one call. */
	limits(limits: { matchLimit?: number; resultLimit?: number; headLimit?: number; columnMax?: number }): this {
		if (limits.matchLimit !== undefined) {
			this.matchLimit(limits.matchLimit);
		}
		if (limits.resultLimit !== undefined) {
			this.resultLimit(limits.resultLimit);
		}
		if (limits.headLimit !== undefined) {
			this.headLimit(limits.headLimit);
		}
		if (limits.columnMax !== undefined) {
			this.columnTruncated(limits.columnMax);
		}
		return this;
	}

	/** Add result limit notice. No-op if reached <= 0. */
	resultLimit(reached: number, suggestion = reached * 2): this {
		if (reached <= 0) return this;
		this.#meta.limits = { ...this.#meta.limits, resultLimit: { reached, suggestion } };
		return this;
	}

	/** Add limit notice for head truncation. No-op if reached <= 0. */
	headLimit(reached: number, suggestion = reached * 2): this {
		if (reached <= 0) return this;
		this.#meta.limits = { ...this.#meta.limits, headLimit: { reached, suggestion } };
		return this;
	}

	/** Add column truncation notice. No-op if maxColumn <= 0. */
	columnTruncated(maxColumn: number): this {
		if (maxColumn <= 0) return this;
		this.#meta.limits = { ...this.#meta.limits, columnTruncated: { maxColumn } };
		return this;
	}

	/** Add source path info. */
	sourcePath(value: string): this {
		this.#meta.source = { type: "path", value };
		return this;
	}

	/** Add source URL info. */
	sourceUrl(value: string): this {
		this.#meta.source = { type: "url", value };
		return this;
	}

	/** Add internal URL source info (skill://, agent://, artifact://). */
	sourceInternal(value: string): this {
		this.#meta.source = { type: "internal", value };
		return this;
	}

	/** Add LSP diagnostics. No-op if no messages. */
	diagnostics(summary: string, messages: string[]): this {
		if (messages.length === 0) return this;
		this.#meta.diagnostics = { summary, messages };
		return this;
	}

	/** Get the built OutputMeta, or undefined if empty. */
	get(): OutputMeta | undefined {
		return Object.keys(this.#meta).length > 0 ? this.#meta : undefined;
	}
}

/** Create a new OutputMetaBuilder. */
export function outputMeta(): OutputMetaBuilder {
	return new OutputMetaBuilder();
}

// =============================================================================
// Notice formatting
// =============================================================================

export function formatFullOutputReference(artifactId: string): string {
	return `Read artifact://${artifactId} for full output`;
}

export function formatTruncationMetaNotice(truncation: TruncationMeta): string {
	const range = truncation.shownRange;
	let notice: string;

	if (range && range.end >= range.start) {
		notice = `Showing lines ${range.start}-${range.end} of ${truncation.totalLines}`;
	} else {
		notice = `Showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
	}

	if (truncation.truncatedBy === "bytes") {
		const maxBytes = truncation.maxBytes ?? truncation.outputBytes;
		notice += ` (${formatBytes(maxBytes)} limit)`;
	}

	if (truncation.nextOffset != null) {
		notice += `. Use sel=${truncation.nextOffset} to continue`;
	}

	if (truncation.artifactId != null) {
		notice += `. ${formatFullOutputReference(truncation.artifactId)}`;
	}

	return notice;
}

/**
 * Format styled artifact reference with warning color and brackets.
 * For TUI rendering of truncation warnings.
 */
export function formatStyledArtifactReference(artifactId: string, theme: Theme): string {
	return theme.fg("warning", formatFullOutputReference(artifactId));
}

/**
 * Format notices from OutputMeta for LLM consumption.
 * Returns empty string if no notices needed.
 */
export function formatOutputNotice(meta: OutputMeta | undefined): string {
	if (!meta) return "";

	const parts: string[] = [];

	// Truncation notice
	if (meta.truncation) {
		parts.push(formatTruncationMetaNotice(meta.truncation));
	}

	// Limit notices
	if (meta.limits?.matchLimit) {
		const l = meta.limits.matchLimit;
		parts.push(`${l.reached} matches limit reached. Use limit=${l.suggestion} for more`);
	}
	if (meta.limits?.resultLimit) {
		const l = meta.limits.resultLimit;
		parts.push(`${l.reached} results limit reached. Use limit=${l.suggestion} for more`);
	}
	if (meta.limits?.headLimit) {
		const l = meta.limits.headLimit;
		parts.push(`${l.reached} results limit reached. Use limit=${l.suggestion} for more`);
	}
	if (meta.limits?.columnTruncated) {
		parts.push(`Some lines truncated to ${meta.limits.columnTruncated.maxColumn} chars`);
	}

	// Diagnostics
	let diagnosticsNotice = "";
	if (meta.diagnostics && meta.diagnostics.messages.length > 0) {
		const d = meta.diagnostics;
		diagnosticsNotice = `\n\nLSP Diagnostics (${d.summary}):\n${formatGroupedDiagnosticMessages(d.messages)}`;
	}

	const notice = parts.length ? `\n\n[${parts.join(". ")}]` : "";
	return notice + diagnosticsNotice;
}

/**
 * Format a styled truncation warning message.
 * Returns null if no truncation metadata present.
 */
export function formatStyledTruncationWarning(meta: OutputMeta | undefined, theme: Theme): string | null {
	if (!meta?.truncation) return null;
	const message = formatTruncationMetaNotice(meta.truncation);
	return theme.fg("warning", wrapBrackets(message, theme));
}

// =============================================================================
// Tool wrapper
// =============================================================================

/**
 * Append output notice to tool result content if meta is present.
 */
function appendOutputNotice(
	content: (TextContent | ImageContent)[],
	meta: OutputMeta | undefined,
): (TextContent | ImageContent)[] {
	const notice = formatOutputNotice(meta);
	if (!notice) return content;

	const result = [...content];
	for (let i = result.length - 1; i >= 0; i--) {
		const item = result[i];
		if (item.type === "text") {
			result[i] = { ...item, text: item.text + notice };
			return result;
		}
	}

	result.push({ type: "text", text: notice.trim() });
	return result;
}

const kUnwrappedExecute = Symbol("OutputMeta.UnwrappedExecute");

// =============================================================================
// Centralized artifact spill for large tool results
// =============================================================================

/** Resolved artifact spill config sourced from the session settings (or schema defaults). */
function getSpillConfig(s: Settings | undefined) {
	const get = <P extends "tools.artifactSpillThreshold" | "tools.artifactTailBytes" | "tools.artifactTailLines">(
		path: P,
	) => s?.get(path) ?? getDefault(path);
	return {
		threshold: get("tools.artifactSpillThreshold") * 1024,
		tailBytes: get("tools.artifactTailBytes") * 1024,
		tailLines: get("tools.artifactTailLines"),
	};
}

/**
 * If the tool result text exceeds RESULT_ARTIFACT_THRESHOLD, save the full
 * output as a session artifact and replace the content with a tail-truncated
 * version plus an artifact reference. Skips when the tool already saved its
 * own artifact (e.g. bash/python via OutputSink).
 */
async function spillLargeResultToArtifact(
	result: AgentToolResult,
	toolName: string,
	context: AgentToolContext | undefined,
): Promise<AgentToolResult> {
	const sessionManager = context?.sessionManager;
	if (!sessionManager) return result;
	if (toolName === "read") return result;
	const { threshold, tailBytes, tailLines } = getSpillConfig(context?.settings);

	// Skip if tool already saved an artifact
	const existingMeta: OutputMeta | undefined = result.details?.meta;
	if (existingMeta?.truncation?.artifactId) return result;

	// Measure total text content
	const textParts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text" && block.text) {
			textParts.push(block.text);
		}
	}
	if (textParts.length === 0) return result;

	const fullText = textParts.length === 1 ? textParts[0] : textParts.join("\n");
	const totalBytes = Buffer.byteLength(fullText, "utf-8");
	if (totalBytes <= threshold) return result;

	// Save full output as artifact
	const artifactId = await sessionManager.saveArtifact(fullText, toolName);
	if (!artifactId) return result;

	// Truncate to tail
	const truncated = truncateTail(fullText, {
		maxBytes: tailBytes,
		maxLines: tailLines,
	});

	// Replace text blocks with single tail-truncated block, keep images
	const newContent: (TextContent | ImageContent)[] = [];
	for (const block of result.content) {
		if (block.type !== "text") {
			newContent.push(block);
		}
	}
	newContent.push({ type: "text", text: truncated.content });

	// Build truncation meta
	const outputLines = truncated.outputLines ?? truncated.totalLines;
	const outputBytes = truncated.outputBytes ?? truncated.totalBytes;
	const shownStart = truncated.totalLines - outputLines + 1;
	const truncationMeta: TruncationMeta = {
		direction: "tail",
		truncatedBy: truncated.truncatedBy ?? "bytes",
		totalLines: truncated.totalLines,
		totalBytes: truncated.totalBytes,
		outputLines,
		outputBytes,
		maxBytes: tailBytes,
		shownRange: { start: shownStart, end: truncated.totalLines },
		artifactId,
	};

	const newMeta: OutputMeta = { ...(existingMeta ?? {}), truncation: truncationMeta };
	const newDetails = { ...(result.details ?? {}), meta: newMeta };

	return { ...result, content: newContent, details: newDetails };
}

// =============================================================================
// Tool wrapper
// =============================================================================

async function wrappedExecute(
	this: AgentTool & { [kUnwrappedExecute]: AgentToolExecFn },
	toolCallId: string,
	params: any,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback,
	context?: AgentToolContext,
): Promise<AgentToolResult> {
	const originalExecute = this[kUnwrappedExecute];

	try {
		let result = await originalExecute.call(this, toolCallId, params, signal, onUpdate, context);

		// Spill large results to artifact, truncate to tail
		result = await spillLargeResultToArtifact(result, this.name, context);

		// Append notices from meta
		const meta: OutputMeta | undefined = result.details?.meta;
		if (meta) {
			return {
				...result,
				content: appendOutputNotice(result.content, meta),
			};
		}
		return result;
	} catch (e) {
		// Re-throw with formatted message so agent-loop sets isError flag
		throw new Error(renderError(e));
	}
}

/**
 * Wrap a tool to:
 * 1. Automatically append output notices based on details.meta
 * 2. Handle ToolError rendering
 */
export function wrapToolWithMetaNotice<T extends AgentTool<any, any, any>>(tool: T): T {
	if (kUnwrappedExecute in tool) {
		return tool;
	}

	const originalExecute = tool.execute;

	return Object.defineProperties(tool, {
		[kUnwrappedExecute]: {
			value: originalExecute,
			enumerable: false,
			configurable: true,
		},
		execute: {
			value: wrappedExecute,
			enumerable: false,
			configurable: true,
			writable: true,
		},
	});
}

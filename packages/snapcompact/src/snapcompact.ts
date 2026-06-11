/**
 * Snapcompact compaction: archive conversation history as dense bitmap images.
 *
 * Instead of asking an LLM to summarize discarded history, the serialized
 * conversation is rendered into square PNG frames of pixel-font text that
 * vision models read back directly, like an archivist at a snapcompact frame
 * reader.
 *
 * The frame shape is provider-aware, following the snapcompact SQuAD evals
 * (`packages/snapcompact`, 200k-token monolithic runs):
 *
 * - **Anthropic** (`8x8r-bw`): unscii-8 square cells, black ink, every line
 *   printed twice with the copy on a pale highlight band. Read at F1 parity
 *   with raw text at ~2x lower cost; the colored variants drew refusals at
 *   scale, the repeated plain shape did not.
 * - **Google** (`8x8r-sent`): same repeated grid with six-hue sentence
 *   coloring (0.90 F1 at ~2.9x lower cost on gemini-3.5-flash).
 * - **OpenAI** (`6x6u-sent`): OpenAI bills a flat ~2.9k tokens per image, so
 *   image count is the only cost lever — unscii-8 Lanczos-stretched to 6x6
 *   cells packs the most readable chars per frame. Frames request
 *   `detail: "original"`; the default `auto` downscale destroys 6px glyphs.
 * - **Unknown providers** default to the Anthropic shape (most
 *   refusal-robust). Gateways that resize images (e.g. OpenRouter normalizes
 *   visual payloads to a fixed token budget) defeat any shape — optical
 *   context fails silently there.
 *
 * The whole pass is local and deterministic — no LLM call, no API key, no
 * latency beyond rendering. Rasterization and PNG encoding happen in native
 * code (`renderSnapcompactPng` in `crates/pi-natives/src/snapcompact.rs`).
 * Frames persist in the compaction entry's `preserveData` and are
 * re-attached to the compaction summary message on every context rebuild.
 */

import type { Api, ImageContent, Message, Model } from "@oh-my-pi/pi-ai";
import { renderSnapcompactPng } from "@oh-my-pi/pi-natives";
import { formatGroupedPaths, prompt } from "@oh-my-pi/pi-utils";
import fileOperationsTemplate from "./prompts/file-operations.md" with { type: "text" };
import snapcompactSummaryPrompt from "./prompts/snapcompact-summary.md" with { type: "text" };

// ============================================================================
// Shapes
// ============================================================================

/** One eval-validated frame shape: font, cell, ink, repetition, and size. */
export interface SnapcompactShape {
	/** Bundled font in the native renderer. */
	font: "5x8" | "8x8";
	/** Target cell advance in pixels; differing from the font's natural cell
	 *  renders via Lanczos stretch (anti-aliased RGB frame). */
	cellWidth: number;
	/** Target cell pitch in pixels. */
	cellHeight: number;
	/** Ink: `sent` cycles six hues at sentence boundaries; `bw` is black. */
	variant: "sent" | "bw";
	/** Each text line is printed this many times; copies after the first sit
	 *  on a pale highlight band (redundancy coding). */
	lineRepeat: number;
	/** Frame edge in pixels. */
	frameSize: number;
	/** Per-frame billed-token estimate for the shape's target provider. */
	frameTokenEstimate: number;
	/** Resolution hint attached to frame images (OpenAI-only). */
	imageDetail?: ImageContent["detail"];
}

/** Eval-validated shapes, keyed by the provider family they won on. */
export const SNAPCOMPACT_SHAPES = {
	/** `8x8r-bw`: unscii square, black ink, lines doubled on highlight bands. */
	anthropic: {
		font: "8x8",
		cellWidth: 8,
		cellHeight: 8,
		variant: "bw",
		lineRepeat: 2,
		frameSize: 1568,
		frameTokenEstimate: 3300,
	},
	/** `8x8r-sent`: the repeated grid with sentence-hue ink. */
	google: {
		font: "8x8",
		cellWidth: 8,
		cellHeight: 8,
		variant: "sent",
		lineRepeat: 2,
		frameSize: 1568,
		frameTokenEstimate: 1100,
	},
	/** `6x6u-sent`: unscii stretched to 6x6 — densest readable cell, fewest
	 *  frames (OpenAI bills per image, ~2.9k tokens flat). */
	openaiDense: {
		font: "8x8",
		cellWidth: 6,
		cellHeight: 6,
		variant: "sent",
		lineRepeat: 1,
		frameSize: 1568,
		frameTokenEstimate: 2900,
		imageDetail: "original",
	},
	/** Original 5x8 X.org shape (pre-shape-table sessions rendered this). */
	legacy: {
		font: "5x8",
		cellWidth: 5,
		cellHeight: 8,
		variant: "sent",
		lineRepeat: 1,
		frameSize: 2576,
		frameTokenEstimate: 3300,
	},
} as const satisfies Record<string, SnapcompactShape>;

/** Runtime guard for shape overrides loaded from config or preserve data. */
export function isSnapcompactShape(value: unknown): value is SnapcompactShape {
	if (!value || typeof value !== "object") return false;
	const shape = value as Record<string, unknown>;
	const font = shape.font;
	const variant = shape.variant;
	const detail = shape.imageDetail;
	return (
		(font === "5x8" || font === "8x8") &&
		typeof shape.cellWidth === "number" &&
		shape.cellWidth > 0 &&
		typeof shape.cellHeight === "number" &&
		shape.cellHeight > 0 &&
		(variant === "sent" || variant === "bw") &&
		typeof shape.lineRepeat === "number" &&
		shape.lineRepeat > 0 &&
		typeof shape.frameSize === "number" &&
		shape.frameSize > 0 &&
		typeof shape.frameTokenEstimate === "number" &&
		shape.frameTokenEstimate > 0 &&
		(detail === undefined || detail === "auto" || detail === "low" || detail === "high" || detail === "original")
	);
}

/** Pick the eval-optimal frame shape for a provider API. */
export function resolveSnapcompactShape(api?: Api): SnapcompactShape {
	switch (api) {
		case "openai-completions":
		case "openai-responses":
		case "openai-codex-responses":
		case "azure-openai-responses":
			return SNAPCOMPACT_SHAPES.openaiDense;
		case "google-generative-ai":
		case "google-gemini-cli":
		case "google-vertex":
			return SNAPCOMPACT_SHAPES.google;
		default:
			// anthropic-messages, bedrock-converse-stream, and anything unknown:
			// the plain repeated grid is the most refusal-robust reader shape.
			return SNAPCOMPACT_SHAPES.anthropic;
	}
}

// ============================================================================
// Constants
// ============================================================================

/** Legacy frame edge in pixels (the 5x8 shape's eval-validated size). New
 *  shapes carry their own `frameSize`. */
export const SNAPCOMPACT_FRAME_SIZE = 2576;

/** Maximum frames carried on a compaction entry. Oldest frames are dropped
 *  first once the budget is exceeded (mirrors how iterative text summaries
 *  fade the oldest detail). */
export const SNAPCOMPACT_MAX_FRAMES = 8;

/** Conservative per-frame token estimate used for context budgeting
 *  (upper bound across shapes: Anthropic bills 1568*1568/750 ≈ 3,278). */
export const SNAPCOMPACT_FRAME_TOKEN_ESTIMATE = 3300;

/** Key under `CompactionEntry.preserveData` holding the frame archive. */
export const SNAPCOMPACT_PRESERVE_KEY = "snapcompact";

// ============================================================================
// Types
// ============================================================================

/** One developed snapcompact frame: a base64 PNG plus its reading geometry. */
export interface SnapcompactFrame {
	/** Base64-encoded PNG. */
	data: string;
	mimeType: string;
	/** Characters per row in the frame grid. */
	cols: number;
	/** Text rows in the frame grid (unique lines, not repeated copies). */
	rows: number;
	/** Characters actually printed onto this frame. */
	chars: number;
	/** Shape metadata (absent on legacy frames, which are 5x8 `sent`). */
	font?: SnapcompactShape["font"];
	variant?: SnapcompactShape["variant"];
	lineRepeat?: number;
	/** Resolution hint forwarded to the provider when re-attaching. */
	detail?: ImageContent["detail"];
}

/** Frame archive persisted under `preserveData[SNAPCOMPACT_PRESERVE_KEY]`. */
export interface SnapcompactArchive {
	/** Frames ordered oldest to newest. */
	frames: SnapcompactFrame[];
	/** Characters currently readable across all frames. */
	totalChars: number;
	/** Characters dropped so far to respect the frame budget. */
	truncatedChars: number;
}

export interface SnapcompactGeometry {
	cols: number;
	rows: number;
	/** Characters that fit one frame (cols * rows). */
	capacity: number;
}

export interface SnapcompactOptions<TMessage = Message> extends SnapcompactSerializeOptions {
	/** App-level message transformer (same contract as agent-core's `SummaryOptions.convertToLlm`). */
	convertToLlm?: SnapcompactConvertToLlm<TMessage>;
	/** Model whose provider API selects the frame shape. */
	model?: Pick<Model, "api">;
	/** Explicit shape override; wins over `model`. */
	shape?: SnapcompactShape;
	/** Frame edge in pixels. Defaults to the shape's `frameSize`. */
	frameSize?: number;
	/** Frame budget. Defaults to {@link SNAPCOMPACT_MAX_FRAMES}. */
	maxFrames?: number;
}

/** Result of rendering one frame. */
export interface RenderedFrame {
	/** Base64-encoded PNG, as returned by the native renderer. */
	data: string;
	cols: number;
	rows: number;
	/** Characters printed (ink toggles excluded; input may be shorter than capacity). */
	chars: number;
}

// ============================================================================
// Compaction data contracts
// ============================================================================

export interface SnapcompactFileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export interface SnapcompactCompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

export interface SnapcompactCompactionPreparation<TMessage = Message> {
	/** UUID of first entry to keep. */
	firstKeptEntryId: string;
	/** Messages that will be archived and discarded. */
	messagesToSummarize: TMessage[];
	/** Messages that will be archived as the split-turn prefix, if any. */
	turnPrefixMessages: TMessage[];
	tokensBefore: number;
	/** Summary from previous compaction, for continuity when no prior snapcompact archive exists. */
	previousSummary?: string;
	/** Preserved opaque compaction payload from the previous compaction, if any. */
	previousPreserveData?: Record<string, unknown>;
	/** File operations extracted by the host agent. */
	fileOps: SnapcompactFileOperations;
}

export interface SnapcompactCompactionResult<T = SnapcompactCompactionDetails> {
	summary: string;
	shortSummary?: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: T;
	preserveData?: Record<string, unknown>;
}

export type SnapcompactConvertToLlm<TMessage = Message> = (messages: TMessage[]) => Message[];

function defaultConvertToLlm<TMessage>(messages: TMessage[]): Message[] {
	return messages as unknown as Message[];
}

// ============================================================================
// File operation helpers
// ============================================================================

export function createSnapcompactFileOps(): SnapcompactFileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

export function computeSnapcompactFileLists(fileOps: SnapcompactFileOperations): SnapcompactCompactionDetails {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readFiles = [...fileOps.read].filter(file => !modified.has(file)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles, modifiedFiles };
}

/**
 * Format file operations as one `<files>` tag: a grouped, prefix-folded
 * directory tree (find-tool shape) with a ` (Read)` / ` (Write)` / ` (RW)`
 * marker per file. `readSet` is the cumulative read set (`fileOps.read`),
 * used to tell modified files that were also read (RW) from blind writes.
 */
const FILE_OPERATION_SUMMARY_LIMIT = 20;

function stripFileOperationTags(summary: string): string {
	// Legacy <read-files>/<modified-files> tags are still stripped so summaries
	// written before the combined <files> tag self-heal on the next compaction.
	return summary
		.replace(/<files>[\s\S]*?<\/files>\s*/g, "")
		.replace(/<read-files>[\s\S]*?<\/read-files>\s*/g, "")
		.replace(/<modified-files>[\s\S]*?<\/modified-files>\s*/g, "")
		.trimEnd();
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[], readSet?: ReadonlySet<string>): string {
	if (readFiles.length === 0 && modifiedFiles.length === 0) return "";
	const mode = new Map<string, "Read" | "Write" | "RW">();
	for (const file of readFiles) mode.set(file, "Read");
	for (const file of modifiedFiles) mode.set(file, readSet?.has(file) ? "RW" : "Write");
	const all = [...mode.keys()].sort();
	let files = formatGroupedPaths(all.slice(0, FILE_OPERATION_SUMMARY_LIMIT), path => ` (${mode.get(path)})`);
	if (all.length > FILE_OPERATION_SUMMARY_LIMIT) {
		files += `\n… (${all.length - FILE_OPERATION_SUMMARY_LIMIT} more files omitted)`;
	}
	return prompt.render(fileOperationsTemplate, { files });
}

export function upsertSnapcompactFileOperations(
	summary: string,
	readFiles: string[],
	modifiedFiles: string[],
	readSet?: ReadonlySet<string>,
): string {
	const baseSummary = stripFileOperationTags(summary);
	const fileOperations = formatFileOperations(readFiles, modifiedFiles, readSet);
	if (!fileOperations) return baseSummary;
	if (!baseSummary) return fileOperations;
	return `${baseSummary}\n\n${fileOperations}`;
}

// ============================================================================
// Message serialization
// ============================================================================

/** Default per-tool-result character cap in serialized history. */
export const SNAPCOMPACT_TOOL_RESULT_MAX_CHARS = 2000;

/** Default per-argument-value character cap inside serialized tool calls
 *  (write/edit bodies otherwise dump whole files into the archive). */
export const SNAPCOMPACT_TOOL_ARG_MAX_CHARS = 500;

/** Default character cap across one tool call's full serialized argument list. */
export const SNAPCOMPACT_TOOL_CALL_MAX_CHARS = 2000;

/** Default fraction of a truncation budget spent on the head; the remainder
 *  keeps the tail, where command errors and test failures usually land. */
export const SNAPCOMPACT_TRUNCATE_HEAD_RATIO = 0.6;

/** Zero-width ink toggles understood by the native renderer (shift-out/in):
 *  text between them prints in dim gray ink without occupying a cell. */
export const SNAPCOMPACT_DIM_ON = "\u000e";
export const SNAPCOMPACT_DIM_OFF = "\u000f";

/** Character budgets applied while serializing discarded history for frame
 *  rendering. Pass `Infinity` to disable an individual cap. */
export interface SnapcompactSerializeOptions {
	/** Per-tool-result cap. Defaults to {@link SNAPCOMPACT_TOOL_RESULT_MAX_CHARS}. */
	toolResultMaxChars?: number;
	/** Per-argument-value cap. Defaults to {@link SNAPCOMPACT_TOOL_ARG_MAX_CHARS}. */
	toolArgMaxChars?: number;
	/** Whole-argument-list cap per call. Defaults to {@link SNAPCOMPACT_TOOL_CALL_MAX_CHARS}. */
	toolCallMaxChars?: number;
	/** Head share of each budget, clamped to [0, 1]. Defaults to {@link SNAPCOMPACT_TRUNCATE_HEAD_RATIO}. */
	truncateHeadRatio?: number;
	/** Print tool-result text in dim gray ink so archived conversation reads
	 *  louder than archived tool noise. Defaults to `true`. */
	dimToolResults?: boolean;
}

/** Keep the head and tail of `text`, eliding the middle beyond `maxChars`. */
function truncateForSummary(text: string, maxChars: number, headRatio: number): string {
	if (text.length <= maxChars) return text;
	const ratio = Math.min(Math.max(headRatio, 0), 1);
	const headChars = Math.round(maxChars * ratio);
	const tailChars = maxChars - headChars;
	const elided = text.length - maxChars;
	const tail = tailChars > 0 ? text.slice(-tailChars) : "";
	return `${text.slice(0, headChars)} [... ${elided} chars elided ...] ${tail}`;
}

const DIM_MARKERS = /[\u000e\u000f]/g;

/** Strip stray ink toggles from raw content so it cannot forge dim spans. */
function stripDimMarkers(text: string): string {
	return text.replace(DIM_MARKERS, "");
}

export function serializeSnapcompactConversation(messages: Message[], options?: SnapcompactSerializeOptions): string {
	const toolResultMaxChars = options?.toolResultMaxChars ?? SNAPCOMPACT_TOOL_RESULT_MAX_CHARS;
	const toolArgMaxChars = options?.toolArgMaxChars ?? SNAPCOMPACT_TOOL_ARG_MAX_CHARS;
	const toolCallMaxChars = options?.toolCallMaxChars ?? SNAPCOMPACT_TOOL_CALL_MAX_CHARS;
	const headRatio = options?.truncateHeadRatio ?? SNAPCOMPACT_TRUNCATE_HEAD_RATIO;
	const dimToolResults = options?.dimToolResults !== false;
	const parts: string[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((content): content is { type: "text"; text: string } => content.type === "text")
							.map(content => content.text)
							.join("");
			if (content) parts.push(`[User]: ${stripDimMarkers(content)}`);
		} else if (msg.role === "assistant") {
			const textParts: string[] = [];
			const thinkingParts: string[] = [];
			const toolCalls: string[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					textParts.push(stripDimMarkers(block.text));
				} else if (block.type === "thinking") {
					thinkingParts.push(stripDimMarkers(block.thinking));
				} else if (block.type === "toolCall") {
					const args = block.arguments as Record<string, unknown>;
					const argsStr = truncateForSummary(
						Object.entries(args)
							.map(
								([key, value]) =>
									`${key}=${truncateForSummary(JSON.stringify(value) ?? "undefined", toolArgMaxChars, headRatio)}`,
							)
							.join(", "),
						toolCallMaxChars,
						headRatio,
					);
					toolCalls.push(`${block.name}(${argsStr})`);
				}
			}

			if (thinkingParts.length > 0) {
				parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
			}
			if (textParts.length > 0) {
				parts.push(`[Assistant]: ${textParts.join("\n")}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
		} else if (msg.role === "toolResult") {
			const content = msg.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map(block => block.text)
				.join("");
			if (content) {
				// Args above are JSON-escaped, so only raw result text can carry toggles.
				const body = truncateForSummary(stripDimMarkers(content), toolResultMaxChars, headRatio);
				parts.push(
					dimToolResults
						? `[Tool result]: ${SNAPCOMPACT_DIM_ON}${body}${SNAPCOMPACT_DIM_OFF}`
						: `[Tool result]: ${body}`,
				);
			}
		}
	}

	return parts.join("\n\n");
}

// ============================================================================
// Preserve-data helpers
// ============================================================================

const OPENAI_REMOTE_COMPACTION_PRESERVE_KEY = "openaiRemoteCompaction";

function stripOpenAiRemoteCompactionPreserveData(
	preserveData: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!preserveData || !(OPENAI_REMOTE_COMPACTION_PRESERVE_KEY in preserveData)) {
		return preserveData;
	}
	const { [OPENAI_REMOTE_COMPACTION_PRESERVE_KEY]: _removed, ...rest } = preserveData;
	return Object.keys(rest).length > 0 ? rest : undefined;
}

// ============================================================================
// Text normalization
// ============================================================================

/** Folds for common non-Latin-1 characters the bundled fonts cannot draw. */
const CHAR_FOLD: Record<string, string> = {
	"\u2018": "'",
	"\u2019": "'",
	"\u201a": "'",
	"\u201b": "'",
	"\u201c": '"',
	"\u201d": '"',
	"\u201e": '"',
	"\u2013": "-",
	"\u2014": "-",
	"\u2015": "-",
	"\u2212": "-",
	"\u2026": "...",
	"\u2022": "*",
	"\u25cf": "*",
	"\u25a0": "*",
	"\u25aa": "*",
	"\u2190": "<-",
	"\u2192": "->",
	"\u21d2": "=>",
	"\u2713": "v",
	"\u2714": "v",
	"\u2717": "x",
	"\u2718": "x",
};

/**
 * Prepare text for printing: collapse whitespace runs (incl. newlines) to
 * single spaces — the eval's "paragraph breaks collapsed to spaces" format —
 * then fold everything outside the fonts' ASCII + Latin-1 coverage to ASCII
 * approximations (`?` as the last resort).
 */
export function normalizeForSnapcompact(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	let out = "";
	for (const ch of collapsed) {
		const cp = ch.codePointAt(0) as number;
		if (cp < 0x7f || (cp >= 0xa0 && cp <= 0xff)) {
			out += ch;
			continue;
		}
		const fold = CHAR_FOLD[ch];
		if (fold !== undefined) {
			out += fold;
		} else if (cp >= 0x2500 && cp <= 0x257f) {
			// Box drawing: keep table skeletons legible.
			out += cp === 0x2502 || cp === 0x2503 ? "|" : cp === 0x2500 || cp === 0x2501 ? "-" : "+";
		} else {
			out += "?";
		}
	}
	return out;
}

// ============================================================================
// Rendering
// ============================================================================

export function snapcompactGeometry(shape: SnapcompactShape, size: number = shape.frameSize): SnapcompactGeometry {
	const cols = Math.floor(size / shape.cellWidth);
	const rows = Math.floor(size / shape.cellHeight / shape.lineRepeat);
	return { cols, rows, capacity: cols * rows };
}

/** Render one snapcompact frame from already-normalized text. */
export function renderSnapcompactFrame(
	text: string,
	shape: SnapcompactShape,
	size: number = shape.frameSize,
): RenderedFrame {
	const { cols, rows, capacity } = snapcompactGeometry(shape, size);
	const visible = text.length - (text.match(DIM_MARKERS)?.length ?? 0);
	const chars = Math.min(visible, capacity);
	const data = renderSnapcompactPng(text, {
		size,
		font: shape.font,
		cellWidth: shape.cellWidth,
		cellHeight: shape.cellHeight,
		variant: shape.variant,
		lineRepeat: shape.lineRepeat,
	});
	return { data, cols, rows, chars };
}

// ============================================================================
// Archive helpers
// ============================================================================

/** Validate and extract a persisted frame archive from `preserveData`. */
export function getPreservedSnapcompactArchive(
	preserveData: Record<string, unknown> | undefined,
): SnapcompactArchive | undefined {
	const candidate = preserveData?.[SNAPCOMPACT_PRESERVE_KEY];
	if (!candidate || typeof candidate !== "object") return undefined;
	const archive = candidate as SnapcompactArchive;
	if (!Array.isArray(archive.frames)) return undefined;
	const frames = archive.frames.filter(
		frame =>
			!!frame &&
			typeof frame.data === "string" &&
			frame.data.length > 0 &&
			typeof frame.mimeType === "string" &&
			typeof frame.cols === "number" &&
			typeof frame.rows === "number" &&
			typeof frame.chars === "number",
	);
	if (frames.length === 0) return undefined;
	return {
		frames,
		totalChars: typeof archive.totalChars === "number" ? archive.totalChars : 0,
		truncatedChars: typeof archive.truncatedChars === "number" ? archive.truncatedChars : 0,
	};
}

/** Convert archive frames into LLM image blocks (oldest first). */
export function snapcompactImages(archive: SnapcompactArchive): ImageContent[] {
	return archive.frames.map(frame => ({
		type: "image",
		data: frame.data,
		mimeType: frame.mimeType,
		...(frame.detail ? { detail: frame.detail } : {}),
	}));
}

// ============================================================================
// Compaction entry point
// ============================================================================

/**
 * Run a snapcompact compaction over prepared messages. Fully local: serializes
 * the discarded history, prints it onto PNG frames in the provider-optimal
 * shape, merges previously archived frames (oldest dropped beyond the
 * budget), and produces a deterministic summary explaining how to read the
 * frames.
 *
 * Frames archived under a different shape (provider switches, legacy 5x8
 * sessions) are kept as-is — each frame carries its own geometry, and the
 * summary describes the newest shape while noting that older frames may
 * differ.
 *
 * If the previous compaction was text-based, its summary is printed at the
 * head of the frame archive as `[Summary of earlier history]` so no continuity is lost.
 */
export async function snapcompactCompact<TMessage = Message>(
	preparation: SnapcompactCompactionPreparation<TMessage>,
	options?: SnapcompactOptions<TMessage>,
): Promise<SnapcompactCompactionResult> {
	const { firstKeptEntryId, tokensBefore, previousSummary, previousPreserveData, fileOps } = preparation;
	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no ID - session may need migration");
	}
	const shape = options?.shape ?? resolveSnapcompactShape(options?.model?.api);
	const frameSize = options?.frameSize ?? shape.frameSize;
	const maxFrames = Math.max(1, options?.maxFrames ?? SNAPCOMPACT_MAX_FRAMES);
	const geometry = snapcompactGeometry(shape, frameSize);

	const messages = preparation.messagesToSummarize.concat(preparation.turnPrefixMessages);
	const llmMessages = (options?.convertToLlm ?? defaultConvertToLlm)(messages);
	let archiveText = normalizeForSnapcompact(serializeSnapcompactConversation(llmMessages, options));

	const previousArchive = getPreservedSnapcompactArchive(previousPreserveData);
	const includedPreviousSummary = !previousArchive && !!previousSummary;
	if (includedPreviousSummary && previousSummary) {
		const head = `[Summary of earlier history] ${normalizeForSnapcompact(previousSummary)}`;
		archiveText = archiveText.length > 0 ? `${head} [Recent conversation] ${archiveText}` : head;
	}

	let truncatedChars = previousArchive?.truncatedChars ?? 0;

	const newFrames: SnapcompactFrame[] = [];
	let dimOpen = false;
	for (let offset = 0; offset < archiveText.length; offset += geometry.capacity) {
		let chunk = archiveText.slice(offset, offset + geometry.capacity);
		// Re-open a dim span that the previous frame boundary cut through.
		if (dimOpen) chunk = SNAPCOMPACT_DIM_ON + chunk;
		dimOpen = chunk.lastIndexOf(SNAPCOMPACT_DIM_ON) > chunk.lastIndexOf(SNAPCOMPACT_DIM_OFF);
		const rendered = renderSnapcompactFrame(chunk, shape, frameSize);
		newFrames.push({
			data: rendered.data,
			mimeType: "image/png",
			cols: rendered.cols,
			rows: rendered.rows,
			chars: rendered.chars,
			font: shape.font,
			variant: shape.variant,
			lineRepeat: shape.lineRepeat,
			...(shape.imageDetail ? { detail: shape.imageDetail } : {}),
		});
		// Keep the event loop responsive between native render passes.
		await Bun.sleep(0);
	}

	const frames = [...(previousArchive?.frames ?? []), ...newFrames];
	if (frames.length > maxFrames) {
		// Pin the earliest frame: it anchors the session head (the original
		// request, or the filmed summary of even older history) the way the
		// LLM-summary strategies keep the original goal alive across rounds.
		// Eviction removes the oldest *unpinned* frames, so the archive fades
		// from the middle out — head and tail survive. With a budget of one
		// frame the pin is moot; keep the newest frame instead.
		const evictStart = maxFrames >= 2 ? 1 : 0;
		const dropped = frames.splice(evictStart, frames.length - maxFrames);
		for (const frame of dropped) truncatedChars += frame.chars;
	}
	const totalChars = frames.reduce((sum, frame) => sum + frame.chars, 0);
	const mixedShapes = frames.some(
		frame =>
			frame.cols !== geometry.cols ||
			frame.rows !== geometry.rows ||
			(frame.variant ?? "sent") !== shape.variant ||
			(frame.lineRepeat ?? 1) !== shape.lineRepeat,
	);

	let summary: string;
	if (frames.length === 0) {
		summary = "No prior history.";
	} else {
		summary = prompt.render(snapcompactSummaryPrompt, {
			frameCount: frames.length,
			multipleFrames: frames.length > 1,
			fontCell: `${shape.cellWidth}x${shape.cellHeight}`,
			cols: geometry.cols,
			rows: geometry.rows,
			sentenceInk: shape.variant === "sent",
			lineRepeated: shape.lineRepeat > 1,
			dimmedToolResults: options?.dimToolResults !== false,
			mixedShapes,
			totalChars,
			truncatedChars,
			includedPreviousSummary,
		});
	}
	const { readFiles, modifiedFiles } = computeSnapcompactFileLists(fileOps);
	summary = upsertSnapcompactFileOperations(summary, readFiles, modifiedFiles, fileOps.read);

	// A snapcompact pass replaces any provider-side replacement history; strip the
	// OpenAI remote-compaction payload like the default summarizer path does.
	const basePreserve = stripOpenAiRemoteCompactionPreserveData(previousPreserveData) ?? {};
	const archive: SnapcompactArchive = { frames, totalChars, truncatedChars };

	return {
		summary,
		shortSummary: `Archived ${totalChars.toLocaleString()} chars of history onto ${frames.length} snapcompact frame${frames.length === 1 ? "" : "s"}`,
		firstKeptEntryId,
		tokensBefore,
		details: { readFiles, modifiedFiles },
		preserveData: { ...basePreserve, [SNAPCOMPACT_PRESERVE_KEY]: archive },
	};
}

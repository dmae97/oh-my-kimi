/**
 * Snapcompact compaction: archive conversation history as dense bitmap images.
 *
 * Instead of asking an LLM to summarize discarded history, the serialized
 * conversation is rendered into PNG frames of pixel-font text that vision
 * models read back directly, like an archivist at a snapcompact frame
 * reader. Frames are `frameSize` wide; their height hugs the text rows
 * actually printed, so a partially filled frame never bills blank rows.
 *
 * The frame shape is provider-aware, following the snapcompact SQuAD evals
 * (`packages/snapcompact`, 200k-token monolithic runs):
 *
 * - **Anthropic** (`6x12-dim`): X.org 6x12 glyphs, black ink, stopwords
 *   dimmed gray. Production mono eval on claude-fable: f1 .840 vs .877 for
 *   the repeated `8x8r-bw` grid — within noise at n=25 — at 37% lower cost
 *   (12 frames vs 21 per 400k chars). `8x8r-bw` remains the max-recall
 *   choice via the shape setting; it never refused in any probe.
 * - **Google** (`doc-8on16-sent-dim`): two word-wrapped newspaper columns of
 *   8x13 glyphs on a 16px pitch, sentence-hue ink, stopwords dimmed (0.90 F1
 *   on gemini-3.5-flash vs 0.85 for the repeated grid, at lower cost; same
 *   shape won the chunked round-2 evals).
 * - **OpenAI** (`8on16-bw`): 8x13 glyphs on a patch-aligned 16px pitch, black
 *   ink (gpt-5.5 mono F1 0.851 vs 0.602 for the previous dense `6x6u-sent`).
 *   OpenAI bills a flat ~2.9k tokens per image; frames request
 *   `detail: "original"` since the default `auto` downscale destroys glyphs.
 * - **Unknown providers** default to the Anthropic shape. Gateways can
 *   defeat any shape silently: OpenRouter enforces a per-model image cap
 *   (measured: 8 images for glm-4.6v — frames past the cap are dropped with
 *   no error, billed tokens plateau exactly at 8x frame cost). The same
 *   frames routed direct to the vendor read fine (glm f1 .20 -> .78), so
 *   `providerImageBudget` caps per-request images per provider (OpenRouter
 *   8, unknown 5) and `compact()` keeps any archive overflow as a text tail
 *   on the summary instead of rendering frames that would be dropped.
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
export interface Shape {
	/** Bundled font in the native renderer. */
	font: "5x8" | "8x8" | "6x12" | "8x13";
	/** Target cell advance in pixels; differing from the font's natural cell
	 *  renders via Lanczos stretch (anti-aliased RGB frame). */
	cellWidth: number;
	/** Target cell pitch in pixels. */
	cellHeight: number;
	/** `false` → glyphs drawn at natural size on the cell pitch (8on16);
	 *  `true`/`undefined` → legacy auto Lanczos stretch when cell ≠ natural. */
	stretch?: boolean;
	/** Ink: `sent` cycles six hues at sentence boundaries; `bw` is black. */
	variant: "sent" | "bw";
	/** Print stopwords in dim ink (research `dim`/`sent-dim` variants). */
	stopwordDim?: boolean;
	/** 1/undefined = row-major grid; 2 = two word-wrapped newspaper columns
	 *  (research `doc`). */
	columns?: number;
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

/** Geometry half of a {@link Shape}: everything except provider billing. */
export type ShapeGeometry = Omit<Shape, "frameTokenEstimate" | "imageDetail">;

/**
 * Frame variants exercised by the SQuAD evals in `research/` that the native
 * renderer reproduces faithfully, keyed by their research names. Font codes:
 * `8x8u` unscii square cell, `8x8r` unscii with every line printed twice
 * (redundancy coding), `6x6u` unscii Lanczos-squeezed to 6x6 (densest
 * readable cell), `5x8` the X.org legacy font on its 2576px frame, `6x12`
 * and `8x13` the X.org misc fonts, `8on16` 8x13 glyphs on an 8x16 cell pitch
 * (no stretch, extra leading), `doc-` prefixed shapes a two-column
 * word-wrapped newspaper layout. Ink: `sent` cycles six hues at sentence
 * boundaries, `bw` is plain black, `-dim` suffix prints stopwords in gray.
 */
export const SHAPE_VARIANTS = {
	"8x8r-bw": { font: "8x8", cellWidth: 8, cellHeight: 8, variant: "bw", lineRepeat: 2, frameSize: 1568 },
	"8x8r-sent": { font: "8x8", cellWidth: 8, cellHeight: 8, variant: "sent", lineRepeat: 2, frameSize: 1568 },
	"8x8u-bw": { font: "8x8", cellWidth: 8, cellHeight: 8, variant: "bw", lineRepeat: 1, frameSize: 1568 },
	"8x8u-sent": { font: "8x8", cellWidth: 8, cellHeight: 8, variant: "sent", lineRepeat: 1, frameSize: 1568 },
	"6x6u-bw": { font: "8x8", cellWidth: 6, cellHeight: 6, variant: "bw", lineRepeat: 1, frameSize: 1568 },
	"6x6u-sent": { font: "8x8", cellWidth: 6, cellHeight: 6, variant: "sent", lineRepeat: 1, frameSize: 1568 },
	"5x8-bw": { font: "5x8", cellWidth: 5, cellHeight: 8, variant: "bw", lineRepeat: 1, frameSize: 2576 },
	"5x8-sent": { font: "5x8", cellWidth: 5, cellHeight: 8, variant: "sent", lineRepeat: 1, frameSize: 2576 },
	"6x12-dim": {
		font: "6x12",
		cellWidth: 6,
		cellHeight: 12,
		variant: "bw",
		stopwordDim: true,
		lineRepeat: 1,
		frameSize: 1568,
	},
	"8x13-bw": { font: "8x13", cellWidth: 8, cellHeight: 13, variant: "bw", lineRepeat: 1, frameSize: 1568 },
	"8on16-bw": {
		font: "8x13",
		cellWidth: 8,
		cellHeight: 16,
		stretch: false,
		variant: "bw",
		lineRepeat: 1,
		frameSize: 1568,
	},
	"doc-8on16-bw": {
		font: "8x13",
		cellWidth: 8,
		cellHeight: 16,
		stretch: false,
		variant: "bw",
		columns: 2,
		lineRepeat: 1,
		frameSize: 1568,
	},
	"doc-8on16-sent": {
		font: "8x13",
		cellWidth: 8,
		cellHeight: 16,
		stretch: false,
		variant: "sent",
		columns: 2,
		lineRepeat: 1,
		frameSize: 1568,
	},
	"doc-8on16-sent-dim": {
		font: "8x13",
		cellWidth: 8,
		cellHeight: 16,
		stretch: false,
		variant: "sent",
		stopwordDim: true,
		columns: 2,
		lineRepeat: 1,
		frameSize: 1568,
	},
} as const satisfies Record<string, ShapeGeometry>;

/** Research name of one renderable frame variant. */
export type ShapeVariantName = keyof typeof SHAPE_VARIANTS;

/** All variant names, in declaration order (for settings enums). */
export const SHAPE_VARIANT_NAMES = Object.keys(SHAPE_VARIANTS) as readonly ShapeVariantName[];

/** Runtime guard for variant names loaded from config. */
export function isShapeVariantName(value: unknown): value is ShapeVariantName {
	return typeof value === "string" && value in SHAPE_VARIANTS;
}

/** Provider families with distinct image billing. */
type BillingFamily = "anthropic" | "google" | "openai";

function billingFamily(api?: Api): BillingFamily {
	switch (api) {
		case "openai-completions":
		case "openai-responses":
		case "openai-codex-responses":
		case "azure-openai-responses":
			return "openai";
		case "google-generative-ai":
		case "google-gemini-cli":
		case "google-vertex":
			return "google";
		default:
			// anthropic-messages, bedrock-converse-stream, and anything unknown
			// share Anthropic's pixel-area pricing as the safe ceiling.
			return "anthropic";
	}
}

/** Eval-measured per-frame billing for a standard 1568px frame, by family. */
const FAMILY_BILLING: Record<BillingFamily, Pick<Shape, "frameTokenEstimate" | "imageDetail">> = {
	// Anthropic bills pixel area: 1568*1568/750 ≈ 3,278.
	anthropic: { frameTokenEstimate: 3300 },
	google: { frameTokenEstimate: 1100 },
	// OpenAI bills per image at `original` detail, ~2.9k tokens flat.
	openai: { frameTokenEstimate: 2900, imageDetail: "original" },
};

/** Attach a provider family's billing to a variant geometry. */
function priceShape(base: ShapeGeometry, family: BillingFamily): Shape {
	const billing = FAMILY_BILLING[family];
	return {
		...base,
		// Family estimates are measured at 1568px; the larger legacy frame
		// keeps the conservative pixel-area ceiling everywhere.
		frameTokenEstimate:
			base.frameSize > 1568 ? FAMILY_BILLING.anthropic.frameTokenEstimate : billing.frameTokenEstimate,
		...(billing.imageDetail ? { imageDetail: billing.imageDetail } : {}),
	};
}

/** Eval-validated shapes, keyed by the provider family they won on. */
export const SHAPES = {
	/** `6x12-dim`: X.org 6x12 glyphs, black ink with stopwords dimmed gray.
	 *  Production mono eval on claude-fable: f1 .840 vs .877 for the repeated
	 *  `8x8r-bw` grid (within noise at n=25) at 37% lower cost — 12 frames
	 *  instead of 21 per 400k chars. Never refused in any run. */
	anthropic: priceShape(SHAPE_VARIANTS["6x12-dim"], "anthropic"),
	/** `doc-8on16-sent-dim`: two word-wrapped columns, sentence hues, dimmed
	 *  stopwords. Production mono eval on gemini-3.5-flash: f1 .900 vs .853
	 *  for the repeated grid, at lower cost; also the chunked round-2 winner. */
	google: priceShape(SHAPE_VARIANTS["doc-8on16-sent-dim"], "google"),
	/** `8on16-bw`: 8x13 X.org glyphs on a 16px pitch, black ink. Mono eval on
	 *  gpt-5.5 (200k-token single request, n=50): f1 .851 vs .602 for the
	 *  previous `6x6u-sent` default at near-equal total cost; chunked exp14
	 *  scored it .906. */
	openai: priceShape(SHAPE_VARIANTS["8on16-bw"], "openai"),
	/** Original 5x8 X.org shape (pre-shape-table sessions rendered this). */
	legacy: priceShape(SHAPE_VARIANTS["5x8-sent"], "anthropic"),
} satisfies Record<string, Shape>;

/** Runtime guard for shape overrides loaded from config or preserve data. */
export function isShape(value: unknown): value is Shape {
	if (!value || typeof value !== "object") return false;
	const shape = value as Record<string, unknown>;
	const font = shape.font;
	const variant = shape.variant;
	const detail = shape.imageDetail;
	return (
		(font === "5x8" || font === "8x8" || font === "6x12" || font === "8x13") &&
		typeof shape.cellWidth === "number" &&
		shape.cellWidth > 0 &&
		typeof shape.cellHeight === "number" &&
		shape.cellHeight > 0 &&
		(shape.stretch === undefined || typeof shape.stretch === "boolean") &&
		(variant === "sent" || variant === "bw") &&
		(shape.stopwordDim === undefined || typeof shape.stopwordDim === "boolean") &&
		(shape.columns === undefined || shape.columns === 1 || shape.columns === 2) &&
		typeof shape.lineRepeat === "number" &&
		shape.lineRepeat > 0 &&
		typeof shape.frameSize === "number" &&
		shape.frameSize > 0 &&
		typeof shape.frameTokenEstimate === "number" &&
		shape.frameTokenEstimate > 0 &&
		(detail === undefined || detail === "auto" || detail === "low" || detail === "high" || detail === "original")
	);
}

/** Eval-winning variant per provider family (billing fallback when the
 *  model id matches no known reader line). */
const FAMILY_VARIANT: Record<BillingFamily, ShapeVariantName> = {
	anthropic: "6x12-dim",
	google: "doc-8on16-sent-dim",
	openai: "8on16-bw",
};

const FAMILY_SHAPE: Record<BillingFamily, Shape> = {
	anthropic: SHAPES.anthropic,
	google: SHAPES.google,
	openai: SHAPES.openai,
};

/** Eval-winning variant per model line, matched against the model id. The
 *  wire API only identifies the gateway — a Claude served through Vertex or
 *  OpenRouter still reads best with its own shape. Patterns cover the model
 *  lines the mono evals measured; everything else falls back to the API
 *  family's winner. */
const MODEL_VARIANTS: readonly (readonly [RegExp, ShapeVariantName])[] = [
	// claude-fable .840 / opus .800 mono; within noise of 8x8r-bw at ~40% lower cost.
	[/claude/i, "6x12-dim"],
	// gemini-3.5-flash .900 mono; also the chunked round-2 winner.
	[/gemini/i, "doc-8on16-sent-dim"],
	// gpt-5.5 .851 mono / .906 chunked.
	[/gpt|codex/i, "8on16-bw"],
	// kimi-k2.6 .973 mono at <=8 frames per request.
	[/kimi/i, "8on16-bw"],
	// glm-4.6v .780 mono via direct vendor routing.
	[/glm/i, "8on16-bw"],
];

/** Eval-ideal variant for a model id, or undefined when unmeasured. */
export function idealShapeVariant(modelId: string): ShapeVariantName | undefined {
	return MODEL_VARIANTS.find(([pattern]) => pattern.test(modelId))?.[1];
}

/** What will read the frames: the wire API (billing) and model id (shape). */
export interface ShapeTarget {
	api?: Api;
	id?: string;
}

/**
 * Pick the frame shape for a reader. An explicit `variant` (anything but
 * `"auto"`) forces that geometry; otherwise the model id selects the
 * eval-winning shape for its model line, falling back to the API family's
 * winner when the model is unmeasured. Billing (token estimate, detail
 * hint) always follows the API family actually carrying the request.
 * Accepts a full pi-ai `Model` or any `{ api, id }` subset.
 */
export function resolveShape(model?: ShapeTarget, variant?: ShapeVariantName | "auto"): Shape {
	const family = billingFamily(model?.api);
	const name =
		variant && variant !== "auto" ? variant : (model?.id && idealShapeVariant(model.id)) || FAMILY_VARIANT[family];
	return name === FAMILY_VARIANT[family] ? FAMILY_SHAPE[family] : priceShape(SHAPE_VARIANTS[name], family);
}

// ============================================================================
// Constants
// ============================================================================

/** Legacy frame edge in pixels (the 5x8 shape's eval-validated size). New
 *  shapes carry their own `frameSize`. */
export const FRAME_SIZE = 2576;

/** Maximum frames carried on a compaction entry. Oldest frames are dropped
 *  first once the budget is exceeded (mirrors how iterative text summaries
 *  fade the oldest detail). */
export const MAX_FRAMES = 8;

/** Conservative per-frame token estimate used for context budgeting
 *  (upper bound across shapes: Anthropic bills 1568*1568/750 ≈ 3,278). */
export const FRAME_TOKEN_ESTIMATE = 3300;

/**
 * Per-request image-count budgets by provider id. Routers and smaller
 * providers enforce hard caps and silently DROP images past them (measured:
 * OpenRouter caps at 8 — images 9+ vanish with no error and billed tokens
 * plateau at 8x frame cost). First-party APIs allow far more; their values
 * are conservative policy caps well under the measured hard limits
 * (Anthropic 100, OpenAI 500, Gemini ~2500).
 */
export const PROVIDER_IMAGE_BUDGETS: Record<string, number> = {
	anthropic: 90,
	"amazon-bedrock": 90,
	openai: 200,
	google: 200,
	"google-vertex": 200,
	"google-gemini-cli": 200,
	openrouter: 8,
};

/** Safe floor for unknown providers (strictest mainstream measured: Groq ~5). */
export const DEFAULT_PROVIDER_IMAGE_BUDGET = 5;

/** Per-request image budget for `provider`; unknown providers get the floor. */
export function providerImageBudget(provider: string | undefined): number {
	return (provider !== undefined ? PROVIDER_IMAGE_BUDGETS[provider] : undefined) ?? DEFAULT_PROVIDER_IMAGE_BUDGET;
}

/** Archive frame budget for `provider`: its image budget clamped to {@link MAX_FRAMES}. */
export function providerFrameBudget(provider: string | undefined): number {
	return Math.min(MAX_FRAMES, providerImageBudget(provider));
}

/** Key under `CompactionEntry.preserveData` holding the frame archive. */
export const PRESERVE_KEY = "snapcompact";

// ============================================================================
// Types
// ============================================================================

/** One developed snapcompact frame: a base64 PNG plus its reading geometry. */
export interface Frame {
	/** Base64-encoded PNG. */
	data: string;
	mimeType: string;
	/** Characters per row in the frame grid (per-column width on doc frames). */
	cols: number;
	/** Text rows in the frame grid (unique lines, not repeated copies). */
	rows: number;
	/** Characters actually printed onto this frame. */
	chars: number;
	/** Shape metadata (absent on legacy frames, which are 5x8 `sent`). */
	font?: Shape["font"];
	variant?: Shape["variant"];
	lineRepeat?: number;
	/** 2 on two-column doc frames; absent on row-major grid frames. */
	columns?: number;
	/** True when stopwords were printed in dim ink. */
	stopwordDim?: boolean;
	/** Resolution hint forwarded to the provider when re-attaching. */
	detail?: ImageContent["detail"];
}

/** Frame archive persisted under `preserveData[PRESERVE_KEY]`. */
export interface Archive {
	/** Frames ordered oldest to newest. */
	frames: Frame[];
	/** Characters currently readable across all frames. */
	totalChars: number;
	/** Characters dropped so far to respect the frame budget. */
	truncatedChars: number;
	/** Most recent slice of archived history that exceeded the frame budget,
	 *  kept verbatim as normalized text (dim markers and newline glyphs
	 *  included). Shipped as plain text in the compaction summary and folded
	 *  back into frames by the next compaction. */
	textTail?: string;
}

export interface Geometry {
	/** Characters per row (per-column line width when `columns === 2`). */
	cols: number;
	rows: number;
	/** Characters that fit one frame (nominal upper bound on doc shapes,
	 *  where real consumption is wrap-dependent). */
	capacity: number;
}

export interface Options<TMessage = Message> extends SerializeOptions {
	/** App-level message transformer (same contract as agent-core's `SummaryOptions.convertToLlm`). */
	convertToLlm?: ConvertToLlm<TMessage>;
	/** Model whose provider API selects the frame shape. */
	model?: Pick<Model, "api">;
	/** Explicit shape override; wins over `model`. */
	shape?: Shape;
	/** Frame edge in pixels. Defaults to the shape's `frameSize`. */
	frameSize?: number;
	/** Frame budget. Defaults to {@link MAX_FRAMES}. */
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

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

export interface CompactionPreparation<TMessage = Message> {
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
	fileOps: FileOperations;
}

export interface CompactionResult<T = CompactionDetails> {
	summary: string;
	shortSummary?: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: T;
	preserveData?: Record<string, unknown>;
}

export type ConvertToLlm<TMessage = Message> = (messages: TMessage[]) => Message[];

function defaultConvertToLlm<TMessage>(messages: TMessage[]): Message[] {
	return messages as unknown as Message[];
}

// ============================================================================
// File operation helpers
// ============================================================================

export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

export function computeFileLists(fileOps: FileOperations): CompactionDetails {
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

export function upsertFileOperations(
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
export const TOOL_RESULT_MAX_CHARS = 2000;

/** Default per-argument-value character cap inside serialized tool calls
 *  (write/edit bodies otherwise dump whole files into the archive). */
export const TOOL_ARG_MAX_CHARS = 500;

/** Default character cap across one tool call's full serialized argument list. */
export const TOOL_CALL_MAX_CHARS = 2000;

/** Default fraction of a truncation budget spent on the head; the remainder
 *  keeps the tail, where command errors and test failures usually land. */
export const TRUNCATE_HEAD_RATIO = 0.6;

/** Zero-width ink toggles understood by the native renderer (shift-out/in):
 *  text between them prints in dim gray ink without occupying a cell. */
export const DIM_ON = "\u000e";
export const DIM_OFF = "\u000f";

/** Character budgets applied while serializing discarded history for frame
 *  rendering. Pass `Infinity` to disable an individual cap. */
export interface SerializeOptions {
	/** Per-tool-result cap. Defaults to {@link TOOL_RESULT_MAX_CHARS}. */
	toolResultMaxChars?: number;
	/** Per-argument-value cap. Defaults to {@link TOOL_ARG_MAX_CHARS}. */
	toolArgMaxChars?: number;
	/** Whole-argument-list cap per call. Defaults to {@link TOOL_CALL_MAX_CHARS}. */
	toolCallMaxChars?: number;
	/** Head share of each budget, clamped to [0, 1]. Defaults to {@link TRUNCATE_HEAD_RATIO}. */
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

/** Cap on the unrendered archive text tail, in frame-capacity units: enough
 *  to keep the newest discarded history readable without re-inflating the
 *  context a compaction just shrank. */
const TEXT_TAIL_MAX_PAGES = 2;

/** Normalized archive text → plain text: drop zero-width dim toggles and
 *  print newline glyphs as real newlines. */
function toPlainText(text: string): string {
	return stripDimMarkers(text).replaceAll(NEWLINE_GLYPH, "\n");
}

/** Strip stray ink toggles from raw content so it cannot forge dim spans. */
function stripDimMarkers(text: string): string {
	return text.replace(DIM_MARKERS, "");
}

export function serializeConversation(messages: Message[], options?: SerializeOptions): string {
	const toolResultMaxChars = options?.toolResultMaxChars ?? TOOL_RESULT_MAX_CHARS;
	const toolArgMaxChars = options?.toolArgMaxChars ?? TOOL_ARG_MAX_CHARS;
	const toolCallMaxChars = options?.toolCallMaxChars ?? TOOL_CALL_MAX_CHARS;
	const headRatio = options?.truncateHeadRatio ?? TRUNCATE_HEAD_RATIO;
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
				parts.push(dimToolResults ? `[Tool result]: ${DIM_ON}${body}${DIM_OFF}` : `[Tool result]: ${body}`);
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

/** Printed in place of newline runs: the native renderer fills this cell
 *  entirely with pitch-black ink, so line structure survives whitespace
 *  collapsing at a one-cell cost. */
export const NEWLINE_GLYPH = "\u2588";

/** Collapsed in one pass: whitespace plus zero-width format characters (ZWSP,
 *  BOM, directional marks — JS `\s` already counts BOM as whitespace, so they
 *  must fold here, before the per-character pass). */
const COLLAPSIBLE = /[\s\p{Cf}]+/gu;

/** Runs carrying one of these collapse to {@link NEWLINE_GLYPH}. */
const LINE_BREAK = /[\n\r\u2028\u2029]/;

/** Leading/trailing spaces or newline glyphs add no information to a frame. */
const EDGE_RUNS = /^[ \u2588]+|[ \u2588]+$/g;

/** Glyph-less code points skipped outright instead of printing `?`: controls
 *  (bare ESC/BEL/NUL — full ANSI sequences are stripped beforehand),
 *  combining marks the fonts cannot compose, and lone surrogates. */
const UNRENDERABLE = /[\p{Cc}\p{Mn}\p{Me}\p{Cs}]/u;

/**
 * Prepare text for printing: strip ANSI escape sequences, collapse horizontal
 * whitespace runs to single spaces and newline-bearing runs to one
 * {@link NEWLINE_GLYPH} (drawn as a pitch-black cell), then fold everything
 * outside the fonts' ASCII + Latin-1 coverage to ASCII approximations.
 * Unrenderable control/format/combining characters are dropped without
 * occupying a cell; `?` remains the fallback for unsupported graphic
 * characters. The zero-width ink toggles {@link DIM_ON}/{@link DIM_OFF} pass
 * through untouched.
 */
export function normalize(text: string): string {
	const stripped = text.includes("\u001b") ? Bun.stripANSI(text) : text;
	const collapsed = stripped
		// A run of pure format chars (BOM is both \s and Cf) vanishes; only a
		// run containing genuine whitespace separates words.
		.replace(COLLAPSIBLE, run => (LINE_BREAK.test(run) ? NEWLINE_GLYPH : /[^\p{Cf}]/u.test(run) ? " " : ""))
		.replace(EDGE_RUNS, "");
	let out = "";
	for (const ch of collapsed) {
		const cp = ch.codePointAt(0) as number;
		if ((cp >= 0x20 && cp < 0x7f) || (cp >= 0xa0 && cp <= 0xff)) {
			out += ch;
			continue;
		}
		if (ch === DIM_ON || ch === DIM_OFF || ch === NEWLINE_GLYPH) {
			out += ch;
			continue;
		}
		const fold = CHAR_FOLD[ch];
		if (fold !== undefined) {
			out += fold;
		} else if (cp >= 0x2500 && cp <= 0x257f) {
			// Box drawing: keep table skeletons legible.
			out += cp === 0x2502 || cp === 0x2503 ? "|" : cp === 0x2500 || cp === 0x2501 ? "-" : "+";
		} else if (!UNRENDERABLE.test(ch)) {
			out += "?";
		}
	}
	return out;
}

// ============================================================================
// Stopword dimming
// ============================================================================

/** High-frequency function words a reader can reconstruct from context; the
 *  dim shapes render them in light gray so content words carry the contrast
 *  (verbatim from `research/bdf.py` `_STOPWORDS`). */
const STOPWORDS: ReadonlySet<string> = new Set(
	(
		"the a an and or of to in on at as is are was were be been by for with that this it its from had has have not but " +
		"he she his her they their them which also who whom when where while will would could should there then than " +
		"into over under about after before between during each such these those some most more other only same so"
	).split(" "),
);

/** Maximal alphabetic runs (ASCII + Latin-1 letters, the fonts' coverage). */
const ALPHA_RUN = /[a-zA-Z\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u00ff]+/g;

/** Splitter that keeps the zero-width ink toggles as their own segments. */
const DIM_MARKER_SPLIT = /([\u000e\u000f])/;

/**
 * Wrap each maximal alphabetic run that is a stopword in {@link DIM_ON} /
 * {@link DIM_OFF} so it prints in dim gray ink. Spans that are already dim
 * (e.g. archived tool output) pass through untouched — wrapping there would
 * terminate the enclosing dim span early. Markers are zero-width, so the
 * visible glyph count is unchanged.
 */
export function dimStopwords(text: string): string {
	const parts = text.split(DIM_MARKER_SPLIT);
	let dim = false;
	let out = "";
	for (const part of parts) {
		if (part === DIM_ON) {
			dim = true;
			out += part;
		} else if (part === DIM_OFF) {
			dim = false;
			out += part;
		} else if (dim) {
			out += part;
		} else {
			out += part.replace(ALPHA_RUN, word => (STOPWORDS.has(word.toLowerCase()) ? DIM_ON + word + DIM_OFF : word));
		}
	}
	return out;
}

// ============================================================================
// Doc layout (two word-wrapped newspaper columns)
// ============================================================================

/** Char cells between the two doc columns (research exp14 `GUTTER`). */
const DOC_GUTTER = 3;

/**
 * Greedy word-wrap, no mid-word breaks (hard split only for width+ words) —
 * ported verbatim from `research/exp14_bestgpt.py` `wrap()`. Zero-width dim
 * markers count toward word length here; serialized history places them at
 * word boundaries, so the drift is at most one cell per affected line.
 */
export function wrap(text: string, width: number): string[] {
	const lines: string[] = [];
	let cur = "";
	for (const token of text.split(/\s+/)) {
		if (token.length === 0) continue;
		let word = token;
		while (word.length > width) {
			// Pathological; never hit on prose.
			if (cur) {
				lines.push(cur);
				cur = "";
			}
			lines.push(word.slice(0, width));
			word = word.slice(width);
		}
		if (!cur) {
			cur = word;
		} else if (cur.length + 1 + word.length <= width) {
			cur += ` ${word}`;
		} else {
			lines.push(cur);
			cur = word;
		}
	}
	if (cur) lines.push(cur);
	return lines;
}

/**
 * Paginate already-normalized text for a doc shape: wrap once at the column
 * width, then slice into pages of `2 * rows` lines, each page `\n`-joined.
 * Every input character lands on exactly one page (whitespace becomes the
 * wrap points).
 */
function docPages(normalized: string, geo: Geometry): string[] {
	const lines = wrap(normalized, geo.cols);
	const perPage = 2 * geo.rows;
	const pages: string[] = [];
	for (let offset = 0; offset < lines.length; offset += perPage) {
		pages.push(lines.slice(offset, offset + perPage).join("\n"));
	}
	return pages;
}

// ============================================================================
// Rendering
// ============================================================================

export function geometry(shape: Shape, size: number = shape.frameSize): Geometry {
	const gridCols = Math.floor(size / shape.cellWidth);
	const rows = Math.floor(size / shape.cellHeight / shape.lineRepeat);
	if (shape.columns === 2) {
		const cols = Math.floor((gridCols - DOC_GUTTER) / 2);
		return { cols, rows, capacity: 2 * cols * rows };
	}
	return { cols: gridCols, rows, capacity: gridCols * rows };
}

const NEWLINES = /\n/g;

/** Render one snapcompact frame from already-normalized text. Doc shapes
 *  (`columns === 2`) expect one page of `\n`-joined pre-wrapped lines. */
export function render(text: string, shape: Shape, size: number = shape.frameSize): RenderedFrame {
	const { cols, rows, capacity } = geometry(shape, size);
	let visible = text.length - (text.match(DIM_MARKERS)?.length ?? 0);
	// Doc line separators consume no cell; in the grid they print as a blank.
	if (shape.columns === 2) visible -= text.match(NEWLINES)?.length ?? 0;
	const chars = Math.min(visible, capacity);
	const data = renderSnapcompactPng(text, {
		size,
		font: shape.font,
		cellWidth: shape.cellWidth,
		cellHeight: shape.cellHeight,
		stretch: shape.stretch,
		variant: shape.variant,
		lineRepeat: shape.lineRepeat,
		columns: shape.columns,
	});
	return { data, cols, rows, chars };
}

/** Stateful per-page text finisher: re-opens a dim span the previous page
 *  boundary cut through, then applies stopword dimming when the shape asks
 *  for it (after pagination, so capacity math never sees the markers). */
function pageFinisher(shape: Shape): (page: string) => string {
	let dimOpen = false;
	return page => {
		const text = dimOpen ? DIM_ON + page : page;
		dimOpen = text.lastIndexOf(DIM_ON) > text.lastIndexOf(DIM_OFF);
		return shape.stopwordDim ? dimStopwords(text) : text;
	};
}

/** Options for {@link renderMany} and {@link frames}. */
export interface RenderManyOptions {
	/** Explicit shape; wins over `model`. */
	shape?: Shape;
	/** Model whose `api` selects the eval-optimal shape. */
	model?: Pick<Model, "api">;
	/** Frame edge in px; defaults to the shape's `frameSize`. */
	frameSize?: number;
	/** Hard cap on frames produced; omit for unbounded (caller decides usage). */
	maxFrames?: number;
}

/**
 * Render arbitrary text into snapcompact PNG frames as LLM image blocks
 * (first page first). Synchronous: safe to call from per-request transforms.
 * Empty/whitespace-only input yields no frames.
 */
export function renderMany(text: string, options?: RenderManyOptions): ImageContent[] {
	const shape = options?.shape ?? resolveShape(options?.model);
	const frameSize = options?.frameSize ?? shape.frameSize;
	const geo = geometry(shape, frameSize);
	const normalized = normalize(text);
	const frames: ImageContent[] = [];
	const push = (rendered: RenderedFrame): void => {
		frames.push({
			type: "image",
			data: rendered.data,
			mimeType: "image/png",
			...(shape.imageDetail ? { detail: shape.imageDetail } : {}),
		});
	};
	if (shape.columns === 2) {
		const finish = pageFinisher(shape);
		for (const page of docPages(normalized, geo)) {
			if (options?.maxFrames !== undefined && frames.length >= options.maxFrames) break;
			push(render(finish(page), shape, frameSize));
		}
		return frames;
	}
	for (let offset = 0; offset < normalized.length; offset += geo.capacity) {
		if (options?.maxFrames !== undefined && frames.length >= options.maxFrames) break;
		let chunk = normalized.slice(offset, offset + geo.capacity);
		if (shape.stopwordDim) chunk = dimStopwords(chunk);
		push(render(chunk, shape, frameSize));
	}
	return frames;
}

/** Frames needed to hold `text` at the given shape/size, without rendering.
 *  For doc shapes this wraps the text once and counts pages of `2 * rows`
 *  lines; for grid shapes it divides by the frame capacity. */
export function frames(text: string, options?: Pick<RenderManyOptions, "shape" | "model" | "frameSize">): number {
	const shape = options?.shape ?? resolveShape(options?.model);
	const geo = geometry(shape, options?.frameSize ?? shape.frameSize);
	const normalized = normalize(text);
	if (shape.columns === 2) return Math.ceil(wrap(normalized, geo.cols).length / (2 * geo.rows));
	return Math.ceil(normalized.length / geo.capacity);
}

// ============================================================================
// Archive helpers
// ============================================================================

/** Validate and extract a persisted frame archive from `preserveData`. */
export function getPreservedArchive(preserveData: Record<string, unknown> | undefined): Archive | undefined {
	const candidate = preserveData?.[PRESERVE_KEY];
	if (!candidate || typeof candidate !== "object") return undefined;
	const archive = candidate as Archive;
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
		...(typeof archive.textTail === "string" && archive.textTail.length > 0 ? { textTail: archive.textTail } : {}),
	};
}

/** Convert archive frames into LLM image blocks (oldest first). */
export function images(archive: Archive): ImageContent[] {
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
 * frames. Pages past the frame budget are never rendered (providers with
 * hard image caps silently drop excess frames on the wire) — the newest
 * unrendered slice survives verbatim as a text tail on the summary and is
 * folded back into frames by the next compaction.
 *
 * Frames archived under a different shape (provider switches, legacy 5x8
 * sessions) are kept as-is — each frame carries its own geometry, and the
 * summary describes the newest shape while noting that older frames may
 * differ.
 *
 * If the previous compaction was text-based, its summary is printed at the
 * head of the frame archive as `[Summary of earlier history]` so no continuity is lost.
 */
export async function compact<TMessage = Message>(
	preparation: CompactionPreparation<TMessage>,
	options?: Options<TMessage>,
): Promise<CompactionResult> {
	const { firstKeptEntryId, tokensBefore, previousSummary, previousPreserveData, fileOps } = preparation;
	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no ID - session may need migration");
	}
	const shape = options?.shape ?? resolveShape(options?.model);
	const frameSize = options?.frameSize ?? shape.frameSize;
	const maxFrames = Math.max(1, options?.maxFrames ?? MAX_FRAMES);
	const geo = geometry(shape, frameSize);

	const messages = preparation.messagesToSummarize.concat(preparation.turnPrefixMessages);
	const llmMessages = (options?.convertToLlm ?? defaultConvertToLlm)(messages);
	let archiveText = normalize(serializeConversation(llmMessages, options));

	const previousArchive = getPreservedArchive(previousPreserveData);
	const includedPreviousSummary = !previousArchive && !!previousSummary;
	if (includedPreviousSummary && previousSummary) {
		const head = `[Summary of earlier history] ${normalize(previousSummary)}`;
		archiveText = archiveText.length > 0 ? `${head} [Recent conversation] ${archiveText}` : head;
	}

	let truncatedChars = previousArchive?.truncatedChars ?? 0;

	// The previous compaction's unframed text tail is the oldest part of this
	// archive slice — prepend it so it ages into frames first.
	if (previousArchive?.textTail) {
		archiveText =
			archiveText.length > 0
				? `${previousArchive.textTail}${NEWLINE_GLYPH}${archiveText}`
				: previousArchive.textTail;
	}

	const pages: string[] = [];
	if (shape.columns === 2) {
		pages.push(...docPages(archiveText, geo));
	} else {
		for (let offset = 0; offset < archiveText.length; offset += geo.capacity) {
			pages.push(archiveText.slice(offset, offset + geo.capacity));
		}
	}

	// Fit the merged archive into the frame budget BEFORE rendering: pages
	// that cannot ship are never rasterized. Old unpinned frames evict first
	// (the archive fades oldest-first, as before); new pages that still do
	// not fit stay behind as a verbatim text tail instead of being dropped.
	const prevFrames = previousArchive?.frames ?? [];
	let keptPrev = prevFrames;
	if (prevFrames.length + pages.length > maxFrames) {
		// Pin the earliest frame: it anchors the session head (the original
		// request, or the filmed summary of even older history) the way the
		// LLM-summary strategies keep the original goal alive across rounds.
		// With a budget of one frame the pin is moot.
		const pinCount = maxFrames >= 2 && prevFrames.length > 0 ? 1 : 0;
		const evictable = prevFrames.slice(pinCount);
		const surviving = Math.min(evictable.length, Math.max(0, maxFrames - pages.length - pinCount));
		const dropped = evictable.slice(0, evictable.length - surviving);
		for (const frame of dropped) truncatedChars += frame.chars;
		keptPrev = [...prevFrames.slice(0, pinCount), ...evictable.slice(evictable.length - surviving)];
	}
	const renderPages = pages.slice(0, maxFrames - keptPrev.length);
	const tailPages = pages.slice(renderPages.length);

	const newFrames: Frame[] = [];
	const finish = pageFinisher(shape);
	for (const page of renderPages) {
		const rendered = render(finish(page), shape, frameSize);
		newFrames.push({
			data: rendered.data,
			mimeType: "image/png",
			cols: rendered.cols,
			rows: rendered.rows,
			chars: rendered.chars,
			font: shape.font,
			variant: shape.variant,
			lineRepeat: shape.lineRepeat,
			...(shape.columns === 2 ? { columns: 2 } : {}),
			...(shape.stopwordDim ? { stopwordDim: true } : {}),
			...(shape.imageDetail ? { detail: shape.imageDetail } : {}),
		});
		// Keep the event loop responsive between native render passes.
		await Bun.sleep(0);
	}

	// Pages past the budget survive as text, capped at two frames' capacity
	// (middle-elided) so an oversized archive cannot blow the context back up.
	let textTail = "";
	if (tailPages.length > 0) {
		const raw =
			shape.columns === 2 ? tailPages.map(page => page.replaceAll("\n", " ")).join(" ") : tailPages.join("");
		const tailCap = TEXT_TAIL_MAX_PAGES * geo.capacity;
		if (raw.length > tailCap) truncatedChars += raw.length - tailCap;
		// Re-open a dim span the render boundary cut through, so the carried
		// tail keeps tool output dim when it lands on frames next compaction.
		const renderedText = shape.columns === 2 ? renderPages.join("\n") : renderPages.join("");
		const dimOpen = renderedText.lastIndexOf(DIM_ON) > renderedText.lastIndexOf(DIM_OFF);
		textTail = (dimOpen ? DIM_ON : "") + truncateForSummary(raw, tailCap, TRUNCATE_HEAD_RATIO);
	}

	const frames = [...keptPrev, ...newFrames];
	const totalChars = frames.reduce((sum, frame) => sum + frame.chars, 0);
	const mixedShapes = frames.some(
		frame =>
			frame.cols !== geo.cols ||
			frame.rows !== geo.rows ||
			(frame.variant ?? "sent") !== shape.variant ||
			(frame.lineRepeat ?? 1) !== shape.lineRepeat ||
			(frame.columns ?? 1) !== (shape.columns ?? 1) ||
			(frame.stopwordDim ?? false) !== (shape.stopwordDim ?? false),
	);

	let summary: string;
	if (frames.length === 0) {
		summary = "No prior history.";
	} else {
		summary = prompt.render(snapcompactSummaryPrompt, {
			frameCount: frames.length,
			multipleFrames: frames.length > 1,
			fontCell: `${shape.cellWidth}x${shape.cellHeight}`,
			cols: geo.cols,
			rows: geo.rows,
			sentenceInk: shape.variant === "sent",
			lineRepeated: shape.lineRepeat > 1,
			docColumns: shape.columns === 2,
			stopwordDimmed: shape.stopwordDim === true,
			dimmedToolResults: options?.dimToolResults !== false,
			mixedShapes,
			totalChars,
			truncatedChars,
			includedPreviousSummary,
			textTail: textTail.length > 0 ? toPlainText(textTail) : undefined,
		});
	}
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary = upsertFileOperations(summary, readFiles, modifiedFiles, fileOps.read);

	// A snapcompact pass replaces any provider-side replacement history; strip the
	// OpenAI remote-compaction payload like the default summarizer path does.
	const basePreserve = stripOpenAiRemoteCompactionPreserveData(previousPreserveData) ?? {};
	const archive: Archive = { frames, totalChars, truncatedChars, ...(textTail ? { textTail } : {}) };

	const textTailNote = textTail ? ` (+${textTail.length.toLocaleString()} chars as text)` : "";
	return {
		summary,
		shortSummary: `Archived ${totalChars.toLocaleString()} chars of history onto ${frames.length} snapcompact frame${frames.length === 1 ? "" : "s"}${textTailNote}`,
		firstKeptEntryId,
		tokensBefore,
		details: { readFiles, modifiedFiles },
		preserveData: { ...basePreserve, [PRESERVE_KEY]: archive },
	};
}

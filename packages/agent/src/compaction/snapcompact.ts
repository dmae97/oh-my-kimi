/**
 * Snapcompact compaction: archive conversation history as dense bitmap images.
 *
 * Instead of asking an LLM to summarize discarded history, the serialized
 * conversation is rendered into square PNG frames using the X.org `5x8`
 * pixel font (public domain) — one character per 5x8 cell, row-major, glyph
 * ink cycling through six hues at sentence boundaries. Vision models read
 * the frames back directly, like an archivist at a snapcompact frame reader.
 *
 * Validated by the imageee SQuAD eval (`img-5x8-sent`, 2576px frames):
 * ~0.88 F1 recall vs ~0.90 for raw text, at roughly 7x fewer input tokens.
 * The provider downscales frames to its image cap (1568px for Anthropic),
 * so one frame costs ~3.3k tokens while carrying ~165k characters.
 *
 * The whole pass is local and deterministic — no LLM call, no API key, no
 * latency beyond rendering. Rasterization and PNG encoding happen in native
 * code (`renderSnapcompactPng` in `crates/pi-natives/src/snapcompact.rs`).
 * Frames persist in the compaction entry's `preserveData` and are
 * re-attached to the compaction summary message on every context rebuild.
 */

import type { ImageContent } from "@oh-my-pi/pi-ai";
import { renderSnapcompactPng } from "@oh-my-pi/pi-natives";
import { prompt } from "@oh-my-pi/pi-utils";
import type { CompactionDetails, CompactionPreparation, CompactionResult } from "./compaction";
import { type ConvertToLlm, defaultConvertToLlm } from "./messages";
import { withOpenAiRemoteCompactionPreserveData } from "./openai";
import snapcompactSummaryPrompt from "./prompts/snapcompact-summary.md" with { type: "text" };
import { computeFileLists, serializeConversation, upsertFileOperations } from "./utils";

// ============================================================================
// Constants
// ============================================================================

/** Frame edge in pixels. 2576px is the eval-validated sweet spot: the provider
 *  downscale to 1568px anti-aliases the 1px glyph strokes instead of shearing
 *  them, which reads *better* than rendering at 1568 directly. */
export const SNAPCOMPACT_FRAME_SIZE = 2576;

/** Glyph cell geometry of the bundled `5x8` BDF font. */
const GLYPH_ADVANCE_X = 5;
const GLYPH_PITCH_Y = 8;

/** Maximum frames carried on a compaction entry. Oldest frames are dropped
 *  first once the budget is exceeded (mirrors how iterative text summaries
 *  fade the oldest detail). 8 frames ≈ 26k image tokens ≈ 1.3M chars. */
export const SNAPCOMPACT_MAX_FRAMES = 8;

/** Token cost estimate per frame. Frames render at ≥1568px, so providers bill
 *  the downscaled long-edge cap: 1568*1568/750 ≈ 3,278 tokens (Anthropic). */
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
	/** Rows in the frame grid. */
	rows: number;
	/** Characters actually printed onto this frame. */
	chars: number;
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

export interface SnapcompactOptions {
	/** App-level message transformer (same contract as `SummaryOptions.convertToLlm`). */
	convertToLlm?: ConvertToLlm;
	/** Frame edge in pixels. Defaults to {@link SNAPCOMPACT_FRAME_SIZE}. */
	frameSize?: number;
	/** Frame budget. Defaults to {@link SNAPCOMPACT_MAX_FRAMES}. */
	maxFrames?: number;
}

/** Result of rendering one frame, before base64 packing. */
export interface RenderedFrame {
	png: Uint8Array;
	cols: number;
	rows: number;
	/** Characters printed (input may be shorter than capacity). */
	chars: number;
}

// ============================================================================
// Text normalization
// ============================================================================

/** Folds for common non-Latin-1 characters the 5x8 subset cannot draw. */
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
 * then fold everything outside the font's ASCII + Latin-1 coverage to ASCII
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
export function snapcompactGeometry(size: number = SNAPCOMPACT_FRAME_SIZE): SnapcompactGeometry {
	const cols = Math.floor(size / GLYPH_ADVANCE_X);
	const rows = Math.floor(size / GLYPH_PITCH_Y);
	return { cols, rows, capacity: cols * rows };
}

/** Render one snapcompact frame from already-normalized text. */
export function renderSnapcompactFrame(text: string, size: number = SNAPCOMPACT_FRAME_SIZE): RenderedFrame {
	const { cols, rows, capacity } = snapcompactGeometry(size);
	const chars = Math.min(text.length, capacity);
	return { png: renderSnapcompactPng(text, size), cols, rows, chars };
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
	return archive.frames.map(frame => ({ type: "image", data: frame.data, mimeType: frame.mimeType }));
}

// ============================================================================
// Compaction entry point
// ============================================================================

/**
 * Run a snapcompact compaction over prepared messages. Fully local: serializes
 * the discarded history, prints it onto PNG frames, merges previously
 * archived frames (oldest dropped beyond the budget), and produces a
 * deterministic summary explaining how to read the frames.
 *
 * If the previous compaction was text-based, its summary is printed at the
 * head of the frame archive as `[Summary of earlier history]` so no continuity is lost.
 */
export async function snapcompactCompact(
	preparation: CompactionPreparation,
	options?: SnapcompactOptions,
): Promise<CompactionResult> {
	const { firstKeptEntryId, tokensBefore, previousSummary, previousPreserveData, fileOps } = preparation;
	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no ID - session may need migration");
	}
	const frameSize = options?.frameSize ?? SNAPCOMPACT_FRAME_SIZE;
	const maxFrames = Math.max(1, options?.maxFrames ?? SNAPCOMPACT_MAX_FRAMES);
	const geometry = snapcompactGeometry(frameSize);

	const messages = preparation.messagesToSummarize.concat(preparation.turnPrefixMessages);
	const llmMessages = (options?.convertToLlm ?? defaultConvertToLlm)(messages);
	let archiveText = normalizeForSnapcompact(serializeConversation(llmMessages));

	const previousArchive = getPreservedSnapcompactArchive(previousPreserveData);
	const includedPreviousSummary = !previousArchive && !!previousSummary;
	if (includedPreviousSummary && previousSummary) {
		const head = `[Summary of earlier history] ${normalizeForSnapcompact(previousSummary)}`;
		archiveText = archiveText.length > 0 ? `${head} [Recent conversation] ${archiveText}` : head;
	}

	let truncatedChars = previousArchive?.truncatedChars ?? 0;

	const newFrames: SnapcompactFrame[] = [];
	for (let offset = 0; offset < archiveText.length; offset += geometry.capacity) {
		const chunk = archiveText.slice(offset, offset + geometry.capacity);
		const rendered = renderSnapcompactFrame(chunk, frameSize);
		newFrames.push({
			data: Buffer.from(rendered.png).toBase64(),
			mimeType: "image/png",
			cols: rendered.cols,
			rows: rendered.rows,
			chars: rendered.chars,
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

	let summary: string;
	if (frames.length === 0) {
		summary = "No prior history.";
	} else {
		summary = prompt.render(snapcompactSummaryPrompt, {
			frameCount: frames.length,
			multipleFrames: frames.length > 1,
			cols: geometry.cols,
			rows: geometry.rows,
			totalChars,
			truncatedChars,
			includedPreviousSummary,
		});
	}
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary = upsertFileOperations(summary, readFiles, modifiedFiles);

	// A snapcompact pass replaces any provider-side replacement history; strip the
	// OpenAI remote-compaction payload like the default summarizer path does.
	// OpenAI remote-compaction payload like the default summarizer path does.
	const basePreserve = withOpenAiRemoteCompactionPreserveData(previousPreserveData, undefined) ?? {};
	const archive: SnapcompactArchive = { frames, totalChars, truncatedChars };

	return {
		summary,
		shortSummary: `Archived ${totalChars.toLocaleString()} chars of history onto ${frames.length} snapcompact frame${frames.length === 1 ? "" : "s"}`,
		firstKeptEntryId,
		tokensBefore,
		details: { readFiles, modifiedFiles } as CompactionDetails,
		preserveData: { ...basePreserve, [SNAPCOMPACT_PRESERVE_KEY]: archive },
	};
}

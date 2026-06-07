import {
	type Component,
	matchesKey,
	padding,
	replaceTabs,
	ScrollView,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { theme } from "../modes/theme/theme";
import { copyToClipboard } from "../utils/clipboard";
import {
	formatRawSseIsoTime,
	type RawSseDebugBuffer,
	type RawSseDebugRecord,
	rawSseRecordLines,
} from "./raw-sse-buffer";

const MIN_VIEWER_WIDTH = 20;
const VIEWER_FRAME_LINES = 5;
// `data:` lines below this width render fine on a single row; anything wider gets pretty-printed
// across multiple `data:` lines so streamed JSON blobs stop getting clipped by `truncateToWidth`.
const PRETTY_PRINT_DATA_THRESHOLD = 100;

function sanitizeFrameLine(line: string, width: number): string {
	return truncateToWidth(replaceTabs(sanitizeText(line)), width);
}

// Walks the SSE wire lines and replaces single-line `data: <json>` payloads with
// multi-line `data: <indented-json>` entries when the JSON is wide enough to clip.
// Multi-line `data:` is still valid SSE (the spec joins lines with `\n`), so the
// transformed view round-trips back to the same event when copied.
/** @internal Exported for tests. */
export function expandPrettyDataLines(raw: readonly string[]): string[] {
	const out: string[] = [];
	for (const line of raw) {
		if (!line.startsWith("data: ") || line.length <= PRETTY_PRINT_DATA_THRESHOLD) {
			out.push(line);
			continue;
		}
		const body = line.slice("data: ".length);
		const trimmed = body.trim();
		if (trimmed.length === 0 || (trimmed[0] !== "{" && trimmed[0] !== "[")) {
			out.push(line);
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			out.push(line);
			continue;
		}
		const pretty = JSON.stringify(parsed, null, 2);
		for (const prettyLine of pretty.split("\n")) {
			out.push(`data: ${prettyLine}`);
		}
	}
	return out;
}

export interface RawSseViewerOptions {
	buffer: RawSseDebugBuffer;
	terminalRows: number;
	onExit: () => void;
	onStatus?: (message: string) => void;
	onUpdate?: () => void;
}

export class RawSseViewerComponent implements Component {
	readonly #buffer: RawSseDebugBuffer;
	readonly #terminalRows: number;
	readonly #onExit: () => void;
	readonly #onStatus?: (message: string) => void;
	readonly #onUpdate?: () => void;
	readonly #unsubscribe: () => void;
	#scrollOffset = 0;
	#followTail = true;
	#lastRenderWidth = MIN_VIEWER_WIDTH;
	#statusMessage: string | undefined;
	// Pretty-printed wire lines keyed by `record.sequence`. Pretty-printing is
	// the JSON.parse + JSON.stringify per `data:` line, so we cache the result —
	// the render path runs on every keypress and from `#maxScrollOffset()`.
	// Sequences are monotonic; we prune entries below the oldest live record
	// after each render so the cache tracks the buffer's eviction window.
	readonly #prettyLinesCache = new Map<number, string[]>();

	constructor(options: RawSseViewerOptions) {
		this.#buffer = options.buffer;
		this.#terminalRows = options.terminalRows;
		this.#onExit = options.onExit;
		this.#onStatus = options.onStatus;
		this.#onUpdate = options.onUpdate;
		this.#unsubscribe = this.#buffer.subscribe(() => {
			this.#followIfNeeded();
			this.#onUpdate?.();
		});
	}

	handleInput(keyData: string): void {
		if (matchesKey(keyData, "escape") || matchesKey(keyData, "esc")) {
			this.#unsubscribe();
			this.#onExit();
			return;
		}

		if (matchesKey(keyData, "ctrl+c")) {
			this.#copyAll();
			return;
		}

		if (matchesKey(keyData, "up")) {
			this.#followTail = false;
			this.#scrollOffset = Math.max(0, this.#scrollOffset - 1);
			this.#onUpdate?.();
			return;
		}

		if (matchesKey(keyData, "down")) {
			this.#followTail = false;
			this.#scrollOffset = Math.min(this.#maxScrollOffset(), this.#scrollOffset + 1);
			this.#onUpdate?.();
			return;
		}

		if (matchesKey(keyData, "pageUp")) {
			this.#followTail = false;
			this.#scrollOffset = Math.max(0, this.#scrollOffset - this.#bodyHeight());
			this.#onUpdate?.();
			return;
		}

		if (matchesKey(keyData, "pageDown")) {
			this.#followTail = false;
			this.#scrollOffset = Math.min(this.#maxScrollOffset(), this.#scrollOffset + this.#bodyHeight());
			this.#onUpdate?.();
			return;
		}

		if (matchesKey(keyData, "end")) {
			this.#followTail = true;
			this.#scrollToTail();
			this.#onUpdate?.();
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		this.#lastRenderWidth = Math.max(MIN_VIEWER_WIDTH, width);
		this.#followIfNeeded();

		const innerWidth = Math.max(1, this.#lastRenderWidth - 2);
		const bodyHeight = this.#bodyHeight();
		const rawLines = this.#renderRawLines(innerWidth);
		const sv = new ScrollView(rawLines.slice(this.#scrollOffset, this.#scrollOffset + bodyHeight), {
			height: bodyHeight,
			scrollbar: "auto",
			totalRows: rawLines.length,
			theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
		});
		sv.setScrollOffset(this.#scrollOffset);
		const bodyRows = sv.render(innerWidth);

		return [
			this.#frameTop(innerWidth),
			this.#frameLine(this.#summaryText(), innerWidth),
			this.#frameSeparator(innerWidth),
			...bodyRows.map(line => this.#frameLine(line, innerWidth)),
			this.#frameLine(this.#statusText(), innerWidth),
			this.#frameBottom(innerWidth),
		];
	}

	#renderRawLines(innerWidth: number): string[] {
		const snapshot = this.#buffer.snapshot();
		if (snapshot.records.length === 0) {
			return [
				theme.fg("muted", "No raw SSE frames captured yet."),
				theme.fg("muted", "HTTP SSE providers populate this view while a model response is streaming."),
			];
		}

		const lines: string[] = [];
		if (snapshot.droppedRecords > 0) {
			lines.push(
				theme.fg(
					"warning",
					`: omp-debug-dropped records=${snapshot.droppedRecords} chars=${snapshot.droppedChars}`,
				),
			);
			lines.push("");
		}
		const firstSequence = snapshot.records[0]?.sequence;
		for (const record of snapshot.records) {
			for (const line of this.#prettyLinesFor(record)) {
				lines.push(sanitizeFrameLine(line, innerWidth));
			}
			if (record.kind === "event" && record.truncated) {
				lines.push(theme.fg("warning", `: omp-debug-event-truncated originalChars=${record.originalChars}`));
			}
			lines.push("");
		}
		if (firstSequence !== undefined) this.#pruneCache(firstSequence);
		return lines;
	}

	#prettyLinesFor(record: RawSseDebugRecord): string[] {
		const cached = this.#prettyLinesCache.get(record.sequence);
		if (cached) return cached;
		const expanded = expandPrettyDataLines(rawSseRecordLines(record));
		this.#prettyLinesCache.set(record.sequence, expanded);
		return expanded;
	}

	#pruneCache(firstSequence: number): void {
		// Bounded by the buffer eviction rate; with `MAX_RAW_SSE_EVENTS = 1000`
		// this rarely runs and only walks freshly-evicted entries.
		for (const key of this.#prettyLinesCache.keys()) {
			if (key < firstSequence) this.#prettyLinesCache.delete(key);
		}
	}

	#summaryText(): string {
		const snapshot = this.#buffer.snapshot();
		const last = snapshot.lastUpdatedAt ? ` last=${formatRawSseIsoTime(snapshot.lastUpdatedAt)}` : "";
		const follow = this.#followTail ? "follow:on" : "follow:off";
		return ` # raw provider stream (SSE + WS) | events=${snapshot.totalEvents} records=${snapshot.records.length}${last} | ${follow} | Esc back Ctrl+C copy End follow`;
	}

	#statusText(): string {
		return this.#statusMessage ?? " Up/Down scroll  PgUp/PgDn page";
	}

	#bodyHeight(): number {
		return Math.max(3, this.#terminalRows - VIEWER_FRAME_LINES);
	}

	#followIfNeeded(): void {
		if (this.#followTail) this.#scrollToTail();
	}

	#scrollToTail(): void {
		this.#scrollOffset = this.#maxScrollOffset();
	}

	#maxScrollOffset(): number {
		const innerWidth = Math.max(1, this.#lastRenderWidth - 2);
		return Math.max(0, this.#renderRawLines(innerWidth).length - this.#bodyHeight());
	}

	#copyAll(): void {
		const payload = this.#buffer.toRawText();
		if (payload.trim().length === 0) {
			const message = "No raw SSE frames to copy";
			this.#statusMessage = message;
			this.#onStatus?.(message);
			this.#onUpdate?.();
			return;
		}

		try {
			copyToClipboard(payload);
			const message = "Copied raw SSE stream";
			this.#statusMessage = message;
			this.#onStatus?.(message);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#statusMessage = `Copy failed: ${message}`;
		}
		this.#onUpdate?.();
	}

	#frameTop(innerWidth: number): string {
		return `${theme.boxSharp.topLeft}${theme.boxSharp.horizontal.repeat(innerWidth)}${theme.boxSharp.topRight}`;
	}

	#frameSeparator(innerWidth: number): string {
		return `${theme.boxSharp.teeRight}${theme.boxSharp.horizontal.repeat(innerWidth)}${theme.boxSharp.teeLeft}`;
	}

	#frameBottom(innerWidth: number): string {
		return `${theme.boxSharp.bottomLeft}${theme.boxSharp.horizontal.repeat(innerWidth)}${theme.boxSharp.bottomRight}`;
	}

	#frameLine(content: string, innerWidth: number): string {
		const truncated = truncateToWidth(content, innerWidth);
		const remaining = Math.max(0, innerWidth - visibleWidth(truncated));
		return `${theme.boxSharp.vertical}${truncated}${padding(remaining)}${theme.boxSharp.vertical}`;
	}
}

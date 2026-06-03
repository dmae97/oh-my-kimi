import { stripVTControlCharacters } from "node:util";
import {
	type Component,
	CURSOR_MARKER,
	Ellipsis,
	extractSegments,
	type Focusable,
	type OverlayAnchor,
	type OverlayHandle,
	type OverlayOptions,
	sliceByColumn,
	sliceWithWidth,
	TUI,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { VirtualTerminal, type VirtualTerminalWidthModel } from "./virtual-terminal";

const BASE_SEEDS = [
	0x00c0ffee, 0x1badb002, 0x5eed1234, 0xdecafbad, 0x8badf00d, 0x0ddc0ffe, 0xcafed00d, 0xb16b00b5,
] as const;
const LARGE_SCROLL = 1_000_000;
const CORE_ITERATIONS = 120;
const SOAK_ITERATIONS = 300;
const CORE_BULK_MAX = 1_000;
const SOAK_BULK_MAX = 1_000;
const CORE_TIMEOUT_MS = 20_000;
const SOAK_TIMEOUT_MS = 45_000;
const EXHAUSTIVE_SCROLLBACK = Bun.env.TUI_STRESS_EXHAUSTIVE_SCROLLBACK === "1";

const SEGMENT_RESET = "\x1b[0m";
const ESC = "\x1b";
const BEL = "\x07";
const SMILE = String.fromCodePoint(0x1f642);
type TestPlatform = "darwin" | "linux" | "win32";
type TerminalMode = "normal" | "unknown" | "intermittentUnknown" | "staleBottom";
type GeometryMode = "small" | "large";
type EnvMode = "plain" | "tmux" | "termux" | "appleTerminal" | "iterm2" | "wsl";
const ENV_KEYS = [
	"TMUX",
	"STY",
	"ZELLIJ",
	"TERMUX_VERSION",
	"WEZTERM_PANE",
	"KITTY_WINDOW_ID",
	"GHOSTTY_RESOURCES_DIR",
	"ALACRITTY_WINDOW_ID",
	"VTE_VERSION",
	"TERM_PROGRAM",
	"ITERM_SESSION_ID",
	"WT_SESSION",
	"WSL_DISTRO_NAME",
	"WSL_INTEROP",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type OperationKind =
	| "appendSmall"
	| "appendExactWidth"
	| "appendBulk"
	| "streamOne"
	| "editVisibleLine"
	| "editOffscreenLine"
	| "offscreenEditAppendRepeatedTail"
	| "insertOffscreen"
	| "insertMiddle"
	| "deleteTrailing"
	| "deleteMiddle"
	| "replaceAll"
	| "toggleCollapsible"
	| "tickStatusHeader"
	| "appendRepeatedTail"
	| "injectBlankCluster"
	| "appendDuplicateOfExisting"
	| "highWaterPreviewCollapse"
	| "eagerStreamingMutation"
	| "scrollUp"
	| "scrollToBottom"
	| "scrollPartial"
	| "resizeWidth"
	| "resizeHeight"
	| "resizeWithAppend"
	| "forceRender"
	| "toggleFocusInput"
	| "moveCursorVisible"
	| "moveCursorOffscreen"
	| "showOverlay"
	| "hideOverlay"
	| "toggleOverlayHidden"
	| "editOverlay"
	| "moveOverlayCursor"
	| "coalescedBurst"
	| "rotateUp"
	| "collapseToFew"
	| "swapOffscreenRows"
	| "resizeBoth"
	| "resizeNoop"
	| "forceRenderAllowUnknown"
	| "forceRenderClearScrollback"
	| "forceRenderAfterEmptyOverflow"
	| "attachChild"
	| "detachChild"
	| "reorderChildren"
	| "mutateChild";

const BURST_STEP_KINDS = [
	"appendSmall",
	"streamOne",
	"appendRepeatedTail",
	"injectBlankCluster",
	"editVisibleLine",
	"editOffscreenLine",
	"tickStatusHeader",
	"resizeWidth",
	"resizeHeight",
	"scrollPartial",
	"scrollToBottom",
	"forceRender",
] as const;
type BurstStepKind = (typeof BURST_STEP_KINDS)[number];
const OVERLAY_ANCHORS = [
	"center",
	"top-left",
	"top-right",
	"bottom-left",
	"bottom-right",
	"top-center",
	"bottom-center",
	"left-center",
	"right-center",
] as const satisfies readonly OverlayAnchor[];
const CURSOR_MODES = ["start", "middle", "end", "wideBoundary"] as const;
type CursorMode = (typeof CURSOR_MODES)[number];

interface ExpectedCursor {
	row: number;
	col: number;
}

interface ExpectedFrame {
	frame: string[];
	cursor: ExpectedCursor | null;
	// Frame rows whose logical content carries background SGR. Only these rows
	// may have background-colored cells in the terminal; anywhere else is BCE
	// bleed (leaked SGR state painting erased cells).
	backgroundRows: boolean[];
}

interface StressOverlayEntry {
	id: number;
	sentinel: string;
	model: StressOverlayModel;
	component: StressOverlayComponent;
	handle: OverlayHandle;
	options: OverlayOptions;
	hidden: boolean;
	detail: JsonObject;
}

interface StressChildEntry {
	id: number;
	model: StressModel;
	component: StressComponent;
	active: boolean;
}

interface LogicalLine {
	id: number;
	text: string;
}

export interface Scenario {
	name: string;
	seed: number;
	platform: TestPlatform;
	terminalMode: TerminalMode;
	envMode: EnvMode;
	geometryMode: GeometryMode;
	// Terminal cell-width semantics. "legacy" (default) = xterm.js Unicode 6
	// tables (emoji/VS16 narrow); "modern" = grapheme-aware widths matching the
	// renderer's native engine (ghostty/WezTerm/kitty/iTerm2/WT 1.22+). Modern
	// scenarios make geometric oracles cell-exact for emoji content.
	widthModel?: VirtualTerminalWidthModel;
	columns: number;
	rows: number;
	widthChoices: readonly number[];
	heightChoices: readonly number[];
	iterations: number;
	bulkMax: number;
	scrollback: number;
	strictScrollback: boolean;
	timeoutMs: number;
	uniqueContent: boolean;
}

interface Snapshot {
	buffer: string[];
	view: string[];
	viewBackgroundColumns: number[][];
	frameBackgroundRows: boolean[];
	position: { baseY: number; viewportY: number };
	cursor: { row: number; col: number };
	expectedCursor: ExpectedCursor | null;
	redraws: number;
	width: number;
	height: number;
	frame: string[];
	atBottom: boolean;
}

interface AppliedOperation {
	kind: OperationKind;
	detail: JsonObject;
	mutatesContent: boolean;
	checksRowAccounting: boolean;
	geometryChanged: boolean;
	forcedRender: boolean;
	checkpoint: boolean;
	mutatesViewport: boolean;
	coalesced?: boolean;
	// Maximum number of rows the op appended to the frame at any point while it
	// ran, even if a later step inside the same op removed them again (e.g. a
	// preview expanding and collapsing). Appended rows that overflow the
	// viewport legitimately scroll into terminal history and can never be
	// retracted from multiplexer pane history, so growth oracles must allow
	// them. Defaults to the net frame growth when absent.
	transientFrameGrowth?: number;
}

interface OperationLogEntry {
	index: number;
	kind: OperationKind | "periodicCheckpoint";
	detail: JsonObject;
	frameLengthBefore: number;
	frameLengthAfter: number;
	bufferLengthBefore: number;
	bufferLengthAfter: number;
	viewportYBefore: number;
	viewportYAfter: number;
	baseYBefore: number;
	baseYAfter: number;
	redrawsBefore: number;
	redrawsAfter: number;
}

class UnknownViewportTerminal extends VirtualTerminal {
	isNativeViewportAtBottom(): undefined {
		return undefined;
	}
}

class IntermittentUnknownViewportTerminal extends VirtualTerminal {
	#probeCount = 0;

	isNativeViewportAtBottom(): boolean | undefined {
		this.#probeCount += 1;
		return this.#probeCount % 3 === 0 ? undefined : super.isNativeViewportAtBottom();
	}
}

class StaleBottomTerminal extends VirtualTerminal {
	#previous: boolean | undefined;
	#returnStale = false;

	isNativeViewportAtBottom(): boolean | undefined {
		const current = super.isNativeViewportAtBottom();
		if (this.#returnStale) {
			this.#returnStale = false;
			const stale = this.#previous;
			this.#previous = current;
			return stale;
		}
		this.#returnStale = true;
		this.#previous = current;
		return current;
	}
}

class MutableLinesComponent implements Component {
	#lines: string[];

	constructor(lines: readonly string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: readonly string[]): void {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(_width: number): string[] {
		return [...this.#lines];
	}
}

class Rng {
	#state: number;

	constructor(seed: number) {
		this.#state = seed >>> 0;
	}

	next(): number {
		this.#state = (this.#state + 0x6d2b79f5) >>> 0;
		let t = this.#state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	}

	int(min: number, max: number): number {
		if (max < min) return min;
		return Math.floor(this.next() * (max - min + 1)) + min;
	}

	chance(probability: number): boolean {
		return this.next() < probability;
	}

	pick<T>(items: readonly T[]): T {
		if (items.length === 0) {
			throw new Error("Cannot pick from an empty list");
		}
		return items[this.int(0, items.length - 1)]!;
	}
}

class StressModel {
	readonly lines: LogicalLine[] = [];
	readonly minLines: number;
	#rng: Rng;
	#nextId = 0;
	#collapsibleIds: number[] = [];
	#cursorLineIndex: number | null = null;
	#cursorMode: CursorMode = "end";
	#uniqueContent: boolean;
	#usedText = new Set<string>();
	#labelPrefix: string;

	constructor(rng: Rng, minLines: number, uniqueContent = false, labelPrefix = "") {
		this.#rng = rng;
		this.minLines = minLines;
		this.#uniqueContent = uniqueContent;
		this.#labelPrefix = labelPrefix;
		const initialLength = minLines + 20;
		for (let i = 0; i < initialLength; i++) {
			this.lines.push(this.#line(this.#initialText(i)));
		}
	}

	renderedLines(width: number, focused = false): string[] {
		const lines = this.lines.map(line => line.text);
		if (focused && lines.length > 0) {
			const index = this.#clampedCursorLineIndex();
			lines[index] = insertCursorMarker(lines[index] ?? "", this.#cursorMode, width);
		}
		return lines;
	}

	debugLines(): string[] {
		const cursor = this.#cursorLineIndex === null ? "none" : `${this.#cursorLineIndex}:${this.#cursorMode}`;
		return [`cursor:${cursor}`, ...this.lines.map(line => `${line.id}:${JSON.stringify(line.text)}`)];
	}

	setCursorVisible(height: number, width: number): JsonObject {
		this.#ensureLine();
		const start = Math.max(0, this.lines.length - height);
		const index = this.#rng.int(start, this.lines.length - 1);
		return this.#setCursor(index, width, false);
	}

	setCursorOffscreen(height: number, width: number): JsonObject {
		while (this.lines.length <= height) {
			this.lines.push(this.#randomLine("u"));
		}
		const limit = Math.max(1, this.lines.length - height);
		const index = this.#rng.int(0, limit - 1);
		return this.#setCursor(index, width, true);
	}

	appendSmall(): JsonObject {
		const count = this.#rng.int(1, 3);
		for (let i = 0; i < count; i++) {
			this.lines.push(this.#randomLine("a"));
		}
		return { count };
	}

	// Append a row whose visible width EXACTLY equals the terminal width. Half
	// the time the final cell is a wide (2-cell) glyph so the exact-fit boundary
	// lands a double-width char on the last column — the pending-wrap trigger the
	// renderer's autowrap-off discipline must neutralize.
	appendExactWidth(width: number): JsonObject {
		const text = this.#exactWidthLine(width);
		this.lines.push(this.#line(text));
		return { width, text, visibleWidth: visibleWidth(text) };
	}

	#exactWidthLine(width: number): string {
		if (width <= 0) return "";
		const label = `${this.#labelPrefix}ew${this.#nextId.toString(36)}`;
		// Pad with enough ASCII fill to cover any terminal width (the widest stress
		// geometry is 120 cols). ASCII is one cell per code unit, so a code-unit
		// slice is a cell-exact slice.
		const fill = label.length >= width ? label : `${label}${".".repeat(width)}`;
		// End on a wide CJK char (2 cells) on the wider rows so the exact-fit
		// boundary lands a double-width glyph on the last column.
		if (width >= 3 && this.#rng.chance(0.5)) {
			return `${fill.slice(0, width - 2)}界`;
		}
		return fill.slice(0, width);
	}

	appendBulk(maxBulk: number): JsonObject {
		const min = Math.min(20, maxBulk);
		const count = this.#rng.int(min, maxBulk);
		for (let i = 0; i < count; i++) {
			this.lines.push(this.#randomLine("b"));
		}
		return { count };
	}

	streamOne(): JsonObject {
		this.lines.push(this.#randomLine("s"));
		return { count: 1 };
	}

	appendRepeatedTail(): JsonObject {
		if (this.#uniqueContent) {
			const line = this.#freshLine("repeatAlt");
			this.lines.push(line);
			return { convertedToUnique: true, text: line.text };
		}
		const text = this.lines[this.lines.length - 1]?.text ?? "";
		this.lines.push(this.#line(text));
		return { text };
	}

	appendDuplicateOfExisting(): JsonObject {
		const sourceIndex = this.#rng.int(0, this.lines.length - 1);
		if (this.#uniqueContent) {
			const line = this.#freshLine("dupAlt");
			this.lines.push(line);
			return { sourceIndex, convertedToUnique: true, text: line.text };
		}
		const text = this.lines[sourceIndex]?.text ?? "";
		this.lines.push(this.#line(text));
		return { sourceIndex, text };
	}

	injectBlankCluster(): JsonObject {
		const count = this.#rng.int(2, 8);
		for (let i = 0; i < count; i++) {
			this.lines.push(this.#line(""));
		}
		return { count };
	}

	editVisibleLine(height: number): JsonObject {
		const start = Math.max(0, this.lines.length - height);
		const index = this.#rng.int(start, this.lines.length - 1);
		const before = this.lines[index]?.text ?? "";
		this.lines[index] = this.#randomLine("v");
		return { index, before, after: this.lines[index]?.text ?? "" };
	}

	editOffscreenLine(height: number): JsonObject {
		const limit = Math.max(1, this.lines.length - height);
		const index = this.#rng.int(0, limit - 1);
		const before = this.lines[index]?.text ?? "";
		this.lines[index] = this.#randomLine("o");
		return { index, before, after: this.lines[index]?.text ?? "" };
	}

	offscreenEditAppendRepeatedTail(height: number): JsonObject {
		while (this.lines.length < height + 3) {
			this.lines.push(this.#randomLine("p"));
		}
		const previousLength = this.lines.length;
		const offscreenLimit = Math.max(1, previousLength - height);
		const offscreenIndex = this.#rng.int(0, offscreenLimit - 1);
		const previousLast = this.lines[previousLength - 1]?.text ?? "";
		this.lines[offscreenIndex] = this.#randomLine("x");
		const repeatedIndex = Math.max(0, previousLength - 2);
		this.lines[repeatedIndex] = this.#uniqueContent ? this.#freshLine("xAlt") : this.#line(previousLast);
		this.lines[previousLength - 1] = this.#randomLine("e");
		this.lines.push(this.#randomLine("f"));
		return { offscreenIndex, repeatedIndex, previousLast, previousLength };
	}

	insertOffscreen(height: number): JsonObject {
		const count = this.#rng.int(1, 4);
		const limit = Math.max(1, this.lines.length - height);
		const index = this.#rng.int(0, limit - 1);
		this.lines.splice(index, 0, ...this.#newLines(count, "i"));
		return { index, count };
	}

	insertMiddle(): JsonObject {
		const count = this.#rng.int(1, 3);
		const index = this.#rng.int(1, Math.max(1, this.lines.length - 2));
		this.lines.splice(index, 0, ...this.#newLines(count, "m"));
		return { index, count };
	}

	deleteTrailing(): JsonObject {
		const removable = Math.max(0, this.lines.length - this.minLines);
		if (removable === 0) return { count: 0 };
		const count = Math.min(removable, this.#rng.int(1, 4));
		const removed = this.lines.splice(this.lines.length - count, count);
		return { count, firstRemoved: removed[0]?.text ?? null };
	}

	deleteMiddle(height: number): JsonObject {
		const removable = Math.max(0, this.lines.length - this.minLines);
		if (removable === 0) return { count: 0 };
		const count = Math.min(removable, this.#rng.int(1, 3));
		const offscreenLimit = Math.max(1, this.lines.length - height - count);
		const index = this.#rng.int(1, Math.max(1, offscreenLimit));
		const removed = this.lines.splice(index, count);
		return { index, count: removed.length, firstRemoved: removed[0]?.text ?? null };
	}

	replaceAll(): JsonObject {
		const nextLength = this.#rng.int(this.minLines, this.minLines + 40);
		this.lines.splice(0, this.lines.length, ...this.#newLines(nextLength, "r"));
		return { nextLength };
	}

	toggleCollapsible(): JsonObject {
		if (this.#collapsibleIds.length > 0) {
			const ids = new Set(this.#collapsibleIds);
			const before = this.lines.length;
			for (let i = this.lines.length - 1; i >= 0; i--) {
				const line = this.lines[i];
				if (line && ids.has(line.id)) {
					this.lines.splice(i, 1);
				}
			}
			const removed = before - this.lines.length;
			this.#collapsibleIds = [];
			if (removed > 0) {
				return { expanded: false, removed };
			}
		}

		const block = this.#uniqueContent
			? [this.#freshLine("blk0"), this.#freshLine("blk1"), this.#freshLine("blk2"), this.#freshLine("blk3")]
			: [
					this.#line(styledText("blk0", 35)),
					this.#line(wideText("blk1")),
					this.#line(linkedText("blk2")),
					this.#line(longText("blk3", 3)),
				];
		this.#collapsibleIds = block.map(line => line.id);
		const index = Math.min(2, this.lines.length);
		this.lines.splice(index, 0, ...block);
		return { expanded: true, inserted: block.length, index };
	}

	tickStatusHeader(): JsonObject {
		const before = this.lines[0]?.text ?? "";
		this.lines[0] = this.#freshLine("h");
		return { index: 0, before, after: this.lines[0]?.text ?? "" };
	}

	rotateUp(): JsonObject {
		if (this.lines.length < 2) {
			this.lines.push(this.#freshLine("t"));
			return { dropped: null, appended: this.lines[this.lines.length - 1]?.text ?? "" };
		}
		const dropped = this.lines.shift();
		this.lines.push(this.#randomLine("t"));
		return { dropped: dropped?.text ?? null, appended: this.lines[this.lines.length - 1]?.text ?? "" };
	}

	collapseToFew(): JsonObject {
		const nextLength = this.#rng.int(0, 2);
		this.lines.splice(0, this.lines.length, ...this.#newLines(nextLength, "c"));
		return { nextLength };
	}

	clear(): JsonObject {
		const previousLength = this.lines.length;
		this.lines.splice(0, this.lines.length);
		return { previousLength };
	}

	appendCount(count: number, prefix: string): JsonObject {
		this.lines.push(...this.#newLines(count, prefix));
		return { count };
	}

	beginHighWaterPreview(height: number): JsonObject {
		while (this.lines.length < height + 8) {
			this.lines.push(this.#freshLine("seed"));
		}
		const start = this.lines.length;
		const count = this.#rng.int(height + 4, height + 14);
		for (let i = 0; i < count; i++) {
			this.lines.push(this.#freshLine("preview"));
		}
		return { start, count };
	}

	collapseHighWaterPreview(start: number, count: number): JsonObject {
		const removed = this.lines.splice(start, count);
		this.#ensureLine();
		const editedIndex = this.lines.length - 1;
		const before = this.lines[editedIndex]?.text ?? "";
		this.lines[editedIndex] = this.#freshLine("done");
		return { start, count: removed.length, editedIndex, before, after: this.lines[editedIndex]?.text ?? "" };
	}

	swapOffscreenRows(height: number): JsonObject {
		const offscreenLimit = this.lines.length - height;
		if (offscreenLimit < 2) return { swapped: 0 };
		const i = this.#rng.int(0, offscreenLimit - 1);
		let j = this.#rng.int(0, offscreenLimit - 1);
		if (j === i) j = (j + 1) % offscreenLimit;
		const a = this.lines[i]!;
		const b = this.lines[j]!;
		this.lines[i] = b;
		this.lines[j] = a;
		return { swapped: 2, i, j };
	}

	#initialText(index: number): string {
		if (this.#uniqueContent) return index % 13 === 0 ? "" : `${this.#labelPrefix}init${index.toString(36)}`;
		if (index % 13 === 0) return "";
		if (index % 37 === 0) return backgroundStyledText(`bg${index.toString(36)}`, 41 + (index % 6));
		if (index % 31 === 0) return emojiPresentationText(`ep${index.toString(36)}`);
		if (index % 29 === 0) return arabicCombiningText(`ar${index.toString(36)}`);
		if (index % 23 === 0) return longText(`L${index.toString(36)}`, 4);
		if (index % 19 === 0) return linkedText(`link${index.toString(36)}`);
		if (index % 17 === 0) return styledText(`sg${index.toString(36)}界`, 31 + (index % 6));
		if (index % 11 === 0) return wideText(`w${index.toString(36)}`);
		if (index % 7 === 0) return `r${index % 3}`;
		return `l${index.toString(36)}`;
	}

	#newLines(count: number, prefix: string): LogicalLine[] {
		const lines: LogicalLine[] = [];
		for (let i = 0; i < count; i++) {
			lines.push(this.#randomLine(prefix));
		}
		return lines;
	}

	#randomLine(prefix: string): LogicalLine {
		if (this.#uniqueContent) return this.#freshLine(prefix);
		const roll = this.#rng.next();
		if (roll < 0.1) return this.#line("");
		if (roll < 0.2) return this.#line(`r${this.#rng.int(0, 3)}`);
		if (roll < 0.34 && this.lines.length > 0) {
			const source = this.lines[this.#rng.int(0, this.lines.length - 1)];
			return this.#line(source?.text ?? "");
		}
		return this.#freshLine(prefix);
	}

	#freshLine(prefix: string): LogicalLine {
		for (;;) {
			const id = this.#nextId.toString(36);
			const text = randomDecoratedText(this.#rng, `${this.#labelPrefix}${prefix}${id}`);
			if (!this.#uniqueContent || text.length === 0 || !this.#usedText.has(text)) return this.#line(text);
			this.#nextId += 1;
		}
	}

	#ensureLine(): void {
		if (this.lines.length === 0) {
			this.lines.push(this.#freshLine("q"));
		}
	}

	#setCursor(index: number, width: number, offscreen: boolean): JsonObject {
		const clampedIndex = Math.max(0, Math.min(index, this.lines.length - 1));
		const text = this.lines[clampedIndex]?.text ?? "";
		const mode = pickCursorMode(this.#rng, text, width);
		this.#cursorLineIndex = clampedIndex;
		this.#cursorMode = mode;
		return { index: clampedIndex, mode, offscreen, text };
	}

	#clampedCursorLineIndex(): number {
		if (this.lines.length === 0) return 0;
		if (this.#cursorLineIndex === null) return this.lines.length - 1;
		return Math.max(0, Math.min(this.#cursorLineIndex, this.lines.length - 1));
	}

	#line(text: string): LogicalLine {
		const line = { id: this.#nextId, text };
		this.#nextId += 1;
		if (text.length > 0) this.#usedText.add(text);
		return line;
	}
}

class StressComponent implements Component, Focusable {
	focused = false;
	#model: StressModel;

	constructor(model: StressModel) {
		this.#model = model;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.#model.renderedLines(width, this.focused);
	}
}

class StressOverlayModel {
	readonly lines: LogicalLine[] = [];
	readonly sentinel: string;
	#rng: Rng;
	#nextId = 0;
	#cursorLineIndex = 0;
	#cursorMode: CursorMode = "middle";

	constructor(rng: Rng, id: number) {
		this.#rng = rng;
		this.sentinel = `OV_SENTINEL_${id.toString(36)}_`;
		const count = rng.int(1, 5);
		this.lines.push(this.#line(`${this.sentinel}${randomDecoratedText(rng, `ov${id}-0`)}`));
		for (let i = 1; i < count; i++) {
			this.lines.push(this.#line(randomDecoratedText(rng, `ov${id}-${i}`)));
		}
	}

	renderedLines(width: number, focused = false): string[] {
		const lines = this.lines.map(line => line.text);
		if (!lines.some(line => line.includes(this.sentinel))) lines.unshift(this.sentinel);
		if (focused && lines.length > 0) {
			const index = this.#clampedCursorLineIndex();
			lines[index] = insertCursorMarker(lines[index] ?? "", this.#cursorMode, width);
		}
		return lines;
	}

	mutate(width: number): JsonObject {
		this.#ensureLine();
		const action = this.#rng.int(0, 3);
		if (action === 0 || this.lines.length === 1) {
			const line = this.#freshLine("oa");
			this.lines.push(line);
			return { action: "append", text: line.text };
		}
		if (action === 1) {
			const index = this.#rng.int(0, this.lines.length - 1);
			const before = this.lines[index]?.text ?? "";
			this.lines[index] = this.#freshLine("oe");
			return { action: "edit", index, before, after: this.lines[index]?.text ?? "" };
		}
		if (action === 2) {
			const index = this.#rng.int(0, this.lines.length - 1);
			const removed = this.lines.splice(index, 1);
			return { action: "delete", index, removed: removed[0]?.text ?? "" };
		}
		return { action: "cursor", ...this.setCursor(width) };
	}

	setCursor(width: number): JsonObject {
		this.#ensureLine();
		const index = this.#rng.int(0, this.lines.length - 1);
		const text = this.lines[index]?.text ?? "";
		const mode = pickCursorMode(this.#rng, text, width);
		this.#cursorLineIndex = index;
		this.#cursorMode = mode;
		return { index, mode, text };
	}

	debugLines(): string[] {
		return this.lines.map(line => `${line.id}:${JSON.stringify(line.text)}`);
	}

	#freshLine(prefix: string): LogicalLine {
		const id = this.#nextId.toString(36);
		return this.#line(randomDecoratedText(this.#rng, `${prefix}${id}`));
	}

	#ensureLine(): void {
		if (this.lines.length === 0) {
			this.lines.push(this.#freshLine("oq"));
		}
	}

	#clampedCursorLineIndex(): number {
		return Math.max(0, Math.min(this.#cursorLineIndex, this.lines.length - 1));
	}

	#line(text: string): LogicalLine {
		const line = { id: this.#nextId, text };
		this.#nextId += 1;
		return line;
	}
}

class StressOverlayComponent implements Component, Focusable {
	focused = false;
	#model: StressOverlayModel;

	constructor(model: StressOverlayModel) {
		this.#model = model;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.#model.renderedLines(width, this.focused);
	}
}

class StressDriver {
	#scenario: Scenario;
	#rng: Rng;
	#term: VirtualTerminal;
	#tui: TUI;
	#model: StressModel;
	#component: StressComponent;
	#children: StressChildEntry[] = [];
	#overlays: StressOverlayEntry[] = [];
	#hiddenOverlaySentinels = new Set<string>();
	#nextOverlayId = 0;
	#opLog: OperationLogEntry[] = [];
	// Lines that legitimately appeared 2+ times in any committed frame. Native
	// scrollback retains rows from every past frame — content that leaves the
	// frame (a detached child, collapsed preview, truncation-colliding rows
	// after a width shrink) keeps its committed copies in history forever, so
	// the duplicate oracle must allow them cumulatively, not just against the
	// current frame.
	#everDuplicatedFrameLines = new Set<string>();
	#nativeScrollbackAuditBlocked = false;
	// Every byte the renderer wrote to the terminal, in order. The sync-output
	// discipline oracle audits bracket balance incrementally from #writeLogScanned.
	#writeLog: string[] = [];
	#writeLogScanned = 0;
	// Running depth of synchronized-output (DEC 2026) and autowrap-disable (DECAWM)
	// brackets across the whole session; both must return to 0 at every op
	// boundary and never go out of {0,1}.
	#syncDepth = 0;
	#autowrapOffDepth = 0;

	constructor(scenario: Scenario) {
		this.#scenario = scenario;
		this.#rng = new Rng(scenario.seed);
		const maxHeight = maxOf(scenario.heightChoices);
		this.#model = new StressModel(this.#rng, maxHeight + 12, scenario.uniqueContent, "root-");
		this.#component = new StressComponent(this.#model);
		this.#children = [0, 1].map(id => {
			const model = new StressModel(
				this.#rng,
				Math.max(1, Math.min(3, maxHeight)),
				scenario.uniqueContent,
				`child${id}-`,
			);
			return { id, model, component: new StressComponent(model), active: false };
		});
		this.#term = createTerminal(scenario);
		// Capture every byte written to the terminal so per-op oracles can audit
		// emission discipline (synchronized-output bracketing, autowrap restore).
		const realWrite = this.#term.write.bind(this.#term);
		(this.#term as { write: (data: string) => void }).write = (data: string) => {
			this.#writeLog.push(data);
			realWrite(data);
		};
		this.#tui = new TUI(this.#term, true);
		this.#tui.addChild(this.#component);
	}

	async run(): Promise<void> {
		try {
			this.#tui.start();
			await settle(this.#term);
			this.#assertOracles(
				{
					kind: "forceRender",
					detail: { initial: true },
					mutatesContent: false,
					checksRowAccounting: false,
					geometryChanged: false,
					forcedRender: true,
					mutatesViewport: false,
					checkpoint: false,
				},
				this.#snapshot(),
				this.#snapshot(),
				-1,
			);

			for (let index = 0; index < this.#scenario.iterations; index++) {
				const before = this.#snapshot();
				const kind = this.#chooseOperation(index, before);
				const op = await this.#applyOperation(kind);
				const after = this.#snapshot();
				this.#recordOperation(index, op.kind, op.detail, before, after);
				this.#assertOracles(op, before, after, index);

				if ((index + 1) % 50 === 0) {
					await this.#checkpoint(index, "periodicCheckpoint");
				}
			}
		} finally {
			this.#tui.stop();
			await this.#term.flush();
		}
	}

	#snapshot(): Snapshot {
		const position = this.#term.getBufferPosition();
		const expected = this.#expectedFrame();
		const view = normalizeLines(this.#term.getViewport());
		const viewBackgroundColumns: number[][] = [];
		for (let row = 0; row < this.#term.rows; row++) {
			viewBackgroundColumns.push(this.#term.getViewportRowBackgroundColumns(row));
		}
		// Tmux pane history is intentionally preserved, so overlay bytes can remain
		// in historical scrollback after resize/reflow. The non-strict tmux stress
		// oracle only checks live viewport behavior; avoid repeatedly materializing
		// huge preserved pane history that no invariant consumes.
		return {
			buffer: this.#scenario.envMode === "tmux" ? view : normalizeLines(this.#term.getScrollBuffer()),
			view,
			viewBackgroundColumns,
			frameBackgroundRows: expected.backgroundRows,
			position,
			cursor: this.#term.getCursor(),
			expectedCursor: expected.cursor,
			redraws: this.#tui.fullRedraws,
			width: this.#term.columns,
			height: this.#term.rows,
			frame: expected.frame,
			atBottom: position.viewportY >= position.baseY,
		};
	}

	#expectedFrame(): ExpectedFrame {
		const width = this.#term.columns;
		const height = this.#term.rows;
		const baseLines = this.#baseFrameLines(width);
		const composed = compositeExpectedOverlays(baseLines, this.#overlays, width, height);
		return expectedFrameFromLines(composed, width, height);
	}

	#baseFrameLines(width: number): string[] {
		return [
			...this.#component.render(width),
			...this.#children.flatMap(child => (child.active ? child.component.render(width) : [])),
		];
	}

	#hasVisibleOverlay(): boolean {
		return this.#overlays.some(entry => isExpectedOverlayVisible(entry, this.#term.columns, this.#term.rows));
	}

	#isUnknownEd3RiskScenario(): boolean {
		return (
			this.#scenario.terminalMode === "unknown" &&
			(this.#scenario.envMode === "appleTerminal" ||
				this.#scenario.envMode === "iterm2" ||
				this.#scenario.envMode === "wsl")
		);
	}

	#chooseOperation(index: number, before: Snapshot): OperationKind {
		if (this.#isUnknownEd3RiskScenario() && before.position.baseY > 0) {
			if (before.atBottom && index % 47 === 0) return "scrollUp";
			if (!before.atBottom && index % 47 === 1) return "eagerStreamingMutation";
		}

		if (
			this.#scenario.strictScrollback &&
			before.atBottom &&
			before.frame.length > before.height + 8 &&
			index % 43 === 0
		) {
			return "collapseToFew";
		}
		if (
			this.#scenario.strictScrollback &&
			before.atBottom &&
			before.frame.length > before.height + 8 &&
			!this.#hasVisibleOverlay() &&
			index % 37 === 0
		) {
			return "highWaterPreviewCollapse";
		}
		if (this.#scenario.strictScrollback && before.atBottom && index % 41 === 0) {
			return "offscreenEditAppendRepeatedTail";
		}
		if (!before.atBottom && this.#rng.chance(0.28)) {
			return "scrollToBottom";
		}

		const weighted: OperationKind[] = [];
		this.#pushWeighted(weighted, "appendSmall", 14);
		this.#pushWeighted(weighted, "streamOne", 12);
		// Exact-width rows are the pending-wrap / DECAWM boundary case: a row whose
		// visible width equals the terminal width writes its last cell, latching
		// pending-wrap on autowrap terminals so a following cursor move can wrap and
		// staircase. The renderer disables autowrap around paints (\x1b[?7l). Skipped
		// for uniqueContent scenarios — at width 1-2 the finite cell alphabet cannot
		// stay unique across hundreds of ops.
		this.#pushWeighted(weighted, "appendExactWidth", this.#scenario.uniqueContent ? 0 : 5);
		this.#pushWeighted(weighted, "appendRepeatedTail", this.#scenario.uniqueContent ? 2 : 8);
		this.#pushWeighted(weighted, "appendDuplicateOfExisting", this.#scenario.uniqueContent ? 2 : 8);
		this.#pushWeighted(weighted, "injectBlankCluster", 5);
		this.#pushWeighted(weighted, "appendBulk", 3);
		this.#pushWeighted(weighted, "editVisibleLine", 8);
		this.#pushWeighted(weighted, "editOffscreenLine", 7);
		this.#pushWeighted(weighted, "offscreenEditAppendRepeatedTail", 5);
		this.#pushWeighted(weighted, "insertOffscreen", 3);
		this.#pushWeighted(weighted, "insertMiddle", 2);
		this.#pushWeighted(weighted, "deleteTrailing", 3);
		this.#pushWeighted(weighted, "deleteMiddle", 2);
		this.#pushWeighted(weighted, "replaceAll", 1);
		this.#pushWeighted(weighted, "toggleCollapsible", 2);
		this.#pushWeighted(weighted, "tickStatusHeader", 8);
		this.#pushWeighted(weighted, "scrollUp", before.position.baseY > 0 ? 4 : 0);
		this.#pushWeighted(weighted, "scrollPartial", before.position.baseY > 0 ? 3 : 0);
		this.#pushWeighted(weighted, "scrollToBottom", before.atBottom ? 2 : 8);
		this.#pushWeighted(weighted, "resizeWidth", 3);
		this.#pushWeighted(weighted, "resizeHeight", 3);
		this.#pushWeighted(weighted, "forceRender", 2);
		this.#pushWeighted(weighted, "forceRenderAllowUnknown", 2);
		this.#pushWeighted(weighted, "forceRenderClearScrollback", 1);
		this.#pushWeighted(weighted, "forceRenderAfterEmptyOverflow", 1);
		this.#pushWeighted(weighted, "toggleFocusInput", 2);
		this.#pushWeighted(weighted, "moveCursorVisible", 3);
		this.#pushWeighted(weighted, "moveCursorOffscreen", 2);
		this.#pushWeighted(weighted, "showOverlay", this.#overlays.length < 2 ? 3 : 1);
		this.#pushWeighted(weighted, "hideOverlay", this.#overlays.length > 0 ? 2 : 0);
		this.#pushWeighted(weighted, "toggleOverlayHidden", this.#overlays.length > 0 ? 2 : 0);
		this.#pushWeighted(weighted, "editOverlay", this.#overlays.length > 0 ? 4 : 0);
		this.#pushWeighted(weighted, "moveOverlayCursor", this.#overlays.length > 0 ? 2 : 0);
		this.#pushWeighted(weighted, "coalescedBurst", 6);
		this.#pushWeighted(weighted, "rotateUp", 4);
		this.#pushWeighted(weighted, "swapOffscreenRows", 3);
		this.#pushWeighted(weighted, "collapseToFew", 1);
		this.#pushWeighted(weighted, "highWaterPreviewCollapse", 2);
		this.#pushWeighted(weighted, "eagerStreamingMutation", this.#scenario.envMode === "tmux" ? 0 : 3);
		this.#pushWeighted(weighted, "resizeBoth", 2);
		this.#pushWeighted(weighted, "resizeNoop", 1);
		this.#pushWeighted(weighted, "resizeWithAppend", 2);
		this.#pushWeighted(weighted, "attachChild", this.#children.some(child => !child.active) ? 2 : 0);
		this.#pushWeighted(weighted, "detachChild", this.#children.some(child => child.active) ? 2 : 0);
		this.#pushWeighted(weighted, "reorderChildren", this.#children.filter(child => child.active).length > 1 ? 1 : 0);
		this.#pushWeighted(weighted, "mutateChild", this.#children.some(child => child.active) ? 3 : 0);
		return this.#rng.pick(weighted);
	}

	#pushWeighted(target: OperationKind[], kind: OperationKind, weight: number): void {
		for (let i = 0; i < weight; i++) {
			target.push(kind);
		}
	}

	async #applyOperation(kind: OperationKind): Promise<AppliedOperation> {
		switch (kind) {
			case "appendSmall":
				return await this.#applyContent(kind, this.#model.appendSmall(), true);
			case "appendExactWidth":
				return await this.#applyContent(kind, this.#model.appendExactWidth(this.#term.columns), true);
			case "appendBulk":
				return await this.#applyContent(kind, this.#model.appendBulk(this.#scenario.bulkMax), true);
			case "streamOne":
				return await this.#applyContent(kind, this.#model.streamOne(), true);
			case "editVisibleLine":
				return await this.#applyContent(kind, this.#model.editVisibleLine(this.#term.rows), true);
			case "editOffscreenLine":
				return await this.#applyContent(kind, this.#model.editOffscreenLine(this.#term.rows), true);
			case "offscreenEditAppendRepeatedTail":
				return await this.#applyContent(kind, this.#model.offscreenEditAppendRepeatedTail(this.#term.rows), true);
			case "insertOffscreen":
				return await this.#applyContent(kind, this.#model.insertOffscreen(this.#term.rows), true);
			case "insertMiddle":
				return await this.#applyContent(kind, this.#model.insertMiddle(), true);
			case "deleteTrailing":
				return await this.#applyContent(kind, this.#model.deleteTrailing(), false);
			case "deleteMiddle":
				return await this.#applyContent(kind, this.#model.deleteMiddle(this.#term.rows), true);
			case "replaceAll":
				return await this.#applyContent(kind, this.#model.replaceAll(), true);
			case "toggleCollapsible":
				return await this.#applyContent(kind, this.#model.toggleCollapsible(), true);
			case "tickStatusHeader":
				return await this.#applyContent(kind, this.#model.tickStatusHeader(), true);
			case "appendRepeatedTail":
				return await this.#applyContent(kind, this.#model.appendRepeatedTail(), true);
			case "injectBlankCluster":
				return await this.#applyContent(kind, this.#model.injectBlankCluster(), true);
			case "appendDuplicateOfExisting":
				return await this.#applyContent(kind, this.#model.appendDuplicateOfExisting(), true);
			case "highWaterPreviewCollapse":
				return await this.#highWaterPreviewCollapse();
			case "eagerStreamingMutation":
				return await this.#eagerStreamingMutation();
			case "scrollUp":
				return await this.#scrollUp();
			case "scrollToBottom":
				return await this.#scrollToBottom();
			case "scrollPartial":
				return await this.#scrollPartial();
			case "resizeWidth":
				return await this.#resizeWidth();
			case "resizeHeight":
				return await this.#resizeHeight();
			case "resizeWithAppend":
				return await this.#resizeWithAppend();
			case "forceRender":
				return await this.#forceRender();
			case "forceRenderAllowUnknown":
				return await this.#forceRenderAllowUnknown();
			case "forceRenderClearScrollback":
				return await this.#forceRenderClearScrollback();
			case "forceRenderAfterEmptyOverflow":
				return await this.#forceRenderAfterEmptyOverflow();
			case "toggleFocusInput":
				return await this.#toggleFocusInput();
			case "moveCursorVisible":
				return await this.#moveBaseCursor("moveCursorVisible", false);
			case "moveCursorOffscreen":
				return await this.#moveBaseCursor("moveCursorOffscreen", true);
			case "showOverlay":
				return await this.#showOverlay();
			case "hideOverlay":
				return await this.#hideOverlay();
			case "toggleOverlayHidden":
				return await this.#toggleOverlayHidden();
			case "editOverlay":
				return await this.#editOverlay();
			case "moveOverlayCursor":
				return await this.#moveOverlayCursor();
			case "rotateUp":
				return await this.#applyContent(kind, this.#model.rotateUp(), false);
			case "collapseToFew":
				return await this.#applyContent(kind, this.#model.collapseToFew(), false);
			case "swapOffscreenRows":
				return await this.#applyContent(kind, this.#model.swapOffscreenRows(this.#term.rows), false);
			case "coalescedBurst":
				return await this.#coalescedBurst();
			case "resizeBoth":
				return await this.#resizeBoth();
			case "resizeNoop":
				return await this.#resizeNoop();
			case "attachChild":
				return await this.#attachChild();
			case "detachChild":
				return await this.#detachChild();
			case "reorderChildren":
				return await this.#reorderChildren();
			case "mutateChild":
				return await this.#mutateChild();
		}
	}

	async #applyContent(
		kind: OperationKind,
		detail: JsonObject,
		checksRowAccounting: boolean,
	): Promise<AppliedOperation> {
		this.#renderContentFrame();
		await settle(this.#term);
		return {
			kind,
			detail,
			mutatesContent: true,
			checksRowAccounting,
			geometryChanged: false,
			forcedRender: false,
			mutatesViewport: false,
			checkpoint: false,
		};
	}

	async #eagerStreamingMutation(): Promise<AppliedOperation> {
		this.#tui.setEagerNativeScrollbackRebuild(true);
		let detail: JsonObject = {};
		try {
			detail = this.#rng.chance(0.5) ? this.#model.streamOne() : this.#model.editOffscreenLine(this.#term.rows);
			this.#renderContentFrame();
			await settle(this.#term);
		} finally {
			this.#tui.setEagerNativeScrollbackRebuild(false);
		}
		return {
			kind: "eagerStreamingMutation",
			detail,
			mutatesContent: true,
			checksRowAccounting: false,
			geometryChanged: false,
			forcedRender: false,
			mutatesViewport: false,
			checkpoint: false,
		};
	}

	#renderContentFrame(): void {
		const position = this.#term.getBufferPosition();
		const atBottom = position.viewportY >= position.baseY;
		if (!this.#scenario.strictScrollback && atBottom) {
			this.#tui.requestRender(true, { allowUnknownViewportMutation: true });
		} else {
			const allowUnknownViewportMutation = this.#scenario.terminalMode === "unknown" && atBottom;
			this.#tui.requestRender(
				false,
				allowUnknownViewportMutation ? { allowUnknownViewportMutation: true } : undefined,
			);
		}
	}

	async #highWaterPreviewCollapse(): Promise<AppliedOperation> {
		// `beginHighWaterPreview` first pads seed rows up to `height + 8`, THEN
		// pushes the preview rows — so the op's true peak frame growth is the
		// padding plus the preview count, not the preview count alone. In a
		// multiplexer every one of those overflowing rows enters irretractable pane
		// history, so the transient bound must measure the actual expansion.
		const lengthBeforeBegin = this.#model.lines.length;
		const begin = this.#model.beginHighWaterPreview(this.#term.rows);
		const expandedFrameGrowth = this.#model.lines.length - lengthBeforeBegin;
		this.#renderContentFrame();
		await settle(this.#term);
		const start = typeof begin.start === "number" ? begin.start : 0;
		const count = typeof begin.count === "number" ? begin.count : 0;
		const collapse = this.#model.collapseHighWaterPreview(start, count);
		this.#renderContentFrame();
		await settle(this.#term);
		return {
			kind: "highWaterPreviewCollapse",
			detail: { begin, collapse },
			mutatesContent: true,
			checksRowAccounting: false,
			geometryChanged: false,
			forcedRender: false,
			mutatesViewport: false,
			checkpoint: false,
			// The preview rows AND the seed-padding rows that begin appended scroll
			// into history while expanded; the collapse cannot retract them, and a
			// multiplexer pane keeps every one. Bound by the measured expansion.
			transientFrameGrowth: Math.max(count, expandedFrameGrowth),
		};
	}

	async #coalescedBurst(): Promise<AppliedOperation> {
		const count = this.#rng.int(2, 6);
		const steps: JsonValue[] = [];
		let mutatesContent = false;
		let geometryChanged = false;
		let forcedRender = false;
		let mutatesViewport = false;
		for (let i = 0; i < count; i++) {
			const stepKind = this.#rng.pick(BURST_STEP_KINDS);
			const detail = this.#applyBurstStep(stepKind);
			steps.push({ kind: stepKind, detail });
			mutatesContent ||=
				stepKind !== "resizeWidth" &&
				stepKind !== "resizeHeight" &&
				stepKind !== "scrollPartial" &&
				stepKind !== "scrollToBottom" &&
				stepKind !== "forceRender";
			geometryChanged ||= stepKind === "resizeWidth" || stepKind === "resizeHeight";
			mutatesViewport ||=
				stepKind === "resizeWidth" ||
				stepKind === "resizeHeight" ||
				stepKind === "scrollPartial" ||
				stepKind === "scrollToBottom" ||
				stepKind === "forceRender";
			forcedRender ||= stepKind === "forceRender";
			// Schedule without settling so the throttle coalesces every step into one paint.
			if (stepKind !== "forceRender") this.#tui.requestRender();
		}
		this.#renderContentFrame();
		await settle(this.#term);
		return {
			kind: "coalescedBurst",
			detail: { count, steps },
			mutatesContent,
			checksRowAccounting: false,
			geometryChanged,
			forcedRender,
			mutatesViewport,
			checkpoint: false,
			coalesced: true,
		};
	}

	#applyBurstStep(kind: BurstStepKind): JsonObject {
		switch (kind) {
			case "appendSmall":
				return this.#model.appendSmall();
			case "streamOne":
				return this.#model.streamOne();
			case "appendRepeatedTail":
				return this.#model.appendRepeatedTail();
			case "injectBlankCluster":
				return this.#model.injectBlankCluster();
			case "editVisibleLine":
				return this.#model.editVisibleLine(this.#term.rows);
			case "editOffscreenLine":
				return this.#model.editOffscreenLine(this.#term.rows);
			case "tickStatusHeader":
				return this.#model.tickStatusHeader();
			case "resizeWidth": {
				const columns = this.#pickDifferent(this.#scenario.widthChoices, this.#term.columns);
				this.#term.resize(columns, this.#term.rows);
				return { columns };
			}
			case "resizeHeight": {
				const rows = this.#pickDifferent(this.#scenario.heightChoices, this.#term.rows);
				this.#term.resize(this.#term.columns, rows);
				return { rows };
			}
			case "scrollPartial": {
				const amount = this.#rng.int(1, Math.max(1, this.#term.rows));
				const direction = this.#rng.chance(0.5) ? -1 : 1;
				this.#term.scrollLines(direction * amount);
				return { amount: direction * amount };
			}
			case "scrollToBottom":
				this.#term.scrollLines(LARGE_SCROLL);
				return { amount: LARGE_SCROLL };
			case "forceRender":
				this.#tui.requestRender(true, { allowUnknownViewportMutation: true });
				return { allowUnknownViewportMutation: true };
		}
	}

	async #moveBaseCursor(
		kind: "moveCursorVisible" | "moveCursorOffscreen",
		offscreen: boolean,
	): Promise<AppliedOperation> {
		const cursor = offscreen
			? this.#model.setCursorOffscreen(this.#term.rows, this.#term.columns)
			: this.#model.setCursorVisible(this.#term.rows, this.#term.columns);
		this.#tui.setFocus(this.#component);
		this.#tui.requestRender(false, { allowUnknownViewportMutation: true });
		await settle(this.#term);
		return this.#viewOperation(kind, { cursor });
	}

	async #showOverlay(): Promise<AppliedOperation> {
		const id = this.#nextOverlayId;
		this.#nextOverlayId += 1;
		const model = new StressOverlayModel(this.#rng, id);
		const component = new StressOverlayComponent(model);
		const { options, detail } = this.#randomOverlayOptions();
		const handle = this.#tui.showOverlay(component, options);
		const entry: StressOverlayEntry = {
			id,
			sentinel: model.sentinel,
			model,
			component,
			handle,
			options,
			hidden: false,
			detail,
		};
		this.#overlays.push(entry);
		await settle(this.#term);
		return this.#viewOperation("showOverlay", {
			id,
			sentinel: model.sentinel,
			options: detail,
			lines: model.debugLines(),
		});
	}

	async #hideOverlay(): Promise<AppliedOperation> {
		const entry = this.#pickOverlay();
		if (entry === undefined) return this.#viewOperation("hideOverlay", { skipped: true });
		entry.handle.hide();
		this.#overlays = this.#overlays.filter(overlay => overlay !== entry);
		this.#hiddenOverlaySentinels.add(entry.sentinel);
		await settle(this.#term);
		return this.#viewOperation("hideOverlay", { id: entry.id, sentinel: entry.sentinel });
	}

	async #toggleOverlayHidden(): Promise<AppliedOperation> {
		const entry = this.#pickOverlay();
		if (entry === undefined) return this.#viewOperation("toggleOverlayHidden", { skipped: true });
		entry.hidden = !entry.hidden;
		entry.handle.setHidden(entry.hidden);
		if (entry.hidden) this.#hiddenOverlaySentinels.add(entry.sentinel);
		await settle(this.#term);
		return this.#viewOperation("toggleOverlayHidden", {
			id: entry.id,
			sentinel: entry.sentinel,
			hidden: entry.hidden,
		});
	}

	async #editOverlay(): Promise<AppliedOperation> {
		const entry = this.#pickOverlay();
		if (entry === undefined) return this.#viewOperation("editOverlay", { skipped: true });
		const detail = entry.model.mutate(this.#term.columns);
		this.#tui.requestRender(false, { allowUnknownViewportMutation: true });
		await settle(this.#term);
		return this.#viewOperation("editOverlay", { id: entry.id, detail });
	}

	async #moveOverlayCursor(): Promise<AppliedOperation> {
		const entry = this.#pickOverlay();
		if (entry === undefined) return this.#viewOperation("moveOverlayCursor", { skipped: true });
		const cursor = entry.model.setCursor(this.#term.columns);
		this.#tui.setFocus(entry.component);
		this.#tui.requestRender(false, { allowUnknownViewportMutation: true });
		await settle(this.#term);
		return this.#viewOperation("moveOverlayCursor", { id: entry.id, cursor });
	}

	#pickOverlay(): StressOverlayEntry | undefined {
		if (this.#overlays.length === 0) return undefined;
		return this.#overlays[this.#rng.int(0, this.#overlays.length - 1)];
	}

	#randomOverlayOptions(): { options: OverlayOptions; detail: JsonObject } {
		const options: OverlayOptions = {};
		const detail: JsonObject = {};
		if (this.#rng.chance(0.75)) {
			const width = this.#rng.chance(0.35)
				? (`${this.#rng.pick([25, 40, 60, 80])}%` as `${number}%`)
				: this.#rng.int(1, Math.max(1, this.#term.columns + 8));
			options.width = width;
			detail.width = width;
		}
		if (this.#rng.chance(0.35)) {
			const maxHeight = this.#rng.chance(0.35)
				? (`${this.#rng.pick([25, 50, 75])}%` as `${number}%`)
				: this.#rng.int(1, Math.max(1, this.#term.rows));
			options.maxHeight = maxHeight;
			detail.maxHeight = maxHeight;
		}
		if (this.#rng.chance(0.25)) {
			const minWidth = this.#rng.int(1, Math.max(1, this.#term.columns + 4));
			options.minWidth = minWidth;
			detail.minWidth = minWidth;
		}
		if (this.#rng.chance(0.5)) {
			const anchor = this.#rng.pick(OVERLAY_ANCHORS);
			options.anchor = anchor;
			options.offsetX = this.#rng.int(-3, 3);
			options.offsetY = this.#rng.int(-2, 2);
			detail.anchor = anchor;
			detail.offsetX = options.offsetX;
			detail.offsetY = options.offsetY;
		} else {
			const row = this.#rng.chance(0.45)
				? (`${this.#rng.pick([0, 25, 50, 75, 100])}%` as `${number}%`)
				: this.#rng.int(-2, this.#term.rows + 2);
			const col = this.#rng.chance(0.45)
				? (`${this.#rng.pick([0, 25, 50, 75, 100])}%` as `${number}%`)
				: this.#rng.int(-4, this.#term.columns + 4);
			options.row = row;
			options.col = col;
			detail.row = row;
			detail.col = col;
		}
		if (this.#rng.chance(0.6)) {
			if (this.#rng.chance(0.5)) {
				const margin = this.#rng.int(0, 2);
				options.margin = margin;
				detail.margin = margin;
			} else {
				const margin = {
					top: this.#rng.int(0, 2),
					right: this.#rng.int(0, 2),
					bottom: this.#rng.int(0, 2),
					left: this.#rng.int(0, 2),
				};
				options.margin = margin;
				detail.margin = margin;
			}
		}
		return { options, detail };
	}

	async #resizeBoth(): Promise<AppliedOperation> {
		const columns = this.#pickDifferent(this.#scenario.widthChoices, this.#term.columns);
		const rows = this.#pickDifferent(this.#scenario.heightChoices, this.#term.rows);
		this.#term.resize(columns, rows);
		if (!this.#scenario.strictScrollback) {
			this.#tui.requestRender(true, { allowUnknownViewportMutation: true });
		}
		await settle(this.#term);
		return {
			kind: "resizeBoth",
			detail: { columns, rows },
			mutatesContent: false,
			checksRowAccounting: false,
			geometryChanged: true,
			forcedRender: false,
			mutatesViewport: true,
			checkpoint: false,
		};
	}

	async #resizeNoop(): Promise<AppliedOperation> {
		this.#term.resize(this.#term.columns, this.#term.rows);
		await settle(this.#term);
		return {
			kind: "resizeNoop",
			detail: { columns: this.#term.columns, rows: this.#term.rows },
			mutatesContent: false,
			checksRowAccounting: false,
			geometryChanged: false,
			forcedRender: false,
			mutatesViewport: false,
			checkpoint: false,
		};
	}

	async #scrollUp(): Promise<AppliedOperation> {
		const amount = this.#rng.int(1, Math.max(1, this.#term.rows * 2));
		this.#term.scrollLines(-amount);
		await settle(this.#term);
		return this.#viewOperation("scrollUp", { amount });
	}

	async #scrollToBottom(): Promise<AppliedOperation> {
		this.#term.scrollLines(LARGE_SCROLL);
		this.#tui.requestRender(true, {
			allowUnknownViewportMutation: true,
			clearScrollback: this.#scenario.strictScrollback,
		});
		await settle(this.#term);
		return {
			kind: "scrollToBottom",
			detail: { forcedCheckpoint: this.#scenario.strictScrollback },
			mutatesContent: false,
			checksRowAccounting: false,
			geometryChanged: false,
			forcedRender: true,
			mutatesViewport: true,
			checkpoint: true,
		};
	}

	async #scrollPartial(): Promise<AppliedOperation> {
		const amount = this.#rng.int(1, Math.max(1, this.#term.rows));
		const direction = this.#rng.chance(0.5) ? -1 : 1;
		this.#term.scrollLines(direction * amount);
		await settle(this.#term);
		return this.#viewOperation("scrollPartial", { amount: direction * amount });
	}
	async #resizeWidth(): Promise<AppliedOperation> {
		const columns = this.#pickDifferent(this.#scenario.widthChoices, this.#term.columns);
		this.#term.resize(columns, this.#term.rows);
		if (!this.#scenario.strictScrollback) {
			this.#tui.requestRender(true, { allowUnknownViewportMutation: true });
		}
		await settle(this.#term);
		return {
			kind: "resizeWidth",
			detail: { columns },
			mutatesContent: false,
			checksRowAccounting: false,
			geometryChanged: true,
			forcedRender: false,
			mutatesViewport: true,
			checkpoint: false,
		};
	}

	async #resizeHeight(): Promise<AppliedOperation> {
		const rows = this.#pickDifferent(this.#scenario.heightChoices, this.#term.rows);
		this.#term.resize(this.#term.columns, rows);
		if (!this.#scenario.strictScrollback) {
			this.#tui.requestRender(true, { allowUnknownViewportMutation: true });
		}
		await settle(this.#term);
		return {
			kind: "resizeHeight",
			detail: { rows },
			mutatesContent: false,
			checksRowAccounting: false,
			geometryChanged: true,
			forcedRender: false,
			mutatesViewport: true,
			checkpoint: false,
		};
	}

	// SIGWINCH racing a streamed token: the model grows and the terminal
	// resizes inside the same frame budget. The TUI's own resize handler
	// schedules the (non-forced) render; the embedder does not force — this is
	// the default production path for "user resizes the window while the
	// assistant is streaming".
	async #resizeWithAppend(): Promise<AppliedOperation> {
		const appended = this.#model.appendSmall();
		const rows = this.#pickDifferent(this.#scenario.heightChoices, this.#term.rows);
		const columns = this.#rng.chance(0.5)
			? this.#pickDifferent(this.#scenario.widthChoices, this.#term.columns)
			: this.#term.columns;
		this.#term.resize(columns, rows);
		await settle(this.#term);
		return {
			kind: "resizeWithAppend",
			detail: { appended, columns, rows },
			mutatesContent: true,
			checksRowAccounting: false,
			geometryChanged: true,
			forcedRender: false,
			mutatesViewport: true,
			checkpoint: false,
		};
	}

	async #forceRender(): Promise<AppliedOperation> {
		this.#tui.requestRender(true);
		await settle(this.#term);
		return this.#forceOperation("forceRender", {});
	}

	async #forceRenderAllowUnknown(): Promise<AppliedOperation> {
		this.#tui.requestRender(true, { allowUnknownViewportMutation: true });
		await settle(this.#term);
		return this.#forceOperation("forceRenderAllowUnknown", { allowUnknownViewportMutation: true });
	}

	async #forceRenderClearScrollback(): Promise<AppliedOperation> {
		this.#term.scrollLines(LARGE_SCROLL);
		this.#tui.requestRender(true, { allowUnknownViewportMutation: true, clearScrollback: true });
		await settle(this.#term);
		return { ...this.#forceOperation("forceRenderClearScrollback", { clearScrollback: true }), checkpoint: true };
	}

	async #forceRenderAfterEmptyOverflow(): Promise<AppliedOperation> {
		const detachedChildren: number[] = [];
		for (const child of this.#children) {
			if (!child.active) continue;
			child.active = false;
			detachedChildren.push(child.id);
			this.#tui.removeChild(child.component);
		}
		const empty = this.#model.clear();
		this.#tui.requestRender(true, { allowUnknownViewportMutation: true, clearScrollback: true });
		await settle(this.#term);
		// The clear's own replay frame can itself overflow the viewport (status
		// header + residual rows), so the transient bound must cover everything
		// this op writes: the cleared frame plus the fresh overflow appends.
		const clearedFrameLength = this.#expectedFrame().frame.length;
		const overflowCount = this.#term.rows + this.#rng.int(1, 4);
		const overflow = this.#model.appendCount(overflowCount, "overflow");
		this.#tui.requestRender(true, { allowUnknownViewportMutation: true });
		await settle(this.#term);
		return {
			...this.#forceOperation("forceRenderAfterEmptyOverflow", { detachedChildren, empty, overflow }),
			mutatesContent: true,
			// In multiplexers everything written during this op scrolls into pane
			// history on top of whatever was already there.
			transientFrameGrowth: clearedFrameLength + overflowCount,
		};
	}

	#forceOperation(kind: OperationKind, detail: JsonObject): AppliedOperation {
		return {
			kind,
			detail,
			mutatesContent: false,
			checksRowAccounting: false,
			geometryChanged: false,
			forcedRender: true,
			mutatesViewport: kind === "forceRenderClearScrollback" || kind === "forceRenderAfterEmptyOverflow",
			checkpoint: false,
		};
	}

	async #toggleFocusInput(): Promise<AppliedOperation> {
		let cursor: JsonObject | null = null;
		if (this.#component.focused) {
			this.#tui.setFocus(null);
		} else {
			cursor = this.#rng.chance(0.25)
				? this.#model.setCursorOffscreen(this.#term.rows, this.#term.columns)
				: this.#model.setCursorVisible(this.#term.rows, this.#term.columns);
			this.#tui.setFocus(this.#component);
		}
		this.#tui.requestRender(false, { allowUnknownViewportMutation: true });
		await settle(this.#term);
		return {
			kind: "toggleFocusInput",
			detail: { focused: this.#component.focused, cursor },
			mutatesContent: false,
			checksRowAccounting: false,
			geometryChanged: false,
			forcedRender: false,
			mutatesViewport: false,
			checkpoint: false,
		};
	}

	// Container.addChild appends and Container.render walks children in array
	// order, so re-attaching a lower-id child after a higher-id one is already
	// active would leave the TUI ordered [child1, child0] while #expectedFrame
	// renders them in this.#children index order [child0, child1]. Rebuild the
	// TUI child list from the canonical this.#children order so the model and the
	// real frame always agree regardless of attach/detach sequencing.
	#syncChildOrder(): void {
		for (const child of this.#children) this.#tui.removeChild(child.component);
		this.#tui.removeChild(this.#component);
		this.#tui.addChild(this.#component);
		for (const child of this.#children) {
			if (child.active) this.#tui.addChild(child.component);
		}
	}

	async #attachChild(): Promise<AppliedOperation> {
		const child = this.#children.find(entry => !entry.active);
		if (child === undefined) return this.#viewOperation("attachChild", { skipped: true });
		child.active = true;
		this.#syncChildOrder();
		this.#renderContentFrame();
		await settle(this.#term);
		return {
			kind: "attachChild",
			detail: { id: child.id, lines: child.model.debugLines() },
			mutatesContent: true,
			checksRowAccounting: false,
			geometryChanged: false,
			forcedRender: false,
			mutatesViewport: false,
			checkpoint: false,
		};
	}

	async #detachChild(): Promise<AppliedOperation> {
		const active = this.#children.filter(entry => entry.active);
		const child = active.length === 0 ? undefined : active[this.#rng.int(0, active.length - 1)];
		if (child === undefined) return this.#viewOperation("detachChild", { skipped: true });
		child.active = false;
		this.#tui.removeChild(child.component);
		this.#renderContentFrame();
		await settle(this.#term);
		return {
			kind: "detachChild",
			detail: { id: child.id },
			mutatesContent: true,
			checksRowAccounting: false,
			geometryChanged: false,
			forcedRender: false,
			mutatesViewport: false,
			checkpoint: false,
		};
	}

	async #reorderChildren(): Promise<AppliedOperation> {
		const active = this.#children.filter(entry => entry.active);
		if (active.length < 2) return this.#viewOperation("reorderChildren", { skipped: true });
		const first = this.#children.shift();
		if (first !== undefined) this.#children.push(first);
		this.#syncChildOrder();
		this.#renderContentFrame();
		await settle(this.#term);
		return {
			kind: "reorderChildren",
			detail: { activeOrder: this.#children.filter(child => child.active).map(child => child.id) },
			mutatesContent: true,
			checksRowAccounting: false,
			geometryChanged: false,
			forcedRender: false,
			mutatesViewport: false,
			checkpoint: false,
		};
	}

	async #mutateChild(): Promise<AppliedOperation> {
		const active = this.#children.filter(entry => entry.active);
		const child = active.length === 0 ? undefined : active[this.#rng.int(0, active.length - 1)];
		if (child === undefined) return this.#viewOperation("mutateChild", { skipped: true });
		const detail = this.#rng.chance(0.5) ? child.model.appendSmall() : child.model.editVisibleLine(this.#term.rows);
		this.#renderContentFrame();
		await settle(this.#term);
		return {
			kind: "mutateChild",
			detail: { id: child.id, detail },
			mutatesContent: true,
			checksRowAccounting: false,
			geometryChanged: false,
			forcedRender: false,
			mutatesViewport: false,
			checkpoint: false,
		};
	}

	#viewOperation(kind: OperationKind, detail: JsonObject): AppliedOperation {
		return {
			kind,
			detail,
			mutatesContent: false,
			checksRowAccounting: false,
			geometryChanged: false,
			forcedRender: false,
			mutatesViewport: kind === "scrollUp" || kind === "scrollPartial",
			checkpoint: false,
		};
	}

	#pickDifferent(values: readonly number[], current: number): number {
		const candidates = values.filter(value => value !== current);
		return candidates.length === 0 ? current : this.#rng.pick(candidates);
	}

	async #checkpoint(index: number, kind: "periodicCheckpoint"): Promise<void> {
		const before = this.#snapshot();
		this.#term.scrollLines(LARGE_SCROLL);
		this.#tui.requestRender(true, {
			allowUnknownViewportMutation: true,
			clearScrollback: this.#scenario.strictScrollback,
		});
		await settle(this.#term);
		const after = this.#snapshot();
		this.#recordOperation(index, kind, { forcedCheckpoint: this.#scenario.strictScrollback }, before, after);
		this.#assertOracles(
			{
				kind: "scrollToBottom",
				detail: { periodic: true },
				mutatesContent: false,
				checksRowAccounting: false,
				geometryChanged: false,
				forcedRender: true,
				mutatesViewport: true,
				checkpoint: true,
			},
			before,
			after,
			index,
		);
	}

	#recordOperation(
		index: number,
		kind: OperationKind | "periodicCheckpoint",
		detail: JsonObject,
		before: Snapshot,
		after: Snapshot,
	): void {
		this.#opLog.push({
			index,
			kind,
			detail,
			frameLengthBefore: before.frame.length,
			frameLengthAfter: after.frame.length,
			bufferLengthBefore: before.buffer.length,
			bufferLengthAfter: after.buffer.length,
			viewportYBefore: before.position.viewportY,
			viewportYAfter: after.position.viewportY,
			baseYBefore: before.position.baseY,
			baseYAfter: after.position.baseY,
			redrawsBefore: before.redraws,
			redrawsAfter: after.redraws,
		});
	}
	#assertOracles(op: AppliedOperation, before: Snapshot, after: Snapshot, index: number): void {
		this.#assertSyncOutputDiscipline(op, before, after, index);
		this.#assertViewportFidelity(op, before, after, index);
		this.#assertCleanBufferWhenAligned(op, before, after, index);
		this.#assertNoFrameNeutralScrollbackGrowth(op, before, after, index);
		this.#assertCursor(op, before, after, index);
		this.#assertScrolledDeferral(op, before, after, index);
		this.#assertRowAccounting(op, before, after, index);
		this.#assertScrollbackGrowthMatchesFrameGrowth(op, before, after, index);
		this.#assertMultiplexerPaneHistoryGrowth(op, before, after, index);
		this.#assertHistoryPrefixStability(op, before, after, index);
		this.#assertNativeScrollbackReplay(op, before, after, index);
		this.#assertNoStaleOverlaySentinels(op, before, after, index);
		this.#assertUniqueContentNoUnexpectedDuplicates(op, before, after, index);
		this.#assertNoBackgroundBleed(op, before, after, index);
		if (op.checkpoint && this.#scenario.strictScrollback) {
			this.#assertCleanBuffer(op, before, after, index);
		}
	}

	// Synchronized-output (DEC 2026) + autowrap (DECAWM) bracket discipline.
	// Every paint write opens with PAINT_BEGIN (`\x1b[?2026h\x1b[?7l`) and closes
	// with PAINT_END (`\x1b[?7h\x1b[?2026l`); the standalone cursor write brackets
	// its move in `\x1b[?2026h…\x1b[?2026l`. The contract: across the entire byte
	// stream the brackets must strictly alternate open/close (depth stays in
	// {0,1}) and return to 0 at every op boundary. A renderer path that opens a
	// sync block and returns before closing it freezes the terminal until the
	// next keystroke — the "output froze until I pressed a key" bug class — and
	// an unbalanced `\x1b[?7l` leaves autowrap off, producing staircase trails on
	// the next non-TUI write. There is no terminal-side timeout for an unclosed
	// 2026 block (Contour synchronized-output spec), so the renderer alone owns
	// the invariant. Audits incrementally from #writeLogScanned to stay O(bytes).
	#assertSyncOutputDiscipline(op: AppliedOperation, before: Snapshot, after: Snapshot, index: number): void {
		for (; this.#writeLogScanned < this.#writeLog.length; this.#writeLogScanned++) {
			const chunk = this.#writeLog[this.#writeLogScanned]!;
			let cursor = 0;
			while (cursor < chunk.length) {
				const esc = chunk.indexOf("\x1b[?", cursor);
				if (esc === -1) break;
				if (chunk.startsWith("\x1b[?2026h", esc)) {
					this.#syncDepth++;
					if (this.#syncDepth > 1) {
						this.#fail("nested synchronized-output begin (BSU within BSU)", op, before, after, index, {
							syncDepth: this.#syncDepth,
						});
					}
					cursor = esc + 8;
				} else if (chunk.startsWith("\x1b[?2026l", esc)) {
					this.#syncDepth--;
					if (this.#syncDepth < 0) {
						this.#fail("synchronized-output end (ESU) without matching begin", op, before, after, index, {
							syncDepth: this.#syncDepth,
						});
					}
					cursor = esc + 8;
				} else if (chunk.startsWith("\x1b[?7l", esc)) {
					this.#autowrapOffDepth++;
					cursor = esc + 5;
				} else if (chunk.startsWith("\x1b[?7h", esc)) {
					this.#autowrapOffDepth--;
					cursor = esc + 5;
				} else {
					cursor = esc + 3;
				}
			}
		}
		// At an op boundary every paint/cursor write the op emitted has completed,
		// so both brackets must be balanced. A nonzero depth means a paint path
		// left the terminal inside a sync block or with autowrap disabled.
		if (this.#syncDepth !== 0) {
			this.#fail("synchronized-output left open at op boundary", op, before, after, index, {
				syncDepth: this.#syncDepth,
			});
		}
		if (this.#autowrapOffDepth !== 0) {
			this.#fail("autowrap left disabled at op boundary", op, before, after, index, {
				autowrapOffDepth: this.#autowrapOffDepth,
			});
		}
	}

	// SGR/BCE bleed: background attributes must appear only on viewport rows
	// whose logical content carries background SGR. Stress content includes
	// deliberately unreset background sequences (backgroundStyledText); the
	// renderer's per-line terminators (#applyLineResets / LINE_TERMINATOR) must
	// confine the color to its own row. A leak means BCE (back-color-erase, which
	// xterm.js and most real terminals implement) paints \x1b[K / \x1b[2K erased
	// cells with the stale background — the user-visible "random colored blank
	// rows" bug class. Text-only oracles cannot see this; this oracle reads cell
	// attributes.
	#assertNoBackgroundBleed(op: AppliedOperation, before: Snapshot, after: Snapshot, index: number): void {
		if (this.#hasVisibleOverlay()) return;
		if (!after.atBottom) return;
		const expectedView = expectedViewport(after.frame, after.height);
		const viewportTop = Math.max(0, after.frame.length - after.height);
		for (let row = 0; row < after.height; row++) {
			const backgroundColumns = after.viewBackgroundColumns[row] ?? [];
			if (backgroundColumns.length === 0) continue;
			// Judge only rows whose text matches the frame row they map to: a
			// deferred/stale row (text mismatch) has ambiguous provenance and is
			// re-checked once a repaint re-aligns it. backgroundStyledText labels are
			// never whitespace-only, so a stale background row cannot masquerade as a
			// legitimately blank row.
			if ((after.view[row] ?? "") !== (expectedView[row] ?? "")) continue;
			const frameRow = viewportTop + row;
			if (after.frameBackgroundRows[frameRow] !== true) {
				this.#fail("background SGR bleed", op, before, after, index, {
					row,
					frameRow,
					backgroundColumns,
					rowText: after.view[row] ?? null,
					expected: "background-colored cells only on rows whose content carries background SGR",
				});
			}
		}
	}

	#assertViewportFidelity(op: AppliedOperation, before: Snapshot, after: Snapshot, index: number): void {
		if (this.#hasVisibleOverlay()) return;
		if (!after.atBottom) return;
		// Multiplexer mode: the buffer snapshot is just the view, so the
		// buffer-length alignment precondition below can never hold once the frame
		// overflows. Check fidelity on geometry-changed frames instead — tmux
		// reflows the pane grid on resize, and the renderer must repaint the whole
		// visible window at the new geometry (any output anchored to pre-reflow
		// rows splices phantom rows into the pane). Geometry repaints write every
		// row, so ghost trailing blanks cannot occur and the comparison is exact.
		if (this.#scenario.envMode === "tmux") {
			if (!op.geometryChanged) return;
			const expectedAfterResize = expectedViewport(after.frame, after.height);
			if (!sameLines(after.view, expectedAfterResize)) {
				this.#fail("viewport fidelity", op, before, after, index, { expected: expectedAfterResize });
			}
			return;
		}
		// Strict bottom-anchoring only holds when the buffer carries no ghost/stale
		// extra rows. A trailing shrink clears the bottom row in place (it cannot pull
		// a scrollback line down without a disruptive full repaint), leaving the
		// content top-aligned with a ghost blank below — buffer.length then exceeds
		// the clean expectation until the next forced repaint/checkpoint re-anchors it.
		if (after.buffer.length !== this.#expectedScrollbackBuffer(after).length) return;
		const expected = expectedViewport(after.frame, after.height);
		if (!sameLines(after.view, expected)) {
			this.#fail("viewport fidelity", op, before, after, index, { expected });
		}
	}

	#assertCleanBufferWhenAligned(op: AppliedOperation, before: Snapshot, after: Snapshot, index: number): void {
		if (!this.#scenario.strictScrollback || !after.atBottom || op.geometryChanged) return;
		if (this.#hasVisibleOverlay()) return;
		if (!this.#bufferReflectsFrame(before.buffer, before.frame, before.height)) return;
		const expected = this.#expectedScrollbackBuffer(after);
		if (after.buffer.length !== expected.length) return;
		if (!sameLines(after.buffer, expected)) {
			this.#fail("aligned buffer fidelity", op, before, after, index, {
				expectedLength: expected.length,
				actualLength: after.buffer.length,
			});
		}
	}

	#assertNoFrameNeutralScrollbackGrowth(op: AppliedOperation, before: Snapshot, after: Snapshot, index: number): void {
		if (this.#hasVisibleOverlay()) return;
		if (!this.#scenario.strictScrollback || op.checkpoint || op.geometryChanged) return;
		if (!before.atBottom || !after.atBottom) return;
		if (!sameLines(before.frame, after.frame)) return;
		if (after.buffer.length > before.buffer.length) {
			if (this.#isCleanBuffer(after.buffer, after.frame, after.height)) return;
			this.#fail("frame-neutral scrollback growth", op, before, after, index, {
				beforeLength: before.buffer.length,
				afterLength: after.buffer.length,
			});
		}
	}

	#assertCursor(op: AppliedOperation, before: Snapshot, after: Snapshot, index: number): void {
		if (this.#hasVisibleOverlay()) return;
		if (after.cursor.row < 0 || after.cursor.row >= after.height || after.cursor.col < 0) {
			this.#fail("cursor bounds", op, before, after, index, { cursor: cursorObject(after) });
		}
		const expectedCursor = after.expectedCursor;
		if (expectedCursor === null || !after.atBottom) return;
		// Exact cursor parking is only predictable when the buffer is bottom-anchored
		// (no ghost/stale rows). After a trailing shrink the cursor sits on the
		// de-anchored last content row, which is checked once a repaint re-anchors.
		if (after.buffer.length !== this.#expectedScrollbackBuffer(after).length) return;
		if (after.cursor.row !== expectedCursor.row) {
			this.#fail("focused cursor row", op, before, after, index, {
				expectedRow: expectedCursor.row,
				actualRow: after.cursor.row,
				actualCol: after.cursor.col,
			});
		}
		// Cursor column is a terminal cell offset, not a UTF-16 length. When the
		// marker is at or beyond the right margin, CHA clamping/pending-wrap details
		// are terminal-dependent, so only assert exact columns that fit in-view.
		if (expectedCursor.col < after.width && after.cursor.col !== expectedCursor.col) {
			this.#fail("focused cursor column", op, before, after, index, {
				expectedCol: expectedCursor.col,
				actualCol: after.cursor.col,
				actualRow: after.cursor.row,
			});
		}
	}

	#assertScrolledDeferral(op: AppliedOperation, before: Snapshot, after: Snapshot, index: number): void {
		if (!op.mutatesContent || before.atBottom) return;
		if (op.mutatesViewport || op.geometryChanged || op.checkpoint) return;
		if (
			this.#scenario.terminalMode !== "normal" &&
			this.#scenario.platform !== "win32" &&
			!this.#isUnknownEd3RiskScenario()
		)
			return;
		if (after.position.viewportY !== before.position.viewportY) {
			this.#fail("scrolled viewport moved during content mutation", op, before, after, index, {
				expectedViewportY: before.position.viewportY,
				actualViewportY: after.position.viewportY,
			});
		}

		// The anti-yank contract while scrolled into history: the viewport must not
		// move (asserted above) and the visible rows that come from committed
		// scrollback (history) must not be rewritten by a deferred content mutation.
		// Rows below the history boundary belong to the live region and may legitimately
		// repaint — e.g. a deferred shrink pads and repaints the live viewport, and a
		// partial scroll (by < height) keeps the top live row on screen.
		const historyVisible = Math.max(0, Math.min(before.position.baseY - before.position.viewportY, before.height));
		for (let i = 0; i < historyVisible; i++) {
			if (after.view[i] !== before.view[i]) {
				this.#fail("scrolled history row rewritten during deferred content mutation", op, before, after, index, {
					row: i,
					historyVisible,
					beforeRow: before.view[i] ?? null,
					afterRow: after.view[i] ?? null,
				});
			}
		}
	}

	#assertRowAccounting(op: AppliedOperation, before: Snapshot, after: Snapshot, index: number): void {
		if (!this.#scenario.strictScrollback || this.#hasVisibleOverlay()) return;
		if (!op.mutatesContent || !op.checksRowAccounting || op.geometryChanged || op.forcedRender) return;
		if (!before.atBottom || !after.atBottom) return;
		if (this.#scrollbackCapReached(before) || this.#scrollbackCapReached(after)) return;
		if (before.redraws !== after.redraws) return;
		// Row accounting is only meaningful once content overflows the viewport. While
		// content fits within `height`, xterm pins buffer.length at `height`, so a
		// content row added inside the viewport grows the buffer by 0 — `ΔB == ΔF`
		// does not apply until rows are actually being pushed into scrollback.
		if (before.frame.length < before.height) return;
		const deltaFrame = after.frame.length - before.frame.length;
		if (deltaFrame < 0) return;
		const deltaBuffer = after.buffer.length - before.buffer.length;
		const incremental = deltaBuffer === deltaFrame;
		const clean = this.#isCleanBuffer(after.buffer, after.frame, after.height);
		if (!incremental && !clean) {
			this.#fail("buffer row accounting", op, before, after, index, {
				deltaFrame,
				deltaBuffer,
				clean,
				expected: "deltaBuffer === deltaFrame OR clean full reconstruction",
			});
		}
	}

	#assertScrollbackGrowthMatchesFrameGrowth(
		op: AppliedOperation,
		before: Snapshot,
		after: Snapshot,
		index: number,
	): void {
		if (!this.#scenario.strictScrollback || this.#hasVisibleOverlay()) return;
		if (op.checkpoint || op.geometryChanged) return;
		if (!before.atBottom || !after.atBottom) return;
		const deltaBuffer = after.buffer.length - before.buffer.length;
		if (this.#scrollbackCapReached(before) || this.#scrollbackCapReached(after)) return;
		if (deltaBuffer <= 0) return;
		const clean = this.#isCleanBuffer(after.buffer, after.frame, after.height);
		if (clean) return;
		const deltaFrame = Math.max(0, after.frame.length - before.frame.length);
		if (deltaBuffer > deltaFrame) {
			this.#fail("scrollback grew faster than frame", op, before, after, index, {
				deltaFrame,
				deltaBuffer,
				expected: "dirty live scrollback growth must not exceed logical frame growth",
			});
		}
		const expectedTail = after.frame.slice(after.frame.length - deltaBuffer);
		const actualTail = after.buffer.slice(after.buffer.length - deltaBuffer);
		if (!sameLines(actualTail, expectedTail)) {
			this.#fail("scrollback growth tail mismatch", op, before, after, index, {
				deltaBuffer,
				expectedTail,
				actualTail,
			});
		}
	}

	// Multiplexer panes never receive a destructive scrollback clear (the
	// renderer forces clearScrollback off inside tmux/screen/zellij because pane
	// history is intentionally preserved), so any full-frame replay during live
	// rendering appends a complete duplicate copy of the transcript to pane
	// history. Users see every transcript row twice (or more) when scrolling
	// back, and the per-frame write cost becomes O(frame). Bound live-frame pane
	// history growth by the rows the frame actually appended; only explicit
	// checkpoints may replay the transcript wholesale. Geometry-changed frames
	// are exempt except for pure height resizes, where xterm/tmux reflow is
	// bounded: a height shrink moves at most (oldHeight - newHeight) rows into
	// pane history and a height grow moves rows back out — width changes rewrap
	// pane history with unbounded row deltas and cannot be bounded from here.
	#assertMultiplexerPaneHistoryGrowth(op: AppliedOperation, before: Snapshot, after: Snapshot, index: number): void {
		if (this.#scenario.envMode !== "tmux") return;
		if (op.checkpoint) return;
		const heightOnlyResize = op.kind === "resizeHeight";
		if (op.geometryChanged && !heightOnlyResize) return;
		const reflowAllowance = heightOnlyResize ? Math.max(0, before.height - after.height) : 0;
		const deltaBaseY = after.position.baseY - before.position.baseY;
		if (deltaBaseY <= 0) return;
		// Rows appended at any point during the op (including transient preview
		// expansions that later collapsed) legitimately scroll into pane history
		// — terminal scrolling is how appends work, and pane history can never be
		// retracted. The invariant targets full-frame replays, which grow history
		// by ~frame.length instead of by the number of appended rows.
		const allowedGrowth =
			Math.max(Math.max(0, after.frame.length - before.frame.length), op.transientFrameGrowth ?? 0) +
			reflowAllowance;
		if (deltaBaseY > allowedGrowth) {
			this.#fail("multiplexer pane history grew faster than frame", op, before, after, index, {
				deltaBaseY,
				allowedGrowth,
				transientFrameGrowth: op.transientFrameGrowth ?? null,
				expected: "live frames must not replay the transcript into preserved pane history",
			});
		}
	}

	#assertHistoryPrefixStability(op: AppliedOperation, before: Snapshot, after: Snapshot, index: number): void {
		if (!this.#scenario.strictScrollback) return;
		if (this.#scrollbackCapReached(before) || this.#scrollbackCapReached(after)) return;
		if (!op.mutatesContent || before.redraws !== after.redraws) return;
		const prefixLength = Math.max(0, Math.min(before.position.viewportY, before.buffer.length));
		const beforePrefix = before.buffer.slice(0, prefixLength);
		const afterPrefix = after.buffer.slice(0, prefixLength);
		if (!sameLines(beforePrefix, afterPrefix)) {
			this.#fail("scrollback prefix changed without redraw", op, before, after, index, {
				prefixLength,
				beforePrefix,
				afterPrefix,
			});
		}
	}

	#assertNativeScrollbackReplay(op: AppliedOperation, before: Snapshot, after: Snapshot, index: number): void {
		if (!this.#scenario.strictScrollback) return;
		if (op.geometryChanged) {
			this.#nativeScrollbackAuditBlocked = true;
			return;
		}
		if (this.#hasVisibleOverlay()) return;
		if (this.#nativeScrollbackAuditBlocked && !op.checkpoint) return;
		if (!after.atBottom) return;
		if (!op.mutatesContent && !op.forcedRender && !op.checkpoint) return;
		const expected = this.#expectedScrollbackBuffer(after);
		if (!sameLines(after.buffer, expected)) {
			const mismatch = firstMismatchIndex(after.buffer, expected);
			this.#fail("native scrollback buffer fidelity", op, before, after, index, {
				expectedLength: expected.length,
				actualLength: after.buffer.length,
				firstMismatch: mismatch,
				expectedWindow: windowAround(expected, mismatch),
				actualWindow: windowAround(after.buffer, mismatch),
			});
		}
		this.#nativeScrollbackAuditBlocked = false;

		const probes = scrollbackProbePositions(after.position.baseY, expected.length, after.height);
		try {
			for (const viewportY of probes) {
				const current = this.#term.getBufferPosition().viewportY;
				this.#term.scrollLines(viewportY - current);
				const actual = normalizeLines(this.#term.getViewport());
				const expectedView = fixedViewportSlice(expected, viewportY, after.height);
				if (!sameLines(actual, expectedView)) {
					this.#fail("native scrollback viewport fidelity", op, before, after, index, {
						viewportY,
						expected: expectedView,
						actual,
					});
				}
			}
		} finally {
			this.#term.scrollLines(LARGE_SCROLL);
		}
	}

	#assertCleanBuffer(op: AppliedOperation, before: Snapshot, after: Snapshot, index: number): void {
		if (this.#hasVisibleOverlay()) return;
		const expected = this.#expectedScrollbackBuffer(after);
		if (!sameLines(after.buffer, expected)) {
			this.#fail("clean checkpoint reconstruction", op, before, after, index, {
				expectedLength: expected.length,
				actualLength: after.buffer.length,
			});
		}
	}

	#expectedScrollbackBuffer(snapshot: Snapshot): string[] {
		return expectedScrollbackBuffer(snapshot.frame, snapshot.height, this.#scenario.scrollback);
	}
	#scrollbackCapReached(snapshot: Snapshot): boolean {
		return Math.max(snapshot.height, snapshot.frame.length) > snapshot.height + this.#scenario.scrollback;
	}

	#bufferReflectsFrame(buffer: readonly string[], frame: readonly string[], height: number): boolean {
		return sameLines(buffer, expectedScrollbackBuffer(frame, height, this.#scenario.scrollback));
	}

	#isCleanBuffer(buffer: readonly string[], frame: readonly string[], height: number): boolean {
		return this.#bufferReflectsFrame(buffer, frame, height);
	}

	#assertNoStaleOverlaySentinels(op: AppliedOperation, before: Snapshot, after: Snapshot, index: number): void {
		if (this.#hiddenOverlaySentinels.size === 0) return;
		const visibleSentinels = new Set(
			this.#overlays
				.filter(entry => isExpectedOverlayVisible(entry, this.#term.columns, this.#term.rows))
				.map(entry => entry.sentinel),
		);
		// Multiplexers preserve pane history and do not allow the renderer to scrub
		// scrollback safely. A hidden overlay must disappear from the live viewport,
		// but the viewport can itself be parked in pane history while scrolled.
		if (this.#scenario.envMode === "tmux" && !after.atBottom) return;
		const nativeText =
			this.#scenario.envMode === "tmux"
				? after.view.join("\n")
				: `${after.buffer.join("\n")}\n${after.view.join("\n")}`;
		for (const sentinel of this.#hiddenOverlaySentinels) {
			if (visibleSentinels.has(sentinel)) continue;
			if (nativeText.includes(sentinel)) {
				this.#fail("stale overlay sentinel", op, before, after, index, { sentinel });
			}
		}
	}

	#assertUniqueContentNoUnexpectedDuplicates(
		op: AppliedOperation,
		before: Snapshot,
		after: Snapshot,
		index: number,
	): void {
		if (!this.#scenario.uniqueContent) return;
		// Accumulate even when the check below is skipped (scrolled/overlay): the
		// frame's legitimate duplicates commit to scrollback regardless of where
		// the viewport is parked.
		for (const line of duplicateNonblankLines(after.frame)) {
			this.#everDuplicatedFrameLines.add(line);
		}
		if (this.#hasVisibleOverlay() || !after.atBottom) return;
		const allowed = this.#everDuplicatedFrameLines;
		const seen = new Set<string>();
		for (const line of after.buffer) {
			if (line.length === 0) continue;
			if (seen.has(line) && !allowed.has(line)) {
				this.#fail("unexpected duplicate native scrollback line", op, before, after, index, { line });
			}
			seen.add(line);
		}
	}

	#fail(
		message: string,
		op: AppliedOperation,
		before: Snapshot,
		after: Snapshot,
		index: number,
		extra: JsonObject,
	): never {
		const dump = {
			message,
			scenario: this.#scenario.name,
			seed: formatSeed(this.#scenario.seed),
			opIndex: index,
			op: { kind: op.kind, detail: op.detail },
			extra,
			before: snapshotDump(before),
			after: snapshotDump(after),
			model: this.#model.debugLines(),
			opLog: this.#opLog,
		};
		throw new Error(`TUI render stress invariant failed: ${message}\n${JSON.stringify(dump, null, 2)}`);
	}
}

function createTerminal(scenario: Scenario): VirtualTerminal {
	const widthModel = scenario.widthModel ?? "legacy";
	switch (scenario.terminalMode) {
		case "unknown":
			return new UnknownViewportTerminal(scenario.columns, scenario.rows, scenario.scrollback, widthModel);
		case "intermittentUnknown":
			return new IntermittentUnknownViewportTerminal(
				scenario.columns,
				scenario.rows,
				scenario.scrollback,
				widthModel,
			);
		case "staleBottom":
			return new StaleBottomTerminal(scenario.columns, scenario.rows, scenario.scrollback, widthModel);
		case "normal":
			return new VirtualTerminal(scenario.columns, scenario.rows, scenario.scrollback, widthModel);
	}
}

function normalizeLines(lines: readonly string[]): string[] {
	return lines.map(line => line.trimEnd());
}

function expectedViewport(frame: readonly string[], height: number): string[] {
	return fixedViewportSlice(frame, Math.max(0, frame.length - height), height);
}

function fixedViewportSlice(frame: readonly string[], start: number, height: number): string[] {
	const view: string[] = [];
	for (let i = 0; i < height; i++) {
		view.push(frame[start + i] ?? "");
	}
	return view;
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	for (let i = 0; i < left.length; i++) {
		if (left[i] !== right[i]) return false;
	}
	return true;
}

function firstMismatchIndex(left: readonly string[], right: readonly string[]): number {
	const maxLength = Math.max(left.length, right.length);
	for (let i = 0; i < maxLength; i++) {
		if (left[i] !== right[i]) return i;
	}
	return -1;
}

function windowAround(lines: readonly string[], center: number): string[] {
	const safeCenter = center < 0 ? 0 : center;
	const start = Math.max(0, safeCenter - 3);
	const end = Math.min(lines.length, safeCenter + 4);
	return lines.slice(start, end);
}

function expectedScrollbackBuffer(frame: readonly string[], height: number, scrollback: number): string[] {
	const expected = [...frame];
	while (expected.length < height) {
		expected.push("");
	}
	const cap = height + scrollback;
	return expected.length > cap ? expected.slice(expected.length - cap) : expected;
}

function scrollbackProbePositions(maxViewportY: number, frameLength: number, height: number): number[] {
	const maxY = Math.max(0, maxViewportY);
	const positions = new Set<number>();
	const add = (value: number): void => {
		positions.add(Math.max(0, Math.min(maxY, value)));
	};
	add(0);
	add(maxY);
	add(Math.floor(maxY / 2));
	add(Math.max(0, frameLength - height));
	add(frameLength - 1);
	add(frameLength);
	if (EXHAUSTIVE_SCROLLBACK || maxY <= 32) {
		for (let y = 0; y <= maxY; y++) add(y);
	}
	return [...positions].sort((left, right) => left - right);
}

function duplicateNonblankLines(lines: readonly string[]): Set<string> {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const line of lines) {
		if (line.length === 0) continue;
		if (seen.has(line)) duplicates.add(line);
		seen.add(line);
	}
	return duplicates;
}

function expectedTerminalLine(line: string, width: number): string {
	const safeWidth = Math.max(1, width);
	const fitted = visibleWidth(line) > safeWidth ? truncateToWidth(line, safeWidth, Ellipsis.Omit) : line;
	return stripPlainTerminalText(fitted).trimEnd();
}

function stripPlainTerminalText(text: string): string {
	return stripVTControlCharacters(text)
		.replace(/\]8;;[^\x07]*(?:\x07)?/g, "")
		.replaceAll(BEL, "");
}

// SGR sequence carrying a background color parameter (40-47 basic, 48 extended,
// 100-107 bright). Used to mark which logical rows may legitimately produce
// background-colored terminal cells.
const BACKGROUND_SGR_REGEX = /\x1b\[(?:\d+;)*(?:4[0-8]|10[0-7])(?:;\d+)*m/;

function expectedFrameFromLines(lines: readonly string[], width: number, height: number): ExpectedFrame {
	const stripped = [...lines];
	const viewportTop = Math.max(0, stripped.length - height);
	let cursor: ExpectedCursor | null = null;
	const backgroundRows: boolean[] = new Array(stripped.length).fill(false);
	for (let row = stripped.length - 1; row >= 0; row--) {
		const line = stripped[row] ?? "";
		backgroundRows[row] = BACKGROUND_SGR_REGEX.test(line);
		const markerIndex = line.indexOf(CURSOR_MARKER);
		if (markerIndex === -1) continue;
		if (cursor === null && row >= viewportTop) {
			cursor = { row: row - viewportTop, col: visibleWidth(line.slice(0, markerIndex)) };
		}
		stripped[row] = removeCursorMarkers(line);
	}
	return { frame: stripped.map(line => expectedTerminalLine(line, width)), cursor, backgroundRows };
}

function removeCursorMarkers(line: string): string {
	return line.includes(CURSOR_MARKER) ? line.split(CURSOR_MARKER).join("") : line;
}

function compositeExpectedOverlays(
	lines: readonly string[],
	overlays: readonly StressOverlayEntry[],
	termWidth: number,
	termHeight: number,
): string[] {
	if (overlays.length === 0) return [...lines];
	const result = [...lines];
	const rendered: { overlayLines: string[]; row: number; col: number; w: number }[] = [];
	let minLinesNeeded = result.length;
	for (const entry of overlays) {
		if (!isExpectedOverlayVisible(entry, termWidth, termHeight)) continue;
		const firstLayout = resolveExpectedOverlayLayout(entry.options, 0, termWidth, termHeight);
		let overlayLines = entry.component.render(firstLayout.width);
		if (firstLayout.maxHeight !== undefined && overlayLines.length > firstLayout.maxHeight) {
			overlayLines = overlayLines.slice(0, firstLayout.maxHeight);
		}
		const layout = resolveExpectedOverlayLayout(entry.options, overlayLines.length, termWidth, termHeight);
		rendered.push({ overlayLines, row: layout.row, col: layout.col, w: layout.width });
		minLinesNeeded = Math.max(minLinesNeeded, layout.row + overlayLines.length);
	}
	const workingHeight = Math.max(result.length, minLinesNeeded);
	while (result.length < workingHeight) {
		result.push("");
	}
	const viewportStart = Math.max(0, workingHeight - termHeight);
	for (const { overlayLines, row, col, w } of rendered) {
		for (let i = 0; i < overlayLines.length; i++) {
			const index = viewportStart + row + i;
			if (index < 0 || index >= result.length) continue;
			const overlayLine = overlayLines[i] ?? "";
			const truncatedOverlayLine =
				visibleWidth(overlayLine) > w ? sliceByColumn(overlayLine, 0, w, true) : overlayLine;
			result[index] = compositeExpectedLineAt(result[index] ?? "", truncatedOverlayLine, col, w, termWidth);
		}
	}
	return result;
}

function isExpectedOverlayVisible(entry: StressOverlayEntry, termWidth: number, termHeight: number): boolean {
	if (entry.hidden) return false;
	return entry.options.visible?.(termWidth, termHeight) ?? true;
}

function resolveExpectedOverlayLayout(
	options: OverlayOptions | undefined,
	overlayHeight: number,
	termWidth: number,
	termHeight: number,
): { width: number; row: number; col: number; maxHeight: number | undefined } {
	const opt = options ?? {};
	const margin =
		typeof opt.margin === "number"
			? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
			: (opt.margin ?? {});
	const marginTop = Math.max(0, margin.top ?? 0);
	const marginRight = Math.max(0, margin.right ?? 0);
	const marginBottom = Math.max(0, margin.bottom ?? 0);
	const marginLeft = Math.max(0, margin.left ?? 0);
	const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
	const availHeight = Math.max(1, termHeight - marginTop - marginBottom);
	let width = parseOverlaySizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
	if (opt.minWidth !== undefined) {
		width = Math.max(width, opt.minWidth);
	}
	width = Math.max(1, Math.min(width, availWidth));
	let maxHeight = parseOverlaySizeValue(opt.maxHeight, termHeight);
	if (maxHeight !== undefined) {
		maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
	}
	const effectiveHeight = maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;
	let row: number;
	let col: number;
	if (opt.row !== undefined) {
		row =
			typeof opt.row === "string"
				? resolveOverlayPercentPosition(opt.row, Math.max(0, availHeight - effectiveHeight), marginTop)
				: opt.row;
	} else {
		row = resolveExpectedAnchorRow(opt.anchor ?? "center", effectiveHeight, availHeight, marginTop);
	}
	if (opt.col !== undefined) {
		col =
			typeof opt.col === "string"
				? resolveOverlayPercentPosition(opt.col, Math.max(0, availWidth - width), marginLeft)
				: opt.col;
	} else {
		col = resolveExpectedAnchorCol(opt.anchor ?? "center", width, availWidth, marginLeft);
	}
	if (opt.offsetY !== undefined) row += opt.offsetY;
	if (opt.offsetX !== undefined) col += opt.offsetX;
	row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
	col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));
	return { width, row, col, maxHeight };
}

function parseOverlaySizeValue(value: OverlayOptions["width"] | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	return match ? Math.floor((referenceSize * Number.parseFloat(match[1] ?? "0")) / 100) : undefined;
}

function resolveOverlayPercentPosition(value: string, maxPosition: number, margin: number): number {
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (!match) return margin + Math.floor(maxPosition / 2);
	return margin + Math.floor(maxPosition * (Number.parseFloat(match[1] ?? "0") / 100));
}

function resolveExpectedAnchorRow(
	anchor: OverlayAnchor,
	height: number,
	availHeight: number,
	marginTop: number,
): number {
	switch (anchor) {
		case "top-left":
		case "top-center":
		case "top-right":
			return marginTop;
		case "bottom-left":
		case "bottom-center":
		case "bottom-right":
			return marginTop + availHeight - height;
		case "left-center":
		case "center":
		case "right-center":
			return marginTop + Math.floor((availHeight - height) / 2);
	}
}

function resolveExpectedAnchorCol(
	anchor: OverlayAnchor,
	width: number,
	availWidth: number,
	marginLeft: number,
): number {
	switch (anchor) {
		case "top-left":
		case "left-center":
		case "bottom-left":
			return marginLeft;
		case "top-right":
		case "right-center":
		case "bottom-right":
			return marginLeft + availWidth - width;
		case "top-center":
		case "center":
		case "bottom-center":
			return marginLeft + Math.floor((availWidth - width) / 2);
	}
}

function compositeExpectedLineAt(
	baseLine: string,
	overlayLine: string,
	startCol: number,
	overlayWidth: number,
	totalWidth: number,
): string {
	const afterStart = startCol + overlayWidth;
	const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);
	const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);
	const beforePad = Math.max(0, startCol - base.beforeWidth);
	const overlayPad = Math.max(0, overlayWidth - overlay.width);
	const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
	const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
	const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
	const afterPad = Math.max(0, afterTarget - base.afterWidth);
	const result =
		base.before +
		" ".repeat(beforePad) +
		SEGMENT_RESET +
		overlay.text +
		" ".repeat(overlayPad) +
		SEGMENT_RESET +
		base.after +
		" ".repeat(afterPad);
	return visibleWidth(result) <= totalWidth ? result : sliceByColumn(result, 0, totalWidth, true);
}

function wideText(label: string): string {
	return `${label}界${SMILE}한`;
}

function arabicCombiningText(label: string): string {
	// Arabic tashkeel are nonspacing marks stored in the base cell. Stress them
	// alongside LTR labels because mis-measuring the marks used to overrun TUI
	// rows and crash on width verification (issue #643).
	return `${label}-بَسِمَ-قُرْآن`;
}

function emojiPresentationText(label: string): string {
	// Text-default symbols promoted to emoji presentation by VS16 (U+FE0F) plus a
	// keycap sequence. The renderer's native width engine (unicode-width, matching
	// ghostty/WezTerm/kitty) measures each as 2 cells, while the xterm.js test
	// model (Unicode 6 tables) renders them as 1 cell (VS16 = combining, width 0).
	// This deliberately models the legacy-terminal disagreement direction: the
	// renderer OVER-measures, so its truncation is conservative and written lines
	// can never overflow the model terminal. The opposite direction (renderer
	// under-measures, e.g. ZWJ families on kitty/alacritty) clips intra-line and
	// is locked by deterministic regression tests instead — randomized text-fidelity
	// oracles would mis-report that unavoidable clipping as a renderer bug.
	// Width facts: xterm.js UnicodeV6.ts (VS16 in BMP_COMBINING), unicode-width
	// tests ("\u{26A0}\u{FE0F}" == 2), kitty text-sizing-protocol.rst (VS16
	// promotes the previous cell to width 2).
	return `${label} \u26A0\uFE0F\u2139\uFE0F 1\uFE0F\u20E3`;
}

function styledText(label: string, color: number): string {
	return `${ESC}[${color}m${label}${ESC}[0m`;
}

function backgroundStyledText(label: string, color: number): string {
	// Background SGR with NO trailing reset. Real components do leak unreset SGR
	// (markdown renderers, raw tool output), and BCE terminals (xterm.js included)
	// fill cells erased by \x1b[K / \x1b[2K with the *current* background — so a
	// leaked background paints whole phantom-colored rows. The renderer must
	// contain the leak to this row via its per-line terminators; the
	// no-background-bleed oracle asserts neighboring and blank rows never
	// inherit the color.
	return `${ESC}[${color}m${label}`;
}

function linkedText(label: string): string {
	return `${ESC}]8;;https://example.test/${label}${BEL}${label}-link${ESC}]8;;${BEL}`;
}

function longText(label: string, repeats: number): string {
	let text = `${label}-`;
	for (let i = 0; i < repeats; i++) {
		text += `${i}界`;
	}
	return `${text}-${label}`;
}

function randomDecoratedText(rng: Rng, label: string): string {
	const roll = rng.next();
	if (roll < 0.18) return wideText(label);
	if (roll < 0.34) return styledText(`${label}界`, 31 + rng.int(0, 6));
	if (roll < 0.5) return linkedText(label);
	if (roll < 0.66) return longText(label, rng.int(2, 6));
	if (roll < 0.76) return arabicCombiningText(label);
	if (roll < 0.85) return emojiPresentationText(label);
	if (roll < 0.93) return backgroundStyledText(label, 41 + rng.int(0, 6));
	return label;
}

function pickCursorMode(rng: Rng, text: string, width: number): CursorMode {
	if (text.includes("\x1b") || visibleWidth(text) === 0 || width <= 1) {
		return rng.chance(0.5) ? "start" : "end";
	}
	return rng.pick(CURSOR_MODES);
}

function insertCursorMarker(text: string, mode: CursorMode, width: number): string {
	const index = cursorInsertionIndex(text, mode, width);
	return `${text.slice(0, index)}${CURSOR_MARKER}${text.slice(index)}`;
}

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function cursorInsertionIndex(text: string, mode: CursorMode, width: number): number {
	if (mode === "start") return 0;
	if (mode === "end" || text.includes("\x1b")) return text.length;
	const textWidth = visibleWidth(text);
	const target = mode === "wideBoundary" ? Math.max(0, Math.min(width - 1, textWidth)) : Math.floor(textWidth / 2);
	let offset = 0;
	let col = 0;
	for (const segment of SEGMENTER.segment(text)) {
		const nextCol = col + visibleWidth(segment.segment);
		if (nextCol > target) break;
		offset = segment.index + segment.segment.length;
		col = nextCol;
		if (col >= target) break;
	}
	return offset;
}

function snapshotDump(snapshot: Snapshot): JsonObject {
	return {
		buffer: snapshot.buffer,
		view: snapshot.view,
		viewBackgroundColumns: snapshot.viewBackgroundColumns,
		position: { baseY: snapshot.position.baseY, viewportY: snapshot.position.viewportY },
		cursor: cursorObject(snapshot),
		expectedCursor:
			snapshot.expectedCursor === null
				? null
				: { row: snapshot.expectedCursor.row, col: snapshot.expectedCursor.col },
		redraws: snapshot.redraws,
		width: snapshot.width,
		height: snapshot.height,
		frame: snapshot.frame,
		atBottom: snapshot.atBottom,
	};
}

function cursorObject(snapshot: Snapshot): JsonObject {
	return { row: snapshot.cursor.row, col: snapshot.cursor.col };
}

function maxOf(values: readonly number[]): number {
	let max = values[0] ?? 0;
	for (const value of values) {
		if (value > max) max = value;
	}
	return max;
}

async function settle(term: VirtualTerminal): Promise<void> {
	// Wait for the TUI's scheduled render to land using EVENT-LOOP ORDER, not
	// wall-clock sleeps. The renderer schedules non-forced renders as
	// process.nextTick(...) → setTimeout(..., 0) (the 16ms throttle always
	// computes delay 0 under the mocked performance.now). Same-delay timers fire
	// in creation order, so a nextTick + setTimeout(0) round issued here — after
	// the op's requestRender() — runs strictly after the renderer's own chain,
	// no matter how starved the worker thread is. A fixed Bun.sleep(1) raced that
	// chain and lost under parallel-worker CPU contention, snapshotting torn
	// mid-frame states that produced unreplayable "failures" (fails in a full
	// cranked run, passes in isolation — see render-stress-journal.md iteration 5).
	// Two rounds cover a render that re-requests itself; the trailing flush waits
	// out xterm.js's own async write parsing.
	for (let round = 0; round < 2; round++) {
		const tick = Promise.withResolvers<void>();
		process.nextTick(tick.resolve);
		await tick.promise;
		const timer = Promise.withResolvers<void>();
		setTimeout(timer.resolve, 0);
		await timer.promise;
	}
	await term.flush();
}

function parsePositiveInt(name: string, fallback: number): number {
	const raw = Bun.env[name];
	if (raw === undefined || raw.length === 0) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function formatSeed(seed: number): string {
	return `0x${(seed >>> 0).toString(16).padStart(8, "0")}`;
}

function scenarioEnv(envMode: EnvMode): Record<EnvKey, string | undefined> {
	return {
		TMUX: envMode === "tmux" ? "1" : undefined,
		STY: undefined,
		ZELLIJ: undefined,
		TERMUX_VERSION: envMode === "termux" ? "0.118.0" : undefined,
		WEZTERM_PANE: undefined,
		KITTY_WINDOW_ID: undefined,
		GHOSTTY_RESOURCES_DIR: undefined,
		ALACRITTY_WINDOW_ID: undefined,
		VTE_VERSION: undefined,
		TERM_PROGRAM: envMode === "appleTerminal" ? "Apple_Terminal" : envMode === "iterm2" ? "iTerm.app" : undefined,
		ITERM_SESSION_ID: envMode === "iterm2" ? "w0t0p0" : undefined,
		// WSL fronted by Windows Terminal: WT propagates WT_SESSION into the
		// Linux environment, and WSL sets its own distro markers. See #1610.
		WT_SESSION: envMode === "wsl" ? "5ca7376f-cd1b-4524-a45a-7e87b06b8f9e" : undefined,
		WSL_DISTRO_NAME: envMode === "wsl" ? "Ubuntu" : undefined,
		WSL_INTEROP: envMode === "wsl" ? "/run/WSL/8_interop" : undefined,
	};
}

export function buildScenarios(): Scenario[] {
	const soak = Bun.env.TUI_STRESS_SOAK === "1";
	const templates = soak ? soakTemplates() : coreTemplates();
	const replay = parseReplay(templates);
	if (replay !== null) {
		const maxHeight = maxOf(replay.template.heightChoices);
		return [
			materializeScenario(
				replay.template,
				replay.seed,
				replay.iterations,
				SOAK_BULK_MAX,
				SOAK_TIMEOUT_MS,
				maxHeight,
			),
		];
	}
	const defaultSeedCount = Math.max(BASE_SEEDS.length, templates.length);
	const seedCount = parsePositiveInt("TUI_STRESS_SEEDS", defaultSeedCount);
	const iterations = parsePositiveInt("TUI_STRESS_ITER", soak ? SOAK_ITERATIONS : CORE_ITERATIONS);
	const bulkMax = soak ? SOAK_BULK_MAX : CORE_BULK_MAX;
	const baseIterations = soak ? SOAK_ITERATIONS : CORE_ITERATIONS;
	const baseTimeoutMs = soak ? SOAK_TIMEOUT_MS : CORE_TIMEOUT_MS;
	// Higher-iteration hunts scale worse than linearly because exhaustive
	// scrollback probes and resize/overlay rebuilds revisit larger buffers.
	const timeoutMs = Math.max(baseTimeoutMs, Math.ceil((baseTimeoutMs * iterations * 3) / baseIterations));
	const seeds = buildSeeds(seedCount);
	const scenarios: Scenario[] = [];
	for (let i = 0; i < seeds.length; i++) {
		const template = templates[i % templates.length]!;
		const maxHeight = maxOf(template.heightChoices);
		scenarios.push(materializeScenario(template, seeds[i]!, iterations, bulkMax, timeoutMs, maxHeight));
	}
	return scenarios;
}

function materializeScenario(
	template: ScenarioTemplate,
	seed: number,
	iterations: number,
	bulkMax: number,
	timeoutMs: number,
	maxHeight: number,
): Scenario {
	return {
		...template,
		seed,
		iterations,
		bulkMax,
		scrollback: template.scrollbackRows ?? Math.max(10_000, maxHeight + 64 + iterations * (bulkMax + 8)),
		strictScrollback:
			template.envMode !== "tmux" && template.terminalMode === "normal" && template.platform !== "win32",
		timeoutMs,
		uniqueContent: template.uniqueContent ?? false,
	};
}

function parseReplay(
	templates: readonly ScenarioTemplate[],
): { template: ScenarioTemplate; seed: number; iterations: number } | null {
	const raw = Bun.env.TUI_STRESS_REPLAY;
	if (raw === undefined || raw.length === 0) return null;
	const parsed = JSON.parse(raw) as JsonObject;
	const scenario = typeof parsed.scenario === "string" ? parsed.scenario : "";
	const template = templates.find(candidate => candidate.name === scenario);
	if (template === undefined) throw new Error(`Unknown TUI_STRESS_REPLAY scenario: ${scenario}`);
	const iterations =
		typeof parsed.iterations === "number" && Number.isFinite(parsed.iterations)
			? Math.max(1, Math.floor(parsed.iterations))
			: CORE_ITERATIONS;
	const seed = parseReplaySeed(parsed.seed);
	return { template, seed, iterations };
}

function parseReplaySeed(seed: JsonValue | undefined): number {
	if (typeof seed === "number" && Number.isFinite(seed)) return seed >>> 0;
	if (typeof seed === "string") {
		const parsed = Number.parseInt(seed, seed.startsWith("0x") || seed.startsWith("0X") ? 16 : 10);
		if (Number.isFinite(parsed)) return parsed >>> 0;
	}
	return BASE_SEEDS[0];
}

function buildSeeds(count: number): number[] {
	const seeds: number[] = [];
	for (let i = 0; i < count; i++) {
		const fixed = BASE_SEEDS[i];
		seeds.push(fixed === undefined ? (0x9e3779b9 + Math.imul(i + 1, 0x85ebca6b)) >>> 0 : fixed);
	}
	return seeds;
}

type ScenarioTemplate = Omit<
	Scenario,
	"seed" | "iterations" | "bulkMax" | "scrollback" | "strictScrollback" | "timeoutMs" | "uniqueContent"
> & {
	scrollbackRows?: number;
	uniqueContent?: boolean;
};

function coreTemplates(): ScenarioTemplate[] {
	return [
		{
			name: "darwin-normal-small",
			platform: "darwin",
			terminalMode: "normal",
			envMode: "plain",
			geometryMode: "small",
			columns: 32,
			rows: 4,
			widthChoices: [10, 16, 24, 32, 40],
			heightChoices: [3, 4, 6],
			scrollbackRows: 5,
		},
		{
			name: "linux-normal-small",
			platform: "linux",
			terminalMode: "normal",
			envMode: "plain",
			geometryMode: "small",
			columns: 40,
			rows: 6,
			widthChoices: [10, 18, 32, 40],
			heightChoices: [3, 4, 6],
		},
		{
			name: "darwin-normal-large",
			platform: "darwin",
			terminalMode: "normal",
			envMode: "plain",
			geometryMode: "large",
			columns: 80,
			rows: 12,
			widthChoices: [40, 80, 120],
			heightChoices: [12, 24],
		},
		{
			name: "win32-intermittentUnknown-small",
			platform: "win32",
			terminalMode: "intermittentUnknown",
			envMode: "plain",
			geometryMode: "small",
			columns: 32,
			rows: 4,
			widthChoices: [10, 16, 32],
			heightChoices: [3, 4, 6],
		},
		{
			name: "darwin-normal-tmux-small",
			platform: "darwin",
			terminalMode: "normal",
			envMode: "tmux",
			geometryMode: "small",
			columns: 32,
			rows: 4,
			widthChoices: [10, 16, 32],
			heightChoices: [3, 4, 6],
		},
		{
			name: "linux-staleBottom-large",
			platform: "linux",
			terminalMode: "staleBottom",
			envMode: "plain",
			geometryMode: "large",
			columns: 120,
			rows: 24,
			widthChoices: [80, 120],
			heightChoices: [12, 24],
		},
		{
			name: "darwin-normal-tiny",
			platform: "darwin",
			terminalMode: "normal",
			envMode: "plain",
			geometryMode: "small",
			columns: 6,
			rows: 1,
			widthChoices: [1, 2, 6, 12],
			heightChoices: [1, 2, 3],
			uniqueContent: true,
		},
		{
			name: "linux-normal-termux-small",
			platform: "linux",
			terminalMode: "normal",
			envMode: "termux",
			geometryMode: "small",
			columns: 32,
			rows: 4,
			widthChoices: [10, 16, 32],
			heightChoices: [1, 2, 3, 4, 6],
		},
		{
			name: "darwin-unknown-appleTerminal-small",
			platform: "darwin",
			terminalMode: "unknown",
			envMode: "appleTerminal",
			geometryMode: "small",
			columns: 32,
			rows: 4,
			widthChoices: [10, 16, 32],
			heightChoices: [3, 4, 6],
			scrollbackRows: 10_000,
		},
		{
			// WSL fronted by Windows Terminal (#1610): the viewport probe is
			// permanently unobservable (kernel32 is unreachable from a Linux
			// process) and the outer WT host erases scrollback on ED3, snapping a
			// scrolled-up reader to the remaining buffer. The renderer must treat
			// this environment as ED3-risk and defer eager live rebuilds.
			name: "linux-unknown-wsl-small",
			platform: "linux",
			terminalMode: "unknown",
			envMode: "wsl",
			geometryMode: "small",
			columns: 32,
			rows: 4,
			widthChoices: [10, 16, 32],
			heightChoices: [3, 4, 6],
			scrollbackRows: 10_000,
		},
		{
			// Modern grapheme-aware terminal (ghostty/WezTerm/kitty/iTerm2/WT 1.22+):
			// the terminal's width model agrees with the renderer's native engine for
			// all stress content (emoji presentation = 2 cells, VS16 promotion), so
			// text-fidelity oracles double as cell-exact geometric oracles here.
			name: "darwin-normal-modern-small",
			platform: "darwin",
			terminalMode: "normal",
			envMode: "plain",
			geometryMode: "small",
			widthModel: "modern",
			columns: 32,
			rows: 4,
			widthChoices: [10, 16, 24, 32, 40],
			heightChoices: [3, 4, 6],
			scrollbackRows: 10_000,
		},
	];
}

function soakTemplates(): ScenarioTemplate[] {
	const templates: ScenarioTemplate[] = [];
	const platformEnvModes: readonly { platform: TestPlatform; envModes: readonly EnvMode[] }[] = [
		{ platform: "darwin", envModes: ["plain", "tmux"] },
		{ platform: "linux", envModes: ["plain", "tmux", "termux"] },
		{ platform: "win32", envModes: ["plain"] },
	];
	const terminalModes: readonly TerminalMode[] = ["normal", "unknown", "intermittentUnknown", "staleBottom"];
	const geometries: readonly GeometryMode[] = ["small", "large"];
	for (const { platform, envModes } of platformEnvModes) {
		for (const terminalMode of terminalModes) {
			for (const envMode of envModes) {
				for (const geometryMode of geometries) {
					const large = geometryMode === "large";
					templates.push({
						name: `${platform}-${terminalMode}-${envMode}-${geometryMode}`,
						platform,
						terminalMode,
						envMode,
						geometryMode,
						columns: large ? 80 : 32,
						rows: large ? 12 : 4,
						widthChoices: large ? [80, 120] : [2, 10, 16, 24, 32, 40],
						heightChoices: large ? [12, 24] : [3, 4, 6],
						...(!large && terminalMode === "normal" && envMode === "plain"
							? { scrollbackRows: 5, uniqueContent: true }
							: {}),
					});
				}
			}
		}
	}
	// WSL fronted by Windows Terminal (#1610): only the unknown terminal mode is
	// realistic — the kernel32 viewport probe never answers from a Linux process.
	for (const geometryMode of geometries) {
		const large = geometryMode === "large";
		templates.push({
			name: `linux-unknown-wsl-${geometryMode}`,
			platform: "linux",
			terminalMode: "unknown",
			envMode: "wsl",
			geometryMode,
			columns: large ? 80 : 32,
			rows: large ? 12 : 4,
			widthChoices: large ? [80, 120] : [2, 10, 16, 24, 32, 40],
			heightChoices: large ? [12, 24] : [3, 4, 6],
		});
	}
	// Modern grapheme-aware width model (ghostty/WezTerm/kitty/iTerm2/WT 1.22+):
	// terminal cell widths agree with the renderer's native engine, so the
	// text-fidelity oracles double as cell-exact geometric oracles. Cover the
	// observable probe modes on both geometries.
	for (const terminalMode of ["normal", "unknown"] as const) {
		for (const geometryMode of geometries) {
			const large = geometryMode === "large";
			templates.push({
				name: `darwin-${terminalMode}-modern-${geometryMode}`,
				platform: "darwin",
				terminalMode,
				envMode: "plain",
				geometryMode,
				widthModel: "modern",
				columns: large ? 80 : 32,
				rows: large ? 12 : 4,
				widthChoices: large ? [80, 120] : [2, 10, 16, 24, 32, 40],
				heightChoices: large ? [12, 24] : [3, 4, 6],
			});
		}
	}
	return templates;
}

export interface StressEnvSnapshot {
	bun: Record<EnvKey, string | undefined>;
	process: Record<EnvKey, string | undefined>;
}

export function applyStressEnv(envMode: Scenario["envMode"]): StressEnvSnapshot {
	const envPatch = scenarioEnv(envMode);
	const snapshot: StressEnvSnapshot = {
		bun: {
			TMUX: undefined,
			STY: undefined,
			ZELLIJ: undefined,
			TERMUX_VERSION: undefined,
			WEZTERM_PANE: undefined,
			KITTY_WINDOW_ID: undefined,
			GHOSTTY_RESOURCES_DIR: undefined,
			ALACRITTY_WINDOW_ID: undefined,
			VTE_VERSION: undefined,
			TERM_PROGRAM: undefined,
			ITERM_SESSION_ID: undefined,
			WT_SESSION: undefined,
			WSL_DISTRO_NAME: undefined,
			WSL_INTEROP: undefined,
		},
		process: {
			TMUX: undefined,
			STY: undefined,
			ZELLIJ: undefined,
			TERMUX_VERSION: undefined,
			WEZTERM_PANE: undefined,
			KITTY_WINDOW_ID: undefined,
			GHOSTTY_RESOURCES_DIR: undefined,
			ALACRITTY_WINDOW_ID: undefined,
			VTE_VERSION: undefined,
			TERM_PROGRAM: undefined,
			ITERM_SESSION_ID: undefined,
			WT_SESSION: undefined,
			WSL_DISTRO_NAME: undefined,
			WSL_INTEROP: undefined,
		},
	};
	for (const key of ENV_KEYS) {
		snapshot.bun[key] = Bun.env[key];
		snapshot.process[key] = process.env[key];
		const value = envPatch[key];
		if (value === undefined) {
			delete Bun.env[key];
			delete process.env[key];
		} else {
			Bun.env[key] = value;
			process.env[key] = value;
		}
	}
	return snapshot;
}

export function restoreStressEnv(snapshot: StressEnvSnapshot): void {
	for (const key of ENV_KEYS) {
		const bunValue = snapshot.bun[key];
		if (bunValue === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = bunValue;
		}
		const processValue = snapshot.process[key];
		if (processValue === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = processValue;
		}
	}
}

async function withPatchedEnv<T>(envMode: Scenario["envMode"], run: () => Promise<T>): Promise<T> {
	const snapshot = applyStressEnv(envMode);
	try {
		return await run();
	} finally {
		restoreStressEnv(snapshot);
	}
}

async function withPatchedPlatform<T>(platform: Scenario["platform"], run: () => Promise<T>): Promise<T> {
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { configurable: true, value: platform });
	try {
		return await run();
	} finally {
		if (platformDescriptor !== undefined) {
			Object.defineProperty(process, "platform", platformDescriptor);
		}
	}
}

export interface StressWorkerRequest {
	id: number;
	scenario: Scenario;
	patchEnv?: boolean;
}

export interface StressWorkerSuccess {
	id: number;
	ok: true;
}

export interface StressWorkerFailure {
	id: number;
	ok: false;
	scenario: string;
	seed: string;
	error: string;
	stack?: string;
}

export type StressWorkerResponse = StressWorkerSuccess | StressWorkerFailure;

async function withPatchedMonotonicNow<T>(run: () => Promise<T>): Promise<T> {
	const descriptor = Object.getOwnPropertyDescriptor(performance, "now");
	let monotonicNow = 0;
	Object.defineProperty(performance, "now", {
		configurable: true,
		value: () => {
			monotonicNow += 20;
			return monotonicNow;
		},
	});
	try {
		return await run();
	} finally {
		if (descriptor === undefined) {
			Reflect.deleteProperty(performance, "now");
		} else {
			Object.defineProperty(performance, "now", descriptor);
		}
	}
}

export async function runStressScenario(scenario: Scenario, options?: { patchEnv?: boolean }): Promise<void> {
	await withPatchedMonotonicNow(async () => {
		const run = async (): Promise<void> => {
			await withPatchedPlatform(scenario.platform, async () => {
				const driver = new StressDriver(scenario);
				await driver.run();
			});
		};
		if (options?.patchEnv === false) {
			await run();
		} else {
			await withPatchedEnv(scenario.envMode, run);
		}
	});
}

export async function runPreexistingScrollbackRegression(): Promise<void> {
	await withPatchedMonotonicNow(async () => {
		const term = new VirtualTerminal(40, 5, 100);
		term.write(`${Array.from({ length: 12 }, (_value, index) => `shell-${index}`).join("\r\n")}\r\n`);
		await settle(term);

		const tui = new TUI(term, true);
		const component = new MutableLinesComponent(["ui-0", "ui-1", "ui-2"]);
		tui.addChild(component);

		try {
			tui.start();
			await settle(term);

			const externalRows = normalizeLines(term.getScrollBuffer()).filter(line => line.startsWith("shell-"));
			if (externalRows.length === 0) {
				throw new Error("Test setup failed: preexisting shell scrollback did not survive initial TUI paint");
			}

			const frames = [
				["ui-0", "inserted-0", "ui-1", "ui-2"],
				["ui-0", "inserted-1", "ui-1", "ui-2"],
				["ui-0", "ui-1", "ui-2"],
				["prefix", "ui-0", "ui-1", "ui-2"],
			] as const;

			for (let index = 0; index < frames.length; index++) {
				component.setLines(frames[index]!);
				tui.requestRender();
				await settle(term);

				const buffer = normalizeLines(term.getScrollBuffer());
				for (const row of externalRows) {
					if (!buffer.includes(row)) {
						throw new Error(
							`Preexisting shell scrollback was cleared by visible structural mutation\n${JSON.stringify(
								{ mutationIndex: index, missing: row, externalRows, buffer },
								null,
								2,
							)}`,
						);
					}
				}
			}
		} finally {
			tui.stop();
			await term.flush();
		}
	});
}

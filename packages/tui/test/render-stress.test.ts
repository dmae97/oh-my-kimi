import { afterEach, beforeEach, describe, it, vi } from "bun:test";
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
import { VirtualTerminal } from "./virtual-terminal";

const BASE_SEEDS = [
	0x00c0ffee, 0x1badb002, 0x5eed1234, 0xdecafbad, 0x8badf00d, 0x0ddc0ffe, 0xcafed00d, 0xb16b00b5,
] as const;
const LARGE_SCROLL = 1_000_000;
const CORE_ITERATIONS = 300;
const SOAK_ITERATIONS = 600;
const CORE_BULK_MAX = 1_000;
const SOAK_BULK_MAX = 1_000;
const CORE_TIMEOUT_MS = 30_000;
const SOAK_TIMEOUT_MS = 120_000;

const SEGMENT_RESET = "\x1b[0m";
const ESC = "\x1b";
const BEL = "\x07";
const SMILE = String.fromCodePoint(0x1f642);
type TestPlatform = "darwin" | "linux" | "win32";
type TerminalMode = "normal" | "unknown";
type GeometryMode = "small" | "large";
type EnvMode = "plain" | "tmux" | "termux";
const ENV_KEYS = ["TMUX", "STY", "ZELLIJ", "TERMUX_VERSION"] as const;
type EnvKey = (typeof ENV_KEYS)[number];
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type OperationKind =
	| "appendSmall"
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
	| "scrollUp"
	| "scrollToBottom"
	| "scrollPartial"
	| "resizeWidth"
	| "resizeHeight"
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
	| "resizeNoop";

const BURST_STEP_KINDS = [
	"appendSmall",
	"streamOne",
	"appendRepeatedTail",
	"injectBlankCluster",
	"editVisibleLine",
	"editOffscreenLine",
	"tickStatusHeader",
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
}

interface StressOverlayEntry {
	id: number;
	model: StressOverlayModel;
	component: StressOverlayComponent;
	handle: OverlayHandle;
	options: OverlayOptions;
	hidden: boolean;
	detail: JsonObject;
}

interface LogicalLine {
	id: number;
	text: string;
}

interface Scenario {
	name: string;
	seed: number;
	platform: TestPlatform;
	terminalMode: TerminalMode;
	envMode: EnvMode;
	geometryMode: GeometryMode;
	columns: number;
	rows: number;
	widthChoices: readonly number[];
	heightChoices: readonly number[];
	iterations: number;
	bulkMax: number;
	scrollback: number;
	strictScrollback: boolean;
	timeoutMs: number;
}

interface Snapshot {
	buffer: string[];
	view: string[];
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
	coalesced?: boolean;
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

	constructor(rng: Rng, minLines: number) {
		this.#rng = rng;
		this.minLines = minLines;
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
		const text = this.lines[this.lines.length - 1]?.text ?? "";
		this.lines.push(this.#line(text));
		return { text };
	}

	appendDuplicateOfExisting(): JsonObject {
		const sourceIndex = this.#rng.int(0, this.lines.length - 1);
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
		this.lines[repeatedIndex] = this.#line(previousLast);
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

		const block = [
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
		if (index % 13 === 0) return "";
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
		const id = this.#nextId.toString(36);
		return this.#line(randomDecoratedText(this.#rng, `${prefix}${id}`));
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
	#rng: Rng;
	#nextId = 0;
	#cursorLineIndex = 0;
	#cursorMode: CursorMode = "middle";

	constructor(rng: Rng, id: number) {
		this.#rng = rng;
		const count = rng.int(1, 5);
		for (let i = 0; i < count; i++) {
			this.lines.push(this.#line(randomDecoratedText(rng, `ov${id}-${i}`)));
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
	#overlays: StressOverlayEntry[] = [];
	#nextOverlayId = 0;
	#opLog: OperationLogEntry[] = [];
	#nativeScrollbackAuditBlocked = false;

	constructor(scenario: Scenario) {
		this.#scenario = scenario;
		this.#rng = new Rng(scenario.seed);
		const maxHeight = maxOf(scenario.heightChoices);
		this.#model = new StressModel(this.#rng, maxHeight + 12);
		this.#component = new StressComponent(this.#model);
		this.#term = createTerminal(scenario);
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
		return {
			buffer: normalizeLines(this.#term.getScrollBuffer()),
			view: normalizeLines(this.#term.getViewport()),
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
		const baseLines = this.#component.render(width);
		const composed = compositeExpectedOverlays(baseLines, this.#overlays, width, height);
		return expectedFrameFromLines(composed, width, height);
	}

	#hasVisibleOverlay(): boolean {
		return this.#overlays.some(entry => isExpectedOverlayVisible(entry, this.#term.columns, this.#term.rows));
	}

	#chooseOperation(index: number, before: Snapshot): OperationKind {
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
		this.#pushWeighted(weighted, "appendRepeatedTail", 8);
		this.#pushWeighted(weighted, "appendDuplicateOfExisting", 8);
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
		this.#pushWeighted(weighted, "resizeBoth", 2);
		this.#pushWeighted(weighted, "resizeNoop", 1);
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
			case "forceRender":
				return await this.#forceRender();
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
		const begin = this.#model.beginHighWaterPreview(this.#term.rows);
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
			checkpoint: false,
		};
	}

	async #coalescedBurst(): Promise<AppliedOperation> {
		const count = this.#rng.int(2, 6);
		const steps: JsonValue[] = [];
		for (let i = 0; i < count; i++) {
			const stepKind = this.#rng.pick(BURST_STEP_KINDS);
			steps.push({ kind: stepKind, detail: this.#applyBurstStep(stepKind) });
			// Schedule without settling so the throttle coalesces every step into one paint.
			this.#tui.requestRender();
		}
		this.#renderContentFrame();
		await settle(this.#term);
		return {
			kind: "coalescedBurst",
			detail: { count, steps },
			mutatesContent: true,
			checksRowAccounting: false,
			geometryChanged: false,
			forcedRender: false,
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
		const entry: StressOverlayEntry = { id, model, component, handle, options, hidden: false, detail };
		this.#overlays.push(entry);
		await settle(this.#term);
		return this.#viewOperation("showOverlay", { id, options: detail, lines: model.debugLines() });
	}

	async #hideOverlay(): Promise<AppliedOperation> {
		const entry = this.#pickOverlay();
		if (entry === undefined) return this.#viewOperation("hideOverlay", { skipped: true });
		entry.handle.hide();
		this.#overlays = this.#overlays.filter(overlay => overlay !== entry);
		await settle(this.#term);
		return this.#viewOperation("hideOverlay", { id: entry.id });
	}

	async #toggleOverlayHidden(): Promise<AppliedOperation> {
		const entry = this.#pickOverlay();
		if (entry === undefined) return this.#viewOperation("toggleOverlayHidden", { skipped: true });
		entry.hidden = !entry.hidden;
		entry.handle.setHidden(entry.hidden);
		await settle(this.#term);
		return this.#viewOperation("toggleOverlayHidden", { id: entry.id, hidden: entry.hidden });
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
			checkpoint: false,
		};
	}

	async #forceRender(): Promise<AppliedOperation> {
		this.#tui.requestRender(true, { allowUnknownViewportMutation: true });
		await settle(this.#term);
		return {
			kind: "forceRender",
			detail: {},
			mutatesContent: false,
			checksRowAccounting: false,
			geometryChanged: false,
			forcedRender: true,
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
		this.#assertViewportFidelity(op, before, after, index);
		this.#assertCleanBufferWhenAligned(op, before, after, index);
		this.#assertNoFrameNeutralScrollbackGrowth(op, before, after, index);
		this.#assertCursor(op, before, after, index);
		this.#assertScrolledDeferral(op, before, after, index);
		this.#assertRowAccounting(op, before, after, index);
		this.#assertScrollbackGrowthMatchesFrameGrowth(op, before, after, index);
		this.#assertHistoryPrefixStability(op, before, after, index);
		this.#assertNativeScrollbackReplay(op, before, after, index);
		if (op.checkpoint && this.#scenario.strictScrollback) {
			this.#assertCleanBuffer(op, before, after, index);
		}
	}

	#assertViewportFidelity(op: AppliedOperation, before: Snapshot, after: Snapshot, index: number): void {
		if (this.#hasVisibleOverlay()) return;
		if (!after.atBottom) return;
		// Strict bottom-anchoring only holds when the buffer carries no ghost/stale
		// extra rows. A trailing shrink clears the bottom row in place (it cannot pull
		// a scrollback line down without a disruptive full repaint), leaving the
		// content top-aligned with a ghost blank below — buffer.length then exceeds
		// the clean expectation until the next forced repaint/checkpoint re-anchors it.
		if (after.buffer.length !== Math.max(after.height, after.frame.length)) return;
		const expected = expectedViewport(after.frame, after.height);
		if (!sameLines(after.view, expected)) {
			this.#fail("viewport fidelity", op, before, after, index, { expected });
		}
	}

	#assertCleanBufferWhenAligned(op: AppliedOperation, before: Snapshot, after: Snapshot, index: number): void {
		if (!this.#scenario.strictScrollback || !after.atBottom || op.geometryChanged) return;
		if (this.#hasVisibleOverlay()) return;
		if (!bufferReflectsFrame(before.buffer, before.frame, before.height)) return;
		if (after.buffer.length !== Math.max(after.height, after.frame.length)) return;
		if (!bufferReflectsFrame(after.buffer, after.frame, after.height)) {
			this.#fail("aligned buffer fidelity", op, before, after, index, {
				expectedLength: Math.max(after.height, after.frame.length),
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
		if (after.buffer.length !== Math.max(after.height, after.frame.length)) return;
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
		if (this.#scenario.terminalMode === "unknown" && this.#scenario.platform !== "win32") return;
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
		const clean = isCleanBuffer(after.buffer, after.frame, after.height);
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
		if (deltaBuffer <= 0) return;
		const clean = isCleanBuffer(after.buffer, after.frame, after.height);
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

	#assertHistoryPrefixStability(op: AppliedOperation, before: Snapshot, after: Snapshot, index: number): void {
		if (!this.#scenario.strictScrollback) return;
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
		const expected = expectedScrollbackBuffer(after.frame, after.height);
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

		const probes = scrollbackProbePositions(after.position.baseY, after.frame.length, after.height);
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
		if (!bufferReflectsFrame(after.buffer, after.frame, after.height)) {
			this.#fail("clean checkpoint reconstruction", op, before, after, index, {
				expectedLength: Math.max(after.height, after.frame.length),
				actualLength: after.buffer.length,
			});
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
	if (scenario.terminalMode === "unknown") {
		return new UnknownViewportTerminal(scenario.columns, scenario.rows, scenario.scrollback);
	}
	return new VirtualTerminal(scenario.columns, scenario.rows, scenario.scrollback);
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

function expectedScrollbackBuffer(frame: readonly string[], height: number): string[] {
	const expected = [...frame];
	while (expected.length < height) {
		expected.push("");
	}
	return expected;
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
	if (maxY <= 32) {
		for (let y = 0; y <= maxY; y++) add(y);
	}
	return [...positions].sort((left, right) => left - right);
}

function isCleanBuffer(buffer: readonly string[], frame: readonly string[], height: number): boolean {
	return bufferReflectsFrame(buffer, frame, height);
}

/**
 * A clean terminal buffer holds the logical frame followed by blank padding up to
 * the viewport height. When content overflows the viewport this collapses to a
 * byte-for-byte match (`buffer.length === frame.length`); when content fits, the
 * terminal still keeps `height` rows, so the tail is blank padding.
 */
function bufferReflectsFrame(buffer: readonly string[], frame: readonly string[], height: number): boolean {
	const expectedLength = Math.max(height, frame.length);
	if (buffer.length !== expectedLength) return false;
	for (let i = 0; i < frame.length; i++) {
		if (buffer[i] !== frame[i]) return false;
	}
	for (let i = frame.length; i < buffer.length; i++) {
		if (buffer[i] !== "") return false;
	}
	return true;
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

function expectedFrameFromLines(lines: readonly string[], width: number, height: number): ExpectedFrame {
	const stripped = [...lines];
	const viewportTop = Math.max(0, stripped.length - height);
	let cursor: ExpectedCursor | null = null;
	for (let row = stripped.length - 1; row >= 0; row--) {
		const line = stripped[row] ?? "";
		const markerIndex = line.indexOf(CURSOR_MARKER);
		if (markerIndex === -1) continue;
		if (cursor === null && row >= viewportTop) {
			cursor = { row: row - viewportTop, col: visibleWidth(line.slice(0, markerIndex)) };
		}
		stripped[row] = removeCursorMarkers(line);
	}
	return { frame: stripped.map(line => expectedTerminalLine(line, width)), cursor };
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

function styledText(label: string, color: number): string {
	return `${ESC}[${color}m${label}${ESC}[0m`;
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
	if (roll < 0.22) return wideText(label);
	if (roll < 0.42) return styledText(`${label}界`, 31 + rng.int(0, 6));
	if (roll < 0.62) return linkedText(label);
	if (roll < 0.82) return longText(label, rng.int(2, 6));
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
	const { promise, resolve } = Promise.withResolvers<void>();
	process.nextTick(resolve);
	await promise;
	await Bun.sleep(1);
	await term.flush();
}

function parsePositiveInt(name: string, fallback: number): number {
	const raw = Bun.env[name];
	if (raw === undefined || raw.length === 0) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatSeed(seed: number): string {
	return `0x${(seed >>> 0).toString(16).padStart(8, "0")}`;
}

function scenarioEnv(envMode: EnvMode): Record<EnvKey, string | undefined> {
	return {
		TMUX: envMode === "tmux" ? "1" : undefined,
		TERMUX_VERSION: envMode === "termux" ? "0.118.0" : undefined,
		STY: undefined,
		ZELLIJ: undefined,
	};
}

function buildScenarios(): Scenario[] {
	const soak = Bun.env.TUI_STRESS_SOAK === "1";
	const templates = soak ? soakTemplates() : coreTemplates();
	const defaultSeedCount = soak ? Math.max(BASE_SEEDS.length, templates.length) : BASE_SEEDS.length;
	const seedCount = parsePositiveInt("TUI_STRESS_SEEDS", defaultSeedCount);
	const iterations = parsePositiveInt("TUI_STRESS_ITER", soak ? SOAK_ITERATIONS : CORE_ITERATIONS);
	const bulkMax = soak ? SOAK_BULK_MAX : CORE_BULK_MAX;
	const timeoutMs = soak ? SOAK_TIMEOUT_MS : CORE_TIMEOUT_MS;
	const seeds = buildSeeds(seedCount);
	const scenarios: Scenario[] = [];
	for (let i = 0; i < seeds.length; i++) {
		const template = templates[i % templates.length]!;
		const maxHeight = maxOf(template.heightChoices);
		scenarios.push({
			...template,
			seed: seeds[i]!,
			iterations,
			bulkMax,
			scrollback: Math.max(10_000, maxHeight + 64 + iterations * (bulkMax + 8)),
			strictScrollback:
				template.envMode !== "tmux" && template.terminalMode === "normal" && template.platform !== "win32",
			timeoutMs,
		});
	}
	return scenarios;
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
	"seed" | "iterations" | "bulkMax" | "scrollback" | "strictScrollback" | "timeoutMs"
>;

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
			name: "win32-unknown-small",
			platform: "win32",
			terminalMode: "unknown",
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
			name: "linux-unknown-large",
			platform: "linux",
			terminalMode: "unknown",
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
	];
}

function soakTemplates(): ScenarioTemplate[] {
	const templates: ScenarioTemplate[] = [];
	const platforms: readonly TestPlatform[] = ["darwin", "linux", "win32"];
	const terminalModes: readonly TerminalMode[] = ["normal", "unknown"];
	const envModes: readonly EnvMode[] = ["plain", "tmux", "termux"];
	const geometries: readonly GeometryMode[] = ["small", "large"];
	for (const platform of platforms) {
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
					});
				}
			}
		}
	}
	return templates;
}

async function withPatchedGlobals<T>(scenario: Scenario, run: () => Promise<T>): Promise<T> {
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	const envPatch = scenarioEnv(scenario.envMode);
	const savedBunEnv: Record<EnvKey, string | undefined> = {
		TMUX: undefined,
		STY: undefined,
		ZELLIJ: undefined,
		TERMUX_VERSION: undefined,
	};
	const savedProcessEnv: Record<EnvKey, string | undefined> = {
		TMUX: undefined,
		STY: undefined,
		ZELLIJ: undefined,
		TERMUX_VERSION: undefined,
	};
	for (const key of ENV_KEYS) {
		savedBunEnv[key] = Bun.env[key];
		savedProcessEnv[key] = process.env[key];
		const value = envPatch[key];
		if (value === undefined) {
			delete Bun.env[key];
			delete process.env[key];
		} else {
			Bun.env[key] = value;
			process.env[key] = value;
		}
	}
	Object.defineProperty(process, "platform", { configurable: true, value: scenario.platform });
	try {
		return await run();
	} finally {
		if (platformDescriptor !== undefined) {
			Object.defineProperty(process, "platform", platformDescriptor);
		}
		for (const key of ENV_KEYS) {
			const bunValue = savedBunEnv[key];
			if (bunValue === undefined) {
				delete Bun.env[key];
			} else {
				Bun.env[key] = bunValue;
			}
			const processValue = savedProcessEnv[key];
			if (processValue === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = processValue;
			}
		}
	}
}

describe("TUI randomized render stress", () => {
	let monotonicNow = 0;

	beforeEach(() => {
		monotonicNow = 0;
		vi.spyOn(performance, "now").mockImplementation(() => {
			monotonicNow += 20;
			return monotonicNow;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	for (const scenario of buildScenarios()) {
		it(
			`${scenario.name} seed=${formatSeed(scenario.seed)} ops=${scenario.iterations}`,
			async () => {
				await withPatchedGlobals(scenario, async () => {
					const driver = new StressDriver(scenario);
					await driver.run();
				});
			},
			scenario.timeoutMs,
		);
	}
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import {
	type Component,
	CURSOR_MARKER,
	type Focusable,
	findCommittedPrefixResync,
	type OverlayAnchor,
	type OverlayHandle,
	type OverlayOptions,
	TUI,
} from "@oh-my-pi/pi-tui/tui";
import {
	Ellipsis,
	extractSegments,
	sliceByColumn,
	sliceWithWidth,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui/utils";
import { StressRenderScheduler } from "./render-stress-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

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
type EnvMode = "plain" | "tmux" | "termux" | "appleTerminal" | "iterm2" | "wsl" | "vteNoSync" | "ghostty";
export type ScenarioTag =
	| "small"
	| "large"
	| "tmux"
	| "strictScrollback"
	| "unknownViewport"
	| "foregroundStream"
	| "ed3Risk";
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
	"PI_NO_SYNC_OUTPUT",
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

export type OperationKind =
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

export const OPERATION_KINDS = [
	"appendSmall",
	"appendExactWidth",
	"appendBulk",
	"streamOne",
	"editVisibleLine",
	"editOffscreenLine",
	"offscreenEditAppendRepeatedTail",
	"insertOffscreen",
	"insertMiddle",
	"deleteTrailing",
	"deleteMiddle",
	"replaceAll",
	"toggleCollapsible",
	"tickStatusHeader",
	"appendRepeatedTail",
	"injectBlankCluster",
	"appendDuplicateOfExisting",
	"highWaterPreviewCollapse",
	"eagerStreamingMutation",
	"scrollUp",
	"scrollToBottom",
	"scrollPartial",
	"resizeWidth",
	"resizeHeight",
	"resizeWithAppend",
	"forceRender",
	"toggleFocusInput",
	"moveCursorVisible",
	"moveCursorOffscreen",
	"showOverlay",
	"hideOverlay",
	"toggleOverlayHidden",
	"editOverlay",
	"moveOverlayCursor",
	"coalescedBurst",
	"rotateUp",
	"collapseToFew",
	"swapOffscreenRows",
	"resizeBoth",
	"resizeNoop",
	"forceRenderAllowUnknown",
	"forceRenderClearScrollback",
	"forceRenderAfterEmptyOverflow",
	"attachChild",
	"detachChild",
	"reorderChildren",
	"mutateChild",
] as const satisfies readonly OperationKind[];
const OPERATION_KIND_SET = new Set<string>(OPERATION_KINDS);

export function isOperationKind(value: unknown): value is OperationKind {
	return typeof value === "string" && OPERATION_KIND_SET.has(value);
}

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
export type CursorMode = (typeof CURSOR_MODES)[number];

export interface ExpectedCursor {
	row: number;
	col: number;
}

export interface ExpectedFrame {
	frame: string[];
	cursor: ExpectedCursor | null;
	// Frame columns whose logical content carries background SGR. Only these
	// cells may have non-default background in the terminal; background outside
	// these column ranges is BCE bleed from stale SGR state painting erased cells.
	backgroundColumns: number[][];
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
	// Models a foreground tool actively streaming output: content frames are
	// re-rendered with a plain (non-forced) `requestRender()`, so offscreen-edit
	// growth flows through `viewportRepaint` (which advances the rendered line
	// count without committing the overflow to native history). The default
	// content-frame path instead forces a render and never exercises that
	// lagging-high-water state.
	foregroundStream: boolean;
	// Renders each logical line wrapped to the viewport width, so a width resize
	// changes the physical line COUNT (reflow), not just per-row truncation —
	// exercising the geometry-change + line-count-change interaction the
	// fixed-line components never produced. Wrapped content must agree with the
	// real Ghostty-backed terminal's cell widths.
	reflow: boolean;
	tags: readonly ScenarioTag[];
	replayOperations?: readonly OperationKind[];
}

type ViewportProbeTrait = "known" | "unknown" | "intermittentUnknown" | "staleBottom";

interface TerminalStressTraits {
	readonly preservesPaneHistory: boolean;
	readonly strictNativeScrollback: boolean;
	readonly syncOutputDisabled: boolean;
	readonly viewportProbe: ViewportProbeTrait;
	readonly ed3ScrollbackEraseRisk: boolean;
	readonly conptyHostScrollbackUnobservable: boolean;
	readonly foregroundStreaming: boolean;
}

interface Snapshot {
	buffer: string[];
	view: string[];
	viewBackgroundColumns: number[][];
	frameBackgroundColumns: number[][];
	position: { baseY: number; viewportY: number };
	cursor: { row: number; col: number };
	expectedCursor: ExpectedCursor | null;
	redraws: number;
	width: number;
	height: number;
	frame: string[];
	atBottom: boolean;
	shadowTapeLength: number;
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
	// The periodic prompt-submit checkpoint pins the viewport to the bottom and
	// runs the prompt-submit reconciliation (a `/clear`-style forced rebuild for
	// `normal`; other hosts get a plain forced render). Native scrollback
	// must equal the transcript only when that reconciliation actually ran:
	// ConPTY/Windows and other unobservable host-scrollback paths deliberately
	// keep dirty history deferred until the renderer gets a positive at-tail probe.
	// Plain `scrollToBottom` / forced-render ops also set `checkpoint`, but on
	// Windows hosts a forced render cannot rebuild ConPTY-hidden history, so the
	// clean-buffer oracle keys on this flag for non-`normal` scenarios.
	reconcilesNativeScrollback?: boolean;
}

type AppliedOperationOverrides = Partial<Omit<AppliedOperation, "kind" | "detail">>;

function appliedOperation(
	kind: OperationKind,
	detail: JsonObject,
	overrides: AppliedOperationOverrides,
): AppliedOperation {
	return {
		kind,
		detail,
		mutatesContent: false,
		checksRowAccounting: false,
		geometryChanged: false,
		forcedRender: false,
		checkpoint: false,
		mutatesViewport: false,
		...overrides,
	};
}

function contentOperation(
	kind: OperationKind,
	detail: JsonObject,
	checksRowAccounting: boolean,
	overrides: AppliedOperationOverrides = {},
): AppliedOperation {
	return appliedOperation(kind, detail, { mutatesContent: true, checksRowAccounting, ...overrides });
}

function viewOperation(
	kind: OperationKind,
	detail: JsonObject,
	overrides: AppliedOperationOverrides = {},
): AppliedOperation {
	return appliedOperation(kind, detail, overrides);
}

function forceRenderOperation(
	kind: OperationKind,
	detail: JsonObject,
	overrides: AppliedOperationOverrides = {},
): AppliedOperation {
	return appliedOperation(kind, detail, { forcedRender: true, ...overrides });
}

type OperationLogKind = OperationKind | "periodicCheckpoint";

interface OperationLogEntry {
	index: number;
	kind: OperationLogKind;
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

interface BurstStepMetadata {
	readonly mutatesContent: boolean;
	readonly geometryChanged: boolean;
	readonly forcedRender: boolean;
	readonly mutatesViewport: boolean;
}

const BURST_STEP_METADATA = {
	appendSmall: { mutatesContent: true, geometryChanged: false, forcedRender: false, mutatesViewport: false },
	streamOne: { mutatesContent: true, geometryChanged: false, forcedRender: false, mutatesViewport: false },
	appendRepeatedTail: { mutatesContent: true, geometryChanged: false, forcedRender: false, mutatesViewport: false },
	injectBlankCluster: { mutatesContent: true, geometryChanged: false, forcedRender: false, mutatesViewport: false },
	editVisibleLine: { mutatesContent: true, geometryChanged: false, forcedRender: false, mutatesViewport: false },
	editOffscreenLine: { mutatesContent: true, geometryChanged: false, forcedRender: false, mutatesViewport: false },
	tickStatusHeader: { mutatesContent: true, geometryChanged: false, forcedRender: false, mutatesViewport: false },
	resizeWidth: { mutatesContent: false, geometryChanged: true, forcedRender: false, mutatesViewport: true },
	resizeHeight: { mutatesContent: false, geometryChanged: true, forcedRender: false, mutatesViewport: true },
	scrollPartial: { mutatesContent: false, geometryChanged: false, forcedRender: false, mutatesViewport: true },
	scrollToBottom: { mutatesContent: false, geometryChanged: false, forcedRender: false, mutatesViewport: true },
	forceRender: { mutatesContent: false, geometryChanged: false, forcedRender: true, mutatesViewport: true },
} satisfies Record<BurstStepKind, BurstStepMetadata>;

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

interface StressRandomStreams {
	readonly ops: Rng;
	readonly content: Rng;
	readonly overlay: Rng;
	readonly geometry: Rng;
	readonly cursor: Rng;
	readonly children: Rng;
}

function createRandomStreams(seed: number): StressRandomStreams {
	return {
		ops: new Rng(mixSeed(seed, 0x01)),
		content: new Rng(mixSeed(seed, 0x02)),
		overlay: new Rng(mixSeed(seed, 0x03)),
		geometry: new Rng(mixSeed(seed, 0x04)),
		cursor: new Rng(mixSeed(seed, 0x05)),
		children: new Rng(mixSeed(seed, 0x06)),
	};
}

function mixSeed(seed: number, stream: number): number {
	let mixed = (seed ^ Math.imul(stream, 0x9e3779b9)) >>> 0;
	mixed = Math.imul(mixed ^ (mixed >>> 16), 0x7feb352d);
	mixed = Math.imul(mixed ^ (mixed >>> 15), 0x846ca68b);
	return (mixed ^ (mixed >>> 16)) >>> 0;
}

function isEd3RiskScenario(terminalMode: TerminalMode, envMode: EnvMode): boolean {
	return (
		terminalMode === "unknown" &&
		(envMode === "appleTerminal" || envMode === "iterm2" || envMode === "wsl" || envMode === "ghostty")
	);
}

interface WeightedCandidate<T> {
	readonly item: T;
	readonly weight: number;
}

function weightedPick<T>(rng: Rng, items: readonly WeightedCandidate<T>[]): T {
	let total = 0;
	for (const entry of items) {
		total += Math.max(0, entry.weight);
	}
	if (total <= 0) throw new Error("No weighted candidates");

	let roll = rng.next() * total;
	for (const entry of items) {
		const weight = Math.max(0, entry.weight);
		roll -= weight;
		if (roll < 0) return entry.item;
	}
	return items[items.length - 1]!.item;
}

function assertNever(value: never): never {
	throw new Error(`Unexpected value: ${String(value)}`);
}

function terminalStressTraits(scenario: Scenario): TerminalStressTraits {
	return {
		preservesPaneHistory: scenario.envMode === "tmux",
		strictNativeScrollback: scenario.strictScrollback,
		syncOutputDisabled: scenario.envMode === "vteNoSync",
		viewportProbe: scenario.terminalMode === "normal" ? "known" : scenario.terminalMode,
		ed3ScrollbackEraseRisk: isEd3RiskScenario(scenario.terminalMode, scenario.envMode),
		conptyHostScrollbackUnobservable: scenario.platform === "win32" && scenario.terminalMode === "unknown",
		foregroundStreaming: scenario.foregroundStream,
	};
}

function scenarioTags(
	template: Pick<Scenario, "envMode" | "terminalMode" | "geometryMode">,
	strictNativeScrollback: boolean,
	foregroundStreaming: boolean,
): readonly ScenarioTag[] {
	const tags: ScenarioTag[] = [template.geometryMode];
	if (template.envMode === "tmux") tags.push("tmux");
	if (strictNativeScrollback) tags.push("strictScrollback");
	if (template.terminalMode !== "normal") tags.push("unknownViewport");
	if (foregroundStreaming) tags.push("foregroundStream");
	if (isEd3RiskScenario(template.terminalMode, template.envMode)) tags.push("ed3Risk");
	return tags;
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

// Wrap a rendered line set to the viewport width, ANSI- and grapheme-aware, so
// a logical line can occupy a width-dependent NUMBER of physical rows — the
// reflow that real wrapped/markdown content performs and that fixed-line
// components never exercised. Use the renderer's native wrapper rather than
// Bun.wrapAnsi so combining marks stay with their base grapheme instead of
// starting a physical row the terminal will fold back into the previous cell.
function reflowToWidth(lines: readonly string[], width: number): string[] {
	const target = Math.max(1, width);
	const out: string[] = [];
	for (const line of lines) {
		if (line.length === 0) {
			out.push("");
			continue;
		}
		for (const physical of wrapTextWithAnsi(line, target)) out.push(physical);
	}
	return out;
}

class StressComponent implements Component, Focusable {
	focused = false;
	#model: StressModel;
	#reflow: boolean;

	constructor(model: StressModel, reflow = false) {
		this.#model = model;
		this.#reflow = reflow;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines = this.#model.renderedLines(width, this.focused);
		return this.#reflow ? reflowToWidth(lines, width) : lines;
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
	#streams: StressRandomStreams;
	#traits: TerminalStressTraits;
	#scheduler: StressRenderScheduler;
	#term: VirtualTerminal;
	#tui: TUI;
	#model: StressModel;
	#component: StressComponent;
	#children: StressChildEntry[] = [];
	#overlays: StressOverlayEntry[] = [];
	#hiddenOverlaySentinels = new Set<string>();
	#nextOverlayId = 0;
	#opLog: OperationLogEntry[] = [];
	#operationCoverage = new Map<OperationLogKind, number>();
	// Lines that legitimately appeared 2+ times in any committed frame. Native
	// scrollback retains rows from every past frame — content that leaves the
	// frame (a detached child, collapsed preview, truncation-colliding rows
	// after a width shrink) keeps its committed copies in history forever, so
	// the duplicate oracle must allow them cumulatively, not just against the
	// current frame.
	#everDuplicatedFrameLines = new Set<string>();
	// Shadow commit ledger mirroring the engine's append-only law, fed only by
	// observed frames (render wrap) and observed bytes (write wrap) — never by
	// engine internals. `#shadowTape` is what native scrollback must contain;
	// `#shadowWindowTop` is the frame row mapped to grid row 0. Double-entry
	// bookkeeping for committedRows/windowTop: the engine and this ledger must
	// independently arrive at the same terminal state.
	#shadowTape: string[] = [];
	#shadowCommitted = 0;
	// Raw-row mirror of the engine's committed prefix. The resync audit must
	// run on the same inputs as the engine (raw rows, not normalized ones), or
	// width-truncation collisions would let the two ledgers disagree about
	// whether a divergence happened.
	#shadowRawFrame: string[] = [];
	#shadowRawPrefix: string[] = [];
	#shadowWindowTop = 0;
	#shadowFrame: string[] = [];
	#shadowFrameHeight = 0;
	#shadowFrameWidth = 0;
	#shadowFrameOverlay = false;
	#shadowFrameGeometryChanged = false;
	#shadowResizePending = false;
	#shadowAltActive = false;
	// Every byte the renderer wrote to the terminal, in order. The sync-output
	// discipline oracle audits bracket balance incrementally from #writeLogScanned
	// and carries partial private CSI sequences across write chunks.
	#writeLog: string[] = [];
	#writeLogScanned = 0;
	#ansiCarry = "";
	// Running depth of synchronized-output (DEC 2026) and autowrap-disable (DECAWM)
	// brackets across the whole session; both must return to 0 at every op
	// boundary and never go out of {0,1}.
	#syncDepth = 0;
	#autowrapOffDepth = 0;

	constructor(scenario: Scenario) {
		this.#scenario = scenario;
		this.#streams = createRandomStreams(scenario.seed);
		this.#traits = terminalStressTraits(scenario);
		this.#scheduler = new StressRenderScheduler();
		const maxHeight = maxOf(scenario.heightChoices);
		this.#model = new StressModel(this.#streams.content, maxHeight + 12, scenario.uniqueContent, "root-");
		this.#component = new StressComponent(this.#model, scenario.reflow);
		this.#children = [0, 1].map(id => {
			const model = new StressModel(
				this.#streams.children,
				Math.max(1, Math.min(3, maxHeight)),
				scenario.uniqueContent,
				`child${id}-`,
			);
			return { id, model, component: new StressComponent(model, scenario.reflow), active: false };
		});
		this.#term = createTerminal(scenario);
		// Capture every byte written to the terminal so per-op oracles can audit
		// emission discipline (synchronized-output bracketing, autowrap restore).
		const realWrite = this.#term.write.bind(this.#term);
		(this.#term as { write: (data: string) => void }).write = (data: string) => {
			this.#writeLog.push(data);
			realWrite(data);
			this.#applyShadowWrite(data);
		};
		// Mirror the engine's resize-event signal: a net-unchanged resize still
		// reflows the terminal, and the engine classifies it as a geometry frame
		// (audit skipped, commits frozen in multiplexers) — a dimension compare
		// alone cannot see it.
		const realResize = this.#term.resize.bind(this.#term);
		(this.#term as { resize: (columns: number, rows: number) => void }).resize = (columns: number, rows: number) => {
			this.#shadowResizePending = true;
			realResize(columns, rows);
		};
		this.#tui = new TUI(this.#term, true, { renderScheduler: this.#scheduler });
		this.#tui.addChild(this.#component);
		const realRender = this.#tui.render.bind(this.#tui);
		(this.#tui as { render: (width: number) => readonly string[] }).render = (width: number) => {
			const lines = realRender(width);
			this.#shadowFrameGeometryChanged =
				this.#shadowResizePending ||
				(this.#shadowFrameWidth > 0 &&
					(width !== this.#shadowFrameWidth || this.#term.rows !== this.#shadowFrameHeight));
			this.#shadowResizePending = false;
			// Markers are engine-internal sentinels; the engine strips them from
			// this same array immediately after render returns, and its commit
			// ledger (prefix + audit) only ever sees stripped rows — mirror that
			// exactly. (Also: stripVTControlCharacters would otherwise swallow
			// everything after an APC introducer during normalization.)
			const stripped = lines.map(line => (line.includes(CURSOR_MARKER) ? line.replaceAll(CURSOR_MARKER, "") : line));
			this.#shadowRawFrame = stripped;
			this.#shadowFrame = stripped.map(line => expectedTerminalLine(line, width));
			this.#shadowFrameWidth = width;
			this.#shadowFrameHeight = this.#term.rows;
			this.#shadowFrameOverlay = this.#tui.hasOverlay();
			// Mirror the engine's render-time ledger transitions here: the audit
			// resync and the shrink-into-prefix re-anchor can both fire on frames
			// that emit zero bytes, which the write hook would never observe.
			if (!this.#shadowFrameGeometryChanged && this.#shadowRawPrefix.length > 0) {
				const resyncTo = findCommittedPrefixResync(stripped, this.#shadowRawPrefix);
				if (resyncTo >= 0) {
					this.#shadowCommitted = resyncTo;
					this.#shadowRawPrefix.length = resyncTo;
				}
			}
			if (stripped.length <= this.#shadowCommitted) {
				this.#shadowCommitted = Math.max(0, stripped.length - Math.max(1, this.#term.rows));
				this.#shadowWindowTop = this.#shadowCommitted;
				this.#shadowRawPrefix = stripped.slice(0, this.#shadowCommitted);
			}
			return lines;
		};
	}

	async run(): Promise<void> {
		try {
			this.#tui.start();
			await this.#settle();
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
				const kind = this.#scenario.replayOperations?.[index] ?? this.#chooseOperation(index, before);
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
			buffer: this.#traits.preservesPaneHistory ? view : normalizeLines(this.#term.getScrollBuffer()),
			view,
			viewBackgroundColumns,
			frameBackgroundColumns: expected.backgroundColumns,
			position,
			cursor: this.#term.getCursor(),
			expectedCursor: expected.cursor,
			redraws: this.#tui.fullRedraws,
			width: this.#term.columns,
			height: this.#term.rows,
			frame: expected.frame,
			atBottom: position.viewportY >= position.baseY,
			shadowTapeLength: this.#shadowTape.length,
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

	#settle(): Promise<void> {
		return this.#scheduler.drain(this.#term);
	}

	#chooseOperation(index: number, before: Snapshot): OperationKind {
		if (
			(this.#traits.ed3ScrollbackEraseRisk || this.#traits.conptyHostScrollbackUnobservable) &&
			before.position.baseY > 0
		) {
			if (before.atBottom && index % 47 === 0) return "scrollUp";
			if (!before.atBottom && index % 47 === 1) {
				return this.#traits.foregroundStreaming ? "streamOne" : "eagerStreamingMutation";
			}
		}

		if (
			this.#traits.strictNativeScrollback &&
			before.atBottom &&
			before.frame.length > before.height + 8 &&
			index % 43 === 0
		) {
			return "collapseToFew";
		}
		if (
			this.#traits.strictNativeScrollback &&
			before.atBottom &&
			before.frame.length > before.height + 8 &&
			!this.#hasVisibleOverlay() &&
			index % 37 === 0
		) {
			return "highWaterPreviewCollapse";
		}
		if (this.#traits.strictNativeScrollback && before.atBottom && index % 41 === 0) {
			return "offscreenEditAppendRepeatedTail";
		}
		if (!before.atBottom && this.#streams.ops.chance(0.28)) {
			return "scrollToBottom";
		}

		// Exact-width rows are the pending-wrap / DECAWM boundary case: a row whose
		// visible width equals the terminal width writes its last cell, latching
		// pending-wrap on autowrap terminals so a following cursor move can wrap and
		// staircase. The renderer disables autowrap around paints (\x1b[?7l). Skipped
		// for uniqueContent scenarios — at width 1-2 the finite cell alphabet cannot
		// stay unique across hundreds of ops.
		const weighted: readonly WeightedCandidate<OperationKind>[] = [
			{ item: "appendSmall", weight: 14 },
			{ item: "streamOne", weight: 12 },
			{ item: "appendExactWidth", weight: this.#scenario.uniqueContent ? 0 : 5 },
			{ item: "appendRepeatedTail", weight: this.#scenario.uniqueContent ? 2 : 8 },
			{ item: "appendDuplicateOfExisting", weight: this.#scenario.uniqueContent ? 2 : 8 },
			{ item: "injectBlankCluster", weight: 5 },
			{ item: "appendBulk", weight: 3 },
			{ item: "editVisibleLine", weight: 8 },
			{ item: "editOffscreenLine", weight: 7 },
			{ item: "offscreenEditAppendRepeatedTail", weight: 5 },
			{ item: "insertOffscreen", weight: 3 },
			{ item: "insertMiddle", weight: 2 },
			{ item: "deleteTrailing", weight: 3 },
			{ item: "deleteMiddle", weight: 2 },
			{ item: "replaceAll", weight: 1 },
			{ item: "toggleCollapsible", weight: 2 },
			{ item: "tickStatusHeader", weight: 8 },
			{ item: "scrollUp", weight: before.position.baseY > 0 ? 4 : 0 },
			{ item: "scrollPartial", weight: before.position.baseY > 0 ? 3 : 0 },
			{ item: "scrollToBottom", weight: before.atBottom ? 2 : 8 },
			{ item: "resizeWidth", weight: 3 },
			{ item: "resizeHeight", weight: 3 },
			{ item: "forceRender", weight: 2 },
			{ item: "forceRenderAllowUnknown", weight: 2 },
			{ item: "forceRenderClearScrollback", weight: 1 },
			{ item: "forceRenderAfterEmptyOverflow", weight: 1 },
			{ item: "toggleFocusInput", weight: 2 },
			{ item: "moveCursorVisible", weight: 3 },
			{ item: "moveCursorOffscreen", weight: 2 },
			{ item: "showOverlay", weight: this.#overlays.length < 2 ? 3 : 1 },
			{ item: "hideOverlay", weight: this.#overlays.length > 0 ? 2 : 0 },
			{ item: "toggleOverlayHidden", weight: this.#overlays.length > 0 ? 2 : 0 },
			{ item: "editOverlay", weight: this.#overlays.length > 0 ? 4 : 0 },
			{ item: "moveOverlayCursor", weight: this.#overlays.length > 0 ? 2 : 0 },
			{ item: "coalescedBurst", weight: 6 },
			{ item: "rotateUp", weight: 4 },
			{ item: "swapOffscreenRows", weight: 3 },
			{ item: "collapseToFew", weight: 1 },
			{ item: "highWaterPreviewCollapse", weight: 2 },
			// `eagerStreamingMutation` toggles the eager opt-in off in its `finally`,
			// which would end the modeled foreground-tool turn early; a foregroundStream
			// scenario keeps the opt-in on for its whole run, so skip it there.
			{
				item: "eagerStreamingMutation",
				weight: this.#traits.preservesPaneHistory || this.#traits.foregroundStreaming ? 0 : 3,
			},
			{ item: "resizeBoth", weight: 2 },
			{ item: "resizeNoop", weight: 1 },
			{ item: "resizeWithAppend", weight: 2 },
			{ item: "attachChild", weight: this.#children.some(child => !child.active) ? 2 : 0 },
			{ item: "detachChild", weight: this.#children.some(child => child.active) ? 2 : 0 },
			{ item: "reorderChildren", weight: this.#children.filter(child => child.active).length > 1 ? 1 : 0 },
			{ item: "mutateChild", weight: this.#children.some(child => child.active) ? 3 : 0 },
		];
		return weightedPick(this.#streams.ops, weighted);
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
			default:
				return assertNever(kind);
		}
	}

	async #applyContent(
		kind: OperationKind,
		detail: JsonObject,
		checksRowAccounting: boolean,
	): Promise<AppliedOperation> {
		this.#renderContentFrame();
		await this.#settle();
		return contentOperation(kind, detail, checksRowAccounting);
	}

	async #eagerStreamingMutation(): Promise<AppliedOperation> {
		const detail: JsonObject = this.#streams.content.chance(0.5)
			? this.#model.streamOne()
			: this.#model.editOffscreenLine(this.#term.rows);
		this.#renderContentFrame();
		await this.#settle();
		return contentOperation("eagerStreamingMutation", detail, false);
	}

	#renderContentFrame(): void {
		if (this.#traits.foregroundStreaming) {
			// A foreground tool's own re-render: a plain, non-forced request. The
			// renderer keeps the live tail through `viewportRepaint`/`diff`;
			// offscreen-edit growth advances the rendered line count without
			// committing the overflow to native history, which is the lagging
			// high-water state a later shrink must still re-anchor from.
			this.#tui.requestRender();
			return;
		}
		const position = this.#term.getBufferPosition();
		const atBottom = position.viewportY >= position.baseY;
		if (!this.#traits.strictNativeScrollback && atBottom) {
			this.#tui.requestRender(true);
		} else {
			this.#tui.requestRender();
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
		await this.#settle();
		const start = typeof begin.start === "number" ? begin.start : 0;
		const count = typeof begin.count === "number" ? begin.count : 0;
		const collapse = this.#model.collapseHighWaterPreview(start, count);
		this.#renderContentFrame();
		await this.#settle();
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
		const count = this.#streams.ops.int(2, 6);
		const steps: JsonValue[] = [];
		let mutatesContent = false;
		let geometryChanged = false;
		let forcedRender = false;
		let mutatesViewport = false;
		for (let i = 0; i < count; i++) {
			const stepKind = this.#streams.ops.pick(BURST_STEP_KINDS);
			const detail = this.#applyBurstStep(stepKind);
			steps.push({ kind: stepKind, detail });
			const metadata = BURST_STEP_METADATA[stepKind];
			mutatesContent ||= metadata.mutatesContent;
			geometryChanged ||= metadata.geometryChanged;
			mutatesViewport ||= metadata.mutatesViewport;
			forcedRender ||= metadata.forcedRender;
			// Schedule without settling so the throttle coalesces every step into one paint.
			if (stepKind !== "forceRender") this.#tui.requestRender();
		}
		this.#renderContentFrame();
		await this.#settle();
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
				const amount = this.#streams.geometry.int(1, Math.max(1, this.#term.rows));
				const direction = this.#streams.geometry.chance(0.5) ? -1 : 1;
				this.#term.scrollLines(direction * amount);
				return { amount: direction * amount };
			}
			case "scrollToBottom":
				this.#term.scrollLines(LARGE_SCROLL);
				return { amount: LARGE_SCROLL };
			case "forceRender":
				this.#tui.requestRender(true);
				return {};
			default:
				return assertNever(kind);
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
		this.#tui.requestRender();
		await this.#settle();
		return this.#viewOperation(kind, { cursor });
	}

	async #showOverlay(): Promise<AppliedOperation> {
		const id = this.#nextOverlayId;
		this.#nextOverlayId += 1;
		const model = new StressOverlayModel(this.#streams.overlay, id);
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
		await this.#settle();
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
		await this.#settle();
		return this.#viewOperation("hideOverlay", { id: entry.id, sentinel: entry.sentinel });
	}

	async #toggleOverlayHidden(): Promise<AppliedOperation> {
		const entry = this.#pickOverlay();
		if (entry === undefined) return this.#viewOperation("toggleOverlayHidden", { skipped: true });
		entry.hidden = !entry.hidden;
		entry.handle.setHidden(entry.hidden);
		if (entry.hidden) this.#hiddenOverlaySentinels.add(entry.sentinel);
		await this.#settle();
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
		this.#tui.requestRender();
		await this.#settle();
		return this.#viewOperation("editOverlay", { id: entry.id, detail });
	}

	async #moveOverlayCursor(): Promise<AppliedOperation> {
		const entry = this.#pickOverlay();
		if (entry === undefined) return this.#viewOperation("moveOverlayCursor", { skipped: true });
		const cursor = entry.model.setCursor(this.#term.columns);
		this.#tui.setFocus(entry.component);
		this.#tui.requestRender();
		await this.#settle();
		return this.#viewOperation("moveOverlayCursor", { id: entry.id, cursor });
	}

	#pickOverlay(): StressOverlayEntry | undefined {
		if (this.#overlays.length === 0) return undefined;
		return this.#overlays[this.#streams.overlay.int(0, this.#overlays.length - 1)];
	}

	#randomOverlayOptions(): { options: OverlayOptions; detail: JsonObject } {
		const rng = this.#streams.overlay;
		const options: OverlayOptions = {};
		const detail: JsonObject = {};
		if (rng.chance(0.75)) {
			const width = rng.chance(0.35)
				? (`${rng.pick([25, 40, 60, 80])}%` as `${number}%`)
				: rng.int(1, Math.max(1, this.#term.columns + 8));
			options.width = width;
			detail.width = width;
		}
		if (rng.chance(0.35)) {
			const maxHeight = rng.chance(0.35)
				? (`${rng.pick([25, 50, 75])}%` as `${number}%`)
				: rng.int(1, Math.max(1, this.#term.rows));
			options.maxHeight = maxHeight;
			detail.maxHeight = maxHeight;
		}
		if (rng.chance(0.25)) {
			const minWidth = rng.int(1, Math.max(1, this.#term.columns + 4));
			options.minWidth = minWidth;
			detail.minWidth = minWidth;
		}
		if (rng.chance(0.5)) {
			const anchor = rng.pick(OVERLAY_ANCHORS);
			options.anchor = anchor;
			options.offsetX = rng.int(-3, 3);
			options.offsetY = rng.int(-2, 2);
			detail.anchor = anchor;
			detail.offsetX = options.offsetX;
			detail.offsetY = options.offsetY;
		} else {
			const row = rng.chance(0.45)
				? (`${rng.pick([0, 25, 50, 75, 100])}%` as `${number}%`)
				: rng.int(-2, this.#term.rows + 2);
			const col = rng.chance(0.45)
				? (`${rng.pick([0, 25, 50, 75, 100])}%` as `${number}%`)
				: rng.int(-4, this.#term.columns + 4);
			options.row = row;
			options.col = col;
			detail.row = row;
			detail.col = col;
		}
		if (rng.chance(0.6)) {
			if (rng.chance(0.5)) {
				const margin = rng.int(0, 2);
				options.margin = margin;
				detail.margin = margin;
			} else {
				const margin = {
					top: rng.int(0, 2),
					right: rng.int(0, 2),
					bottom: rng.int(0, 2),
					left: rng.int(0, 2),
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
		// foregroundStream models a live tool turn: let the terminal's own resize
		// callback drive the (non-forced, gated) repaint the real app relies on,
		// rather than forcing a full rebuild the streaming path never uses.
		if (!this.#traits.strictNativeScrollback && !this.#traits.foregroundStreaming) {
			this.#tui.requestRender(true);
		}
		await this.#settle();
		return viewOperation("resizeBoth", { columns, rows }, { geometryChanged: true, mutatesViewport: true });
	}

	async #resizeNoop(): Promise<AppliedOperation> {
		this.#term.resize(this.#term.columns, this.#term.rows);
		await this.#settle();
		return viewOperation("resizeNoop", { columns: this.#term.columns, rows: this.#term.rows });
	}

	async #scrollUp(): Promise<AppliedOperation> {
		const amount = this.#streams.geometry.int(1, Math.max(1, this.#term.rows * 2));
		this.#term.scrollLines(-amount);
		await this.#settle();
		return this.#viewOperation("scrollUp", { amount });
	}

	async #scrollToBottom(): Promise<AppliedOperation> {
		this.#term.scrollLines(LARGE_SCROLL);
		this.#tui.requestRender(true, { clearScrollback: this.#traits.strictNativeScrollback });
		await this.#settle();
		return forceRenderOperation(
			"scrollToBottom",
			{ forcedCheckpoint: this.#traits.strictNativeScrollback },
			{ checkpoint: true, mutatesViewport: true },
		);
	}

	async #scrollPartial(): Promise<AppliedOperation> {
		const amount = this.#streams.geometry.int(1, Math.max(1, this.#term.rows));
		const direction = this.#streams.geometry.chance(0.5) ? -1 : 1;
		this.#term.scrollLines(direction * amount);
		await this.#settle();
		return this.#viewOperation("scrollPartial", { amount: direction * amount });
	}
	async #resizeWidth(): Promise<AppliedOperation> {
		const columns = this.#pickDifferent(this.#scenario.widthChoices, this.#term.columns);
		this.#term.resize(columns, this.#term.rows);
		if (!this.#traits.strictNativeScrollback && !this.#traits.foregroundStreaming) {
			this.#tui.requestRender(true);
		}
		await this.#settle();
		return viewOperation("resizeWidth", { columns }, { geometryChanged: true, mutatesViewport: true });
	}

	async #resizeHeight(): Promise<AppliedOperation> {
		const rows = this.#pickDifferent(this.#scenario.heightChoices, this.#term.rows);
		this.#term.resize(this.#term.columns, rows);
		if (!this.#traits.strictNativeScrollback && !this.#traits.foregroundStreaming) {
			this.#tui.requestRender(true);
		}
		await this.#settle();
		return viewOperation("resizeHeight", { rows }, { geometryChanged: true, mutatesViewport: true });
	}

	// SIGWINCH racing a streamed token: the model grows and the terminal
	// resizes inside the same frame budget. The TUI's own resize handler
	// schedules the (non-forced) render; the embedder does not force — this is
	// the default production path for "user resizes the window while the
	// assistant is streaming".
	async #resizeWithAppend(): Promise<AppliedOperation> {
		const appended = this.#model.appendSmall();
		const rows = this.#pickDifferent(this.#scenario.heightChoices, this.#term.rows);
		const columns = this.#streams.geometry.chance(0.5)
			? this.#pickDifferent(this.#scenario.widthChoices, this.#term.columns)
			: this.#term.columns;
		this.#term.resize(columns, rows);
		await this.#settle();
		return contentOperation("resizeWithAppend", { appended, columns, rows }, false, {
			geometryChanged: true,
			mutatesViewport: true,
		});
	}

	async #forceRender(): Promise<AppliedOperation> {
		this.#tui.requestRender(true);
		await this.#settle();
		return this.#forceOperation("forceRender", {});
	}

	async #forceRenderAllowUnknown(): Promise<AppliedOperation> {
		this.#tui.requestRender(true);
		await this.#settle();
		return this.#forceOperation("forceRenderAllowUnknown", {});
	}

	async #forceRenderClearScrollback(): Promise<AppliedOperation> {
		this.#term.scrollLines(LARGE_SCROLL);
		this.#tui.requestRender(true, { clearScrollback: true });
		await this.#settle();
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
		this.#tui.requestRender(true, { clearScrollback: true });
		await this.#settle();
		// The clear's own replay frame can itself overflow the viewport (status
		// header + residual rows), so the transient bound must cover everything
		// this op writes: the cleared frame plus the fresh overflow appends.
		const clearedFrameLength = this.#expectedFrame().frame.length;
		const overflowCount = this.#term.rows + this.#streams.geometry.int(1, 4);
		const overflow = this.#model.appendCount(overflowCount, "overflow");
		this.#tui.requestRender(true);
		await this.#settle();
		return {
			...this.#forceOperation("forceRenderAfterEmptyOverflow", { detachedChildren, empty, overflow }),
			mutatesContent: true,
			// In multiplexers everything written during this op scrolls into pane
			// history on top of whatever was already there.
			transientFrameGrowth: clearedFrameLength + overflowCount,
		};
	}

	#forceOperation(kind: OperationKind, detail: JsonObject): AppliedOperation {
		return forceRenderOperation(kind, detail, {
			mutatesViewport: kind === "forceRenderClearScrollback" || kind === "forceRenderAfterEmptyOverflow",
		});
	}

	async #toggleFocusInput(): Promise<AppliedOperation> {
		let cursor: JsonObject | null = null;
		if (this.#component.focused) {
			this.#tui.setFocus(null);
		} else {
			cursor = this.#streams.cursor.chance(0.25)
				? this.#model.setCursorOffscreen(this.#term.rows, this.#term.columns)
				: this.#model.setCursorVisible(this.#term.rows, this.#term.columns);
			this.#tui.setFocus(this.#component);
		}
		this.#tui.requestRender();
		await this.#settle();
		return viewOperation("toggleFocusInput", { focused: this.#component.focused, cursor });
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
		await this.#settle();
		return contentOperation("attachChild", { id: child.id, lines: child.model.debugLines() }, false);
	}

	async #detachChild(): Promise<AppliedOperation> {
		const active = this.#children.filter(entry => entry.active);
		const child = active.length === 0 ? undefined : active[this.#streams.children.int(0, active.length - 1)];
		if (child === undefined) return this.#viewOperation("detachChild", { skipped: true });
		child.active = false;
		this.#tui.removeChild(child.component);
		this.#renderContentFrame();
		await this.#settle();
		return contentOperation("detachChild", { id: child.id }, false);
	}

	async #reorderChildren(): Promise<AppliedOperation> {
		const active = this.#children.filter(entry => entry.active);
		if (active.length < 2) return this.#viewOperation("reorderChildren", { skipped: true });
		const first = this.#children.shift();
		if (first !== undefined) this.#children.push(first);
		this.#syncChildOrder();
		this.#renderContentFrame();
		await this.#settle();
		return contentOperation(
			"reorderChildren",
			{ activeOrder: this.#children.filter(child => child.active).map(child => child.id) },
			false,
		);
	}

	async #mutateChild(): Promise<AppliedOperation> {
		const active = this.#children.filter(entry => entry.active);
		const child = active.length === 0 ? undefined : active[this.#streams.children.int(0, active.length - 1)];
		if (child === undefined) return this.#viewOperation("mutateChild", { skipped: true });
		const detail = this.#streams.children.chance(0.5)
			? child.model.appendSmall()
			: child.model.editVisibleLine(this.#term.rows);
		this.#renderContentFrame();
		await this.#settle();
		return contentOperation("mutateChild", { id: child.id, detail }, false);
	}

	#viewOperation(kind: OperationKind, detail: JsonObject): AppliedOperation {
		return viewOperation(kind, detail, {
			mutatesViewport: kind === "scrollUp" || kind === "scrollPartial",
		});
	}

	#pickDifferent(values: readonly number[], current: number): number {
		const candidates = values.filter(value => value !== current);
		return candidates.length === 0 ? current : this.#streams.geometry.pick(candidates);
	}

	async #checkpoint(index: number, kind: "periodicCheckpoint"): Promise<void> {
		const before = this.#snapshot();
		// Model a prompt submit: the editor keystroke pins the terminal to the
		// bottom, then the app reconciles any deferred native-scrollback rewrite
		// only if the renderer can prove the native host viewport is at the tail.
		this.#term.scrollLines(LARGE_SCROLL);
		let reconcilesNativeScrollback = false;
		if (this.#traits.strictNativeScrollback || this.#traits.preservesPaneHistory) {
			// Normal POSIX uses a /clear-style forced rebuild; tmux keeps its forced
			// repaint (its pane history cannot be destructively reconciled).
			this.#tui.requestRender(true, {
				clearScrollback: this.#traits.strictNativeScrollback,
			});
			reconcilesNativeScrollback = this.#traits.strictNativeScrollback;
		} else {
			// Unknown-viewport / ED3-risk / Windows hosts: the deferred
			// native-scrollback reconciliation no longer exists, so a prompt submit
			// is a plain forced render that never destructively rewrites native
			// scrollback.
			this.#tui.requestRender(true);
		}
		await this.#settle();
		const after = this.#snapshot();
		this.#recordOperation(index, kind, { forcedCheckpoint: this.#traits.strictNativeScrollback }, before, after);
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
				reconcilesNativeScrollback,
			},
			before,
			after,
			index,
		);
	}

	#recordOperation(
		index: number,
		kind: OperationLogKind,
		detail: JsonObject,
		before: Snapshot,
		after: Snapshot,
	): void {
		this.#operationCoverage.set(kind, (this.#operationCoverage.get(kind) ?? 0) + 1);
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
		this.#assertTapeScrollParity(op, before, after, index);
		this.#assertViewportFidelity(op, before, after, index);
		this.#assertCleanBufferWhenAligned(op, before, after, index);
		this.#assertNoFrameNeutralScrollbackGrowth(op, before, after, index);
		this.#assertCursor(op, before, after, index);
		this.#assertScrolledDeferral(op, before, after, index);
		this.#assertMultiplexerPaneHistoryGrowth(op, before, after, index);
		this.#assertHistoryPrefixStability(op, before, after, index);
		this.#assertNativeScrollbackReplay(op, before, after, index);
		this.#assertNoStaleOverlaySentinels(op, before, after, index);
		this.#assertUniqueContentNoUnexpectedDuplicates(op, before, after, index);
		this.#assertNoBackgroundBleed(op, before, after, index);
		// Native scrollback must reconcile to an exact bottom-anchored copy of the
		// transcript at checkpoints where the renderer actually performed a
		// destructive/native-history rebuild. Unknown ConPTY host scrollback and
		// ED3-risk terminals with no positive at-tail probe intentionally keep dirty
		// history deferred; asserting a clean buffer there would contradict the
		// anti-yank contract. tmux is excluded: its pane history is preserved, not
		// rebuilt, so the buffer snapshot is the view, not history.
		if (
			op.checkpoint &&
			!this.#traits.preservesPaneHistory &&
			(this.#traits.strictNativeScrollback || op.reconcilesNativeScrollback === true)
		) {
			this.#assertCleanBuffer(op, before, after, index);
		}
	}

	// The shadow tape and the physical buffer must scroll in lockstep: outside
	// gesture replays (checkpoints, geometry) the only thing that ever pushes
	// rows into native scrollback is a commit, and every commit appends to the
	// tape in the same write. Any disagreement means the ledgers diverged —
	// catch it at the op where it happens instead of N ops later when the
	// content mismatch surfaces.
	#assertTapeScrollParity(op: AppliedOperation, before: Snapshot, after: Snapshot, index: number): void {
		if (!this.#traits.strictNativeScrollback) return;
		if (op.checkpoint || op.geometryChanged) return;
		if (this.#scrollbackCapReached(before) || this.#scrollbackCapReached(after)) return;
		const physicalDelta = after.position.baseY - before.position.baseY;
		const tapeDelta = after.shadowTapeLength - before.shadowTapeLength;
		if (physicalDelta !== tapeDelta) {
			this.#fail("tape/physical scroll parity", op, before, after, index, {
				physicalDelta,
				tapeDelta,
			});
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
			this.#consumeAnsiChunk(this.#writeLog[this.#writeLogScanned]!, op, before, after, index);
		}
		if (this.#ansiCarry.length > 0) {
			this.#fail("incomplete private CSI sequence at op boundary", op, before, after, index, {
				carry: this.#ansiCarry,
			});
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

	#consumeAnsiChunk(data: string, op: AppliedOperation, before: Snapshot, after: Snapshot, index: number): void {
		const input = this.#ansiCarry + data;
		this.#ansiCarry = "";
		let cursor = 0;
		while (cursor < input.length) {
			const esc = input.indexOf("\x1b[?", cursor);
			if (esc === -1) break;
			const terminator = findPrivateCsiTerminator(input, esc + 3);
			if (terminator === -1) {
				this.#ansiCarry = input.slice(esc);
				return;
			}
			const final = input[terminator] ?? "";
			if (final === "h" || final === "l") {
				const params = parseCsiParameters(input.slice(esc + 3, terminator));
				this.#consumePrivateModeSequence(params, final, op, before, after, index);
			}
			cursor = terminator + 1;
		}
		const carryStart = trailingPrivateCsiPrefixStart(input);
		if (carryStart >= 0) {
			this.#ansiCarry = input.slice(carryStart);
		}
	}

	#consumePrivateModeSequence(
		params: readonly number[],
		final: "h" | "l",
		op: AppliedOperation,
		before: Snapshot,
		after: Snapshot,
		index: number,
	): void {
		if (params.includes(2026)) {
			if (this.#traits.syncOutputDisabled) {
				this.#fail(
					final === "h"
						? "synchronized-output begin emitted while PI_NO_SYNC_OUTPUT is set"
						: "synchronized-output end emitted while PI_NO_SYNC_OUTPUT is set",
					op,
					before,
					after,
					index,
					{ sequence: final === "h" ? "BSU" : "ESU" },
				);
			}
			this.#syncDepth += final === "h" ? 1 : -1;
			if (this.#syncDepth > 1) {
				this.#fail("nested synchronized-output begin (BSU within BSU)", op, before, after, index, {
					syncDepth: this.#syncDepth,
				});
			}
			if (this.#syncDepth < 0) {
				this.#fail("synchronized-output end (ESU) without matching begin", op, before, after, index, {
					syncDepth: this.#syncDepth,
				});
			}
		}
		if (params.includes(7)) {
			this.#autowrapOffDepth += final === "l" ? 1 : -1;
			if (this.#autowrapOffDepth < 0) {
				this.#fail("autowrap enabled without matching disable", op, before, after, index, {
					autowrapOffDepth: this.#autowrapOffDepth,
				});
			}
		}
	}

	// SGR/BCE bleed: background attributes must appear only on viewport cells
	// whose logical content carries background SGR. Stress content includes
	// deliberately unreset background sequences (backgroundStyledText); the
	// renderer's per-line terminators (#applyLineResets / LINE_TERMINATOR) must
	// confine the color to its own text cells. A leak means BCE (back-color-erase,
	// which xterm.js and most real terminals implement) paints \x1b[K / \x1b[2K
	// erased cells with the stale background — the user-visible "random colored
	// blank cells" bug class. Text-only oracles cannot see this; this oracle reads
	// cell attributes.
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
			const expectedColumns = new Set(after.frameBackgroundColumns[frameRow] ?? []);
			const unexpectedColumns = backgroundColumns.filter(column => !expectedColumns.has(column));
			if (unexpectedColumns.length > 0) {
				this.#fail("background SGR bleed", op, before, after, index, {
					row,
					frameRow,
					backgroundColumns,
					unexpectedColumns,
					expectedColumns: [...expectedColumns],
					rowText: after.view[row] ?? null,
					expected: "background-colored cells only on columns whose content carries background SGR",
				});
			}
		}
	}

	#assertViewportFidelity(op: AppliedOperation, before: Snapshot, after: Snapshot, index: number): void {
		if (this.#hasVisibleOverlay()) return;
		if (!after.atBottom) return;
		// The grid must show the shadow window slice: the frame tail anchored at
		// the ledger's window top (which floors at the committed boundary after
		// a shrink, leaving blank rows below the content instead of re-showing
		// committed rows). Multiplexer mode only checks geometry frames — tmux
		// reflows the pane grid on resize and the renderer must repaint the
		// whole visible window at the new geometry.
		if (this.#traits.preservesPaneHistory && !op.geometryChanged) return;
		const expected: string[] = [];
		for (let r = 0; r < after.height; r++) {
			expected.push(after.frame[this.#shadowWindowTop + r] ?? "");
		}
		if (!sameLinesAllowingMarkDrift(after.view, expected)) {
			this.#fail(
				this.#traits.foregroundStreaming ? "foreground-stream viewport fidelity" : "viewport fidelity",
				op,
				before,
				after,
				index,
				{ expected, shadowWindowTop: this.#shadowWindowTop },
			);
		}
	}

	#assertCleanBufferWhenAligned(op: AppliedOperation, before: Snapshot, after: Snapshot, index: number): void {
		if (!this.#traits.strictNativeScrollback || !after.atBottom || op.geometryChanged) return;
		if (this.#hasVisibleOverlay()) return;
		if (!this.#bufferReflectsFrame(before.buffer, before.frame, before.height)) return;
		const expected = this.#expectedScrollbackBuffer(after);
		if (after.buffer.length !== expected.length) return;
		if (!sameLinesAllowingMarkDrift(after.buffer, expected)) {
			const mismatch = firstMismatchIndex(after.buffer, expected);
			this.#fail("aligned buffer fidelity", op, before, after, index, {
				expectedLength: expected.length,
				actualLength: after.buffer.length,
				firstMismatch: mismatch,
				expectedWindow: windowAround(expected, mismatch),
				actualWindow: windowAround(after.buffer, mismatch),
			});
		}
	}

	#assertNoFrameNeutralScrollbackGrowth(op: AppliedOperation, before: Snapshot, after: Snapshot, index: number): void {
		if (this.#hasVisibleOverlay()) return;
		if (!this.#traits.strictNativeScrollback || op.checkpoint || op.geometryChanged) return;
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
		if (!this.#isCleanBuffer(after.buffer, after.frame, after.height)) return;
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
			this.#traits.viewportProbe !== "known" &&
			!this.#traits.conptyHostScrollbackUnobservable &&
			!this.#traits.ed3ScrollbackEraseRisk
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

	// Multiplexer panes never receive a destructive scrollback clear (the
	// renderer forces clearScrollback off inside tmux/screen/zellij because pane
	// history is intentionally preserved), so any full-frame replay during live
	// rendering appends a complete duplicate copy of the transcript to pane
	// history. Users see every transcript row twice (or more) when scrolling
	// back, and the per-frame write cost becomes O(frame). Pane history may grow
	// exactly by the rows the shadow ledger committed during the op (appends,
	// plus backfill of a chunk frozen during an overlay or geometry frame);
	// anything beyond that is a replay leaking into preserved history. Geometry
	// frames are exempt except pure height resizes, where xterm/tmux reflow is
	// bounded: a height shrink moves at most (oldHeight - newHeight) rows into
	// pane history — width changes rewrap pane history with unbounded row
	// deltas and cannot be bounded from here.
	#assertMultiplexerPaneHistoryGrowth(op: AppliedOperation, before: Snapshot, after: Snapshot, index: number): void {
		if (!this.#traits.preservesPaneHistory) return;
		if (op.checkpoint) return;
		const heightOnlyResize = op.kind === "resizeHeight";
		if (op.geometryChanged && !heightOnlyResize) return;
		const reflowAllowance = heightOnlyResize ? Math.max(0, before.height - after.height) : 0;
		const deltaBaseY = after.position.baseY - before.position.baseY;
		if (deltaBaseY <= 0) return;
		const committedDelta = Math.max(0, after.shadowTapeLength - before.shadowTapeLength);
		const allowedGrowth = committedDelta + reflowAllowance;
		if (deltaBaseY > allowedGrowth) {
			this.#fail("multiplexer pane history grew faster than committed rows", op, before, after, index, {
				deltaBaseY,
				allowedGrowth,
				committedDelta,
				expected: "live frames must not replay the transcript into preserved pane history",
			});
		}
	}

	#assertHistoryPrefixStability(op: AppliedOperation, before: Snapshot, after: Snapshot, index: number): void {
		if (!this.#traits.strictNativeScrollback) return;
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
		if (!this.#traits.strictNativeScrollback) return;
		if (this.#hasVisibleOverlay()) return;
		if (!after.atBottom) return;
		if (!op.mutatesContent && !op.forcedRender && !op.checkpoint && !op.geometryChanged) return;
		const expected = this.#expectedScrollbackBuffer(after);
		if (!sameLinesAllowingMarkDrift(after.buffer, expected)) {
			const mismatch = firstMismatchIndex(after.buffer, expected);
			this.#fail("native scrollback buffer fidelity", op, before, after, index, {
				expectedLength: expected.length,
				actualLength: after.buffer.length,
				firstMismatch: mismatch,
				expectedWindow: windowAround(expected, mismatch),
				actualWindow: windowAround(after.buffer, mismatch),
			});
		}

		const probes = scrollbackProbePositions(after.position.baseY, expected.length, after.height);
		try {
			for (const viewportY of probes) {
				const current = this.#term.getBufferPosition().viewportY;
				this.#term.scrollLines(viewportY - current);
				const actual = normalizeLines(this.#term.getViewport());
				const expectedView = fixedViewportSlice(expected, viewportY, after.height);
				if (!sameLinesAllowingMarkDrift(actual, expectedView)) {
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
		if (!sameLinesAllowingMarkDrift(after.buffer, expected)) {
			this.#fail("clean checkpoint reconstruction", op, before, after, index, {
				expectedLength: expected.length,
				actualLength: after.buffer.length,
			});
		}
	}

	#expectedScrollbackBuffer(snapshot: Snapshot): string[] {
		const height = snapshot.height;
		const expected = [...this.#shadowTape];
		for (let r = 0; r < height; r++) {
			expected.push(this.#shadowFrame[this.#shadowWindowTop + r] ?? "");
		}
		const cap = height + this.#scenario.scrollback;
		return expected.length > cap ? expected.slice(expected.length - cap) : expected;
	}

	/**
	 * Advance the shadow commit ledger for one observed write. Classification
	 * is byte-driven: ED3 = destructive replay, ED2-without-ED3 =
	 * non-destructive replay (initial paint / multiplexer replace), anything
	 * else = ordinary update following the engine's append-only law.
	 */
	#applyShadowWrite(data: string): void {
		if (data.includes("\x1b[?1049h")) this.#shadowAltActive = true;
		if (data.includes("\x1b[?1049l")) {
			this.#shadowAltActive = false;
			return;
		}
		if (this.#shadowAltActive) return;
		const frame = this.#shadowFrame;
		const raw = this.#shadowRawFrame;
		const height = Math.max(1, this.#shadowFrameHeight);
		const length = frame.length;
		if (data.includes("\x1b[3J")) {
			this.#shadowCommitted = Math.max(0, length - height);
			this.#shadowWindowTop = this.#shadowCommitted;
			this.#shadowTape = frame.slice(0, this.#shadowCommitted);
			this.#shadowRawPrefix = raw.slice(0, this.#shadowCommitted);
			return;
		}
		if (data.includes("\x1b[2J")) {
			// Grid cleared in place, committed prefix scrolls above it; prior
			// history rows stay (and are erased only by the ED3 branch above).
			const chunkTo = Math.max(0, length - height);
			for (let i = 0; i < chunkTo; i++) this.#shadowTape.push(frame[i] ?? "");
			this.#shadowCommitted = chunkTo;
			this.#shadowWindowTop = chunkTo;
			this.#shadowRawPrefix = raw.slice(0, chunkTo);
			return;
		}
		// Audit and shrink re-anchoring are mirrored at render time (they can
		// fire on zero-byte frames); the write hook only applies commits.
		const windowTop = Math.max(this.#shadowCommitted, length - height, 0);
		this.#shadowWindowTop = windowTop;
		// Overlays and multiplexer geometry frames freeze commits; a geometry
		// frame also re-bases the raw prefix at the new width (accepted wrap
		// drift, mirrored from the engine).
		if (this.#shadowFrameGeometryChanged) {
			this.#shadowRawPrefix = raw.slice(0, this.#shadowCommitted);
			return;
		}
		if (this.#shadowFrameOverlay) return;
		const chunkTo = Math.max(this.#shadowCommitted, Math.min(length, windowTop));
		for (let i = this.#shadowCommitted; i < chunkTo; i++) {
			this.#shadowTape.push(frame[i] ?? "");
			this.#shadowRawPrefix.push(raw[i] ?? "");
		}
		this.#shadowCommitted = chunkTo;
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
		if (this.#traits.preservesPaneHistory && !after.atBottom) return;
		const nativeText = this.#traits.preservesPaneHistory
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
		// All comparisons run with non-spacing marks stripped: the virtual
		// terminal drops them on input (ghostty-web 0.4 margin-cluster crash
		// workaround), so buffer readback and frame/tape rows would otherwise
		// never collide on marked rows.
		const strip = (line: string): string => line.replace(NONSPACING_MARKS, "");
		// Accumulate even when the check below is skipped (scrolled/overlay): the
		// frame's legitimate duplicates commit to scrollback regardless of where
		// the viewport is parked. The shadow tape contributes too: a no-seam
		// offscreen insert re-indexes committed content, so the shifted rows
		// legitimately commit a second time (the exact tape-equality oracle has
		// already proven the buffer matches the ledger row for row).
		for (const line of duplicateNonblankLines(after.frame)) {
			this.#everDuplicatedFrameLines.add(strip(line));
		}
		const tapeSeen = new Set<string>();
		for (const raw of this.#shadowTape) {
			if (raw.length === 0) continue;
			const line = strip(raw);
			if (tapeSeen.has(line)) this.#everDuplicatedFrameLines.add(line);
			tapeSeen.add(line);
		}
		// A committed row that still sits in the visible window (window floored
		// at the commit boundary) legitimately appears in both regions of the
		// whole-tape buffer snapshot.
		for (let r = 0; r < after.height; r++) {
			const raw = this.#shadowFrame[this.#shadowWindowTop + r] ?? "";
			if (raw.length === 0) continue;
			const line = strip(raw);
			if (tapeSeen.has(line)) this.#everDuplicatedFrameLines.add(line);
		}
		if (this.#hasVisibleOverlay() || !after.atBottom) return;
		const allowed = this.#everDuplicatedFrameLines;
		const seen = new Set<string>();
		for (const raw of after.buffer) {
			if (raw.length === 0) continue;
			const line = strip(raw);
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
		const replayLogPath = writeReplayLog(this.#scenario, this.#opLog);
		const replay = `TUI_STRESS_REPLAY=${JSON.stringify({
			scenario: this.#scenario.name,
			seed: formatSeed(this.#scenario.seed),
			iterations: index + 1,
		})}`;
		const replayLog = `TUI_STRESS_REPLAY_LOG=${replayLogPath}`;
		const fullDump = Bun.env.TUI_STRESS_FULL_DUMP === "1";
		const dump = {
			message,
			scenario: this.#scenario.name,
			seed: formatSeed(this.#scenario.seed),
			opIndex: index,
			replay,
			replayLog,
			replayLogPath,
			op: { kind: op.kind, detail: op.detail },
			extra,
			traits: this.#traits,
			tags: this.#scenario.tags,
			operationCoverage: Object.fromEntries(this.#operationCoverage.entries()),
			lastOperations: this.#opLog.slice(-50),
			shadow: {
				committed: this.#shadowCommitted,
				windowTop: this.#shadowWindowTop,
				tapeLength: this.#shadowTape.length,
				frameLength: this.#shadowFrame.length,
				geometryChanged: this.#shadowFrameGeometryChanged,
				overlayVisible: this.#shadowFrameOverlay,
			},
			lastWrites: this.#writeLog.slice(-4).map(write => JSON.stringify(write.slice(-400))),
			children: this.#children.map(child => ({
				id: child.id,
				active: child.active,
				focused: child.component.focused,
				lines: child.model.debugLines(),
			})),
			overlays: this.#overlays.map(overlay => ({
				id: overlay.id,
				hidden: overlay.hidden,
				focused: overlay.component.focused,
				sentinel: overlay.sentinel,
				options: overlay.detail,
				lines: overlay.model.debugLines(),
			})),
			before: fullDump ? snapshotDump(before) : snapshotSummary(before),
			after: fullDump ? snapshotDump(after) : snapshotSummary(after),
			model: fullDump ? this.#model.debugLines() : undefined,
			opLog: fullDump ? this.#opLog : undefined,
			fullDump: fullDump ? true : "set TUI_STRESS_FULL_DUMP=1 for complete buffers and op log",
		};
		throw new Error(`TUI render stress invariant failed: ${message}\n${JSON.stringify(dump, null, 2)}`);
	}
}

function createTerminal(scenario: Scenario): VirtualTerminal {
	switch (scenario.terminalMode) {
		case "unknown":
			return new UnknownViewportTerminal(scenario.columns, scenario.rows, scenario.scrollback);
		case "intermittentUnknown":
			return new IntermittentUnknownViewportTerminal(scenario.columns, scenario.rows, scenario.scrollback);
		case "staleBottom":
			return new StaleBottomTerminal(scenario.columns, scenario.rows, scenario.scrollback);
		case "normal":
			return new VirtualTerminal(scenario.columns, scenario.rows, scenario.scrollback);
		default:
			return assertNever(scenario.terminalMode);
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

// ghostty-web's cell-grid text extraction can migrate or merge Unicode
// non-spacing marks across neighboring cells for combining-heavy scripts
// (Arabic harakat), so a byte-exact round trip through the virtual terminal is
// not achievable for those rows (the engine paints them verbatim; see the
// WIDTH notes in docs/tui-core-renderer.md). Fall back to comparing with
// non-spacing marks stripped — row count, order, and all spacing content stay
// exact.
const NONSPACING_MARKS = /\p{Mn}/gu;
function sameLinesAllowingMarkDrift(left: readonly string[], right: readonly string[]): boolean {
	if (sameLines(left, right)) return true;
	if (left.length !== right.length) return false;
	for (let i = 0; i < left.length; i++) {
		if (left[i] === right[i]) continue;
		if (left[i]!.replace(NONSPACING_MARKS, "") !== right[i]!.replace(NONSPACING_MARKS, "")) return false;
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

export function expectedScrollbackBuffer(frame: readonly string[], height: number, scrollback: number): string[] {
	const expected = [...frame];
	while (expected.length < height) {
		expected.push("");
	}
	const cap = height + scrollback;
	return expected.length > cap ? expected.slice(expected.length - cap) : expected;
}

export function scrollbackProbePositions(maxViewportY: number, frameLength: number, height: number): number[] {
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

export function duplicateNonblankLines(lines: readonly string[]): Set<string> {
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

export function stripPlainTerminalText(text: string): string {
	return stripVTControlCharacters(text)
		.replace(/\]8;;[^\x07]*(?:\x07)?/g, "")
		.replaceAll(BEL, "");
}

function findPrivateCsiTerminator(input: string, start: number): number {
	return findCsiTerminator(input, start);
}

function findCsiTerminator(input: string, start: number): number {
	for (let index = start; index < input.length; index++) {
		const code = input.charCodeAt(index);
		if (code >= 0x40 && code <= 0x7e) return index;
	}
	return -1;
}

function findOscTerminator(input: string, start: number): number {
	for (let index = start; index < input.length; index++) {
		const code = input.charCodeAt(index);
		if (code === 0x07) return index + 1;
		if (code === 0x1b && input[index + 1] === "\\") return index + 2;
	}
	return -1;
}

function parseCsiParameters(paramsText: string): number[] {
	if (paramsText.length === 0) return [];
	const params: number[] = [];
	for (const part of paramsText.split(";")) {
		if (part.length === 0) continue;
		const parsed = Number.parseInt(part, 10);
		if (Number.isFinite(parsed)) params.push(parsed);
	}
	return params;
}

function trailingPrivateCsiPrefixStart(input: string): number {
	const esc = input.lastIndexOf(ESC);
	if (esc === -1) return -1;
	const tail = input.slice(esc);
	return /^\x1b(?:\[?|\[\?[0-9;]*)$/.test(tail) ? esc : -1;
}

export function expectedFrameFromLines(lines: readonly string[], width: number, height: number): ExpectedFrame {
	const stripped = [...lines];
	const viewportTop = Math.max(0, stripped.length - height);
	let cursor: ExpectedCursor | null = null;
	const backgroundColumns: number[][] = Array.from({ length: stripped.length }, () => []);
	for (let row = stripped.length - 1; row >= 0; row--) {
		const line = stripped[row] ?? "";
		const markerIndex = line.indexOf(CURSOR_MARKER);
		const cleanLine = markerIndex === -1 ? line : removeCursorMarkers(line);
		backgroundColumns[row] = expectedBackgroundColumns(cleanLine, width);
		if (markerIndex !== -1 && cursor === null && row >= viewportTop) {
			cursor = { row: row - viewportTop, col: visibleWidth(line.slice(0, markerIndex)) };
		}
		stripped[row] = cleanLine;
	}
	return { frame: stripped.map(line => expectedTerminalLine(line, width)), cursor, backgroundColumns };
}

function expectedBackgroundColumns(line: string, width: number): number[] {
	const safeWidth = Math.max(1, width);
	const fitted = visibleWidth(line) > safeWidth ? truncateToWidth(line, safeWidth, Ellipsis.Omit) : line;
	const columns: number[] = [];
	let backgroundActive = false;
	let skipUntil = 0;
	let col = 0;
	for (const segment of SEGMENTER.segment(fitted)) {
		if (segment.index < skipUntil) continue;
		if (fitted.charCodeAt(segment.index) === 0x1b) {
			const next = segment.index + 1;
			if (fitted[next] === "[") {
				const terminator = findCsiTerminator(fitted, next + 1);
				if (terminator === -1) break;
				if (fitted[terminator] === "m") {
					backgroundActive = applySgrBackground(backgroundActive, fitted.slice(next + 1, terminator));
				}
				skipUntil = terminator + 1;
				continue;
			}
			if (fitted[next] === "]") {
				const terminator = findOscTerminator(fitted, next + 1);
				if (terminator === -1) break;
				skipUntil = terminator;
				continue;
			}
		}
		const segmentWidth = visibleWidth(segment.segment);
		if (segmentWidth <= 0) continue;
		if (backgroundActive) {
			const end = Math.min(safeWidth, col + segmentWidth);
			for (let column = col; column < end; column++) columns.push(column);
		}
		col += segmentWidth;
		if (col >= safeWidth) break;
	}
	return columns;
}

function applySgrBackground(current: boolean, paramsText: string): boolean {
	const params = parseCsiParameters(paramsText);
	let active = current;
	for (const param of params.length === 0 ? [0] : params) {
		if (param === 0 || param === 49) {
			active = false;
		} else if ((param >= 40 && param <= 48) || (param >= 100 && param <= 107)) {
			active = true;
		}
	}
	return active;
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

export function resolveExpectedOverlayLayout(
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
		default:
			return assertNever(anchor);
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
		default:
			return assertNever(anchor);
	}
}

export function compositeExpectedLineAt(
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
	// keycap sequence. With the Ghostty-backed terminal, these are now cell-exact:
	// Ghostty is the real modern terminal oracle, and both the renderer and the
	// terminal measure each sequence here as 2 cells.
	//
	// Keep randomized stress to VS16/keycap emoji for this migration baseline.
	// ZWJ and regional-indicator content should be enabled separately as renderer
	// bug triage: Ghostty will expose real under-measure and overrun failures
	// instead of hiding them behind a legacy model mismatch.
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

export function cursorInsertionIndex(text: string, mode: CursorMode, width: number): number {
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
		frameBackgroundColumns: snapshot.frameBackgroundColumns,
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

function snapshotSummary(snapshot: Snapshot): JsonObject {
	return {
		bufferLength: snapshot.buffer.length,
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
		frameLength: snapshot.frame.length,
		frameTail: snapshot.frame.slice(-Math.min(snapshot.height + 3, snapshot.frame.length)),
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

function parsePositiveInt(name: string, fallback: number): number {
	const raw = Bun.env[name];
	if (raw === undefined || raw.length === 0) return fallback;
	if (!/^[1-9]\d*$/.test(raw)) {
		throw new Error(`${name} must be a positive integer; received ${JSON.stringify(raw)}`);
	}
	return Number.parseInt(raw, 10);
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
		GHOSTTY_RESOURCES_DIR: envMode === "ghostty" ? "/Applications/Ghostty.app/Contents/Resources" : undefined,
		ALACRITTY_WINDOW_ID: undefined,
		VTE_VERSION: envMode === "vteNoSync" ? "6800" : undefined,
		PI_NO_SYNC_OUTPUT: envMode === "vteNoSync" ? "1" : undefined,
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
	const replayOperations = parseReplayOperations();
	if (replayOperations !== null && replay === null) {
		throw new Error("TUI_STRESS_REPLAY_LOG requires TUI_STRESS_REPLAY to select the scenario and seed");
	}
	if (replay !== null) {
		const maxHeight = maxOf(replay.template.heightChoices);
		return [
			materializeScenario(
				replay.template,
				replay.seed,
				replayOperations?.length ?? replay.iterations,
				SOAK_BULK_MAX,
				SOAK_TIMEOUT_MS,
				maxHeight,
				replayOperations ?? undefined,
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
	replayOperations?: readonly OperationKind[],
): Scenario {
	const strictScrollback =
		template.envMode !== "tmux" && template.terminalMode === "normal" && template.platform !== "win32";
	const foregroundStream = template.foregroundStream ?? false;
	const reflow = template.reflow ?? false;
	return {
		...template,
		seed,
		iterations,
		bulkMax,
		scrollback: template.scrollbackRows ?? Math.max(10_000, maxHeight + 64 + iterations * (bulkMax + 8)),
		strictScrollback,
		timeoutMs,
		uniqueContent: template.uniqueContent ?? false,
		foregroundStream,
		reflow,
		tags: scenarioTags(template, strictScrollback, foregroundStream),
		replayOperations,
	};
}

function parseReplay(
	templates: readonly ScenarioTemplate[],
): { template: ScenarioTemplate; seed: number; iterations: number } | null {
	const raw = Bun.env.TUI_STRESS_REPLAY;
	if (raw === undefined || raw.length === 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Invalid TUI_STRESS_REPLAY JSON: ${raw}`, { cause: error });
	}
	if (!isJsonRecord(parsed)) {
		throw new Error("Invalid TUI_STRESS_REPLAY: expected an object with scenario, seed, and optional iterations");
	}
	const scenario = parsed.scenario;
	if (typeof scenario !== "string" || scenario.length === 0) {
		throw new Error("Invalid TUI_STRESS_REPLAY.scenario: expected a non-empty scenario name");
	}
	const template = templates.find(candidate => candidate.name === scenario);
	if (template === undefined) throw new Error(`Unknown TUI_STRESS_REPLAY scenario: ${scenario}`);
	const iterationsValue = parsed.iterations;
	const iterations = iterationsValue === undefined ? CORE_ITERATIONS : parseReplayIterations(iterationsValue);
	const seed = parseReplaySeed(parsed.seed);
	return { template, seed, iterations };
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseReplayIterations(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
		throw new Error("Invalid TUI_STRESS_REPLAY.iterations: expected a positive number");
	}
	return Math.floor(value);
}

function parseReplaySeed(seed: unknown): number {
	if (typeof seed === "number" && Number.isFinite(seed)) return seed >>> 0;
	if (typeof seed === "string") {
		const radix = seed.startsWith("0x") || seed.startsWith("0X") ? 16 : 10;
		const valid = radix === 16 ? /^0x[0-9a-f]+$/i.test(seed) : /^\d+$/.test(seed);
		if (!valid) throw new Error(`Invalid TUI_STRESS_REPLAY.seed: ${JSON.stringify(seed)}`);
		return Number.parseInt(seed, radix) >>> 0;
	}
	throw new Error("Invalid TUI_STRESS_REPLAY.seed: expected a number or integer string");
}

function parseReplayOperations(): readonly OperationKind[] | null {
	const path = Bun.env.TUI_STRESS_REPLAY_LOG;
	if (path === undefined || path.length === 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Invalid TUI_STRESS_REPLAY_LOG JSON: ${path}`, { cause: error });
	}
	const entries = Array.isArray(parsed)
		? parsed
		: isJsonRecord(parsed) && Array.isArray(parsed.operations)
			? parsed.operations
			: null;
	if (entries === null) {
		throw new Error("Invalid TUI_STRESS_REPLAY_LOG: expected an operation array or { operations } object");
	}
	const operations: OperationKind[] = [];
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		const kind = isJsonRecord(entry) ? entry.kind : entry;
		if (kind === "periodicCheckpoint") continue;
		if (!isOperationKind(kind)) {
			throw new Error(`Invalid TUI_STRESS_REPLAY_LOG operation at index ${index}`);
		}
		operations.push(kind);
	}
	return operations;
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
	| "seed"
	| "iterations"
	| "bulkMax"
	| "scrollback"
	| "strictScrollback"
	| "timeoutMs"
	| "uniqueContent"
	| "foregroundStream"
	| "reflow"
	| "tags"
	| "replayOperations"
> & {
	scrollbackRows?: number;
	uniqueContent?: boolean;
	foregroundStream?: boolean;
	reflow?: boolean;
};

function writeReplayLog(scenario: Scenario, operations: readonly OperationLogEntry[]): string {
	const filePath = path.join(
		os.tmpdir(),
		`omp-tui-stress-${scenario.name}-${(scenario.seed >>> 0).toString(16)}-${Date.now().toString(36)}.json`,
	);
	fs.writeFileSync(filePath, JSON.stringify(operations, null, 2));
	return filePath;
}

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
			// VTE 0.68 reports DEC 2026 synchronized output as permanently reset
			// and users can opt out when a terminal's implementation is buggy or
			// visually worse. The renderer must remove only the 2026 wrapper; it
			// still keeps autowrap disabled around paints to avoid pending-wrap
			// staircase corruption.
			name: "linux-normal-vteNoSync-small",
			platform: "linux",
			terminalMode: "normal",
			envMode: "vteNoSync",
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
			// Native-Windows ConPTY host (Windows Terminal, Tabby, Hyper, VS Code,
			// conhost behind ConPTY — #1635/#1746). kernel32 cannot see the host
			// UI's scrollback (the pseudo-console buffer is pinned to the visible
			// grid), and no env var distinguishes the hosts (Tabby sets none), so
			// the probe is permanently `undefined`. A reader scrolled in the host
			// UI must not be yanked by streaming-time rebuilds; reconciliation
			// waits for explicit checkpoints.
			name: "win32-unknown-small",
			platform: "win32",
			terminalMode: "unknown",
			envMode: "plain",
			geometryMode: "small",
			columns: 32,
			rows: 4,
			widthChoices: [10, 16, 32],
			heightChoices: [3, 4, 6],
			scrollbackRows: 10_000,
		},
		{
			// Foreground tool actively streaming on an ED3-risk terminal whose
			// viewport position is unobservable (ghostty/kitty/alacritty/VTE/iTerm2).
			// Content frames flow through `viewportRepaint`/`diff` instead of a
			// forced history rebuild. An offscreen-edit growth then repaints in
			// place — advancing the rendered line count without committing the
			// overflow to native history — and the next shrink must still
			// re-anchor the bottom of the viewport from that lagging high-water mark.
			// The default content-frame path forces a render and never reaches this
			// state (a notification chip rendering over the active tool render: the
			// original report).
			name: "darwin-unknown-ghostty-stream-small",
			platform: "darwin",
			terminalMode: "unknown",
			envMode: "ghostty",
			geometryMode: "small",
			columns: 32,
			rows: 4,
			widthChoices: [10, 16, 32],
			heightChoices: [3, 4, 6],
			scrollbackRows: 10_000,
			foregroundStream: true,
		},
		{
			name: "linux-unknown-ghostty-stream-large",
			platform: "linux",
			terminalMode: "unknown",
			envMode: "ghostty",
			geometryMode: "large",
			columns: 80,
			rows: 12,
			widthChoices: [40, 80, 120],
			heightChoices: [8, 12, 24],
			scrollbackRows: 10_000,
			foregroundStream: true,
		},
		{
			// Width-reflowing content (wrapped/markdown-style) uses the same grapheme
			// width semantics as the real Ghostty-backed terminal, so the wrap agrees
			// with the terminal's cell widths. A width resize changes the physical
			// line count, so the renderer must
			// re-anchor the viewport and rebuild native history across a line-count
			// change — not just retruncate rows. Combined with the full random op
			// space (scroll, overlay, append, shrink) it covers reflow interactions
			// the deterministic width tests exercise only in isolation.
			name: "darwin-normal-reflow-small",
			platform: "darwin",
			terminalMode: "normal",
			envMode: "plain",
			geometryMode: "small",
			columns: 32,
			rows: 4,
			widthChoices: [8, 12, 16, 24, 32, 40],
			heightChoices: [3, 4, 6],
			reflow: true,
		},
		{
			name: "darwin-unknown-reflow-stream-large",
			platform: "darwin",
			terminalMode: "unknown",
			envMode: "ghostty",
			geometryMode: "large",
			columns: 80,
			rows: 12,
			widthChoices: [24, 40, 80, 120],
			heightChoices: [8, 12, 24],
			scrollbackRows: 10_000,
			reflow: true,
			foregroundStream: true,
		},
	];
}

function soakTemplates(): ScenarioTemplate[] {
	const templates: ScenarioTemplate[] = [];
	const platformEnvModes: readonly { platform: TestPlatform; envModes: readonly EnvMode[] }[] = [
		{ platform: "darwin", envModes: ["plain", "tmux"] },
		{ platform: "linux", envModes: ["plain", "tmux", "termux", "vteNoSync"] },
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
	// Foreground tool streaming on an ED3-risk terminal with an unobservable
	// viewport (ghostty/kitty/…): the eager native-scrollback rebuild opt-in is
	// gated off, so content frames repaint in place and offscreen-edit growth
	// lags the high-water mark — a later shrink must still re-anchor the viewport
	// bottom rather than drifting rows up over one another.
	for (const geometryMode of geometries) {
		const large = geometryMode === "large";
		templates.push({
			name: `darwin-unknown-ghostty-stream-${geometryMode}`,
			platform: "darwin",
			terminalMode: "unknown",
			envMode: "ghostty",
			geometryMode,
			columns: large ? 80 : 32,
			rows: large ? 12 : 4,
			widthChoices: large ? [80, 120] : [2, 10, 16, 24, 32, 40],
			heightChoices: large ? [8, 12, 24] : [3, 4, 6],
			foregroundStream: true,
		});
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
			PI_NO_SYNC_OUTPUT: undefined,
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
			PI_NO_SYNC_OUTPUT: undefined,
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

let stressEnvPatchDepth = 0;
let platformPatchDepth = 0;

async function withPatchedEnv<T>(envMode: Scenario["envMode"], run: () => Promise<T>): Promise<T> {
	if (stressEnvPatchDepth > 0) throw new Error("Nested stress environment patching is not supported");
	stressEnvPatchDepth += 1;
	const snapshot = applyStressEnv(envMode);
	try {
		return await run();
	} finally {
		restoreStressEnv(snapshot);
		stressEnvPatchDepth -= 1;
	}
}

async function withPatchedPlatform<T>(platform: Scenario["platform"], run: () => Promise<T>): Promise<T> {
	if (platformPatchDepth > 0) throw new Error("Nested stress platform patching is not supported");
	platformPatchDepth += 1;
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { configurable: true, value: platform });
	try {
		return await run();
	} finally {
		if (platformDescriptor !== undefined) {
			Object.defineProperty(process, "platform", platformDescriptor);
		} else {
			Reflect.deleteProperty(process, "platform");
		}
		platformPatchDepth -= 1;
	}
}

export interface StressScenarioSuccess {
	ok: true;
}

export interface StressScenarioFailure {
	ok: false;
	scenario: string;
	seed: string;
	error: string;
	stack?: string;
}

/**
 * Result a {@link runStressScenario} subprocess emits as a single JSON line on
 * stdout. Each scenario runs in its own `bun` subprocess (one scenario per
 * process), so there is no request multiplexing or `id` to correlate.
 */
export type StressScenarioResult = StressScenarioSuccess | StressScenarioFailure;

export async function runStressScenario(scenario: Scenario, options?: { patchEnv?: boolean }): Promise<void> {
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
}

function restoreOwnProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor === undefined) {
		delete (target as Record<string, unknown>)[key];
		return;
	}
	Object.defineProperty(target, key, descriptor);
}

export async function runNoReflowResizeNotificationRegression(): Promise<void> {
	await withPatchedEnv("ghostty", async () => {
		await withPatchedPlatform("darwin", async () => {
			const stdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
			const stdoutIsTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
			const stdoutColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
			const stdoutRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
			const stdinSetRawMode = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
			const stdinSetEncoding = Object.getOwnPropertyDescriptor(process.stdin, "setEncoding");
			const stdinResume = Object.getOwnPropertyDescriptor(process.stdin, "resume");
			const stdinPause = Object.getOwnPropertyDescriptor(process.stdin, "pause");
			const stdoutWrite = Object.getOwnPropertyDescriptor(process.stdout, "write");
			const processKill = Object.getOwnPropertyDescriptor(process, "kill");
			const writes: string[] = [];

			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
			Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
			Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
			Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
			Object.defineProperty(process.stdin, "setRawMode", { value: () => process.stdin, configurable: true });
			Object.defineProperty(process.stdin, "setEncoding", { value: () => process.stdin, configurable: true });
			Object.defineProperty(process.stdin, "resume", { value: () => process.stdin, configurable: true });
			Object.defineProperty(process.stdin, "pause", { value: () => process.stdin, configurable: true });
			Object.defineProperty(process.stdout, "write", {
				value: (chunk: string | Uint8Array) => {
					writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
					return true;
				},
				configurable: true,
			});
			Object.defineProperty(process, "kill", { value: () => true, configurable: true });

			const term = new ProcessTerminal();
			const scheduler = new StressRenderScheduler();
			const tui = new TUI(term, true, { renderScheduler: scheduler });
			const initialLines = Array.from({ length: 35 }, (_value, index) => `stream-row-${index}`);
			const component = new MutableLinesComponent(initialLines);
			const drainTarget = { flush: async () => {} } as VirtualTerminal;
			tui.addChild(component);

			try {
				tui.start();
				await scheduler.drain(drainTarget);

				const reportOnlyWriteStart = writes.length;
				process.stdin.emit("data", "\x1b[48;30;100;600;1000t");
				await scheduler.drain(drainTarget);
				if (writes.length !== reportOnlyWriteStart) {
					throw new Error("Unchanged DEC 2048 resize report scheduled a render without a geometry change");
				}

				const streamingWriteStart = writes.length;
				component.setLines([...initialLines, "stream-row-35"]);
				process.stdin.emit("data", "\x1b[48;30;100;600;1000t");
				tui.requestRender();
				await scheduler.drain(drainTarget);

				const emitted = writes.slice(streamingWriteStart).join("");
				if (emitted.includes("\x1b[3J")) {
					throw new Error(
						"Unchanged DEC 2048 report coalesced with streaming content emitted destructive scrollback clear",
					);
				}
			} finally {
				tui.stop();
				restoreOwnProperty(process.stdin, "isTTY", stdinIsTty);
				restoreOwnProperty(process.stdout, "isTTY", stdoutIsTty);
				restoreOwnProperty(process.stdout, "columns", stdoutColumns);
				restoreOwnProperty(process.stdout, "rows", stdoutRows);
				restoreOwnProperty(process.stdin, "setRawMode", stdinSetRawMode);
				restoreOwnProperty(process.stdin, "setEncoding", stdinSetEncoding);
				restoreOwnProperty(process.stdin, "resume", stdinResume);
				restoreOwnProperty(process.stdin, "pause", stdinPause);
				restoreOwnProperty(process.stdout, "write", stdoutWrite);
				restoreOwnProperty(process, "kill", processKill);
			}
		});
	});
}

export async function runPreexistingScrollbackRegression(): Promise<void> {
	const term = new VirtualTerminal(40, 5, 100);
	const scheduler = new StressRenderScheduler();
	term.write(`${Array.from({ length: 12 }, (_value, index) => `shell-${index}`).join("\r\n")}\r\n`);
	await term.flush();

	const tui = new TUI(term, true, { renderScheduler: scheduler });
	const component = new MutableLinesComponent(["ui-0", "ui-1", "ui-2"]);
	tui.addChild(component);

	try {
		tui.start();
		await scheduler.drain(term);

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
			await scheduler.drain(term);

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
}

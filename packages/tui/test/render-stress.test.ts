import { afterEach, beforeEach, describe, it, vi } from "bun:test";
import { type Component, CURSOR_MARKER, type Focusable, TUI } from "@oh-my-pi/pi-tui";
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
	| "scrollUp"
	| "scrollToBottom"
	| "scrollPartial"
	| "resizeWidth"
	| "resizeHeight"
	| "forceRender"
	| "toggleFocusInput"
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

	constructor(rng: Rng, minLines: number) {
		this.#rng = rng;
		this.minLines = minLines;
		const initialLength = minLines + 20;
		for (let i = 0; i < initialLength; i++) {
			this.lines.push(this.#line(this.#initialText(i)));
		}
	}

	renderedLines(width: number): string[] {
		const safeWidth = Math.max(1, width);
		return this.lines.map(line => (line.text.length > safeWidth ? line.text.slice(0, safeWidth) : line.text));
	}

	debugLines(): string[] {
		return this.lines.map(line => `${line.id}:${JSON.stringify(line.text)}`);
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

		const block = [this.#line("blk0"), this.#line("blk1"), this.#line("blk2"), this.#line("blk3")];
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
		if (roll < 0.12) return this.#line("");
		if (roll < 0.28) return this.#line(`r${this.#rng.int(0, 3)}`);
		if (roll < 0.42 && this.lines.length > 0) {
			const source = this.lines[this.#rng.int(0, this.lines.length - 1)];
			return this.#line(source?.text ?? "");
		}
		return this.#freshLine(prefix);
	}

	#freshLine(prefix: string): LogicalLine {
		return this.#line(`${prefix}${this.#nextId.toString(36)}`);
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
		const lines = this.#model.renderedLines(width);
		if (this.focused && lines.length > 0) {
			const last = lines.length - 1;
			lines[last] = `${lines[last]}${CURSOR_MARKER}`;
		}
		return lines;
	}
}

class StressDriver {
	#scenario: Scenario;
	#rng: Rng;
	#term: VirtualTerminal;
	#tui: TUI;
	#model: StressModel;
	#component: StressComponent;
	#opLog: OperationLogEntry[] = [];

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
		const frame = this.#model.renderedLines(this.#term.columns);
		return {
			buffer: normalizeLines(this.#term.getScrollBuffer()),
			view: normalizeLines(this.#term.getViewport()),
			position,
			cursor: this.#term.getCursor(),
			redraws: this.#tui.fullRedraws,
			width: this.#term.columns,
			height: this.#term.rows,
			frame,
			atBottom: position.viewportY >= position.baseY,
		};
	}

	#chooseOperation(index: number, before: Snapshot): OperationKind {
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
		this.#pushWeighted(weighted, "coalescedBurst", 6);
		this.#pushWeighted(weighted, "rotateUp", 4);
		this.#pushWeighted(weighted, "swapOffscreenRows", 3);
		this.#pushWeighted(weighted, "collapseToFew", 1);
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
		if (this.#component.focused) {
			this.#tui.setFocus(null);
		} else {
			this.#tui.setFocus(this.#component);
		}
		this.#tui.requestRender(false, { allowUnknownViewportMutation: true });
		await settle(this.#term);
		return {
			kind: "toggleFocusInput",
			detail: { focused: this.#component.focused },
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
		this.#assertCursor(op, before, after, index);
		this.#assertScrolledDeferral(op, before, after, index);
		this.#assertRowAccounting(op, before, after, index);
		this.#assertHistoryPrefixStability(op, before, after, index);
		if (op.checkpoint && this.#scenario.strictScrollback) {
			this.#assertCleanBuffer(op, before, after, index);
		}
	}

	#assertViewportFidelity(op: AppliedOperation, before: Snapshot, after: Snapshot, index: number): void {
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

	#assertCursor(op: AppliedOperation, before: Snapshot, after: Snapshot, index: number): void {
		if (after.cursor.row < 0 || after.cursor.row >= after.height || after.cursor.col < 0) {
			this.#fail("cursor bounds", op, before, after, index, { cursor: cursorObject(after) });
		}
		if (!this.#component.focused || !after.atBottom || after.frame.length === 0) return;
		// Exact cursor parking is only predictable when the buffer is bottom-anchored
		// (no ghost/stale rows). After a trailing shrink the cursor sits on the
		// de-anchored last content row, which is checked once a repaint re-anchors.
		if (after.buffer.length !== Math.max(after.height, after.frame.length)) return;
		const expectedRow = Math.min(after.frame.length, after.height) - 1;
		if (after.cursor.row !== expectedRow) {
			this.#fail("focused cursor row", op, before, after, index, {
				expectedRow,
				actualRow: after.cursor.row,
				actualCol: after.cursor.col,
			});
		}
		// The marker sits after the last line. When that line fills (or overflows) the
		// viewport width the cursor is parked at the right margin, where the reported
		// column is terminal-dependent (pending-wrap reports `width`, CHA clamping
		// reports `width - 1`). Only assert the exact column when it is unambiguous.
		const lastLineWidth = after.frame[after.frame.length - 1]?.length ?? 0;
		if (lastLineWidth < after.width && after.cursor.col !== lastLineWidth) {
			this.#fail("focused cursor column", op, before, after, index, {
				expectedCol: lastLineWidth,
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
		if (!this.#scenario.strictScrollback) return;
		if (!op.mutatesContent || !op.checksRowAccounting || op.geometryChanged || op.forcedRender) return;
		if (!before.atBottom || !after.atBottom) return;
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

	#assertCleanBuffer(op: AppliedOperation, before: Snapshot, after: Snapshot, index: number): void {
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

function snapshotDump(snapshot: Snapshot): JsonObject {
	return {
		buffer: snapshot.buffer,
		view: snapshot.view,
		position: { baseY: snapshot.position.baseY, viewportY: snapshot.position.viewportY },
		cursor: cursorObject(snapshot),
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

import {
	type Component,
	Ellipsis,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	padding,
	renderInlineMarkdown,
	replaceTabs,
	ScrollView,
	type Tab,
	TabBar,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionAskDialogResultItem,
} from "../../extensibility/extensions";
import { getTabBarTheme } from "../shared";
import { getMarkdownTheme, highlightCode, theme } from "../theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { CountdownTimer } from "./countdown-timer";
import { bottomBorder, divider, row, topBorder } from "./overlay-box";
import { handleTabSwitchKey } from "./selector-helpers";

const OTHER_OPTION = "Other (type your own)";
const CHAT_ABOUT_THIS_OPTION = "Chat about this";
const NEXT_OPTION = "Next →";
const SUBMIT_OPTION = "Submit";

const MIN_BODY_ROWS = 5;
const PREVIEW_MIN_WIDTH = 40;
const SIDE_BY_SIDE_LIST_MIN_WIDTH = 30;
const SIDE_BY_SIDE_GAP_WIDTH = 3;
const MAX_HEADER_CHIP_WIDTH = 16;
const PREVIEW_HEADER = "Preview";

interface AskDialogCallbacks {
	onSubmit(result: ExtensionAskDialogResult): void;
	onCancel(): void;
	onChat(): void;
	onPrompt(title: string, prefill?: string): Promise<string | undefined>;
}

interface AskDialogOptions {
	timeout?: number;
	onTimeout?: () => void;
	tui?: TUI;
}

interface QuestionState {
	selectedOptions: Set<string>;
	customInput: string | undefined;
	note: string | undefined;
	noteRowKey: string | undefined;
	cursorIndex: number;
	scrollOffset: number;
	timedOut: boolean;
}

type QuestionRowKind = "option" | "other" | "next" | "chat";
type SubmitRowKind = "submit" | "chat";

interface QuestionRow {
	kind: QuestionRowKind;
	key: string;
	label: string;
	optionIndex: number | undefined;
}

interface SubmitRow {
	kind: SubmitRowKind;
	key: string;
	label: string;
}

interface RenderedList {
	lines: string[];
	scrollOffset: number;
	indicator: string;
}

interface PreviewSegment {
	kind: "markdown" | "code";
	text: string;
	language: string | undefined;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}

function stripRecommendedSuffix(label: string): string {
	const suffix = " (Recommended)";
	return label.endsWith(suffix) ? label.slice(0, -suffix.length) : label;
}

function questionTabLabel(question: ExtensionAskDialogQuestion, index: number): string {
	const base = question.header?.trim() || question.id || `Q${index + 1}`;
	return truncateToWidth(replaceTabs(base), MAX_HEADER_CHIP_WIDTH, Ellipsis.Unicode);
}

function renderQuestionTitle(question: ExtensionAskDialogQuestion, index: number, width: number): string[] {
	const chip = question.header?.trim() ? theme.fg("accent", `[${questionTabLabel(question, index)}] `) : "";
	const mdTheme = getMarkdownTheme();
	const questionText = renderInlineMarkdown(replaceTabs(question.question), mdTheme, t => theme.fg("text", t));
	const titleWidth = Math.max(1, width - visibleWidth(chip));
	const wrapped = wrapTextWithAnsi(questionText, titleWidth);
	if (wrapped.length === 0) return [chip.trimEnd()];
	return wrapped.map((line, lineIndex) =>
		lineIndex === 0 ? `${chip}${line}` : `${padding(visibleWidth(chip))}${line}`,
	);
}

function splitPreviewSegments(preview: string): PreviewSegment[] {
	const segments: PreviewSegment[] = [];
	const markdownBuffer: string[] = [];
	let fenceChar: string | undefined;
	let fenceLength = 0;
	let fenceLanguage: string | undefined;
	let codeBuffer: string[] = [];

	const flushMarkdown = (): void => {
		if (markdownBuffer.length === 0) return;
		segments.push({ kind: "markdown", text: markdownBuffer.join("\n"), language: undefined });
		markdownBuffer.length = 0;
	};
	const flushCode = (): void => {
		segments.push({ kind: "code", text: codeBuffer.join("\n"), language: fenceLanguage });
		codeBuffer = [];
		fenceChar = undefined;
		fenceLength = 0;
		fenceLanguage = undefined;
	};

	for (const line of replaceTabs(preview).split("\n")) {
		const fenceMatch = /^(\s{0,3})(`{3,}|~{3,})(.*)$/.exec(line);
		if (fenceChar !== undefined) {
			if (fenceMatch) {
				const marker = fenceMatch[2] ?? "";
				const info = fenceMatch[3]?.trim() ?? "";
				if (marker.startsWith(fenceChar) && marker.length >= fenceLength && info === "") {
					flushCode();
					continue;
				}
			}
			codeBuffer.push(line);
			continue;
		}
		if (fenceMatch) {
			flushMarkdown();
			const marker = fenceMatch[2] ?? "";
			fenceChar = marker[0];
			fenceLength = marker.length;
			fenceLanguage = fenceMatch[3]?.trim().split(/\s+/, 1)[0] || undefined;
			codeBuffer = [];
			continue;
		}
		markdownBuffer.push(line);
	}

	if (fenceChar !== undefined) {
		segments.push({ kind: "code", text: codeBuffer.join("\n"), language: fenceLanguage });
	} else {
		flushMarkdown();
	}
	return segments;
}

function renderPreviewContent(preview: string | undefined, width: number): string[] {
	if (!preview?.trim()) return [theme.fg("muted", "No preview for this option.")];
	const out: string[] = [];
	const mdTheme = getMarkdownTheme();
	const accentStyle = { color: (text: string) => theme.fg("muted", text) };
	for (const segment of splitPreviewSegments(preview)) {
		if (segment.kind === "code") {
			const highlighted = highlightCode(segment.text, segment.language);
			const text = new Text(highlighted.join("\n"), 0, 0);
			out.push(...text.render(Math.max(1, width)));
			continue;
		}
		const markdown = new Markdown(segment.text, 0, 0, mdTheme, accentStyle);
		out.push(...markdown.render(Math.max(1, width)));
	}
	return out.length > 0 ? out : [theme.fg("muted", "No preview for this option.")];
}

function normalizedInlineInput(input: string): string {
	return replaceTabs(input).replace(/\s+/g, " ").trim();
}

function renderAnswerSummary(question: ExtensionAskDialogQuestion, state: QuestionState): string {
	const selected = question.options.map(option => option.label).filter(label => state.selectedOptions.has(label));
	if (question.multi) {
		const answers = [...selected];
		if (state.customInput !== undefined) answers.push(`Other: “${normalizedInlineInput(state.customInput)}”`);
		return answers.length > 0 ? answers.join(", ") : theme.fg("warning", "unanswered");
	}
	if (state.customInput !== undefined) return `“${normalizedInlineInput(state.customInput)}”`;
	if (selected.length === 0) return theme.fg("warning", "unanswered");
	return selected[0] ?? theme.fg("warning", "unanswered");
}

function clearNote(state: QuestionState): void {
	state.note = undefined;
	state.noteRowKey = undefined;
}

function clearNoteIfRow(state: QuestionState, rowKey: string): void {
	if (state.noteRowKey === rowKey) clearNote(state);
}

function clearNoteUnlessRow(state: QuestionState, rowKey: string): void {
	if (state.noteRowKey !== undefined && state.noteRowKey !== rowKey) clearNote(state);
}

function noteForSubmittedAnswer(question: ExtensionAskDialogQuestion, state: QuestionState): string | undefined {
	if (state.note === undefined || state.noteRowKey === undefined) return undefined;
	if (state.noteRowKey === "other") return state.customInput !== undefined ? state.note : undefined;
	const match = /^option:(\d+)$/.exec(state.noteRowKey);
	const optionIndex = match?.[1] === undefined ? Number.NaN : Number.parseInt(match[1], 10);
	const option = Number.isInteger(optionIndex) ? question.options[optionIndex] : undefined;
	return option && state.selectedOptions.has(option.label) ? state.note : undefined;
}

function optionMarker(question: ExtensionAskDialogQuestion, checked: boolean): string {
	if (question.multi) return checked ? theme.checkbox.checked : theme.checkbox.unchecked;
	return checked ? theme.radio.selected : theme.radio.unselected;
}

function renderRowLabel(
	rowItem: QuestionRow,
	question: ExtensionAskDialogQuestion,
	state: QuestionState,
	selected: boolean,
	mdTheme: MarkdownTheme,
	width: number,
): string[] {
	const isOption = rowItem.kind === "option";
	const isOther = rowItem.kind === "other";
	const checked = isOption
		? state.selectedOptions.has(stripRecommendedSuffix(rowItem.label))
		: isOther && state.customInput !== undefined;
	const color = selected ? "accent" : checked ? "toolOutput" : "text";
	const marker =
		isOption || isOther ? `${theme.fg(checked ? "success" : "dim", optionMarker(question, checked))} ` : "  ";
	const cursor = selected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
	const label = renderInlineMarkdown(rowItem.label, mdTheme, t => theme.fg(color, t));
	const noteMarker = state.note && state.noteRowKey === rowItem.key ? theme.fg("success", "  ✎ note") : "";
	const firstLine = `${cursor}${marker}${label}${noteMarker}`;
	const lines = [truncateToWidth(firstLine, width, Ellipsis.Unicode)];
	if (rowItem.kind === "option") {
		const option = question.options[rowItem.optionIndex ?? -1];
		if (option?.description?.trim()) {
			const description = renderInlineMarkdown(option.description.trim(), mdTheme, t => theme.fg("muted", t));
			const wrapped = wrapTextWithAnsi(description, Math.max(1, width - 6));
			for (const line of wrapped.slice(0, 2)) {
				lines.push(`      ${truncateToWidth(line, Math.max(1, width - 6), Ellipsis.Unicode)}`);
			}
		}
	}
	if (isOther && state.customInput !== undefined) {
		const preview = replaceTabs(state.customInput).replace(/\s+/g, " ").trim();
		lines.push(theme.fg("muted", `      ${truncateToWidth(preview, Math.max(1, width - 6), Ellipsis.Unicode)}`));
	}
	return lines;
}

export class AskDialogComponent implements Component {
	#states: QuestionState[];
	#activeTabIndex = 0;
	#submitCursorIndex = 0;
	#submitScrollOffset = 0;
	#remainingSeconds: number | undefined;
	#countdown: CountdownTimer | undefined;
	#promptActive = false;
	#timeoutExpired = false;
	#closed = false;
	#tabBar: TabBar | undefined;

	constructor(
		private readonly questions: ExtensionAskDialogQuestion[],
		private readonly callbacks: AskDialogCallbacks,
		private readonly options: AskDialogOptions = {},
	) {
		this.#states = questions.map(question => {
			const recommended = Number.isInteger(question.recommended) ? question.recommended : 0;
			const maxIndex = Math.max(0, question.options.length - 1);
			return {
				selectedOptions: new Set<string>(),
				customInput: undefined,
				note: undefined,
				noteRowKey: undefined,
				cursorIndex: clamp(recommended ?? 0, 0, maxIndex),
				scrollOffset: 0,
				timedOut: false,
			};
		});
		if (options.timeout && options.timeout > 0) {
			this.#countdown = new CountdownTimer(
				options.timeout,
				options.tui,
				seconds => {
					this.#remainingSeconds = seconds;
				},
				() => this.#handleTimeout(),
			);
		}
	}

	invalidate(): void {
		this.#tabBar?.invalidate();
	}

	dispose(): void {
		this.#closed = true;
		this.#countdown?.dispose();
	}

	handleInput(keyData: string): void {
		if (this.#closed || this.#promptActive) return;
		if (matchesSelectCancel(keyData)) {
			this.#finishCancel();
			return;
		}
		if (this.#hasSubmitTab() && handleTabSwitchKey(keyData, direction => this.#switchTab(direction))) {
			this.#requestRender();
			return;
		}
		if (this.#isSubmitTab()) {
			this.#handleSubmitTabInput(keyData);
			return;
		}
		this.#handleQuestionInput(keyData);
	}

	render(width: number): readonly string[] {
		const height = Math.max(12, process.stdout.rows || 40);
		const innerWidth = Math.max(1, width - 4);
		const headerLines = this.#renderHeader(innerWidth);
		const fixedRows = 1 + headerLines.length + 1 + 1 + 1;
		const bodyRows = Math.max(MIN_BODY_ROWS, height - fixedRows);
		const bodyLines = this.#isSubmitTab()
			? this.#renderSubmitBody(innerWidth, bodyRows)
			: this.#renderQuestionBody(innerWidth, bodyRows);
		const footer = this.#footerHintText(bodyLines.indicator);
		return [
			topBorder(width, this.#titleText()),
			...headerLines.map(line => row(line, width)),
			divider(width),
			...bodyLines.lines.map(line => row(line, width)),
			divider(width),
			row(theme.fg("dim", footer), width),
			bottomBorder(width),
		];
	}

	#titleText(): string {
		return this.#remainingSeconds === undefined ? "Ask" : `Ask (${this.#remainingSeconds}s)`;
	}

	#hasSubmitTab(): boolean {
		return this.questions.length > 1;
	}

	#submitTabIndex(): number {
		return this.questions.length;
	}

	#isSubmitTab(): boolean {
		return this.#hasSubmitTab() && this.#activeTabIndex === this.#submitTabIndex();
	}

	#currentQuestionIndex(): number {
		return clamp(this.#activeTabIndex, 0, Math.max(0, this.questions.length - 1));
	}

	#requestRender(): void {
		this.options.tui?.requestRender();
	}

	#renderHeader(width: number): string[] {
		const lines: string[] = [];
		if (this.#hasSubmitTab()) {
			const tabs: Tab[] = [
				...this.questions.map((question, index) => ({
					id: String(index),
					label: questionTabLabel(question, index),
				})),
				{ id: "submit", label: "Submit" },
			];
			this.#tabBar = new TabBar("", tabs, getTabBarTheme(), this.#activeTabIndex);
			this.#tabBar.showHint = false;
			lines.push(...this.#tabBar.render(width));
		}
		if (this.#isSubmitTab()) {
			lines.push(theme.bold(theme.fg("accent", "Review answers")));
			return lines;
		}
		const questionIndex = this.#currentQuestionIndex();
		const question = this.questions[questionIndex];
		if (!question) return lines;
		if (lines.length > 0) lines.push("");
		lines.push(...renderQuestionTitle(question, questionIndex, width));
		return lines;
	}

	#footerHintText(indicator: string): string {
		const scroll = indicator ? ` ${indicator} scroll ·` : "";
		if (this.#isSubmitTab()) {
			return `Enter submit · ↑/↓ move ·${scroll} Esc cancel`;
		}
		const question = this.questions[this.#currentQuestionIndex()];
		const action = question?.multi ? "Space/Enter toggle · n note · Next → continue" : "Enter select · n note";
		const tabs = this.#hasSubmitTab() ? " · Tab/←/→ tabs" : "";
		return `${action} · ↑/↓ move${tabs} ·${scroll} Esc cancel`;
	}

	#questionRows(question: ExtensionAskDialogQuestion): QuestionRow[] {
		const rows: QuestionRow[] = question.options.map((option, index) => ({
			kind: "option",
			key: `option:${index}`,
			label: this.#optionLabel(question, option.label, index),
			optionIndex: index,
		}));
		rows.push({ kind: "other", key: "other", label: OTHER_OPTION, optionIndex: undefined });
		if (question.multi) rows.push({ kind: "next", key: "next", label: NEXT_OPTION, optionIndex: undefined });
		rows.push({ kind: "chat", key: "chat", label: CHAT_ABOUT_THIS_OPTION, optionIndex: undefined });
		return rows;
	}

	#optionLabel(question: ExtensionAskDialogQuestion, label: string, index: number): string {
		return question.recommended === index ? `${label} (Recommended)` : label;
	}

	#activeQuestionState(): { question: ExtensionAskDialogQuestion; state: QuestionState } | undefined {
		const question = this.questions[this.#currentQuestionIndex()];
		const state = this.#states[this.#currentQuestionIndex()];
		if (!question || !state) return undefined;
		return { question, state };
	}

	#handleQuestionInput(keyData: string): void {
		const active = this.#activeQuestionState();
		if (!active) return;
		const { question, state } = active;
		const rows = this.#questionRows(question);
		if (matchesSelectUp(keyData)) {
			state.cursorIndex = clamp(state.cursorIndex - 1, 0, Math.max(0, rows.length - 1));
			this.#requestRender();
			return;
		}
		if (matchesSelectDown(keyData)) {
			state.cursorIndex = clamp(state.cursorIndex + 1, 0, Math.max(0, rows.length - 1));
			this.#requestRender();
			return;
		}
		const rowItem = rows[state.cursorIndex];
		if (!rowItem) return;
		if (keyData === "n" || keyData === "N") {
			if (rowItem.kind === "option" || rowItem.kind === "other") {
				void this.#promptForNote(question, state, rowItem);
			}
			return;
		}
		const isEnter = matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n";
		const isSpace = matchesKey(keyData, "space") || keyData === " ";
		if (!isEnter && !(question.multi && isSpace)) return;
		if (rowItem.kind === "chat") {
			this.#finishChat();
			return;
		}
		if (rowItem.kind === "next") {
			this.#advanceAfterQuestion();
			return;
		}
		if (rowItem.kind === "other") {
			void this.#promptForCustomInput(question, state, rowItem);
			return;
		}
		if (rowItem.kind === "option") {
			const option = question.options[rowItem.optionIndex ?? -1];
			if (!option) return;
			if (question.multi) {
				if (state.selectedOptions.has(option.label)) {
					state.selectedOptions.delete(option.label);
					clearNoteIfRow(state, rowItem.key);
				} else {
					state.selectedOptions.add(option.label);
				}
				this.#requestRender();
				return;
			}
			state.selectedOptions = new Set([option.label]);
			state.customInput = undefined;
			clearNoteUnlessRow(state, rowItem.key);
			this.#advanceAfterQuestion();
		}
	}

	#handleSubmitTabInput(keyData: string): void {
		const rows = this.#submitRows();
		if (matchesSelectUp(keyData)) {
			this.#submitCursorIndex = clamp(this.#submitCursorIndex - 1, 0, Math.max(0, rows.length - 1));
			this.#requestRender();
			return;
		}
		if (matchesSelectDown(keyData)) {
			this.#submitCursorIndex = clamp(this.#submitCursorIndex + 1, 0, Math.max(0, rows.length - 1));
			this.#requestRender();
			return;
		}
		const isEnter = matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n";
		if (!isEnter) return;
		const rowItem = rows[this.#submitCursorIndex];
		if (rowItem?.kind === "chat") {
			this.#finishChat();
			return;
		}
		this.#finishSubmit();
	}

	#switchTab(direction: 1 | -1): void {
		const tabCount = this.questions.length + 1;
		this.#activeTabIndex = (this.#activeTabIndex + direction + tabCount) % tabCount;
		this.#submitCursorIndex = 0;
	}

	#advanceAfterQuestion(): void {
		const current = this.#currentQuestionIndex();
		if (this.questions.length === 1) {
			this.#finishSubmit();
			return;
		}
		this.#activeTabIndex = current + 1 < this.questions.length ? current + 1 : this.#submitTabIndex();
		this.#submitCursorIndex = 0;
		this.#requestRender();
	}

	async #promptForCustomInput(
		question: ExtensionAskDialogQuestion,
		state: QuestionState,
		rowItem: QuestionRow,
	): Promise<void> {
		this.#promptActive = true;
		try {
			const input = await this.callbacks.onPrompt(`Custom answer: ${question.question}`, state.customInput);
			if (input === undefined || this.#closed) return;
			state.customInput = input;
			if (!question.multi) {
				state.selectedOptions.clear();
				clearNoteUnlessRow(state, rowItem.key);
			}
			this.#advanceAfterQuestion();
		} finally {
			this.#promptActive = false;
			this.#runDeferredTimeout();
			this.#requestRender();
		}
	}

	async #promptForNote(
		question: ExtensionAskDialogQuestion,
		state: QuestionState,
		rowItem: QuestionRow,
	): Promise<void> {
		this.#promptActive = true;
		try {
			const input = await this.callbacks.onPrompt(`Note for ${rowItem.label}: ${question.question}`, state.note);
			if (input === undefined || this.#closed) return;
			state.note = input;
			state.noteRowKey = rowItem.key;
		} finally {
			this.#promptActive = false;
			this.#runDeferredTimeout();
			this.#requestRender();
		}
	}

	#renderQuestionBody(width: number, rows: number): RenderedList {
		const active = this.#activeQuestionState();
		if (!active) return { lines: Array.from({ length: rows }, () => ""), scrollOffset: 0, indicator: "" };
		const { question, state } = active;
		const rowItems = this.#questionRows(question);
		state.cursorIndex = clamp(state.cursorIndex, 0, Math.max(0, rowItems.length - 1));
		const selectedRow = rowItems[state.cursorIndex];
		const preview =
			selectedRow?.kind === "option" ? question.options[selectedRow.optionIndex ?? -1]?.preview : undefined;
		const sideBySide = width >= SIDE_BY_SIDE_LIST_MIN_WIDTH + PREVIEW_MIN_WIDTH + SIDE_BY_SIDE_GAP_WIDTH;
		if (sideBySide) {
			const previewWidth = Math.max(PREVIEW_MIN_WIDTH, Math.floor(width * 0.45));
			const listWidth = Math.max(1, width - previewWidth - SIDE_BY_SIDE_GAP_WIDTH);
			const list = this.#renderQuestionList(question, state, rowItems, listWidth, rows);
			const previewLines = this.#renderPreviewPane(preview, previewWidth, rows);
			const lines: string[] = [];
			for (let index = 0; index < rows; index++) {
				const left = truncateToWidth(list.lines[index] ?? "", listWidth, Ellipsis.Unicode);
				const right = truncateToWidth(previewLines[index] ?? "", previewWidth, Ellipsis.Unicode);
				const gap = padding(Math.max(1, listWidth - visibleWidth(left)) + 1);
				lines.push(`${left}${gap}${theme.fg("border", "│")} ${right}`);
			}
			return { lines, scrollOffset: list.scrollOffset, indicator: list.indicator };
		}
		const previewRows = Math.max(3, Math.min(8, Math.floor(rows * 0.4)));
		const listRows = Math.max(3, rows - previewRows - 1);
		const list = this.#renderQuestionList(question, state, rowItems, width, listRows);
		const previewLines = this.#renderPreviewPane(preview, width, previewRows);
		const lines = [...list.lines, theme.fg("border", "─".repeat(Math.max(1, width))), ...previewLines];
		while (lines.length < rows) lines.push("");
		return { lines: lines.slice(0, rows), scrollOffset: list.scrollOffset, indicator: list.indicator };
	}

	#renderQuestionList(
		question: ExtensionAskDialogQuestion,
		state: QuestionState,
		rowItems: QuestionRow[],
		width: number,
		rows: number,
	): RenderedList {
		const mdTheme = getMarkdownTheme();
		const allLines: string[] = [];
		const lineStartByRow: number[] = [];
		for (let index = 0; index < rowItems.length; index++) {
			lineStartByRow.push(allLines.length);
			const rowItem = rowItems[index];
			if (!rowItem) continue;
			allLines.push(...renderRowLabel(rowItem, question, state, index === state.cursorIndex, mdTheme, width));
		}
		const cursorStart = lineStartByRow[state.cursorIndex] ?? 0;
		state.scrollOffset = this.#scrollOffsetForCursor(state.scrollOffset, cursorStart, rows, allLines.length);
		const scrollView = new ScrollView(allLines, {
			height: rows,
			scrollbar: "auto",
			totalRows: allLines.length,
			theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
		});
		scrollView.setScrollOffset(state.scrollOffset);
		const rendered = scrollView.render(width);
		const lines = [...rendered];
		while (lines.length < rows) lines.push("");
		return {
			lines: lines.slice(0, rows),
			scrollOffset: state.scrollOffset,
			indicator: this.#clipIndicator(state.scrollOffset, rows, allLines.length),
		};
	}

	#renderPreviewPane(preview: string | undefined, width: number, rows: number): string[] {
		const bodyWidth = Math.max(1, width - 2);
		const out = [theme.fg("dim", PREVIEW_HEADER)];
		const contentRows = Math.max(0, rows - 1);
		const content = renderPreviewContent(preview, bodyWidth);
		const hidden = Math.max(0, content.length - contentRows);
		const visibleCount = hidden > 0 ? Math.max(0, contentRows - 1) : Math.min(contentRows, content.length);
		for (let index = 0; index < visibleCount; index++) out.push(content[index] ?? "");
		if (hidden > 0) out.push(theme.fg("dim", `… ${hidden + 1} more lines`));
		while (out.length < rows) out.push("");
		return out.slice(0, rows);
	}

	#renderSubmitBody(width: number, rows: number): RenderedList {
		const allLines: string[] = [];
		const unanswered = this.#unansweredCount();
		if (unanswered > 0) {
			allLines.push(
				theme.fg(
					"warning",
					`${unanswered} unanswered question${unanswered === 1 ? "" : "s"}; Enter still submits.`,
				),
			);
			allLines.push("");
		}
		for (let index = 0; index < this.questions.length; index++) {
			const question = this.questions[index];
			const state = this.#states[index];
			if (!question || !state) continue;
			const label = questionTabLabel(question, index);
			const answer = renderAnswerSummary(question, state);
			allLines.push(`${theme.fg("dim", `${index + 1}. ${label}:`)} ${answer}`);
			const submittedNote = noteForSubmittedAnswer(question, state);
			if (submittedNote?.trim()) {
				const note = normalizedInlineInput(submittedNote);
				allLines.push(
					theme.fg("muted", `   Note: ${truncateToWidth(note, Math.max(1, width - 9), Ellipsis.Unicode)}`),
				);
			}
		}
		allLines.push("");
		const rowStart = allLines.length;
		const submitRows = this.#submitRows();
		for (let index = 0; index < submitRows.length; index++) {
			const rowItem = submitRows[index];
			if (!rowItem) continue;
			const cursor = index === this.#submitCursorIndex ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const color = index === this.#submitCursorIndex ? "accent" : "text";
			allLines.push(`${cursor}${theme.fg(color, rowItem.label)}`);
		}
		const cursorStart = rowStart + this.#submitCursorIndex;
		this.#submitScrollOffset = this.#scrollOffsetForCursor(
			this.#submitScrollOffset,
			cursorStart,
			rows,
			allLines.length,
		);
		const scrollView = new ScrollView(allLines, {
			height: rows,
			scrollbar: "auto",
			totalRows: allLines.length,
			theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
		});
		scrollView.setScrollOffset(this.#submitScrollOffset);
		const rendered = scrollView.render(width);
		const lines = [...rendered];
		while (lines.length < rows) lines.push("");
		return {
			lines: lines.slice(0, rows),
			scrollOffset: this.#submitScrollOffset,
			indicator: this.#clipIndicator(this.#submitScrollOffset, rows, allLines.length),
		};
	}

	#submitRows(): SubmitRow[] {
		return [
			{ kind: "submit", key: "submit", label: SUBMIT_OPTION },
			{ kind: "chat", key: "chat", label: CHAT_ABOUT_THIS_OPTION },
		];
	}

	#scrollOffsetForCursor(currentOffset: number, cursorLine: number, rows: number, totalRows: number): number {
		if (totalRows <= rows) return 0;
		let nextOffset = clamp(currentOffset, 0, Math.max(0, totalRows - rows));
		if (cursorLine < nextOffset) nextOffset = cursorLine;
		if (cursorLine >= nextOffset + rows) nextOffset = cursorLine - rows + 1;
		return clamp(nextOffset, 0, Math.max(0, totalRows - rows));
	}

	#clipIndicator(offset: number, rows: number, totalRows: number): string {
		const above = offset > 0;
		const below = offset + rows < totalRows;
		if (above && below) return "↕";
		if (above) return "↑";
		if (below) return "↓";
		return "";
	}

	#unansweredCount(): number {
		let count = 0;
		for (let index = 0; index < this.questions.length; index++) {
			const question = this.questions[index];
			const state = this.#states[index];
			if (!question || !state) continue;
			if (state.selectedOptions.size === 0 && state.customInput === undefined) count += 1;
		}
		return count;
	}

	#handleTimeout(): void {
		if (this.#closed) return;
		if (this.#promptActive) {
			this.#timeoutExpired = true;
			return;
		}
		this.options.onTimeout?.();
		for (let index = 0; index < this.questions.length; index++) {
			const question = this.questions[index];
			const state = this.#states[index];
			if (!question || !state) continue;
			if (state.selectedOptions.size === 0 && state.customInput === undefined) {
				const noteMatch = /^option:(\d+)$/.exec(state.noteRowKey ?? "");
				const notedIndex = noteMatch ? Number.parseInt(noteMatch[1], 10) : Number.NaN;
				const fallbackIndex =
					Number.isInteger(notedIndex) && question.options[notedIndex]
						? notedIndex
						: clamp(question.recommended ?? 0, 0, Math.max(0, question.options.length - 1));
				const fallback = question.options[fallbackIndex];
				if (fallback) state.selectedOptions.add(fallback.label);
				state.timedOut = true;
			}
		}
		this.#finishSubmit();
	}

	#runDeferredTimeout(): void {
		if (!this.#timeoutExpired) return;
		this.#timeoutExpired = false;
		this.#handleTimeout();
	}

	#finishSubmit(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#countdown?.dispose();
		this.callbacks.onSubmit({ kind: "submit", results: this.#buildResults() });
	}

	#finishCancel(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#countdown?.dispose();
		this.callbacks.onCancel();
	}

	#finishChat(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#countdown?.dispose();
		this.callbacks.onChat();
	}

	#buildResults(): ExtensionAskDialogResultItem[] {
		const results: ExtensionAskDialogResultItem[] = [];
		for (let index = 0; index < this.questions.length; index++) {
			const question = this.questions[index];
			const state = this.#states[index];
			if (!question || !state) continue;
			const selectedOptions = question.options
				.map(option => option.label)
				.filter(label => state.selectedOptions.has(label));
			results.push({
				id: question.id,
				question: question.question,
				options: question.options.map(option => option.label),
				multi: question.multi ?? false,
				selectedOptions,
				customInput: state.customInput,
				note: noteForSubmittedAnswer(question, state),
				timedOut: state.timedOut || undefined,
			});
		}
		return results;
	}
}

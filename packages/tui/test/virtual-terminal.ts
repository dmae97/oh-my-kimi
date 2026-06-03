import type { Terminal, TerminalAppearance } from "@oh-my-pi/pi-tui/terminal";
import type {
	ITerminalInitOnlyOptions,
	ITerminalOptions,
	IUnicodeVersionProvider,
	Terminal as XtermTerminalType,
} from "@xterm/headless";
import xterm from "@xterm/headless";

// Extract Terminal class from the module
const XtermTerminal = xterm.Terminal;

/**
 * Width model for the virtual terminal:
 * - "legacy": xterm.js's default Unicode 6 tables (emoji = 1 cell, VS16 = zero
 *   width). Models older terminals: xterm, conhost, VTE, tmux's own grid.
 * - "modern": grapheme-aware semantics used by ghostty/WezTerm/kitty/iTerm2 and
 *   Windows Terminal 1.22+ (emoji presentation = 2 cells, VS16 promotes its
 *   base cell to 2 cells). Matches the renderer's native width engine for all
 *   stress content, so geometric expectations become cell-exact.
 */
export type VirtualTerminalWidthModel = "legacy" | "modern";

// xterm.js UnicodeService character-property packing (UnicodeService.ts):
//   value = (state << 3) | ((width & 3) << 1) | (shouldJoin ? 1 : 0)
// The format is internal but stable across 5.x/6.x; the calibration test in
// modern-width-provider.test.ts asserts it against the live V6 provider.
const packCharProperties = (width: number, shouldJoin: boolean): number => ((width & 3) << 1) | (shouldJoin ? 1 : 0);
const extractWidthFromProperties = (value: number): number => (value >> 1) & 3;

const EMOJI_PRESENTATION_RE = /\p{Emoji_Presentation}/u;
const emojiPresentationCache = new Map<number, boolean>();

function hasDefaultEmojiPresentation(codepoint: number): boolean {
	let result = emojiPresentationCache.get(codepoint);
	if (result === undefined) {
		result = EMOJI_PRESENTATION_RE.test(String.fromCodePoint(codepoint));
		emojiPresentationCache.set(codepoint, result);
	}
	return result;
}

/**
 * Modern (grapheme-aware) width semantics expressed as overrides on top of the
 * real xterm.js Unicode 6 provider:
 *
 * - Codepoints whose default presentation is emoji (`\p{Emoji_Presentation}`,
 *   e.g. U+1F642) occupy 2 cells; V6 reports 1.
 * - VS16 (U+FE0F) after a base cell joins into it and promotes it to 2 cells
 *   (kitty docs/text-sizing-protocol.rst "Wide emoji" rule; ghostty and
 *   WezTerm document the same VS15/VS16 handling).
 *
 * Everything else (combining marks, CJK, Hangul, controls) delegates to the
 * live V6 provider so this model never invents widths for content the
 * modern/legacy split does not affect.
 *
 * Deliberately NOT modeled: ZWJ collapsing (kitty/alacritty/Windows Terminal do
 * not collapse ZWJ sequences — see the "width model disagreement" regression
 * tests) and regional-indicator flag pairs (terminals disagree wildly; stress
 * content avoids them).
 */
class ModernWidthProvider implements IUnicodeVersionProvider {
	readonly version = "modern";
	#v6: IUnicodeVersionProvider;

	constructor(v6: IUnicodeVersionProvider) {
		this.#v6 = v6;
	}

	wcwidth(codepoint: number): 0 | 1 | 2 {
		const width = this.#v6.wcwidth(codepoint);
		if (width === 1 && codepoint > 0xff && hasDefaultEmojiPresentation(codepoint)) {
			return 2;
		}
		return width;
	}

	charProperties(codepoint: number, preceding: number): number {
		// VS16 joins into the preceding cell and promotes it to emoji presentation.
		if (codepoint === 0xfe0f && preceding !== 0 && extractWidthFromProperties(preceding) > 0) {
			return packCharProperties(2, true);
		}
		let width: number = this.wcwidth(codepoint);
		let shouldJoin = width === 0 && preceding !== 0;
		if (shouldJoin) {
			const previousWidth = extractWidthFromProperties(preceding);
			if (previousWidth === 0) {
				shouldJoin = false;
			} else if (previousWidth > width) {
				width = previousWidth;
			}
		}
		return packCharProperties(width, shouldJoin);
	}
}

/** Internal xterm shape needed to reach the registered V6 provider (test-only). */
interface XtermCoreInternals {
	_core: { unicodeService: { _providers: Record<string, IUnicodeVersionProvider> } };
}

/** Fetch the live Unicode 6 provider registered on an xterm instance. */
export function getXtermV6Provider(terminal: XtermTerminalType): IUnicodeVersionProvider {
	const provider = (terminal as unknown as XtermCoreInternals)._core.unicodeService._providers["6"];
	if (provider === undefined) {
		throw new Error("xterm.js V6 unicode provider not found; internal layout changed");
	}
	return provider;
}

/**
 * Virtual terminal for testing using xterm.js for accurate terminal emulation
 */
export class VirtualTerminal implements Terminal {
	private xterm: XtermTerminalType;
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private _columns: number;
	private _rows: number;

	constructor(columns = 80, rows = 24, scrollback?: number, widthModel: VirtualTerminalWidthModel = "legacy") {
		this._columns = columns;
		this._rows = rows;

		const options: ITerminalOptions & ITerminalInitOnlyOptions = {
			cols: columns,
			rows: rows,
			// Disable all interactive features for testing
			disableStdin: true,
			allowProposedApi: true,
		};
		if (scrollback !== undefined) {
			options.scrollback = scrollback;
		}

		// Create xterm instance with specified dimensions
		this.xterm = new XtermTerminal(options);
		if (widthModel === "modern") {
			this.xterm.unicode.register(new ModernWidthProvider(getXtermV6Provider(this.xterm)));
			this.xterm.unicode.activeVersion = "modern";
		}
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
		// Enable bracketed paste mode for consistency with ProcessTerminal
		this.xterm.write("\x1b[?2004h");
	}

	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {
		// No-op for virtual terminal - no stdin to drain
	}

	stop(): void {
		// Disable bracketed paste mode
		this.xterm.write("\x1b[?2004l");
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
	}

	write(data: string): void {
		this.xterm.write(data);
	}

	get columns(): number {
		return this._columns;
	}

	get rows(): number {
		return this._rows;
	}

	get kittyProtocolActive(): boolean {
		// Virtual terminal always reports Kitty protocol as active for testing
		return true;
	}

	get appearance(): TerminalAppearance | undefined {
		return undefined;
	}

	onAppearanceChange(_callback: (appearance: TerminalAppearance) => void): void {
		// No-op for virtual terminal
	}

	moveBy(lines: number): void {
		if (lines > 0) {
			// Move down
			this.xterm.write(`\x1b[${lines}B`);
		} else if (lines < 0) {
			// Move up
			this.xterm.write(`\x1b[${-lines}A`);
		}
		// lines === 0: no movement
	}

	hideCursor(): void {
		this.xterm.write("\x1b[?25l");
	}

	showCursor(): void {
		this.xterm.write("\x1b[?25h");
	}

	clearLine(): void {
		this.xterm.write("\x1b[K");
	}

	clearFromCursor(): void {
		this.xterm.write("\x1b[J");
	}

	clearScreen(): void {
		this.xterm.write("\x1b[H\x1b[0J"); // Move to home (1,1) and clear from cursor to end
	}

	setTitle(title: string): void {
		// OSC 0;title BEL - set terminal window title
		this.xterm.write(`\x1b]0;${title}\x07`);
	}

	setProgress(active: boolean): void {
		// OSC 9;4 progress sequence; no-op in tests beyond writing through to xterm.
		this.xterm.write(active ? "\x1b]9;4;3\x07" : "\x1b]9;4;0;\x07");
	}

	/** Wait for TUI's throttled render pipeline to settle (matches the 16ms frame budget). */
	async waitForRender(): Promise<void> {
		const nextTick = Promise.withResolvers<void>();
		process.nextTick(nextTick.resolve);
		await nextTick.promise;
		await Bun.sleep(20);
		await this.flush();
	}

	// Test-specific methods not in Terminal interface

	/**
	 * Simulate keyboard input
	 */
	sendInput(data: string): void {
		if (this.inputHandler) {
			this.inputHandler(data);
		}
	}
	/**
	 * Simulate the user scrolling through native terminal scrollback.
	 * Negative values scroll up; positive values scroll down.
	 */
	scrollLines(lines: number): void {
		this.xterm.scrollLines(lines);
	}

	/** Return whether the virtual viewport is at the scrollback tail. */
	isNativeViewportAtBottom(): boolean | undefined {
		const buffer = this.xterm.buffer.active;
		return buffer.viewportY >= buffer.baseY;
	}

	/** Get the terminal buffer's scrollback and viewport offsets. */
	getBufferPosition(): { baseY: number; viewportY: number } {
		const buffer = this.xterm.buffer.active;
		return { baseY: buffer.baseY, viewportY: buffer.viewportY };
	}

	/**
	 * Resize the terminal
	 */
	resize(columns: number, rows: number): void {
		this._columns = columns;
		this._rows = rows;
		this.xterm.resize(columns, rows);
		if (this.resizeHandler) {
			this.resizeHandler();
		}
	}

	/**
	 * Wait for all pending writes to complete. Viewport and scroll buffer will be updated.
	 */
	async flush(): Promise<void> {
		// Write an empty string to ensure all previous writes are flushed
		const done = Promise.withResolvers<void>();
		this.xterm.write("", done.resolve);
		return done.promise;
	}

	/**
	 * Flush and get viewport - convenience method for tests
	 */
	async flushAndGetViewport(): Promise<string[]> {
		await this.flush();
		return this.getViewport();
	}

	/**
	 * Get the visible viewport (what's currently on screen)
	 * Note: You should use getViewportAfterWrite() for testing after writing data
	 */
	getViewport(): string[] {
		const lines: string[] = [];
		const buffer = this.xterm.buffer.active;

		// Get only the visible lines (viewport)
		for (let i = 0; i < this.xterm.rows; i++) {
			const line = buffer.getLine(buffer.viewportY + i);
			if (line) {
				lines.push(line.translateToString(true));
			} else {
				lines.push("");
			}
		}

		return lines;
	}

	/**
	 * Columns in a viewport row whose cells carry a non-default background color.
	 * Used by the SGR-bleed oracle: background attributes must appear only on
	 * rows whose logical content carries background SGR — BCE (back-color-erase)
	 * makes `\x1b[K`/`\x1b[2K` fill erased cells with the *current* background,
	 * so leaked SGR state paints whole phantom-colored rows.
	 */
	getViewportRowBackgroundColumns(row: number): number[] {
		const buffer = this.xterm.buffer.active;
		const line = buffer.getLine(buffer.viewportY + row);
		if (!line) return [];
		const columns: number[] = [];
		for (let col = 0; col < this.xterm.cols; col++) {
			const cell = line.getCell(col);
			if (cell && !cell.isBgDefault()) {
				columns.push(col);
			}
		}
		return columns;
	}

	/**
	 * Get the entire scroll buffer
	 */
	getScrollBuffer(): string[] {
		const lines: string[] = [];
		const buffer = this.xterm.buffer.active;

		// Get all lines in the buffer (including scrollback)
		for (let i = 0; i < buffer.length; i++) {
			const line = buffer.getLine(i);
			if (line) {
				lines.push(line.translateToString(true));
			} else {
				lines.push("");
			}
		}

		return lines;
	}

	/**
	 * Get the hardware cursor position within the visible viewport.
	 * Both coordinates are 0-indexed; row is relative to the top of the viewport.
	 */
	getCursor(): { row: number; col: number } {
		const buffer = this.xterm.buffer.active;
		return { row: buffer.cursorY, col: buffer.cursorX };
	}

	/**
	 * Clear the terminal viewport
	 */
	clear(): void {
		this.xterm.clear();
	}

	/**
	 * Reset the terminal completely
	 */
	reset(): void {
		this.xterm.reset();
	}
}

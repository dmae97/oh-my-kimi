import * as fs from "node:fs";
import * as os from "node:os";
import type { Terminal, TerminalAppearance } from "@oh-my-pi/pi-tui/terminal";
import { CellFlags, Ghostty, type GhosttyCell, type GhosttyTerminal } from "ghostty-web";

// ---------------------------------------------------------------------------
// Shared Ghostty VT engine
// ---------------------------------------------------------------------------
// `VirtualTerminal` is backed by libghostty-vt compiled to WASM — Ghostty's real
// VT100 parser. Unlike the previous xterm.js backing, this is a *modern*
// grapheme-aware terminal: emoji presentation and VS16 promotion measure 2
// cells, ZWJ/combining clusters collapse into their base cell, BCE/erase and
// scrollback behave exactly as ghostty/kitty/WezTerm/iTerm2 do. That makes the
// render-stress oracles assert against ground-truth modern-terminal semantics
// instead of an approximation, so kitty-class rendering bugs (wide-char overrun,
// pending-wrap staircase, grapheme mis-measure) surface here.
//
// The WASM module is compiled once per module evaluation, then each
// `VirtualTerminal` gets its own instance. ghostty-web's allocator is not robust
// under the hundreds of create/free/write cycles the fuzz tests perform when all
// terminals share one instance; per-terminal instances keep construction
// synchronous while isolating allocator state.
function loadGhosttyModule(): WebAssembly.Module {
	const wasmPath = Bun.resolveSync("ghostty-web/ghostty-vt.wasm", import.meta.dir);
	// Synchronous compile (no top-level await): `bun test --parallel` leaves any
	// binding declared after a module-level `await` in the temporal dead zone when
	// a sibling test file instantiates `VirtualTerminal`, so module init must stay
	// fully synchronous (see the `DEFAULT_SCROLLBACK_LINES`/`ghosttyModule` TDZ).
	return new WebAssembly.Module(fs.readFileSync(wasmPath));
}

let ghosttyModule = loadGhosttyModule();

/**
 * Recompile the shared WASM module. ghostty-web 0.4 instances created from a
 * module that already produced a trapped instance have been observed to trap
 * again on byte streams that a freshly compiled module replays cleanly; the
 * recovery path swaps the module before rebuilding.
 */
function reloadGhosttyModule(): void {
	ghosttyModule = loadGhosttyModule();
}

// Non-spacing combining marks (Arabic harakat, Thai/Lao vowels) written so a
// cluster lands on the right margin deterministically corrupt ghostty-web
// 0.4's WASM memory (trap surfaces a few bytes later, with autowrap on or
// off). Mark placement through this engine is already unverifiable — readback
// migrates marks across cells, and the harness compares marked rows with
// non-spacing marks stripped (`sameLinesAllowingMarkDrift`) — so dropping the
// marks before the engine sees them removes the crash class without weakening
// any oracle. Variation selectors are kept: they are width-bearing (VS16
// promotes emoji to 2 cells) and never combine at the margin.
const UNSAFE_COMBINING_MARKS = /(?![\uFE00-\uFE0F])\p{Mn}/gu;
function stripCombiningMarksForGhostty(data: string): string {
	if (!/\p{Mn}/u.test(data)) return data;
	return data.replace(UNSAFE_COMBINING_MARKS, "");
}

function createGhosttyEngine(): Ghostty {
	// libghostty-vt reports unimplemented control sequences (e.g. DECCARA `$r`,
	// which this VT build does not apply) through the `env.log` import. Swallow it:
	// the oracles assert on what the renderer *emits*, never on the parser's own
	// diagnostics, and unbuffered logging would corrupt test output.
	return new Ghostty(new WebAssembly.Instance(ghosttyModule, { env: { log: () => {} } }));
}

function createGhosttyTerminal(
	ghostty: Ghostty,
	columns: number,
	rows: number,
	scrollbackCap: number,
): GhosttyTerminal {
	return ghostty.createTerminal(columns, rows, {
		// Byte budget (not a line count). Sized to hold the wrapper's line cap
		// comfortably while staying small enough that ghostty's own page
		// eviction kicks in under heavy write volume: ghostty-web 0.4's
		// allocator traps once an instance accumulates enough un-evicted
		// history (recommit-heavy stress runs hit it). The wrapper still clamps
		// the EXPOSED scrollback to the line cap, so eviction beyond the budget
		// is invisible to the oracles.
		scrollbackLimit: Math.max((scrollbackCap + rows + 64) * 1024, 1024 * 1024),
		fgColor: DEFAULT_FG_RGB,
		bgColor: DEFAULT_BG_RGB,
	});
}

// xterm.js' default scrollback line cap, used when a terminal is created without
// an explicit one. The exposed scrollback is clamped to this many lines (below).
const DEFAULT_SCROLLBACK_LINES = 1000;
// Packed default colors (0xRRGGBB). Light-grey fg on black bg so a styled SGR
// row differs from a default row in cell readback.
const DEFAULT_FG_RGB = 0xcccccc;
const DEFAULT_BG_RGB = 0x000000;
const MAX_GHOSTTY_WRITE_CHUNK = 4096;
// Compact the OOM-recovery event log once it exceeds this many logged chars.
// Kept aggressively small: ghostty-web 0.4 instances can trap on long byte
// histories (interactions that a synthesized text+grid state does not
// reproduce), so recovery must always replay a compact synthetic snapshot
// plus a short tail rather than the raw session history.
const EVENT_LOG_COMPACT_BUDGET = 256_000;
const SYNC_OUTPUT_BEGIN = "\x1b[?2026h";
const SYNC_OUTPUT_END = "\x1b[?2026l";
const OSC_SEQUENCE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
// Compare readback against the configured defaults directly; Ghostty's
// getColors() currently reports render-state metadata, not these cell colors.
const DEFAULT_FG_R = (DEFAULT_FG_RGB >> 16) & 0xff;
const DEFAULT_FG_G = (DEFAULT_FG_RGB >> 8) & 0xff;
const DEFAULT_FG_B = DEFAULT_FG_RGB & 0xff;
const DEFAULT_BG_R = (DEFAULT_BG_RGB >> 16) & 0xff;
const DEFAULT_BG_G = (DEFAULT_BG_RGB >> 8) & 0xff;
const DEFAULT_BG_B = DEFAULT_BG_RGB & 0xff;

/**
 * Virtual terminal for testing, backed by Ghostty's WASM VT engine.
 *
 * The engine models the active screen grid plus a linear scrollback history but
 * has no interactive scroll-viewport (it is always "at the bottom"). The harness
 * relies on xterm-style scroll bookkeeping (`baseY`/`viewportY`/`scrollLines`),
 * so this wrapper emulates that window over `[history ++ active grid]`:
 *
 * - `baseY` is the scrollback line count, clamped to the requested line cap so a
 *   small `scrollback` evicts oldest history exactly like xterm's line cap (the
 *   engine itself evicts by a generous *byte* budget, which we keep far above the
 *   line cap so the clamp is the only eviction the harness observes).
 * - `viewportY` is an absolute scroll offset in `[0, baseY]`; it follows the
 *   bottom on writes/resizes unless the caller scrolled up, matching xterm.
 *
 * This emulation was validated to match `@xterm/headless` bit-for-bit on
 * baseY/viewportY/viewport/scrollBuffer across append, overflow, scroll, write-
 * while-scrolled, and resize sequences.
 */
export class VirtualTerminal implements Terminal {
	#ghostty: Ghostty;
	#term: GhosttyTerminal;
	#columns: number;
	#rows: number;
	#scrollbackCap: number;
	#viewportY = 0;
	#inputHandler?: (data: string) => void;
	#resizeHandler?: () => void;
	#pendingEngineResize = false;
	// Byte/resize event log since the last engine recreate. ghostty-web 0.4's
	// allocator exhausts after enough cumulative write volume in one instance
	// (recommit-heavy stress runs hit it); on an OOM trap the wrapper rebuilds
	// a fresh engine and replays this log, which reproduces the exact terminal
	// state. Full-clear recreates reset the log (prior history is erased), so
	// it stays bounded by the bytes since the last destructive replay.
	#eventLog: (string | { columns: number; rows: number })[] = [];
	#eventLogBytes = 0;
	#logBaseColumns: number;
	#logBaseRows: number;
	#replayingLog = false;
	// Memoized text of committed scrollback rows, keyed by absolute offset. Safe
	// because the engine never evicts (its byte budget sits far above the line
	// cap), so an offset's content is stable until a resize (rewrap) or recreate
	// (clear) — both reset this. Eliminates the per-op O(history) WASM re-reads
	// that made long streaming runs O(n²) in committed rows.
	#historyTextCache: string[] = [];

	constructor(columns = 80, rows = 24, scrollback?: number) {
		this.#columns = columns;
		this.#rows = rows;
		this.#logBaseColumns = columns;
		this.#logBaseRows = rows;
		this.#scrollbackCap = scrollback ?? DEFAULT_SCROLLBACK_LINES;
		this.#ghostty = createGhosttyEngine();
		this.#term = createGhosttyTerminal(this.#ghostty, columns, rows, this.#scrollbackCap);
	}

	// --- Terminal interface --------------------------------------------------

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.#inputHandler = onInput;
		this.#resizeHandler = onResize;
		// Enable bracketed paste mode for consistency with ProcessTerminal.
		this.#engineWrite("\x1b[?2004h");
	}

	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {
		// No-op for virtual terminal - no stdin to drain.
	}

	stop(): void {
		this.#engineWrite("\x1b[?2004l\x1b[?5522l");
		this.#inputHandler = undefined;
		this.#resizeHandler = undefined;
	}

	write(data: string): void {
		this.#engineWrite(data);
	}

	get columns(): number {
		return this.#columns;
	}

	get rows(): number {
		return this.#rows;
	}

	get kittyProtocolActive(): boolean {
		// Backed by a real Ghostty engine: the Kitty keyboard protocol is genuinely
		// supported, so tests can rely on it being active.
		return true;
	}

	get kittyEnableSequence(): string | null {
		return "\x1b[>1u";
	}

	get appearance(): TerminalAppearance | undefined {
		return undefined;
	}

	onAppearanceChange(_callback: (appearance: TerminalAppearance) => void): void {
		// No-op for virtual terminal.
	}

	moveBy(lines: number): void {
		if (lines > 0) this.#engineWrite(`\x1b[${lines}B`);
		else if (lines < 0) this.#engineWrite(`\x1b[${-lines}A`);
	}

	hideCursor(): void {
		this.#engineWrite("\x1b[?25l");
	}

	showCursor(): void {
		this.#engineWrite("\x1b[?25h");
	}

	clearLine(): void {
		this.#engineWrite("\x1b[K");
	}

	clearFromCursor(): void {
		this.#engineWrite("\x1b[J");
	}

	clearScreen(): void {
		this.#engineWrite("\x1b[H\x1b[0J");
	}

	setTitle(title: string): void {
		this.#engineWrite(`\x1b]0;${title}\x07`);
	}

	setProgress(active: boolean): void {
		this.#engineWrite(active ? "\x1b]9;4;3\x07" : "\x1b]9;4;0;\x07");
	}

	resize(columns: number, rows: number): void {
		const wasBottom = this.#atBottom();
		this.#columns = columns;
		this.#rows = rows;
		if (this.#resizeHandler) {
			this.#pendingEngineResize = true;
		} else {
			this.#term.resize(columns, rows);
			this.#historyTextCache.length = 0; // engine rewraps scrollback on resize
			this.#refollowBottom(wasBottom);
		}
		this.#resizeHandler?.();
	}

	/** Return whether the virtual viewport is at the scrollback tail. */
	isNativeViewportAtBottom(): boolean | undefined {
		return this.#atBottom();
	}

	// --- Test-only helpers ---------------------------------------------------

	/** Wait for TUI's throttled render pipeline to settle (matches the ~33ms frame budget). */
	async waitForRender(): Promise<void> {
		const nextTick = Promise.withResolvers<void>();
		process.nextTick(nextTick.resolve);
		await nextTick.promise;
		await Bun.sleep(40);
		await this.flush();
	}

	/** Simulate keyboard input. */
	sendInput(data: string): void {
		this.#inputHandler?.(data);
	}

	/**
	 * Simulate the user scrolling through native terminal scrollback.
	 * Negative values scroll up; positive values scroll down.
	 */
	scrollLines(lines: number): void {
		this.#viewportY = Math.max(0, Math.min(this.#cappedBaseY(), this.#viewportY + lines));
	}

	/** Get the terminal buffer's scrollback and viewport offsets. */
	getBufferPosition(): { baseY: number; viewportY: number } {
		return { baseY: this.#cappedBaseY(), viewportY: this.#viewportY };
	}

	/** ghostty.write is synchronous; nothing to drain. Yield a microtask for ordering. */
	async flush(): Promise<void> {
		await Promise.resolve();
	}

	/** Flush and get viewport - convenience method for tests. */
	async flushAndGetViewport(): Promise<string[]> {
		await this.flush();
		return this.getViewport();
	}

	/** Get the visible viewport (what's currently on screen). */
	getViewport(): string[] {
		this.#term.update();
		const active = this.#term.getViewport();
		const capped = this.#cappedBaseY();
		const historyLen = this.#term.getScrollbackLength();
		const lines: string[] = [];
		for (let i = 0; i < this.#rows; i++) {
			const index = this.#viewportY + i;
			lines.push(
				index < capped
					? this.#historyRowText(historyLen - capped + index)
					: this.#activeRowText(active, index - capped),
			);
		}
		return lines;
	}

	/** Get the entire scroll buffer (clamped scrollback history followed by the active grid). */
	getScrollBuffer(): string[] {
		this.#term.update();
		const active = this.#term.getViewport();
		const capped = this.#cappedBaseY();
		const historyLen = this.#term.getScrollbackLength();
		const lines: string[] = [];
		const total = capped + this.#rows;
		for (let i = 0; i < total; i++) {
			lines.push(
				i < capped ? this.#historyRowText(historyLen - capped + i) : this.#activeRowText(active, i - capped),
			);
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
		const cells = this.#presentedRowCells(row);
		if (!cells) return [];
		const columns: number[] = [];
		for (let col = 0; col < cells.length; col++) {
			const cell = cells[col];
			if (cell && !this.#isDefaultBg(cell)) columns.push(col);
		}
		return columns;
	}

	/**
	 * Columns in a viewport row whose cells carry a non-default foreground color.
	 * Used with unreset-SGR regressions to ensure per-line resets confine
	 * foreground attributes to the row that emitted them.
	 */
	getViewportRowForegroundColumns(row: number): number[] {
		const cells = this.#presentedRowCells(row);
		if (!cells) return [];
		const columns: number[] = [];
		for (let col = 0; col < cells.length; col++) {
			const cell = cells[col];
			if (cell && !this.#isDefaultFg(cell)) columns.push(col);
		}
		return columns;
	}

	/**
	 * Columns in a viewport row whose cells carry underline.
	 * Used with unreset-SGR regressions to ensure style attributes do not bleed
	 * into later rows or erased blanks.
	 */
	getViewportRowUnderlineColumns(row: number): number[] {
		const cells = this.#presentedRowCells(row);
		if (!cells) return [];
		const columns: number[] = [];
		for (let col = 0; col < cells.length; col++) {
			if ((cells[col]?.flags ?? 0) & CellFlags.UNDERLINE) columns.push(col);
		}
		return columns;
	}

	/** Whether the cell at a viewport position carries the italic attribute. */
	getCellItalic(row: number, col: number): boolean {
		const cells = this.#presentedRowCells(row);
		return ((cells?.[col]?.flags ?? 0) & CellFlags.ITALIC) !== 0;
	}

	/**
	 * Get the hardware cursor position within the visible viewport.
	 * Both coordinates are 0-indexed; row is relative to the top of the active grid.
	 */
	getCursor(): { row: number; col: number } {
		const cursor = this.#term.getCursor();
		return { row: cursor.y, col: cursor.x };
	}

	/** Clear the buffer to a blank slate (recreates the engine terminal). */
	clear(): void {
		this.#recreate();
	}

	/** Reset the terminal completely (recreates the engine terminal). */
	reset(): void {
		this.#recreate();
	}

	// --- Internals -----------------------------------------------------------

	#engineWrite(data: string): void {
		const wasBottom = this.#atBottom();
		const clearScrollbackAfterFullClear = "\x1b[2J\x1b[H\x1b[3J";
		const clearIndex = data.indexOf(clearScrollbackAfterFullClear);
		if (clearIndex >= 0 && this.#canRecreateForFullClear(data, clearIndex)) {
			// ghostty-web 0.4 can trap in WASM when libghostty-vt processes a
			// full-clear + ED3 repaint against an existing history buffer. The
			// sequence's observable effect here is a blank terminal with empty
			// history before repainting the transcript, so create exactly that
			// state directly in a fresh WASM instance and feed Ghostty the
			// unmodified text/SGR tail.
			this.#recreate();
			data = data.slice(0, clearIndex) + data.slice(clearIndex + clearScrollbackAfterFullClear.length);
		} else if (this.#pendingEngineResize) {
			this.#term.resize(this.#columns, this.#rows);
			this.#eventLog.push({ columns: this.#columns, rows: this.#rows });
			this.#historyTextCache.length = 0; // engine rewraps scrollback on resize
			this.#pendingEngineResize = false;
		}
		data = this.#stripSynchronizedOutput(data);
		data = stripCombiningMarksForGhostty(data);
		this.#writeToGhostty(data);
		this.#refollowBottom(wasBottom);
	}

	#stripSynchronizedOutput(data: string): string {
		if (!data.includes(SYNC_OUTPUT_BEGIN) && !data.includes(SYNC_OUTPUT_END) && !data.includes("\x1b]")) return data;
		return data.replaceAll(SYNC_OUTPUT_BEGIN, "").replaceAll(SYNC_OUTPUT_END, "").replace(OSC_SEQUENCE, "");
	}

	#writeToGhostty(data: string): void {
		if (!this.#replayingLog) {
			this.#eventLog.push(data);
			this.#eventLogBytes += data.length;
		}
		let offset = 0;
		while (offset < data.length) {
			let end = Math.min(offset + MAX_GHOSTTY_WRITE_CHUNK, data.length);
			const last = data.charCodeAt(end - 1);
			if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
			if (end <= offset) end = Math.min(offset + 1, data.length);
			const chunk = data.slice(offset, end);
			try {
				this.#term.write(chunk);
			} catch (error) {
				if (this.#replayingLog) {
					const dumpPath = `${os.tmpdir()}/ghostty-trap-log-${Date.now()}.json`;
					try {
						fs.writeFileSync(dumpPath, JSON.stringify(this.#eventLog));
					} catch {}
					throw new Error(
						`ghostty write failed during OOM-recovery replay (chunk ${chunk.length} chars at offset ${offset} of ${data.length}): ${String(error)}\n` +
							`event log dumped to ${dumpPath}\n` +
							`chunk head: ${JSON.stringify(chunk.slice(0, 200))}`,
						{ cause: error },
					);
				}
				this.#recoverFromEngineOom();
				return;
			}
			offset = end;
		}
		// Healthy write completed: once the log grows past the budget, compact
		// it to a bounded synthetic state and rotate onto a fresh engine.
		// ghostty-web 0.4 instances cannot be freed safely and grow their WASM
		// memory monotonically with write volume; abandoned giants eventually
		// starve the process so badly that a fresh instance cannot even grow.
		// Rotating early keeps every instance small.
		if (!this.#replayingLog && this.#eventLogBytes > EVENT_LOG_COMPACT_BUDGET) {
			this.#compactEventLog();
			this.#rebuildEngineFromLog();
		}
	}

	/**
	 * Replace the event log with a synthetic stream rebuilt from the healthy
	 * engine's readable state: the wrapper-visible history window as plain
	 * text, the grid repainted with background runs (the only style any oracle
	 * reads), and the cursor restored. Replaying it reproduces every
	 * observable the oracles consume.
	 */
	#compactEventLog(): void {
		const historyLen = this.#term.getScrollbackLength();
		const capped = this.#cappedBaseY();
		let synthetic = "";
		for (let i = 0; i < capped; i++) {
			synthetic += `${this.#historyRowText(historyLen - capped + i)}\r\n`;
		}
		// Push exactly `capped` rows into scrollback, leaving a blank grid.
		synthetic += "\r\n".repeat(Math.max(0, this.#rows - 1));
		for (let row = 0; row < this.#rows; row++) {
			synthetic += `\x1b[${row + 1};1H\x1b[K${this.#syntheticGridRow(row)}`;
		}
		const cursor = this.getCursor();
		synthetic += `\x1b[${cursor.row + 1};${cursor.col + 1}H`;
		this.#eventLog = [synthetic];
		this.#eventLogBytes = synthetic.length;
		this.#logBaseColumns = this.#columns;
		this.#logBaseRows = this.#rows;
	}

	/** Grid row text with minimal background-run SGR, for log compaction. */
	#syntheticGridRow(row: number): string {
		const cells = this.#term.getLine(row);
		if (!cells) return "";
		let out = "";
		let currentBg = -1; // -1 = default
		for (let col = 0; col < cells.length; col++) {
			const cell = cells[col];
			if (!cell || cell.width === 0) continue;
			const bg = this.#isDefaultBg(cell) ? -1 : (cell.bg_r << 16) | (cell.bg_g << 8) | cell.bg_b;
			if (bg !== currentBg) {
				out += bg === -1 ? "\x1b[49m" : `\x1b[48;2;${cell.bg_r};${cell.bg_g};${cell.bg_b}m`;
				currentBg = bg;
			}
			if (cell.codepoint === 0) {
				out += " ";
			} else {
				out +=
					cell.grapheme_len > 0 ? this.#term.getGraphemeString(row, col) : this.#safeCodepointText(cell.codepoint);
			}
		}
		return `${out}\x1b[0m`;
	}

	/**
	 * Rebuild a fresh engine and replay the event log to reproduce the exact
	 * terminal state. The failed write is already in the log, so the replay
	 * completes it against a fresh allocator.
	 */
	#recoverFromEngineOom(): void {
		this.#rebuildEngineFromLog();
	}

	/**
	 * Rebuild a fresh engine and replay the event log to reproduce the exact
	 * terminal state. Used for proactive rotation (with a compacted log) and
	 * for OOM recovery, where the failed write is already in the log so the
	 * replay completes it against a fresh allocator.
	 */
	#rebuildEngineFromLog(): void {
		const log = this.#eventLog;
		// Give JSC a chance to collect previously abandoned instances before
		// allocating another one.
		Bun.gc(true);
		reloadGhosttyModule();
		this.#ghostty = createGhosttyEngine();
		this.#term = createGhosttyTerminal(this.#ghostty, this.#logBaseColumns, this.#logBaseRows, this.#scrollbackCap);
		this.#historyTextCache.length = 0;
		this.#replayingLog = true;
		try {
			for (const event of log) {
				if (typeof event === "string") {
					this.#writeToGhostty(event);
				} else {
					this.#term.resize(event.columns, event.rows);
				}
			}
		} finally {
			this.#replayingLog = false;
		}
	}

	#canRecreateForFullClear(data: string, clearIndex: number): boolean {
		const paintBegin = "\x1b[?25l\x1b[?2026h\x1b[?7l";
		const paintBeginNoSync = "\x1b[?25l\x1b[?7l";
		return (
			(clearIndex === paintBegin.length && data.startsWith(paintBegin)) ||
			(clearIndex === paintBeginNoSync.length && data.startsWith(paintBeginNoSync))
		);
	}

	#atBottom(): boolean {
		return this.#viewportY >= this.#cappedBaseY();
	}

	/** Scrollback line count exposed to callers, clamped to the requested line cap. */
	#cappedBaseY(): number {
		return Math.min(this.#term.getScrollbackLength(), this.#scrollbackCap);
	}
	#refollowBottom(wasBottom: boolean): void {
		const base = this.#cappedBaseY();
		this.#viewportY = wasBottom ? base : Math.min(this.#viewportY, base);
	}

	#recreate(_freeCurrent = true): void {
		// ghostty-web 0.4's terminal/free path is not safe under the rapid
		// resize/full-clear churn in the stress harness. Retire the old instance
		// and build a fresh one; tests are short-lived and this preserves the
		// observable full-clear/reset semantics without poisoning WASM state.
		this.#ghostty = createGhosttyEngine();
		this.#term = createGhosttyTerminal(this.#ghostty, this.#columns, this.#rows, this.#scrollbackCap);
		this.#pendingEngineResize = false;
		this.#viewportY = 0;
		this.#historyTextCache.length = 0; // fresh engine: prior scrollback is gone
		this.#eventLog.length = 0;
		this.#eventLogBytes = 0;
		this.#logBaseColumns = this.#columns;
		this.#logBaseRows = this.#rows;
	}

	/** Cells of the presented viewport row (history when scrolled up, else active grid). */
	#presentedRowCells(row: number): GhosttyCell[] | null {
		const index = this.#viewportY + row;
		const capped = this.#cappedBaseY();
		if (index < capped) {
			return this.#term.getScrollbackLine(this.#term.getScrollbackLength() - capped + index);
		}
		const activeRow = index - capped;
		if (activeRow < 0 || activeRow >= this.#rows) return null;
		return this.#term.getLine(activeRow);
	}

	/** Reconstruct an active-grid row's text from a flat viewport cell array. */
	#activeRowText(cells: GhosttyCell[], row: number): string {
		let text = "";
		const base = row * this.#columns;
		for (let col = 0; col < this.#columns; col++) {
			const cell = cells[base + col];
			if (!cell || cell.width === 0) continue; // wide-char trailing spacer
			if (cell.codepoint === 0) {
				text += " ";
			} else {
				text +=
					cell.grapheme_len > 0 ? this.#term.getGraphemeString(row, col) : this.#safeCodepointText(cell.codepoint);
			}
		}
		return text.replace(/\s+$/u, "");
	}

	/** Reconstruct a scrollback-history row's text by line offset (0 = oldest). */
	#historyRowText(offset: number): string {
		const cached = this.#historyTextCache[offset];
		if (cached !== undefined) return cached;
		const cells = this.#term.getScrollbackLine(offset);
		if (!cells) return "";
		let text = "";
		for (let col = 0; col < cells.length; col++) {
			const cell = cells[col];
			if (!cell || cell.width === 0) continue;
			if (cell.codepoint === 0) {
				text += " ";
			} else {
				text +=
					cell.grapheme_len > 0
						? this.#term.getScrollbackGraphemeString(offset, col)
						: this.#safeCodepointText(cell.codepoint);
			}
		}
		text = text.replace(/\s+$/u, "");
		this.#historyTextCache[offset] = text;
		return text;
	}

	#safeCodepointText(codepoint: number): string {
		if (
			!Number.isInteger(codepoint) ||
			codepoint <= 0 ||
			codepoint > 0x10ffff ||
			(codepoint >= 0xd800 && codepoint <= 0xdfff)
		) {
			return "";
		}
		return String.fromCodePoint(codepoint);
	}

	#isDefaultBg(cell: GhosttyCell): boolean {
		return cell.bg_r === DEFAULT_BG_R && cell.bg_g === DEFAULT_BG_G && cell.bg_b === DEFAULT_BG_B;
	}

	#isDefaultFg(cell: GhosttyCell): boolean {
		return cell.fg_r === DEFAULT_FG_R && cell.fg_g === DEFAULT_FG_G && cell.fg_b === DEFAULT_FG_B;
	}
}

/**
 * StdinBuffer buffers input and emits complete sequences.
 *
 * This is necessary because stdin data events can arrive in partial chunks,
 * especially for escape sequences like mouse events. Without buffering,
 * partial sequences can be misinterpreted as regular keypresses.
 *
 * For example, the mouse SGR sequence `\x1b[<35;20;5m` might arrive as:
 * - Event 1: `\x1b`
 * - Event 2: `[<35`
 * - Event 3: `;20;5m`
 *
 * The buffer accumulates these until a complete sequence is detected.
 * Call the `process()` method to feed input data.
 *
 * Based on code from OpenTUI (https://github.com/anomalyco/opentui)
 * MIT License - Copyright (c) 2025 opentui
 */
import { EventEmitter } from "events";
import { isKittyProtocolActive } from "./keys";

const ESC = "\x1b";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
// Paste-mode recovery bounds: a lost/corrupted end marker (ssh/tmux
// truncation) must not hang input forever or grow memory unboundedly.
const PASTE_INACTIVITY_TIMEOUT_MS = 1000;
const PASTE_MAX_BYTES = 64 * 1024 * 1024;
// A buggy double-report (CSI-u event plus the bare printable for the same
// keypress) arrives in the same terminal write; a bare char that shows up
// later than this window is a real keystroke and must not be swallowed.
const KITTY_PRINTABLE_DEDUP_WINDOW_MS = 25;
// An SGR mouse report prefix is unambiguous: no keyboard sequence starts with
// `\x1b[<`, so a buffer still matching this is always the head of a split
// mouse report. Flushing it on timeout would deliver the tail as literal
// typed text to whatever component is focused (fullscreen overlays enable
// any-motion tracking, so report floods plus render stalls make the split
// routine — see the settings search leaking `[<35;8;16M`).
const SGR_MOUSE_PARTIAL = /^\x1b\[<[\d;]*$/;
// Upper bound on how long an unambiguous partial is held past the flush
// timeout before being delivered raw anyway (terminal died mid-sequence).
// This is also the worst-case added latency for a partial that never
// completes (e.g. a bare ESC delivered while the kitty-active flag is
// stale); keep it small.
const PARTIAL_HOLD_MAX_MS = 150;
/**
 * Check if a string is a complete escape sequence or needs more data
 */
function isCompleteSequence(data: string): "complete" | "incomplete" | "not-escape" {
	if (!data.startsWith(ESC)) {
		return "not-escape";
	}

	if (data.length === 1) {
		return "incomplete";
	}

	const afterEsc = data.slice(1);

	// CSI sequences: ESC [
	if (afterEsc.startsWith("[")) {
		// Check for old-style mouse sequence: ESC[M + 3 bytes
		if (afterEsc.startsWith("[M")) {
			// Old-style mouse needs ESC[M + 3 bytes = 6 total
			return data.length >= 6 ? "complete" : "incomplete";
		}
		return isCompleteCsiSequence(data);
	}

	// OSC sequences: ESC ]
	if (afterEsc.startsWith("]")) {
		return isCompleteOscSequence(data);
	}

	// DCS sequences: ESC P ... ESC \ (includes XTVersion responses)
	if (afterEsc.startsWith("P")) {
		return isCompleteDcsSequence(data);
	}

	// APC sequences: ESC _ ... ESC \ (includes Kitty graphics responses)
	if (afterEsc.startsWith("_")) {
		return isCompleteApcSequence(data);
	}

	// SS3 sequences: ESC O
	if (afterEsc.startsWith("O")) {
		// ESC O followed by a single character
		return afterEsc.length >= 2 ? "complete" : "incomplete";
	}

	// ESC-prefixed sequences (terminals with metaSendsEscape):
	// Only when the inner ESC starts a CSI ('[') or SS3 ('O') sequence.
	// Bare double-ESC (e.g. \x1b\x1bX) remains complete to avoid 10ms timeout lag.
	if (afterEsc.startsWith(ESC)) {
		const inner = data.slice(1);
		const third = inner.charCodeAt(1);
		if (third === 0x5b || third === 0x4f) {
			return isCompleteSequence(inner);
		}
		return "complete";
	}

	// Meta key sequences: ESC followed by a single character
	if (afterEsc.length === 1) {
		return "complete";
	}

	// Unknown escape sequence - treat as complete
	return "complete";
}

/**
 * Check if CSI sequence is complete
 * CSI sequences: ESC [ ... followed by a final byte (0x40-0x7E)
 */
function isCompleteCsiSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}[`)) {
		return "complete";
	}

	// Need at least ESC [ and one more character
	if (data.length < 3) {
		return "incomplete";
	}

	const payload = data.slice(2);

	// CSI sequences end with a byte in the range 0x40-0x7E (@-~)
	// This includes all letters and several special characters
	const lastChar = payload[payload.length - 1];
	const lastCharCode = lastChar.charCodeAt(0);

	if (lastCharCode >= 0x40 && lastCharCode <= 0x7e) {
		// Special handling for SGR mouse sequences
		// Format: ESC[<B;X;Ym or ESC[<B;X;YM
		if (payload.startsWith("<")) {
			// Must have format: <digits;digits;digits[Mm]
			const mouseMatch = /^<\d+;\d+;\d+[Mm]$/.test(payload);
			if (mouseMatch) {
				return "complete";
			}
			// If it ends with M or m but doesn't match the pattern, still incomplete
			if (lastChar === "M" || lastChar === "m") {
				// Check if we have the right structure
				const parts = payload.slice(1, -1).split(";");
				if (parts.length === 3 && parts.every(p => /^\d+$/.test(p))) {
					return "complete";
				}
			}

			return "incomplete";
		}

		return "complete";
	}

	return "incomplete";
}

/**
 * Check if OSC sequence is complete
 * OSC sequences: ESC ] ... ST (where ST is ESC \ or BEL)
 */
function isCompleteOscSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}]`)) {
		return "complete";
	}

	// OSC sequences end with ST (ESC \) or BEL (\x07)
	if (data.endsWith(`${ESC}\\`) || data.endsWith("\x07")) {
		return "complete";
	}

	return "incomplete";
}

/**
 * Check if DCS (Device Control String) sequence is complete
 * DCS sequences: ESC P ... ST (where ST is ESC \)
 * Used for XTVersion responses like ESC P >| ... ESC \
 */
function isCompleteDcsSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}P`)) {
		return "complete";
	}

	// DCS sequences end with ST (ESC \)
	if (data.endsWith(`${ESC}\\`)) {
		return "complete";
	}

	return "incomplete";
}

/**
 * Check if APC (Application Program Command) sequence is complete
 * APC sequences: ESC _ ... ST (where ST is ESC \)
 * Used for Kitty graphics responses like ESC _ G ... ESC \
 */
function isCompleteApcSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}_`)) {
		return "complete";
	}

	// APC sequences end with ST (ESC \)
	if (data.endsWith(`${ESC}\\`)) {
		return "complete";
	}

	return "incomplete";
}

/**
 * Split accumulated buffer into complete sequences
 */
function parseUnmodifiedKittyPrintableCodepoint(sequence: string): number | undefined {
	const match = sequence.match(/^\x1b\[(\d+)(?::\d*)?(?::\d+)?u$/);
	if (!match) return undefined;

	const codepoint = parseInt(match[1]!, 10);
	return codepoint >= 32 ? codepoint : undefined;
}

function extractCompleteSequences(buffer: string): { sequences: string[]; remainder: string } {
	const sequences: string[] = [];
	const length = buffer.length;
	let pos = 0;

	// Index-based scanning: this is the input hot path. Slicing the remaining
	// buffer (or Array.from-ing it) per iteration would make plain-text bursts
	// O(n²) — a 100KB non-bracketed paste must stay O(n).
	while (pos < length) {
		if (buffer.charCodeAt(pos) === 0x1b) {
			// Find the end of this escape sequence by growing the candidate.
			let end = pos + 1;
			let consumed = false;
			while (end <= length) {
				const candidate = buffer.slice(pos, end);
				const status = isCompleteSequence(candidate);
				if (status === "incomplete") {
					end++;
					continue;
				}
				// "\x1b\x1b" is one of three things:
				//   1. ESC prefixing CSI/SS3 (meta-CSI, held Esc joined by a follower):
				//      next byte is "[" or "O" — keep growing so the full sequence stays
				//      together. Consuming two bytes here would tear the follower and
				//      leak its tail as typed text (settings search filling with "[B"
				//      or "[<35;22;17M").
				//   2. ESC followed by a legacy Alt chord (`\x1bd`, `\x1b\x7f`, …):
				//      emit the first ESC, then restart at the second ESC so downstream
				//      parsing still sees the Alt chord as one keypress (#3860 review).
				//   3. Two real Esc keypresses bursted by terminal input batching:
				//      when the buffer ends here, hold the partial for the flush window
				//      so case 1/2 can still arrive; if no follower arrives, `flush()`
				//      splits the held remainder into two ESC events (#3857).
				if (candidate === `${ESC}${ESC}`) {
					if (end >= length) {
						return { sequences, remainder: buffer.slice(pos) };
					}
					const next = buffer.charCodeAt(end);
					if (next === 0x5b || next === 0x4f) {
						end++;
						continue;
					}
					sequences.push(ESC);
					pos += 1;
					consumed = true;
					break;
				}
				// ESC + SGR mouse report is never a meta chord: alt-modified mouse
				// reports carry the modifier in the button bits, not an ESC prefix.
				// Deliver the bare ESC (a real Esc keypress) and the report separately.
				if (candidate.startsWith(`${ESC}${ESC}[<`)) {
					sequences.push(ESC, candidate.slice(1));
					pos = end;
					consumed = true;
					break;
				}
				// "complete" — or "not-escape", which should not happen when
				// starting with ESC; both consume the candidate.
				sequences.push(candidate);
				pos = end;
				consumed = true;
				break;
			}

			if (!consumed) {
				return { sequences, remainder: buffer.slice(pos) };
			}
		} else {
			// Not an escape sequence - take one Unicode scalar, not a UTF-16 code unit.
			const codePoint = buffer.codePointAt(pos)!;
			const charLength = codePoint > 0xffff ? 2 : 1;
			sequences.push(buffer.slice(pos, pos + charLength));
			pos += charLength;
		}
	}

	return { sequences, remainder: "" };
}

export type StdinBufferOptions = {
	/**
	 * Maximum time to wait for sequence completion (default: 75ms).
	 * After this time, a genuinely incomplete escape is flushed.
	 */
	timeout?: number;
	/**
	 * Maximum extra time (default: 150ms) an unambiguous escape partial — an
	 * SGR mouse prefix, or any dangling escape while the kitty keyboard
	 * protocol is active — is held past `timeout` waiting for its tail.
	 */
	partialHoldTimeout?: number;
	/**
	 * Paste-mode inactivity watchdog (default: 1000ms). If no input arrives for
	 * this long while waiting for the bracketed-paste end marker, the paste is
	 * assumed truncated: accumulated bytes are delivered and input recovers.
	 */
	pasteTimeout?: number;
	/**
	 * Paste-mode byte cap (default: 64 MiB). Exceeding it aborts paste mode the
	 * same way, bounding memory when the end marker never arrives.
	 */
	pasteByteLimit?: number;
};

export type StdinBufferEventMap = {
	data: [string];
	paste: [string];
};

/**
 * Buffers stdin input and emits complete sequences via the 'data' event.
 * Handles partial escape sequences that arrive across multiple chunks.
 */
export class StdinBuffer extends EventEmitter<StdinBufferEventMap> {
	#buffer: string = "";
	#timeout?: NodeJS.Timeout;
	#flushDeferral?: NodeJS.Timeout;
	#partialHoldStartMs = 0;
	readonly #timeoutMs: number;
	readonly #partialHoldMaxMs: number;
	readonly #pasteTimeoutMs: number;
	readonly #pasteByteLimit: number;
	#pasteMode: boolean = false;
	#pasteChunks: string[] = [];
	#pasteOverlap: string = "";
	#pasteBytes = 0;
	#pasteWatchdog?: NodeJS.Timeout;
	#pendingKittyPrintableCodepoint: number | undefined;
	#pendingKittyPrintableAtMs = 0;

	constructor(options: StdinBufferOptions = {}) {
		super();
		this.#timeoutMs = options.timeout ?? 75;
		this.#partialHoldMaxMs = options.partialHoldTimeout ?? PARTIAL_HOLD_MAX_MS;
		this.#pasteTimeoutMs = options.pasteTimeout ?? PASTE_INACTIVITY_TIMEOUT_MS;
		this.#pasteByteLimit = options.pasteByteLimit ?? PASTE_MAX_BYTES;
	}

	process(data: string | Buffer): void {
		// Handle high-byte conversion (for compatibility with parseKeypress)
		// If buffer has single byte > 127, convert to ESC + (byte - 128)
		let str: string;
		if (Buffer.isBuffer(data)) {
			if (data.length === 1 && data[0]! > 127) {
				const byte = data[0]! - 128;
				str = `\x1b${String.fromCharCode(byte)}`;
			} else {
				str = data.toString();
			}
		} else {
			str = data;
		}

		if (this.#flushDeferral && this.#isFreshEscapeAfterDeferredFlush(str)) {
			// The buffered partial already hit its flush timeout. A new escape is
			// a fresh sequence, not a tail; flush the stale partial first so the
			// new sequence can be parsed from a clean buffer.
			this.#flushExpired();
		} else {
			// Cancel any pending flush — new data may complete the buffered partial.
			this.#clearFlushTimer();
		}

		if (str.length === 0 && this.#buffer.length === 0) {
			this.#emitDataSequence("");
			return;
		}

		this.#buffer += str;

		if (this.#pasteMode) {
			const chunk = this.#buffer;
			this.#buffer = "";
			this.#consumePasteChunk(chunk);
			return;
		}

		const startIndex = this.#buffer.indexOf(BRACKETED_PASTE_START);
		if (startIndex !== -1) {
			if (startIndex > 0) {
				const beforePaste = this.#buffer.slice(0, startIndex);
				const result = extractCompleteSequences(beforePaste);
				for (const sequence of result.sequences) {
					this.#emitDataSequence(sequence);
				}
			}

			this.#pendingKittyPrintableCodepoint = undefined;
			this.#buffer = this.#buffer.slice(startIndex + BRACKETED_PASTE_START.length);
			const firstChunk = this.#buffer;
			this.#buffer = "";
			this.#pasteMode = true;
			this.#pasteChunks = [];
			this.#pasteOverlap = "";
			this.#pasteBytes = 0;
			this.#consumePasteChunk(firstChunk);
			return;
		}

		const result = extractCompleteSequences(this.#buffer);
		this.#buffer = result.remainder;

		for (const sequence of result.sequences) {
			this.#emitDataSequence(sequence);
		}

		if (this.#buffer.length > 0) {
			this.#armFlushTimer();
		} else {
			this.#partialHoldStartMs = 0;
		}
	}

	/**
	 * Consume one chunk of paste-mode input. Chunks are accumulated in an array
	 * and only joined once the end marker arrives, so a large paste delivered in
	 * many small terminal reads stays O(total) instead of the O(total^2) cost of
	 * re-concatenating and rescanning the whole buffer on every chunk. A short
	 * overlap tail (end-marker length - 1) is carried across chunk boundaries so
	 * a marker split between two reads is still detected without rescanning.
	 */
	#consumePasteChunk(chunk: string): void {
		const probe = this.#pasteOverlap + chunk;
		if (probe.indexOf(BRACKETED_PASTE_END) === -1) {
			this.#pasteChunks.push(chunk);
			this.#pasteBytes += chunk.length;
			const keep = BRACKETED_PASTE_END.length - 1;
			this.#pasteOverlap = probe.length > keep ? probe.slice(probe.length - keep) : probe;
			if (this.#pasteBytes > this.#pasteByteLimit) {
				this.#abortPaste();
				return;
			}
			this.#armPasteWatchdog();
			return;
		}

		// End marker arrived: join once and split at its first occurrence,
		// matching the prior indexOf-from-start semantics exactly.
		const flat = this.#pasteChunks.length > 0 ? `${this.#pasteChunks.join("")}${chunk}` : chunk;
		const endIndex = flat.indexOf(BRACKETED_PASTE_END);
		const pastedContent = flat.slice(0, endIndex);
		const remaining = flat.slice(endIndex + BRACKETED_PASTE_END.length);

		this.#clearPasteWatchdog();
		this.#pasteMode = false;
		this.#pasteChunks = [];
		this.#pasteOverlap = "";
		this.#pasteBytes = 0;
		this.#pendingKittyPrintableCodepoint = undefined;

		this.emit("paste", pastedContent);

		if (remaining.length > 0) {
			this.process(remaining);
		}
	}

	/** Re-arm the paste-mode inactivity watchdog after each chunk. */
	#armPasteWatchdog(): void {
		if (this.#pasteWatchdog) clearTimeout(this.#pasteWatchdog);
		this.#pasteWatchdog = setTimeout(() => {
			this.#pasteWatchdog = undefined;
			this.#abortPaste();
		}, this.#pasteTimeoutMs);
	}

	#clearPasteWatchdog(): void {
		if (this.#pasteWatchdog) {
			clearTimeout(this.#pasteWatchdog);
			this.#pasteWatchdog = undefined;
		}
	}

	/**
	 * Recover from a paste whose end marker never arrived (dropped or corrupted
	 * in transit, or past the byte cap): exit paste mode and deliver the
	 * accumulated bytes as a paste, so they are neither lost, replayed as
	 * keystrokes, nor accumulated forever while input appears dead.
	 */
	#abortPaste(): void {
		this.#clearPasteWatchdog();
		const content = this.#pasteChunks.join("");
		this.#pasteMode = false;
		this.#pasteChunks = [];
		this.#pasteOverlap = "";
		this.#pasteBytes = 0;
		this.emit("paste", content);
	}

	#emitDataSequence(sequence: string): void {
		const rawCodepoint = sequence.length === 1 ? sequence.codePointAt(0) : undefined;
		if (
			rawCodepoint !== undefined &&
			rawCodepoint === this.#pendingKittyPrintableCodepoint &&
			Date.now() - this.#pendingKittyPrintableAtMs <= KITTY_PRINTABLE_DEDUP_WINDOW_MS
		) {
			this.#pendingKittyPrintableCodepoint = undefined;
			return;
		}

		this.#pendingKittyPrintableCodepoint = parseUnmodifiedKittyPrintableCodepoint(sequence);
		if (this.#pendingKittyPrintableCodepoint !== undefined) {
			this.#pendingKittyPrintableAtMs = Date.now();
		}
		this.emit("data", sequence);
	}

	/**
	 * setTimeout(0): when the event loop stalls past the timeout (heavy render)
	 * while the tail of a split escape is already queued on stdin, expired
	 * timers run before the poll phase that delivers the tail — flushing
	 * straight from the timer would tear the sequence apart and leak the tail
	 * as typed text. The zero-delay deferral runs on the next timers pass,
	 * after poll has had a chance to deliver the pending chunk to process()
	 * and cancel the deferral.
	 */
	#armFlushTimer(): void {
		this.#timeout = setTimeout(() => {
			this.#timeout = undefined;
			this.#flushDeferral = setTimeout(() => {
				this.#flushDeferral = undefined;
				this.#flushExpired();
			});
		}, this.#timeoutMs);
	}

	#clearFlushTimer(): void {
		if (this.#timeout) {
			clearTimeout(this.#timeout);
			this.#timeout = undefined;
		}
		if (this.#flushDeferral) {
			clearTimeout(this.#flushDeferral);
			this.#flushDeferral = undefined;
		}
	}

	/**
	 * A deferred flush means the current buffer already waited for the
	 * incomplete-sequence timeout. If the next chunk starts a fresh escape, do
	 * not merge it into the stale partial. Keep ESC-backslash as a continuation
	 * for OSC/DCS/APC string terminators (`ST`).
	 */
	#isFreshEscapeAfterDeferredFlush(str: string): boolean {
		if (!str.startsWith(ESC) || this.#buffer.length === 0) return false;
		if (
			str.startsWith(`${ESC}\\`) &&
			(this.#buffer.startsWith(`${ESC}]`) ||
				this.#buffer.startsWith(`${ESC}P`) ||
				this.#buffer.startsWith(`${ESC}_`))
		) {
			return false;
		}
		return true;
	}

	/**
	 * Whether the dangling partial cannot be a finished keypress and is worth
	 * holding for its tail instead of flushing:
	 * - SGR mouse prefixes (`\x1b[<…`) — no keyboard sequence uses them.
	 * - Any partial while the kitty keyboard protocol is active — the ESC key
	 *   arrives as `\x1b[27u` and alt-chords as CSI-u, so a bare `\x1b` (or
	 *   any unterminated escape) is always a split sequence, never a key.
	 */
	#shouldHoldPartial(): boolean {
		return SGR_MOUSE_PARTIAL.test(this.#buffer) || isKittyProtocolActive();
	}

	/** Timeout-driven flush: hold unambiguous partials (bounded), else deliver. */
	#flushExpired(): void {
		if (this.#buffer.length === 0) {
			this.#partialHoldStartMs = 0;
			return;
		}
		if (this.#shouldHoldPartial()) {
			if (this.#partialHoldStartMs === 0) this.#partialHoldStartMs = Date.now();
			if (Date.now() - this.#partialHoldStartMs < this.#partialHoldMaxMs) {
				this.#armFlushTimer();
				return;
			}
		}
		this.#partialHoldStartMs = 0;
		for (const sequence of this.flush()) {
			this.#emitDataSequence(sequence);
		}
	}

	flush(): string[] {
		this.#clearFlushTimer();

		if (this.#buffer.length === 0) {
			return [];
		}

		const buffered = this.#buffer;
		this.#buffer = "";
		this.#pendingKittyPrintableCodepoint = undefined;
		// Bare double-ESC remainder (no disambiguating "[" / "O" arrived in time):
		// two real Esc keypresses bursted by terminal batching, not a meta-CSI/SS3
		// prefix. `parseKey` returns undefined for the combined chunk, so a single
		// emission swallows the double-escape gesture (#3857). Mirror the inline
		// split in `extractCompleteSequences` and deliver two ESC events.
		if (buffered === `${ESC}${ESC}`) {
			return [ESC, ESC];
		}
		return [buffered];
	}

	clear(): void {
		this.#clearFlushTimer();
		this.#clearPasteWatchdog();
		this.#buffer = "";
		this.#pasteMode = false;
		this.#pasteChunks = [];
		this.#pasteOverlap = "";
		this.#pasteBytes = 0;
		this.#pendingKittyPrintableCodepoint = undefined;
		this.#partialHoldStartMs = 0;
	}

	getBuffer(): string {
		return this.#buffer;
	}

	destroy(): void {
		this.clear();
	}
}

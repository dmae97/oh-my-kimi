import { dlopen, FFIType, ptr } from "bun:ffi";
import * as fs from "node:fs";
import { $env, isBunTestRuntime, logger } from "@oh-my-pi/pi-utils";
import { setKittyProtocolActive } from "./keys";
import { encodeKittyTempFileProbe, getKittyGraphics, kittyTempFileAllowed, setKittyGraphics } from "./kitty-graphics";
import { StdinBuffer } from "./stdin-buffer";
import { ImageProtocol, NotifyProtocol, setCellDimensions, setOsc99Supported, TERMINAL } from "./terminal-capabilities";

const TERMINAL_PROGRESS_KEEPALIVE_MS = 1000;
const TERMINAL_PROGRESS_ACTIVE_SEQUENCE = "\x1b]9;4;3\x07";
const TERMINAL_PROGRESS_CLEAR_SEQUENCE = "\x1b]9;4;0;\x07";

/**
 * Minimal terminal interface for TUI
 */

// Track active terminal for emergency cleanup on crash
let activeTerminal: ProcessTerminal | null = null;
// Track if a terminal was ever started (for emergency restore logic)
let terminalEverStarted = false;

const STD_INPUT_HANDLE = -10;
const ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200;
/**
 * Emergency terminal restore - call this from signal/crash handlers
 * Resets terminal state without requiring access to the ProcessTerminal instance
 */
export function emergencyTerminalRestore(): void {
	try {
		const terminal = activeTerminal;
		if (terminal) {
			terminal.stop();
			terminal.showCursor();
		} else if (terminalEverStarted) {
			// Blind restore only if we know a terminal was started but lost track of it
			// This avoids writing escape sequences for non-TUI commands (grep, commit, etc.)
			process.stdout.write(
				"\x1b[?2004l" + // Disable bracketed paste
					"\x1b[?2031l" + // Disable Mode 2031 appearance notifications
					"\x1b[?2048l" + // Disable in-band resize notifications
					"\x1b[<u" + // Pop kitty keyboard protocol
					"\x1b[>4;0m" + // Disable modifyOtherKeys fallback
					"\x1b[?25h", // Show cursor
			);
			if (process.stdin.setRawMode) {
				process.stdin.setRawMode(false);
			}
		}
	} catch {
		// Terminal may already be dead during crash cleanup - ignore errors
	}
}
/** Terminal-reported appearance (dark/light mode). */
export type TerminalAppearance = "dark" | "light";
export interface Terminal {
	// Start the terminal with input and resize handlers
	start(onInput: (data: string) => void, onResize: () => void): void;

	// Stop the terminal and restore state
	stop(): void;

	/**
	 * Drain stdin before exiting to prevent Kitty key release events from
	 * leaking to the parent shell over slow SSH connections.
	 * @param maxMs - Maximum time to drain (default: 1000ms)
	 * @param idleMs - Exit early if no input arrives within this time (default: 50ms)
	 */
	drainInput(maxMs?: number, idleMs?: number): Promise<void>;

	// Write output to terminal
	write(data: string): void;

	// Get terminal dimensions
	get columns(): number;
	get rows(): number;

	// Whether Kitty keyboard protocol is active
	get kittyProtocolActive(): boolean;

	// Cursor positioning (relative to current position)
	moveBy(lines: number): void; // Move cursor up (negative) or down (positive) by N lines

	// Cursor visibility
	hideCursor(): void; // Hide the cursor
	showCursor(): void; // Show the cursor

	// Clear operations
	clearLine(): void; // Clear current line
	clearFromCursor(): void; // Clear from cursor to end of screen
	clearScreen(): void; // Clear entire screen and move cursor to (0,0)

	// Title operations
	setTitle(title: string): void; // Set terminal window title

	// Progress indicator (OSC 9;4)
	setProgress(active: boolean): void;

	/**
	 * Returns whether the native terminal viewport is at the scrollback tail when
	 * the host exposes that state. `undefined` means the terminal cannot report it.
	 *
	 * `ProcessTerminal` deliberately does not implement this — no real terminal
	 * can answer it truthfully:
	 *
	 * - POSIX terminals expose no scrollback-position API at all.
	 * - Every modern Windows terminal host (Windows Terminal, VS Code, Tabby,
	 *   Hyper, Alacritty, WezTerm, JetBrains, …) fronts console apps through
	 *   ConPTY, where kernel32's `GetConsoleScreenBufferInfo` describes the
	 *   pseudo-console buffer. That buffer is pinned to the visible grid —
	 *   scrollback lives in the host UI, invisible to console APIs
	 *   (microsoft/terminal#10191) — so a probe reads "at bottom" no matter
	 *   where the user scrolled. Trusting it let streaming-time rebuilds emit
	 *   `\x1b[3J` and yank scrolled readers: #1635 (Windows Terminal), #1746
	 *   (Tabby and other ConPTY hosts). No env var distinguishes these hosts
	 *   (Tabby sets none), so trust cannot be conditional on the environment.
	 * - Legacy conhost (the only non-ConPTY host) keeps a real scrollback
	 *   buffer, but its window follows the output cursor: a probe comparing
	 *   `srWindow.Bottom` against `dwSize.Y - 1` reads "scrolled up" for a user
	 *   following live output until all ~9001 buffer rows fill, permanently
	 *   blocking checkpoint scrollback reconciliation.
	 *
	 * The renderer treats a missing implementation / `undefined` as "unknown":
	 * live mutations defer destructive rebuilds and reconcile native scrollback
	 * at explicit checkpoints (prompt submit), where the user's keystroke has
	 * already pinned the host viewport to the bottom. Only test terminals
	 * (xterm.js-backed) implement this with a real answer.
	 */
	isNativeViewportAtBottom?(): boolean | undefined;

	/**
	 * Register a callback for terminal appearance (dark/light) changes.
	 * Detection uses OSC 11 background color query with Mode 2031 as a change trigger.
	 * Fires when the detected appearance changes, including the initial detection.
	 */
	onAppearanceChange(callback: (appearance: TerminalAppearance) => void): void;
	/** The last detected terminal appearance, or undefined if not yet known. */
	get appearance(): TerminalAppearance | undefined;
	/**
	 * Register a callback fired once per DEC private mode when its DECRQM support
	 * status resolves. Optional: only real terminals implement capability probing.
	 */
	onPrivateModeReport?(callback: (mode: number, supported: boolean) => void): void;
}

function isWindowsSubsystemForLinux(): boolean {
	return process.platform === "linux" && (!!$env.WSL_DISTRO_NAME || !!$env.WSL_INTEROP);
}

/** Discriminated owner of an outstanding DA1 sentinel in the unified probe FIFO. */
type Da1SentinelOwner =
	| { kind: "keyboard" }
	| { kind: "osc11" }
	| { kind: "privateMode"; mode: number }
	| { kind: "kittyGraphicsProbe"; id: number }
	| { kind: "osc99Probe"; id: string };

let nextOsc99ProbeId = 1;
let nextKittyGraphicsProbeId = 1;

function parseOsc99KeyValues(section: string): Map<string, string> {
	const values = new Map<string, string>();
	for (const part of section.split(":")) {
		const eq = part.indexOf("=");
		if (eq !== 1) continue;
		values.set(part.slice(0, eq), part.slice(eq + 1));
	}
	return values;
}
/**
 * Real terminal using process.stdin/stdout
 */
export class ProcessTerminal implements Terminal {
	#wasRaw = false;
	#inputHandler?: (data: string) => void;
	#resizeHandler?: () => void;
	#kittyProtocolActive = false;
	#modifyOtherKeysActive = false;
	#modifyOtherKeysTimeout?: Timer;
	#stdinBuffer?: StdinBuffer;
	#stdinDataHandler?: (data: string) => void;
	#dead = false;
	#writeLogPath = $env.PI_TUI_WRITE_LOG || "";
	#windowsVTInputRestore?: () => void;
	#appearanceCallbacks: Array<(appearance: TerminalAppearance) => void> = [];
	#appearance: TerminalAppearance | undefined;
	#osc11Pending = false;
	#osc11QueryQueued = false;
	#osc11ResponseBuffer = "";
	#osc99PendingId: string | undefined;
	#osc99ResponseBuffer = "";
	#osc99Capabilities = new Map<string, string>();
	#kittyGraphicsPendingId: number | undefined;
	#kittyGraphicsProbeCleanup: (() => void) | undefined;
	#privateCsiResponseBuffer = "";
	#da1SentinelOwners: Da1SentinelOwner[] = [];
	/** Resolved DECRQM support per private mode (mode → supported). */
	#privateModeSupport = new Map<number, boolean>();
	#privateModeCallbacks: Array<(mode: number, supported: boolean) => void> = [];
	/** Whether DEC 2048 in-band resize notifications are currently enabled. */
	#inBandResizeActive = false;
	#reportedColumns?: number;
	#reportedRows?: number;
	#osc11PollTimer?: Timer;
	#mode2031DebounceTimer?: Timer;
	#progressTimer?: ReturnType<typeof setInterval>;

	get kittyProtocolActive(): boolean {
		return this.#kittyProtocolActive;
	}

	get appearance(): TerminalAppearance | undefined {
		return this.#appearance;
	}

	onAppearanceChange(callback: (appearance: TerminalAppearance) => void): void {
		this.#appearanceCallbacks.push(callback);
	}

	onPrivateModeReport(callback: (mode: number, supported: boolean) => void): void {
		this.#privateModeCallbacks.push(callback);
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.#inputHandler = onInput;
		this.#resizeHandler = onResize;

		// Register for emergency cleanup
		activeTerminal = this;
		terminalEverStarted = true;

		// Save previous state and enable raw mode
		this.#wasRaw = process.stdin.isRaw || false;
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(true);
		}
		process.stdin.setEncoding("utf8");
		process.stdin.resume();

		// Enable bracketed paste mode - terminal will wrap pastes in \x1b[200~ ... \x1b[201~
		this.#safeWrite("\x1b[?2004h");

		// Set up resize handler immediately
		process.stdout.on("resize", this.#resizeHandler);

		// Refresh terminal dimensions - they may be stale after suspend/resume
		// (SIGWINCH is lost while process is stopped). Unix only.
		if (process.platform !== "win32") {
			process.kill(process.pid, "SIGWINCH");
		}

		// On Windows, enable ENABLE_VIRTUAL_TERMINAL_INPUT so the console sends
		// VT escape sequences (e.g. \x1b[Z for Shift+Tab) instead of raw console
		// events that lose modifier information. Must run after setRawMode(true)
		// since that resets console mode flags.
		this.#enableWindowsVTInput();
		// Query and enable Kitty keyboard protocol
		// The query handler intercepts input temporarily, then installs the user's handler
		// See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
		this.#queryAndEnableKittyProtocol();

		// Query terminal background color via OSC 11 for dark/light detection.
		// Uses DA1 (Primary Device Attributes) as a sentinel: terminals process
		// sequences in order, so if DA1 arrives before OSC 11 response,
		// the terminal does not support OSC 11. This avoids indefinite hangs.
		// Technique used by Neovim, bat, fish, and terminal-colorsaurus.
		this.#queryBackgroundColor();

		// Query OSC 99 notification capabilities for Kitty. The query uses the
		// same DA1 sentinel FIFO as OSC 11/DECRQM so unsupported terminals resolve
		// without leaking probe bytes to application input.
		this.#queryOsc99Support();

		// Probe Kitty temp-file (`t=t`) graphics transmission support. Rides the
		// same DA1 sentinel FIFO; promotes the transmission medium to temp-file
		// only on an explicit `OK`, so unsupported terminals stay on direct base64.
		this.#queryKittyGraphicsTempFile();

		// Subscribe to Mode 2031 appearance change notifications.
		// When the terminal reports a change, we re-query OSC 11 to get the
		// actual background color (following Neovim convention) with 100ms debounce.
		this.#safeWrite("\x1b[?2031h");

		// Start periodic OSC 11 re-query for terminals without Mode 2031
		// (Warp, Alacritty, WezTerm, iTerm2). Self-disables once Mode 2031 fires.
		// Windows Terminal under WSL has been observed to close the hosting tab
		// after repeated OSC 11/DA1 probes. Keep the initial/event-driven probes,
		// but avoid background polling there.
		if (!isWindowsSubsystemForLinux()) {
			this.#startOsc11Poll();
		}

		// Probe DEC private-mode support via DECRQM. 2026 (synchronized output)
		// gates the renderer's begin/end markers; 2048 (in-band resize) is enabled
		// only after the terminal confirms support. Each probe rides the shared DA1
		// sentinel FIFO, so a terminal that ignores DECRQM still resolves (as
		// unsupported) when the DA1 reply arrives.
		this.#queryPrivateMode(2026);
		this.#queryPrivateMode(2048);
	}

	/**
	 * On Windows, add ENABLE_VIRTUAL_TERMINAL_INPUT to the stdin console mode
	 * so modified keys (for example Shift+Tab) arrive as VT escape sequences.
	 */
	#enableWindowsVTInput(): void {
		if (process.platform !== "win32") return;
		this.#restoreWindowsVTInput();
		try {
			const kernel32 = dlopen("kernel32.dll", {
				GetStdHandle: { args: [FFIType.i32], returns: FFIType.ptr },
				GetConsoleMode: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
				SetConsoleMode: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.bool },
			});
			const handle = kernel32.symbols.GetStdHandle(STD_INPUT_HANDLE);
			const mode = new Uint32Array(1);
			const modePtr = ptr(mode);
			if (!modePtr || !kernel32.symbols.GetConsoleMode(handle, modePtr)) {
				kernel32.close();
				return;
			}
			const originalMode = mode[0]!;
			const vtMode = originalMode | ENABLE_VIRTUAL_TERMINAL_INPUT;
			if (vtMode !== originalMode && !kernel32.symbols.SetConsoleMode(handle, vtMode)) {
				kernel32.close();
				return;
			}
			this.#windowsVTInputRestore = () => {
				try {
					kernel32.symbols.SetConsoleMode(handle, originalMode);
				} finally {
					kernel32.close();
				}
			};
		} catch {
			// bun:ffi unavailable or console API unsupported; keep startup non-fatal.
		}
	}

	#restoreWindowsVTInput(): void {
		if (process.platform !== "win32") return;
		const restore = this.#windowsVTInputRestore;
		this.#windowsVTInputRestore = undefined;
		if (!restore) return;
		try {
			restore();
		} catch {
			// Ignore restore errors during terminal teardown.
		}
	}

	/**
	 * Set up StdinBuffer to split batched input into individual sequences.
	 * This ensures components receive single events, making matchesKey/isKeyRelease work correctly.
	 *
	 * Also watches for Kitty protocol response and enables it when detected.
	 * This is done here (after stdinBuffer parsing) rather than on raw stdin
	 * to handle the case where the response arrives split across multiple events.
	 */
	#setupStdinBuffer(): void {
		this.#stdinBuffer = new StdinBuffer({ timeout: 10 });

		// Kitty protocol response pattern: \x1b[?<flags>u
		const kittyResponsePattern = /^\x1b\[\?(\d+)u$/;

		// Mode 2031 DSR response: \x1b[?997;{1=dark,2=light}n
		const appearanceDsrPattern = /^\x1b\[\?997;([12])n$/;

		// OSC 11 response: \x1b]11;rgb:RR/GG/BB or rgba:RR/GG/BB, terminated by BEL or ST.
		const osc11ResponsePattern =
			/^\x1b\]11;rgba?:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})(?:\x07|\x1b\\)$/;

		// DA1 (Primary Device Attributes) response: \x1b[?...c
		const da1ResponsePattern = /^\x1b\[\?[\d;]*c$/;

		// Private CSI partial: \x1b[?<digits/semicolons>... — incomplete probe response
		// that the StdinBuffer flushed before the terminator arrived (split across
		// stdin reads). Used to reassemble DA1, kitty, and Mode 2031 replies.
		const privateCsiPartialPattern = /^\x1b\[\?[\d;]*[\x20-\x2f]*$/;

		// DECRPM private-mode report (DECRQM reply): \x1b[?<mode>;<status>$y
		const decrpmResponsePattern = /^\x1b\[\?(\d+);(\d+)\$y$/;

		// In-band resize report (DEC mode 2048): \x1b[48;rows;cols;yPixels;xPixels t
		const inBandResizePattern = /^\x1b\[48;(\d+);(\d+);(\d+);(\d+)t$/;

		// Forward individual sequences to the input handler
		this.#stdinBuffer.on("data", (sequence: string) => {
			// Reassemble split private CSI responses (DA1, kitty keyboard, Mode 2031).
			// When the terminal writes the response slowly enough that the StdinBuffer's
			// flush timeout elapses mid-sequence, the prefix `\x1b[?<digits>` arrives as
			// one event and the tail `;...<terminator>` arrives as individual character
			// events that would otherwise leak into the prompt as keystrokes. See #1238.
			if (
				this.#privateCsiResponseBuffer ||
				(privateCsiPartialPattern.test(sequence) && this.#da1SentinelOwners.length > 0)
			) {
				if (this.#privateCsiResponseBuffer && sequence.startsWith("\x1b")) {
					// New escape arrived mid-reassembly — abandon partial and re-process the new sequence.
					this.#privateCsiResponseBuffer = "";
				} else {
					this.#privateCsiResponseBuffer += sequence;
					// Cap accumulator to defend against runaway partials if the terminator never arrives.
					if (this.#privateCsiResponseBuffer.length > 256) {
						this.#privateCsiResponseBuffer = "";
						return;
					}
					const lastChar = this.#privateCsiResponseBuffer.at(-1)!;
					const lastCode = lastChar.charCodeAt(0);
					if (lastCode >= 0x40 && lastCode <= 0x7e) {
						// Terminator byte arrived. Fall through to the pattern checks with the
						// reassembled sequence so the existing DA1/kitty/Mode 2031 handlers run.
						sequence = this.#privateCsiResponseBuffer;
						this.#privateCsiResponseBuffer = "";
					} else if (!privateCsiPartialPattern.test(this.#privateCsiResponseBuffer)) {
						// Diverged from a valid private CSI prefix (unexpected byte). Drop the
						// probe noise we ate; do not forward to the input handler.
						this.#privateCsiResponseBuffer = "";
						return;
					} else {
						// Still accumulating.
						return;
					}
				}
			}

			// In-band resize report (DEC mode 2048). Unsolicited and not tied to a
			// sentinel: update reported geometry + cell size, then drive the resize
			// handler so the renderer reflows.
			const resizeMatch = sequence.match(inBandResizePattern);
			if (resizeMatch) {
				this.#handleInBandResizeReport(resizeMatch[1]!, resizeMatch[2]!, resizeMatch[3]!, resizeMatch[4]!);
				return;
			}

			// DECRPM private-mode report. Resolves the matching probe by mode; the
			// owner stays in the FIFO and is drained by its DA1 sentinel (a no-op
			// once resolved). Per DECRPM, status 0 = unrecognized, 1/2 =
			// set/reset, 3 = permanently set, and 4 = permanently reset. Only
			// settable or permanently-set modes are useful for features we enable.
			const decrpmMatch = sequence.match(decrpmResponsePattern);
			if (decrpmMatch) {
				this.#resolvePrivateMode(parseInt(decrpmMatch[1]!, 10), decrpmMatch[2] !== "0" && decrpmMatch[2] !== "4");
				return;
			}

			// DA1 response: swallow our sentinel reply regardless of whether an
			// earlier capability-specific response already succeeded. Other terminal
			// probes should never see these replies.
			if (da1ResponsePattern.test(sequence) && this.#da1SentinelOwners.length > 0) {
				const owner = this.#da1SentinelOwners.shift()!;
				switch (owner.kind) {
					case "osc11": {
						if (this.#osc11Pending) {
							// DA1 arrived before the OSC 11 reply: terminal does not support OSC 11.
							this.#osc11Pending = false;
							this.#osc11ResponseBuffer = "";
						}
						// Start a queued OSC 11 query once the prior cycle is fully drained.
						if (
							this.#osc11QueryQueued &&
							!this.#osc11Pending &&
							!this.#da1SentinelOwners.some(o => o.kind === "osc11") &&
							!this.#dead
						) {
							this.#osc11QueryQueued = false;
							this.#startOsc11Query();
						}
						break;
					}
					case "privateMode": {
						// DA1 beat the DECRPM reply for this mode → treat as unsupported.
						this.#resolvePrivateMode(owner.mode, false);
						break;
					}
					case "keyboard": {
						// Keyboard probe sentinel: kitty reply never arrived → fall back to modifyOtherKeys.
						if (!this.#kittyProtocolActive && !this.#modifyOtherKeysActive && this.#modifyOtherKeysTimeout) {
							clearTimeout(this.#modifyOtherKeysTimeout);
							this.#modifyOtherKeysTimeout = undefined;
							this.#safeWrite("\x1b[>4;2m");
							this.#modifyOtherKeysActive = true;
						}
						break;
					}
					case "osc99Probe": {
						this.#resolveOsc99Support(owner.id, false);
						break;
					}
					case "kittyGraphicsProbe":
						this.#resolveKittyGraphicsTempFile(owner.id, false);
						break;
				}
				return;
			}

			const match = sequence.match(kittyResponsePattern);
			if (match && !this.#modifyOtherKeysActive) {
				if (this.#modifyOtherKeysTimeout) {
					clearTimeout(this.#modifyOtherKeysTimeout);
					this.#modifyOtherKeysTimeout = undefined;
				}
				// Any reply to `\x1b[?u` means the terminal speaks the kitty keyboard
				// protocol. The reported flag value is the *current* stack-top — fresh
				// terminals report 0 — so support is implied by the reply itself, not by
				// the flag value. Pick the level we want; `\x1b[>Nu` pushes one frame
				// that shutdown's single `\x1b[<u` pop balances.
				const reportedFlags = parseInt(match[1]!, 10);
				this.#kittyProtocolActive = true;
				setKittyProtocolActive(true);
				if (reportedFlags >= 3) {
					// Already enriched (Ghostty/foot may keep flags from a parent app).
					// Push level-2 to lock in event reporting.
					this.#safeWrite("\x1b[>7u");
				} else {
					// Level 1 (disambiguate escape codes) — enough for Shift+Enter
					// without the modifyOtherKeys fallback that caused regression #3259.
					this.#safeWrite("\x1b[>1u");
				}
				return;
			}

			// OSC 11 replies can be split if the stdin buffer flushes a partial sequence.
			// Accumulate fragments until the BEL/ST terminator arrives, then parse once.
			// If a new escape sequence arrives (not the ST terminator), abort buffering
			// and forward it as normal input so user keystrokes are never swallowed.
			if (this.#osc11Pending && (this.#osc11ResponseBuffer || sequence.startsWith("\x1b]11;"))) {
				if (this.#osc11ResponseBuffer && sequence.startsWith("\x1b") && sequence !== "\x1b\\") {
					// New escape sequence arrived mid-buffer — not an OSC 11 continuation.
					this.#osc11ResponseBuffer = "";
					// Fall through to normal input handling below.
				} else {
					this.#osc11ResponseBuffer += sequence;
					const osc11Match = this.#osc11ResponseBuffer.match(osc11ResponsePattern);
					if (!osc11Match) return;
					const [, rHex, gHex, bHex] = osc11Match;
					this.#osc11Pending = false;
					this.#osc11ResponseBuffer = "";
					this.#handleOsc11Response(rHex!, gHex!, bHex!);
					return;
				}
			}

			if (this.#osc99PendingId && (this.#osc99ResponseBuffer || sequence.startsWith("\x1b]99;"))) {
				if (this.#osc99ResponseBuffer && sequence.startsWith("\x1b") && sequence !== "\x1b\\") {
					this.#osc99ResponseBuffer = "";
				} else {
					this.#osc99ResponseBuffer += sequence;
					const osc99Match = this.#osc99ResponseBuffer.match(/^\x1b\]99;([^;]*);([\s\S]*?)(?:\x07|\x1b\\)$/u);
					if (!osc99Match) return;
					const [, meta, payload] = osc99Match;
					this.#osc99ResponseBuffer = "";
					this.#handleOsc99CapabilityResponse(meta!, payload!);
					return;
				}
			}

			// Kitty graphics temp-file probe reply: ESC _ G i=<id>;OK ESC \. The
			// owner remains in the FIFO and is drained by its DA1 sentinel (no-op
			// once resolved here).
			if (this.#kittyGraphicsPendingId !== undefined && sequence.startsWith("\x1b_G")) {
				const graphicsMatch = sequence.match(/^\x1b_G([^;]*);([\s\S]*?)\x1b\\$/u);
				if (graphicsMatch) {
					const idMatch = graphicsMatch[1]!.match(/(?:^|,)i=(\d+)(?:,|$)/);
					const replyId = idMatch ? parseInt(idMatch[1]!, 10) : undefined;
					if (replyId === this.#kittyGraphicsPendingId) {
						this.#resolveKittyGraphicsTempFile(replyId, graphicsMatch[2]!.trim() === "OK");
						return;
					}
				}
			}

			// Mode 2031 change notification: re-query OSC 11 with 100ms debounce
			// (Neovim convention — coalesces rapid notifications during transitions)
			const appearanceMatch = sequence.match(appearanceDsrPattern);
			if (appearanceMatch) {
				this.#stopOsc11Poll();
				if (this.#mode2031DebounceTimer) clearTimeout(this.#mode2031DebounceTimer);
				this.#mode2031DebounceTimer = setTimeout(() => {
					this.#mode2031DebounceTimer = undefined;
					this.#queryBackgroundColor();
				}, 100);
				return;
			}
			if (this.#inputHandler) {
				this.#inputHandler(sequence);
			}
		});

		// Re-wrap paste content with bracketed paste markers for existing editor handling
		this.#stdinBuffer.on("paste", (content: string) => {
			if (this.#inputHandler) {
				this.#inputHandler(`\x1b[200~${content}\x1b[201~`);
			}
		});

		// Handler that pipes stdin data through the buffer
		this.#stdinDataHandler = (data: string) => {
			this.#stdinBuffer!.process(data);
		};
	}

	/**
	 * Send OSC 11 background color query followed by DA1 sentinel.
	 * DA1 avoids indefinite hangs: if DA1 response arrives before OSC 11,
	 * the terminal does not support OSC 11.
	 */
	#queryBackgroundColor(): void {
		if (this.#dead) return;
		// Queue if an OSC 11 query is in flight or its DA1 sentinel hasn't been
		// consumed yet. Starting a new query while a DA1 is outstanding would
		// increment the sentinel counter, and the old DA1 arrival would then
		// prematurely clear the new query's pending state.
		if (this.#osc11Pending || this.#da1SentinelOwners.some(o => o.kind === "osc11")) {
			this.#osc11QueryQueued = true;
			return;
		}
		this.#startOsc11Query();
	}

	#startOsc11Query(): void {
		this.#osc11Pending = true;
		this.#osc11ResponseBuffer = "";
		this.#da1SentinelOwners.push({ kind: "osc11" });
		this.#safeWrite("\x1b]11;?\x07"); // OSC 11 query (BEL terminated)
		this.#safeWrite("\x1b[c"); // DA1 sentinel
	}

	#shouldQueryOsc99Support(): boolean {
		if (TERMINAL.notifyProtocol !== NotifyProtocol.Osc99) return false;
		return !isBunTestRuntime() || $env.PI_TUI_OSC99_PROBE === "1";
	}

	#queryOsc99Support(): void {
		setOsc99Supported(false);
		this.#osc99Capabilities.clear();
		this.#osc99PendingId = undefined;
		this.#osc99ResponseBuffer = "";
		if (this.#dead || !this.#shouldQueryOsc99Support()) return;

		const id = `omp-probe-${nextOsc99ProbeId++}`;
		this.#osc99PendingId = id;
		this.#da1SentinelOwners.push({ kind: "osc99Probe", id });
		this.#safeWrite(`\x1b]99;i=${id}:p=?;\x1b\\\x1b[c`);
	}

	#handleOsc99CapabilityResponse(metaRaw: string, payload: string): boolean {
		const pendingId = this.#osc99PendingId;
		if (!pendingId) return false;
		const meta = parseOsc99KeyValues(metaRaw);
		if (meta.get("i") !== pendingId || meta.get("p") !== "?") return false;

		const capabilities = parseOsc99KeyValues(payload);
		this.#osc99Capabilities = capabilities;
		const payloadTypes = capabilities.get("p")?.split(",") ?? [];
		this.#resolveOsc99Support(pendingId, payloadTypes.includes("title"));
		return true;
	}

	#resolveOsc99Support(id: string, supported: boolean): void {
		if (this.#osc99PendingId !== id) return;
		this.#osc99PendingId = undefined;
		this.#osc99ResponseBuffer = "";
		if (!supported) this.#osc99Capabilities.clear();
		setOsc99Supported(supported);
	}

	#shouldQueryKittyGraphicsTempFile(): boolean {
		if (TERMINAL.imageProtocol !== ImageProtocol.Kitty) return false;
		// Honor the remote/explicit env gate, and skip when temp-file is already on.
		if (!kittyTempFileAllowed() || getKittyGraphics().transmissionMedium === "temp-file") return false;
		return !isBunTestRuntime() || $env.PI_TUI_KITTY_GRAPHICS_PROBE === "1";
	}

	#queryKittyGraphicsTempFile(): void {
		this.#clearKittyGraphicsProbe();
		if (this.#dead || !this.#shouldQueryKittyGraphicsTempFile()) return;

		const id = nextKittyGraphicsProbeId++;
		const probe = encodeKittyTempFileProbe(id);
		if (!probe) return;
		this.#kittyGraphicsPendingId = id;
		this.#kittyGraphicsProbeCleanup = probe.cleanup;
		this.#da1SentinelOwners.push({ kind: "kittyGraphicsProbe", id });
		this.#safeWrite(`${probe.sequence}\x1b[c`);
	}

	#resolveKittyGraphicsTempFile(id: number, supported: boolean): void {
		if (this.#kittyGraphicsPendingId !== id) return;
		if (supported) setKittyGraphics({ transmissionMedium: "temp-file" });
		this.#clearKittyGraphicsProbe();
	}

	#clearKittyGraphicsProbe(): void {
		this.#kittyGraphicsPendingId = undefined;
		this.#kittyGraphicsProbeCleanup?.();
		this.#kittyGraphicsProbeCleanup = undefined;
	}
	/**
	 * Parse an OSC 11 background color response and compute BT.601 luminance.
	 * Handles 1-, 2-, 3-, and 4-digit XParseColor hex components.
	 */
	#handleOsc11Response(rHex: string, gHex: string, bHex: string): void {
		const normalize = (hex: string): number => {
			const value = parseInt(hex, 16);
			if (Number.isNaN(value)) return 0;
			const max = 16 ** hex.length - 1;
			return max > 0 ? value / max : 0;
		};
		const luminance = 0.299 * normalize(rHex) + 0.587 * normalize(gHex) + 0.114 * normalize(bHex);
		const mode: TerminalAppearance = luminance < 0.5 ? "dark" : "light";
		if (mode === this.#appearance) return;
		this.#appearance = mode;
		for (const cb of this.#appearanceCallbacks) {
			try {
				cb(mode);
			} catch {
				/* ignore callback errors */
			}
		}
	}

	/**
	 * Start periodic OSC 11 re-queries for terminals without Mode 2031 (Warp, Alacritty, WezTerm).
	 * Self-disables once Mode 2031 fires (push-based is better than polling).
	 */
	#startOsc11Poll(): void {
		this.#stopOsc11Poll();
		this.#osc11PollTimer = setInterval(() => {
			if (this.#dead) {
				this.#stopOsc11Poll();
				return;
			}
			this.#queryBackgroundColor();
		}, 2_000);
		this.#osc11PollTimer.unref();
	}

	#stopOsc11Poll(): void {
		if (this.#osc11PollTimer) {
			clearInterval(this.#osc11PollTimer);
			this.#osc11PollTimer = undefined;
		}
	}

	/**
	 * Query terminal for Kitty keyboard protocol support and enable if available.
	 *
	 * Sends CSI ? u to query current flags. If terminal responds with CSI ? <flags> u,
	 * it supports the protocol and we enable it with CSI > 1 u.
	 *
	 * The response is detected in setupStdinBuffer's data handler, which properly
	 * handles the case where the response arrives split across multiple stdin events.
	 */
	#queryAndEnableKittyProtocol(): void {
		this.#setupStdinBuffer();
		process.stdin.on("data", this.#stdinDataHandler!);
		// Progressive enhancement query: CSI ?u asks the terminal for its current
		// kitty keyboard flags (no side effect on the stack); the DA1 sentinel
		// guarantees a reply even from terminals that ignore CSI ?u.
		this.#da1SentinelOwners.push({ kind: "keyboard" });
		this.#safeWrite("\x1b[?u\x1b[c");
		this.#modifyOtherKeysTimeout = setTimeout(() => {
			this.#modifyOtherKeysTimeout = undefined;
			if (this.#kittyProtocolActive || this.#modifyOtherKeysActive) {
				return;
			}
			this.#safeWrite("\x1b[>4;2m");
			this.#modifyOtherKeysActive = true;
		}, 150);
	}

	/**
	 * Probe a DEC private mode via DECRQM (`CSI ? mode $ p`) plus a DA1 sentinel.
	 * The sentinel guarantees resolution even from terminals that ignore DECRQM.
	 * Query and sentinel are fused into one write so the bare-`CSI c` sentinel
	 * accounting used elsewhere stays accurate.
	 */
	#queryPrivateMode(mode: number): void {
		if (this.#dead) return;
		if (this.#privateModeSupport.has(mode)) return;
		this.#da1SentinelOwners.push({ kind: "privateMode", mode });
		this.#safeWrite(`\x1b[?${mode}$p\x1b[c`);
	}

	/**
	 * Record DECRQM support for a private mode (idempotent — first result wins)
	 * and notify subscribers. Enables DEC 2048 in-band resize when 2048 resolves
	 * supported.
	 */
	#resolvePrivateMode(mode: number, supported: boolean): void {
		if (this.#privateModeSupport.has(mode)) return;
		this.#privateModeSupport.set(mode, supported);
		for (const cb of this.#privateModeCallbacks) {
			try {
				cb(mode, supported);
			} catch {
				// Ignore subscriber errors — capability reporting must not crash input.
			}
		}
		if (mode === 2048 && supported) this.#enableInBandResize();
	}

	/**
	 * Enable DEC 2048 in-band resize notifications. The terminal emits an initial
	 * report immediately, seeding reported geometry and cell dimensions.
	 */
	#enableInBandResize(): void {
		if (this.#inBandResizeActive || this.#dead) return;
		this.#inBandResizeActive = true;
		this.#safeWrite("\x1b[?2048h");
	}

	/**
	 * Apply an in-band resize report. Stores reported geometry so `rows`/`columns`
	 * reflect in-band values, derives cell pixel size, and drives the resize
	 * handler only when the report changes the effective row/column geometry.
	 */
	#handleInBandResizeReport(rowsRaw: string, colsRaw: string, yPixelsRaw: string, xPixelsRaw: string): void {
		const previousRows = this.rows;
		const previousColumns = this.columns;
		const rows = parseInt(rowsRaw, 10);
		const cols = parseInt(colsRaw, 10);
		const yPixels = parseInt(yPixelsRaw, 10);
		const xPixels = parseInt(xPixelsRaw, 10);
		if (rows > 0) this.#reportedRows = rows;
		if (cols > 0) this.#reportedColumns = cols;
		if (cols > 0 && xPixels > 0 && rows > 0 && yPixels > 0) {
			setCellDimensions({
				widthPx: Math.max(1, Math.round(xPixels / cols)),
				heightPx: Math.max(1, Math.round(yPixels / rows)),
			});
		}
		if (rows > 0 && cols > 0 && (rows !== previousRows || cols !== previousColumns)) {
			this.#resizeHandler?.();
		}
	}

	async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
		if (this.#kittyProtocolActive) {
			// Disable Kitty keyboard protocol first so any late key releases
			// do not generate new Kitty escape sequences.
			this.#safeWrite("\x1b[<u");
			this.#kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		if (this.#modifyOtherKeysTimeout) {
			clearTimeout(this.#modifyOtherKeysTimeout);
			this.#modifyOtherKeysTimeout = undefined;
		}
		if (this.#modifyOtherKeysActive) {
			this.#safeWrite("\x1b[>4;0m");
			this.#modifyOtherKeysActive = false;
		}

		const previousHandler = this.#inputHandler;
		this.#inputHandler = undefined;

		let lastDataTime = Date.now();
		const onData = () => {
			lastDataTime = Date.now();
		};

		process.stdin.on("data", onData);
		const endTime = Date.now() + maxMs;

		try {
			while (true) {
				const now = Date.now();
				const timeLeft = endTime - now;
				if (timeLeft <= 0) break;
				if (now - lastDataTime >= idleMs) break;
				await new Promise(resolve => setTimeout(resolve, Math.min(idleMs, timeLeft)));
			}
		} finally {
			process.stdin.removeListener("data", onData);
			this.#inputHandler = previousHandler;
		}
	}

	stop(): void {
		// Unregister from emergency cleanup
		if (activeTerminal === this) {
			activeTerminal = null;
		}

		if (this.#clearProgressTimer()) {
			this.#safeWrite(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}

		// Disable bracketed paste mode
		this.#safeWrite("\x1b[?2004l");

		// Disable Mode 2031 appearance change notifications
		this.#safeWrite("\x1b[?2031l");

		// Disable DEC 2048 in-band resize notifications if we enabled them.
		if (this.#inBandResizeActive) {
			this.#safeWrite("\x1b[?2048l");
			this.#inBandResizeActive = false;
		}
		this.#stopOsc11Poll();
		if (this.#mode2031DebounceTimer) {
			clearTimeout(this.#mode2031DebounceTimer);
			this.#mode2031DebounceTimer = undefined;
		}
		this.#appearanceCallbacks = [];
		this.#osc11Pending = false;
		this.#osc11QueryQueued = false;
		this.#osc11ResponseBuffer = "";
		this.#osc99PendingId = undefined;
		this.#osc99ResponseBuffer = "";
		this.#osc99Capabilities.clear();
		setOsc99Supported(false);
		this.#clearKittyGraphicsProbe();
		this.#privateCsiResponseBuffer = "";
		this.#da1SentinelOwners.length = 0;
		this.#privateModeCallbacks = [];
		this.#privateModeSupport.clear();
		this.#reportedColumns = undefined;
		this.#reportedRows = undefined;

		// Disable Kitty keyboard protocol if not already done by drainInput()
		if (this.#kittyProtocolActive) {
			this.#safeWrite("\x1b[<u");
			this.#kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		if (this.#modifyOtherKeysTimeout) {
			clearTimeout(this.#modifyOtherKeysTimeout);
			this.#modifyOtherKeysTimeout = undefined;
		}
		if (this.#modifyOtherKeysActive) {
			this.#safeWrite("\x1b[>4;0m");
			this.#modifyOtherKeysActive = false;
		}

		this.#restoreWindowsVTInput();
		// Clean up StdinBuffer
		if (this.#stdinBuffer) {
			this.#stdinBuffer.destroy();
			this.#stdinBuffer = undefined;
		}

		// Remove event handlers
		if (this.#stdinDataHandler) {
			process.stdin.removeListener("data", this.#stdinDataHandler);
			this.#stdinDataHandler = undefined;
		}
		this.#inputHandler = undefined;
		this.#appearance = undefined;
		if (this.#resizeHandler) {
			process.stdout.removeListener("resize", this.#resizeHandler);
			this.#resizeHandler = undefined;
		}

		// Pause stdin to prevent any buffered input (e.g., Ctrl+D) from being
		// re-interpreted after raw mode is disabled. This fixes a race condition
		// where Ctrl+D could close the parent shell over SSH.
		process.stdin.pause();

		// Restore raw mode state
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(this.#wasRaw);
		}
	}

	write(data: string): void {
		this.#safeWrite(data);
		if (this.#writeLogPath) {
			try {
				fs.appendFileSync(this.#writeLogPath, data, { encoding: "utf8" });
			} catch {
				// Ignore logging errors
			}
		}
	}

	#safeWrite(data: string): void {
		if (this.#dead) return;
		// Skip control sequences when stdout isn't a TTY (piped output, tests, log
		// files). They serve no purpose there and would surface as visible noise.
		if (!process.stdout.isTTY) return;
		try {
			process.stdout.write(data);
		} catch (err) {
			// Any write failure means terminal is dead - no recovery possible
			this.#dead = true;
			logger.warn("terminal is dead - no recovery possible", { error: err, data });
		}
	}

	get columns(): number {
		if (this.#inBandResizeActive && this.#reportedColumns) return this.#reportedColumns;
		return process.stdout.columns || Number(Bun.env.COLUMNS) || 80;
	}

	get rows(): number {
		if (this.#inBandResizeActive && this.#reportedRows) return this.#reportedRows;
		return process.stdout.rows || Number(Bun.env.LINES) || 24;
	}

	moveBy(lines: number): void {
		if (lines > 0) {
			// Move down
			this.#safeWrite(`\x1b[${lines}B`);
		} else if (lines < 0) {
			// Move up
			this.#safeWrite(`\x1b[${-lines}A`);
		}
		// lines === 0: no movement
	}

	hideCursor(): void {
		this.#safeWrite("\x1b[?25l");
	}

	showCursor(): void {
		this.#safeWrite("\x1b[?25h");
	}

	clearLine(): void {
		this.#safeWrite("\x1b[K");
	}

	clearFromCursor(): void {
		this.#safeWrite("\x1b[J");
	}

	clearScreen(): void {
		this.#safeWrite("\x1b[H\x1b[0J"); // Move to home (1,1) and clear from cursor to end
	}

	setTitle(title: string): void {
		// OSC 0;title BEL - set terminal window title
		this.#safeWrite(`\x1b]0;${title}\x07`);
	}

	setProgress(active: boolean): void {
		if (active) {
			this.#safeWrite(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
			if (!this.#progressTimer) {
				this.#progressTimer = setInterval(() => {
					this.#safeWrite(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
				}, TERMINAL_PROGRESS_KEEPALIVE_MS);
				this.#progressTimer.unref?.();
			}
		} else {
			this.#clearProgressTimer();
			this.#safeWrite(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}
	}

	#clearProgressTimer(): boolean {
		if (!this.#progressTimer) return false;
		clearInterval(this.#progressTimer);
		this.#progressTimer = undefined;
		return true;
	}
}

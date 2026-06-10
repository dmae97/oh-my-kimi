import { StdinBuffer, truncateToWidth } from "@oh-my-pi/pi-tui";
import { postmortem } from "@oh-my-pi/pi-utils";
import { CustomEditor } from "./components/custom-editor";
import { type LspServerInfo, WelcomeComponent } from "./components/welcome";
import { getEditorTheme, theme } from "./theme/theme";

/** Synchronized-output guards (DEC 2026); unsupported terminals ignore them. */
const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

export interface StartupInputOptions {
	version: string;
	modelName: string;
	providerName: string;
	lspServers: LspServerInfo[];
}

/**
 * Pre-TUI live input phase. Paints the same frame the TUI's first full paint
 * will produce — welcome box held on the intro's first frame, blank chat area,
 * editor box — and runs a real {@link CustomEditor} against raw stdin while
 * session creation continues in the background.
 *
 * The editor instance is handed to InteractiveMode at construction, so typed
 * text, cursor position, paste buffers, and undo history carry seamlessly into
 * the live UI. Enter submissions made before the session is ready are queued
 * (rendered dimmed in the chat area, where the real transcript will appear)
 * and replayed through the real submit pipeline once the input loop starts.
 *
 * Handoff contract: {@link detach} must run before `ProcessTerminal.start()`
 * grabs stdin — it restores cooked mode (so the terminal records the correct
 * prior raw state) and pauses stdin, leaving OS-buffered keystrokes to flow
 * into the TUI once it resumes.
 */
export class StartupInput {
	readonly editor: CustomEditor;
	readonly #welcome: WelcomeComponent;
	#queued: string[] = [];
	#stdinBuffer: StdinBuffer | undefined;
	#dataListener: ((chunk: string) => void) | undefined;
	#resizeListener: (() => void) | undefined;
	#unregisterCleanup: (() => void) | undefined;
	#started = false;
	#detached = false;
	#wasRaw = false;

	constructor(options: StartupInputOptions) {
		this.#welcome = new WelcomeComponent(
			options.version,
			options.modelName,
			options.providerName,
			null,
			options.lspServers,
		);
		// Freeze the logo on the intro's first frame so the in-TUI intro picks up
		// exactly where this frame leaves off.
		this.#welcome.holdIntroFirstFrame();

		this.editor = new CustomEditor(getEditorTheme());
		// `Editor.#submitValue` expands paste markers, trims, and clears the
		// buffer before invoking onSubmit, so `text` is final plain text.
		this.editor.onSubmit = text => {
			if (text) this.#queued.push(text);
			this.#paintLiveRegion();
		};
		// Ctrl+C: clear typed text; on an empty editor abort startup (pre-TUI raw
		// mode swallows SIGINT, so this is the muscle-memory escape hatch).
		this.editor.onClear = () => {
			if (this.editor.getText()) {
				this.editor.setText("");
				this.#paintLiveRegion();
			} else {
				this.#exit(130);
			}
		};
		// Ctrl+D: same exit semantics as the live UI on an idle session.
		this.editor.onExit = () => this.#exit(0);
	}

	/** Enter submissions captured before the session was ready, in order. */
	get queuedSubmissions(): readonly string[] {
		return this.#queued;
	}

	/** Grab stdin (raw mode), paint the initial frame, and start echoing input. */
	start(): void {
		if (this.#started) return;
		this.#started = true;
		this.#wasRaw = process.stdin.isRaw === true;
		process.stdin.setRawMode?.(true);
		process.stdin.setEncoding("utf8");
		process.stdin.resume();

		// Same sequence-splitting pipeline ProcessTerminal uses, so the editor
		// receives single key events and bracketed pastes arrive re-wrapped.
		const buffer = new StdinBuffer({ timeout: 50 });
		buffer.on("data", sequence => this.feedInput(sequence));
		buffer.on("paste", content => this.feedInput(`\x1b[200~${content}\x1b[201~`));
		this.#stdinBuffer = buffer;
		this.#dataListener = chunk => buffer.process(chunk);
		process.stdin.on("data", this.#dataListener);
		this.#resizeListener = () => this.#paintFull();
		process.stdout.on("resize", this.#resizeListener);
		// Crash safety: a fatal error before handoff must not leave the user's
		// terminal in raw mode with a hidden cursor.
		this.#unregisterCleanup = postmortem.register("startup-input-restore", () => this.#restoreTerminal());

		// Bracketed paste on; hardware cursor off (the editor draws its own).
		process.stdout.write("\x1b[?2004h\x1b[?25l");
		this.#paintFull();
	}

	/** Route one complete input sequence into the editor and refresh the frame. */
	feedInput(sequence: string): void {
		this.editor.handleInput(sequence);
		this.#paintLiveRegion();
	}

	/**
	 * Stop capturing and hand the terminal to the TUI. Restores cooked mode so
	 * `ProcessTerminal.start()` records the correct prior state, and pauses
	 * stdin so keystrokes typed during the remaining init await flow into the
	 * TUI once it resumes. The painted frame is left in place — the TUI's first
	 * full paint replaces it at the same origin.
	 */
	detach(): void {
		this.#unregisterCleanup?.();
		this.#unregisterCleanup = undefined;
		this.editor.onSubmit = undefined;
		this.editor.onClear = undefined;
		this.editor.onExit = undefined;
		this.#restoreTerminal();
	}

	#restoreTerminal(): void {
		if (!this.#started || this.#detached) return;
		this.#detached = true;
		if (this.#dataListener) process.stdin.off("data", this.#dataListener);
		if (this.#resizeListener) process.stdout.off("resize", this.#resizeListener);
		this.#stdinBuffer?.removeAllListeners();
		process.stdin.pause();
		process.stdin.setRawMode?.(this.#wasRaw);
		process.stdout.write("\x1b[?2004l\x1b[?25h");
	}

	#exit(code: number): void {
		this.detach();
		process.stdout.write("\r\n");
		void postmortem.quit(code);
	}

	/**
	 * Compose the full frame, mirroring the TUI's first-paint layout: Spacer,
	 * welcome box, Spacer, chat area (queued submissions), hook Spacer, editor.
	 * `liveRegionIndex` marks the first row that changes with input; everything
	 * above it is the stable welcome prefix.
	 */
	#frameRows(width: number): { rows: string[]; liveRegionIndex: number } {
		const rows: string[] = ["", ...this.#welcome.render(width), ""];
		const liveRegionIndex = rows.length;
		for (const text of this.#queued) {
			rows.push(truncateToWidth(theme.fg("dim", ` › ${text.replace(/\s+/g, " ")}`), Math.max(0, width - 1)));
		}
		rows.push("");
		const terminalRows = process.stdout.rows || 24;
		this.editor.setMaxHeight(Math.max(3, Math.min(10, terminalRows - rows.length - 2)));
		rows.push(...this.editor.render(width));
		return { rows, liveRegionIndex };
	}

	#paintFull(): void {
		if (!this.#started || this.#detached) return;
		const width = process.stdout.columns || 80;
		const { rows } = this.#frameRows(width);
		// Raw mode disables ONLCR; emit explicit CR+LF between rows.
		process.stdout.write(`${SYNC_BEGIN}\x1b[2J\x1b[H\x1b[3J${rows.join("\r\n")}${SYNC_END}`);
	}

	#paintLiveRegion(): void {
		if (!this.#started || this.#detached) return;
		const width = process.stdout.columns || 80;
		const { rows, liveRegionIndex } = this.#frameRows(width);
		if (rows.length >= (process.stdout.rows || 24)) {
			// Frame taller than the viewport: the initial write scrolled, so
			// absolute row addressing no longer maps to the frame. Repaint all.
			this.#paintFull();
			return;
		}
		const region = rows.slice(liveRegionIndex).join("\r\n");
		process.stdout.write(`${SYNC_BEGIN}\x1b[${liveRegionIndex + 1};1H\x1b[0J${region}${SYNC_END}`);
	}
}

import type { TUI } from "../tui";
import { sliceByColumn, visibleWidth } from "../utils";
import { Text } from "./text";

/**
 * Loader component. Spinner frames advance at `SPINNER_ADVANCE_MS`.
 *
 * Message colorizers that are time-dependent can opt into 30fps redraws by
 * setting `animated` to `true` on the function object.
 */
const RENDER_INTERVAL_MS = 1000 / 30;
const SPINNER_ADVANCE_MS = 80;

type ColorFn = (str: string) => string;

export type LoaderMessageColorFn = ColorFn & {
	readonly animated?: true;
};

export class Loader extends Text {
	#frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	#currentFrame = 0;
	#intervalId?: NodeJS.Timeout;
	#ui: TUI | null = null;
	#lastSpinnerTick = 0;

	constructor(
		ui: TUI,
		private spinnerColorFn: ColorFn,
		private messageColorFn: LoaderMessageColorFn,
		private message: string = "Loading...",
		spinnerFrames?: string[],
	) {
		super("", 1, 0);
		this.#ui = ui;
		if (spinnerFrames && spinnerFrames.length > 0) {
			this.#frames = spinnerFrames;
		}
		this.start();
	}

	render(width: number): readonly string[] {
		const lines = ["", ...super.render(width)];
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (visibleWidth(line) > width) {
				lines[i] = sliceByColumn(line, 0, width, true);
			}
		}
		return lines;
	}

	start() {
		this.#lastSpinnerTick = performance.now();
		this.#updateDisplay();
		const intervalMs = this.messageColorFn.animated === true ? RENDER_INTERVAL_MS : SPINNER_ADVANCE_MS;
		this.#intervalId = setInterval(() => {
			const now = performance.now();
			const elapsed = now - this.#lastSpinnerTick;
			if (elapsed >= SPINNER_ADVANCE_MS) {
				const steps = Math.floor(elapsed / SPINNER_ADVANCE_MS);
				this.#currentFrame = (this.#currentFrame + steps) % this.#frames.length;
				this.#lastSpinnerTick += steps * SPINNER_ADVANCE_MS;
			}
			this.#updateDisplay();
		}, intervalMs);
	}

	stop() {
		if (this.#intervalId) {
			clearInterval(this.#intervalId);
			this.#intervalId = undefined;
		}
	}

	/** Lifecycle teardown: stop the animation timer. Idempotent. */
	dispose() {
		this.stop();
	}

	setMessage(message: string) {
		if (message === this.message) {
			return;
		}
		this.message = message;
		this.#updateDisplay();
	}

	#updateDisplay() {
		const frame = this.#frames[this.#currentFrame];
		const text = `${this.spinnerColorFn(frame)} ${this.messageColorFn(this.message)}`;
		if (this.setText(text) && this.#ui) {
			this.#ui.requestRender();
		}
	}
}

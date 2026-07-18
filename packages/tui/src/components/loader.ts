import type { TUI } from "../tui";
import { getPaddingX, sliceByColumn, visibleWidth } from "../utils";
import { Text } from "./text";

const RENDER_INTERVAL_MS = 1000 / 30;
const SPINNER_ADVANCE_MS = 80;

type ColorFn = (str: string) => string;

/**
 * Styles Loader message fragments without changing their visible text or width.
 * Set `animated` for colorizers whose ANSI output changes over time.
 */
export type LoaderMessageColorFn = ColorFn & {
	readonly animated?: true;
};

/** Animates a spinner and colorized message while asynchronous work is pending. */
export class Loader extends Text {
	#frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	#currentFrame = 0;
	#intervalId?: NodeJS.Timeout;
	#ui: TUI | null = null;
	#lastSpinnerTick = 0;
	#layoutSource?: readonly string[];
	#layout?: readonly { leading: string; content: string; trailing: string }[];

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
		const source = super.render(width);
		if (source !== this.#layoutSource) {
			const paddingX = getPaddingX(1);
			this.#layoutSource = source;
			this.#layout = source.map(line => {
				const clamped = visibleWidth(line) > width ? sliceByColumn(line, 0, width, true) : line;
				const body = clamped.slice(paddingX);
				const content = body.trimEnd();
				return {
					leading: clamped.slice(0, paddingX),
					content,
					trailing: body.slice(content.length),
				};
			});
		}

		const frame = this.#frames[this.#currentFrame];
		const lines = [""];
		const layout = this.#layout ?? [];
		for (let i = 0; i < layout.length; i++) {
			const { leading, content, trailing } = layout[i];
			if (i === 0 && content.startsWith(frame)) {
				const remainder = content.slice(frame.length);
				const separator = remainder.startsWith(" ") ? " " : "";
				const message = remainder.slice(separator.length);
				lines.push(
					`${leading}${this.spinnerColorFn(frame)}${separator}${message ? this.messageColorFn(message) : ""}${trailing}`,
				);
			} else {
				lines.push(`${leading}${content ? this.messageColorFn(content) : ""}${trailing}`);
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
			const shouldAdvanceSpinner = elapsed >= SPINNER_ADVANCE_MS;
			if (shouldAdvanceSpinner) {
				const steps = Math.floor(elapsed / SPINNER_ADVANCE_MS);
				this.#currentFrame = (this.#currentFrame + steps) % this.#frames.length;
				this.#lastSpinnerTick += steps * SPINNER_ADVANCE_MS;
			}
			if (shouldAdvanceSpinner || this.#ui?.synchronizedOutput === true) {
				this.#updateDisplay();
			}
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
		const textChanged = this.setText(`${frame} ${this.message}`);
		if ((textChanged || this.messageColorFn.animated === true) && this.#ui) {
			// Direct write: a loader tick changes only this component, so the TUI
			// can update the already-positioned rows without driving the full
			// compose/prepare/diff pipeline. Lightweight test stubs may not carry
			// the newer API; keep their legacy component-scoped path working.
			if (typeof this.#ui.requestDirectWrite === "function") {
				this.#ui.requestDirectWrite(this);
			} else {
				this.#ui.requestComponentRender(this);
			}
		}
	}
}

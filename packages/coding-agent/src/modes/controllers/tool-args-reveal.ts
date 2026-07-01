import { parseStreamingJson, parseStreamingJsonThrottled, STREAMING_JSON_PARSE_MIN_GROWTH } from "@oh-my-pi/pi-utils";
import { nextStep, STREAMING_REVEAL_FRAME_MS } from "./streaming-reveal";

/** Minimal component surface the reveal pushes frames into. */
type ToolArgsRevealComponent = {
	updateArgs(args: unknown, toolCallId?: string): void;
};

type ToolArgsRevealControllerOptions = {
	getSmoothStreaming(): boolean;
	requestRender(): void;
};

type RevealEntry = {
	component: ToolArgsRevealComponent | undefined;
	/** Latest raw streamed argument text (JSON for function tools, raw text for custom tools). */
	target: string;
	/** Revealed UTF-16 code units of `target`. */
	revealed: number;
	/** Custom-tool raw input: display args are `{ input: prefix }`, never parsed as JSON. */
	rawInput: boolean;
	/** Whether the renderer observes fresh raw JSON prefixes directly. */
	exposeRawPartialJson: boolean;
	/** Last parsed JSON args from the revealed prefix. */
	parsedArgs: Record<string, unknown>;
	/** Prefix length covered by `parsedArgs`. */
	parsedLen: number;
	/** Last object handed to a component; reused when visible args have not changed. */
	displayArgs: Record<string, unknown>;
	/** Raw prefix carried by `displayArgs.__partialJson`. */
	displayPrefix: string;
};

/** Clamp a slice end into `text`, never splitting a surrogate pair: a prefix
 *  ending on a high surrogate would feed a lone surrogate into the parsed
 *  preview args (providers decode UTF-8 incrementally, so the raw stream
 *  itself never contains one). */
function clampSliceEnd(text: string, end: number): number {
	if (end <= 0) return 0;
	if (end >= text.length) return text.length;
	const code = text.charCodeAt(end - 1);
	return code >= 0xd800 && code <= 0xdbff ? end + 1 : end;
}

type ToolArgsRevealTarget = {
	rawInput: boolean;
	exposeRawPartialJson: boolean;
	fullArgs: Record<string, unknown>;
};

type DisplayArgsStep = {
	args: Record<string, unknown>;
	changed: boolean;
};

function initialDisplayArgs(): Record<string, unknown> {
	return { __partialJson: "" };
}

function resetDisplayState(entry: RevealEntry): void {
	entry.parsedArgs = {};
	entry.parsedLen = 0;
	entry.displayArgs = initialDisplayArgs();
	entry.displayPrefix = "";
}

/** Display args for a revealed prefix. Function-tool JSON is parsed at the same
 * growth-throttled cadence providers use, so a long `write` payload cannot make
 * the reveal loop re-parse the whole growing buffer every frame. Renderers that
 * read raw JSON directly still receive fresh `__partialJson` prefixes; other
 * renderers get a stable object reference while parsed fields are unchanged. */
function displayArgsForPrefix(entry: RevealEntry, prefix: string, forceParse = false): DisplayArgsStep {
	if (entry.rawInput) {
		if (prefix === entry.displayPrefix) return { args: entry.displayArgs, changed: false };
		const args = { input: prefix, __partialJson: prefix };
		entry.displayArgs = args;
		entry.displayPrefix = prefix;
		return { args, changed: true };
	}

	let parsedChanged = false;
	if (forceParse || (prefix.length > 0 && prefix.length < STREAMING_JSON_PARSE_MIN_GROWTH)) {
		entry.parsedArgs = parseStreamingJson<Record<string, unknown>>(prefix);
		entry.parsedLen = prefix.length;
		parsedChanged = true;
	} else {
		const throttled = parseStreamingJsonThrottled<Record<string, unknown>>(prefix, entry.parsedLen);
		if (throttled) {
			entry.parsedArgs = throttled.value;
			entry.parsedLen = throttled.parsedLen;
			parsedChanged = true;
		}
	}

	const rawPrefixChanged = entry.exposeRawPartialJson && prefix !== entry.displayPrefix;
	if (!parsedChanged && !rawPrefixChanged) return { args: entry.displayArgs, changed: false };

	const displayPrefix = entry.exposeRawPartialJson || parsedChanged ? prefix : entry.displayPrefix;
	const args = { ...entry.parsedArgs, __partialJson: displayPrefix };
	entry.displayArgs = args;
	entry.displayPrefix = displayPrefix;
	return { args, changed: true };
}

/**
 * Paces streamed tool-call arguments the same way StreamingRevealController
 * paces assistant text: providers that deliver `partialJson` in large batches
 * (or throttle their partial parses) would otherwise make write/edit/bash
 * streaming previews jump in chunks. Each pending tool call reveals its raw
 * argument stream at the shared 30fps cadence with the same adaptive
 * catch-up step. JSON prefixes are parsed only when enough new bytes arrive to
 * change renderer-visible fields, while raw-prefix consumers still receive
 * fresh `__partialJson` on every reveal frame.
 *
 * Reveal units are UTF-16 code units of the raw stream, not graphemes —
 * the prefix goes through a JSON parser rather than straight to the screen,
 * so only surrogate-pair integrity matters (see {@link clampSliceEnd}).
 */
export class ToolArgsRevealController {
	readonly #getSmoothStreaming: () => boolean;
	readonly #requestRender: () => void;
	readonly #entries = new Map<string, RevealEntry>();
	#timer: NodeJS.Timeout | undefined;

	constructor(options: ToolArgsRevealControllerOptions) {
		this.#getSmoothStreaming = options.getSmoothStreaming;
		this.#requestRender = options.requestRender;
	}

	/**
	 * Record the latest streamed argument text for a tool call and return the
	 * args to render right now. With smoothing disabled the full target passes
	 * through in the caller's legacy shape (`{ ...args, __partialJson }`).
	 */
	setTarget(id: string, partialJson: string, target: ToolArgsRevealTarget): Record<string, unknown> {
		const { rawInput, exposeRawPartialJson, fullArgs } = target;
		if (!this.#getSmoothStreaming()) {
			// Toggle may flip mid-call: drop any live entry so ticks stop.
			this.#entries.delete(id);
			return { ...fullArgs, __partialJson: partialJson };
		}
		let entry = this.#entries.get(id);
		if (!entry) {
			entry = {
				component: undefined,
				target: partialJson,
				revealed: clampSliceEnd(partialJson, partialJson.length),
				rawInput,
				exposeRawPartialJson,
				parsedArgs: {},
				parsedLen: 0,
				displayArgs: initialDisplayArgs(),
				displayPrefix: "",
			};
			this.#entries.set(id, entry);
		} else {
			if (entry.rawInput !== rawInput || entry.exposeRawPartialJson !== exposeRawPartialJson) {
				entry.rawInput = rawInput;
				entry.exposeRawPartialJson = exposeRawPartialJson;
				resetDisplayState(entry);
			}
			// Streams only append; a non-prefix target means a rewind — snap into range.
			if (!partialJson.startsWith(entry.target)) {
				entry.revealed = Math.min(entry.revealed, partialJson.length);
				resetDisplayState(entry);
			}
			entry.target = partialJson;
		}
		entry.revealed = clampSliceEnd(entry.target, entry.revealed);
		this.#syncTimer();
		return displayArgsForPrefix(entry, entry.target.slice(0, entry.revealed)).args;
	}

	/** Attach the component future ticks push frames into. */
	bind(id: string, component: ToolArgsRevealComponent): void {
		const entry = this.#entries.get(id);
		if (entry) entry.component = component;
	}

	/** Final arguments arrived (the JSON closed): drop the reveal so the
	 *  caller's final-args render wins immediately, mirroring how assistant
	 *  text snaps to the full message at message_end. */
	finish(id: string): void {
		this.#entries.delete(id);
		if (this.#entries.size === 0) this.#stopTimer();
	}

	/** Snap every live entry to its full received stream and clear. Used at
	 *  message_end (abort/error mid-stream) so sealed components freeze showing
	 *  everything that arrived rather than a mid-reveal prefix. */
	flushAll(): void {
		for (const [id, entry] of this.#entries) {
			if (entry.component && entry.revealed < entry.target.length) {
				entry.component.updateArgs(displayArgsForPrefix(entry, entry.target, true).args, id);
			}
		}
		this.#entries.clear();
		this.#stopTimer();
	}

	/** Clear without pushing (teardown). */
	stop(): void {
		this.#entries.clear();
		this.#stopTimer();
	}

	#syncTimer(): void {
		for (const entry of this.#entries.values()) {
			if (entry.revealed < entry.target.length) {
				this.#startTimer();
				return;
			}
		}
		this.#stopTimer();
	}

	#startTimer(): void {
		if (this.#timer) return;
		this.#timer = setInterval(() => {
			this.#tick();
		}, STREAMING_REVEAL_FRAME_MS);
		this.#timer.unref?.();
	}

	#stopTimer(): void {
		if (!this.#timer) return;
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	#tick(): void {
		let advanced = false;
		let rendered = false;
		for (const [id, entry] of this.#entries) {
			const backlog = entry.target.length - entry.revealed;
			if (backlog <= 0 || !entry.component) continue;
			entry.revealed = clampSliceEnd(entry.target, entry.revealed + nextStep(backlog));
			const display = displayArgsForPrefix(entry, entry.target.slice(0, entry.revealed));
			if (display.changed) {
				entry.component.updateArgs(display.args, id);
				rendered = true;
			}
			advanced = true;
		}
		if (advanced) {
			if (rendered) this.#requestRender();
		} else {
			// Every entry caught up (or unbound); setTarget restarts on growth.
			this.#stopTimer();
		}
	}
}

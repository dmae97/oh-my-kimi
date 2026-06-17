/**
 * Gemini thinking-loop guard.
 *
 * Gemini models (notably `gemini-3.5-flash` via OpenRouter) occasionally fall
 * into a degenerate reasoning loop: they re-emit the same paragraph intent over
 * and over with cosmetic wording drift ("Confirming Safety", "Verifying
 * Completion", …), burning the entire output budget without ever calling a tool
 * or answering. The runaway is *not* byte-identical, so a cheap verbatim
 * tail-repeat check alone misses it.
 *
 * This guard watches the streamed `thinking` deltas and, on a match, terminates
 * the stream with a synthetic `error` {@link AssistantMessage} that carries
 * **no observable content**. An empty-content `stopReason: "error"` whose
 * message hits the transient-transport pattern is what `AgentSession`
 * classifies as a *retryable* stop (a contentful error stop is treated as
 * replay-unsafe and is never retried), so the turn is discarded and re-sampled
 * instead of committing the garbage transcript.
 *
 * Two failure shapes are detected:
 * 1. **Verbatim tail repetition** — a short unit repeated back-to-back (e.g.
 *    "🌊 🌊 🌊 …"). Caught from a rolling 250-char tail.
 * 2. **Near-duplicate segments** — paragraphs that normalize to the same
 *    word-trigram fingerprint. Caught with a Jaccard window over recent
 *    paragraphs. Thresholds were calibrated on a real loop transcript plus
 *    13.5k non-loop thinking blocks (zero false positives; hardest negative
 *    scored 3 against the trigger of 4).
 *
 * Scope is deliberately narrow: **thinking only**. Answer text is left
 * untouched so the guard can never discard already-streamed visible output. The
 * guard is gated to Gemini models and wraps the provider stream, so it works
 * across every Gemini transport (OpenRouter `openai-completions`, direct
 * `google-generative-ai` / `google-gemini-cli`, Vertex). Disable with
 * `PI_NO_THINKING_LOOP_GUARD=1`.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { Api, AssistantMessage, Model } from "../types";
import { AssistantMessageEventStream } from "./event-stream";

/** Stable lead phrase of the guard's error message; exported for tests. The
 *  message also carries "stream stall" so the session + transport retry
 *  classifiers treat it as a transient (retryable) stop without bespoke rules. */
export const THINKING_LOOP_ERROR_MARKER = "Thinking loop detected";

/** Rolling tail (chars) inspected for verbatim back-to-back repetition. */
const VERBATIM_TAIL_WINDOW = 250;
/** Minimum total repeated chars before a verbatim run counts as a loop. */
const VERBATIM_MIN_REPEATED_CHARS = 180;
/** Longest unit length probed for a verbatim repeat. */
const VERBATIM_MAX_UNIT = 60;

/** Char cap for an unterminated segment; forces a flush so a wall-of-text loop
 *  (no blank lines / headings) still segments. */
const SEGMENT_CHAR_CAP = 700;
/** Normalized-length floor below which a segment is ignored (too short to be a
 *  meaningful paragraph; bare headings must not trip detection). */
const SEGMENT_MIN_NORM_CHARS = 60;
/** How many recent substantial segments are kept for similarity comparison. */
const SEGMENT_WINDOW = 16;
/** Word-trigram Jaccard at/above which two segments count as near-duplicates. */
const SEGMENT_SIMILARITY = 0.8;
/** Substantial segments required before detection may fire (warm-up). */
const SEGMENT_MIN_COUNT = 8;
/** Near-duplicate cluster size (current + matches) that trips the loop. */
const SEGMENT_MIN_CLUSTER = 4;

const OPENAI_COMPAT_GUARDED_APIS: Partial<Record<Api, true>> = {
	"openai-completions": true,
	"openai-responses": true,
	"azure-openai-responses": true,
	"openai-codex-responses": true,
};

/**
 * True when `model` should be guarded for thinking loops (Gemini only).
 *
 * OpenAI-compat transports can serve Gemini under an arbitrary provider/id, so
 * for those we trust the family-derived (and user-overridable)
 * `compat.enableGeminiThinkingLoopGuard` flag set by the catalog. Direct Google
 * transports always carry a clearly gemini-shaped id/provider, so a string
 * match is sufficient (and works for hand-built models without a compat record).
 */
export function isGeminiThinkingLoopModel(model: Model<Api>): boolean {
	if (OPENAI_COMPAT_GUARDED_APIS[model.api]) {
		return (
			(model.compat as { enableGeminiThinkingLoopGuard?: boolean } | undefined)?.enableGeminiThinkingLoopGuard ===
			true
		);
	}
	return /gemini/i.test(`${model.provider}/${model.id}`);
}

/**
 * Stateful detector fed the streamed thinking deltas. `push` returns a
 * human-readable reason the first time a loop shape is recognized; the caller
 * is responsible for stopping after the first hit.
 */
export class ThinkingLoopDetector {
	/** Rolling char tail for verbatim repeat detection. */
	#tail = "";
	/** Pending thinking text not yet split into completed segments. */
	#pending = "";
	/** Fingerprints of the most recent substantial segments (≤ SEGMENT_WINDOW). */
	#window: Set<string>[] = [];
	/** Count of substantial segments seen so far (warm-up gate). */
	#count = 0;

	push(delta: string): string | null {
		if (!delta) return null;

		// 1. Verbatim back-to-back repetition over the rolling tail.
		this.#tail += delta;
		if (this.#tail.length > VERBATIM_TAIL_WINDOW) this.#tail = this.#tail.slice(-VERBATIM_TAIL_WINDOW);
		const verbatim = detectVerbatimRepetition(this.#tail);
		if (verbatim) {
			const [unit, times] = verbatim;
			return `repeated "${unit.trim()}" ${times}× back-to-back`;
		}

		// 2. Near-duplicate paragraph loop. Append, then drain completed segments.
		this.#pending += delta;
		while (true) {
			const boundary = /\n\s*\n/.exec(this.#pending);
			let raw: string;
			if (boundary) {
				raw = this.#pending.slice(0, boundary.index);
				this.#pending = this.#pending.slice(boundary.index + boundary[0].length);
			} else if (this.#pending.length > SEGMENT_CHAR_CAP) {
				// No boundary yet but the segment is runaway-long: force a flush.
				raw = this.#pending.slice(0, SEGMENT_CHAR_CAP);
				this.#pending = this.#pending.slice(SEGMENT_CHAR_CAP);
			} else {
				return null;
			}
			// An over-long segment is chunked so each piece stays comparable.
			for (let rest = raw; rest.length > 0; ) {
				const chunk = rest.length > SEGMENT_CHAR_CAP ? rest.slice(0, SEGMENT_CHAR_CAP) : rest;
				rest = rest.slice(chunk.length);
				const hit = this.#consumeSegment(chunk);
				if (hit) return hit;
			}
		}
	}

	/** Process the buffered trailing paragraph (one with no blank-line / heading
	 *  terminator). Called when the thinking block ends so the final segment —
	 *  which may be the one that completes a duplicate cluster — is not dropped. */
	flush(): string | null {
		if (!this.#pending) return null;
		let rest = this.#pending;
		this.#pending = "";
		while (rest.length > 0) {
			const chunk = rest.length > SEGMENT_CHAR_CAP ? rest.slice(0, SEGMENT_CHAR_CAP) : rest;
			rest = rest.slice(chunk.length);
			const hit = this.#consumeSegment(chunk);
			if (hit) return hit;
		}
		return null;
	}

	#consumeSegment(segment: string): string | null {
		const normalized = normalizeSegment(segment);
		if (normalized.length < SEGMENT_MIN_NORM_CHARS) return null;

		const fingerprint = trigramShingles(normalized);
		let cluster = 1;
		for (const prev of this.#window) {
			if (jaccard(fingerprint, prev) >= SEGMENT_SIMILARITY) cluster++;
		}

		this.#window.push(fingerprint);
		if (this.#window.length > SEGMENT_WINDOW) this.#window.shift();
		this.#count++;

		if (this.#count >= SEGMENT_MIN_COUNT && cluster >= SEGMENT_MIN_CLUSTER) {
			return `${cluster} near-identical segments within the last ${SEGMENT_WINDOW}`;
		}
		return null;
	}
}

/**
 * Wrap a provider stream with the loop guard. `controller` is the guard's own
 * abort handle: aborting it (after wiring it into the provider's signal via
 * {@link withGeminiThinkingLoopGuard}) tears down the upstream once a loop
 * trips.
 */
export function guardThinkingLoopStream(
	inner: AssistantMessageEventStream,
	model: Model<Api>,
	controller: AbortController,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();
	const detector = new ThinkingLoopDetector();

	void (async () => {
		// Once any visible answer text or tool call starts, disarm: some providers
		// (e.g. openai-completions with cumulative `reasoning_content`) re-emit
		// fresh thinking deltas after `</think>`, and tripping the retriable path
		// then would discard already-streamed observable output.
		let armed = true;
		try {
			for await (const event of inner) {
				let detail: string | null = null;
				if (armed && event.type === "thinking_delta") {
					detail = detector.push(event.delta);
				} else if (armed && (event.type === "thinking_end" || event.type === "done")) {
					// Final paragraph of the block has no trailing blank line; flush it
					// so the segment that completes a cluster is not dropped. `done`
					// is the backstop for providers that omit a trailing thinking_end.
					detail = detector.flush();
				} else if (
					event.type === "text_start" ||
					event.type === "text_delta" ||
					event.type === "toolcall_start" ||
					event.type === "toolcall_delta"
				) {
					armed = false;
				}
				if (detail) {
					logger.warn("Gemini thinking loop detected; aborting stream for retry.", {
						model: model.id,
						provider: model.provider,
						detail,
					});
					controller.abort(new Error(THINKING_LOOP_ERROR_MARKER));
					outer.push({ type: "error", reason: "error", error: buildThinkingLoopError(model, detail) });
					return;
				}
				outer.push(event);
				if (outer.done) return;
			}
			if (!outer.done) {
				try {
					outer.end(await inner.result());
				} catch (err) {
					outer.fail(err);
				}
			}
		} catch (err) {
			if (!outer.done) outer.fail(err);
		}
	})();

	return outer;
}

/**
 * Apply the Gemini loop guard around a provider dispatch. For non-Gemini models
 * (or when disabled) this is a transparent pass-through. For Gemini it injects a
 * guard abort signal into the provider call so a detected loop tears down the
 * upstream, then wraps the returned stream.
 */
export function withGeminiThinkingLoopGuard<O extends { signal?: AbortSignal }>(
	model: Model<Api>,
	options: O | undefined,
	dispatch: (options: O | undefined) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	if (process.env.PI_NO_THINKING_LOOP_GUARD === "1" || !isGeminiThinkingLoopModel(model)) {
		return dispatch(options);
	}
	const controller = new AbortController();
	const caller = options?.signal;
	const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal;
	const merged = { ...(options ?? {}), signal } as O;
	return guardThinkingLoopStream(dispatch(merged), model, controller);
}

function buildThinkingLoopError(model: Model<Api>, detail: string): AssistantMessage {
	return {
		role: "assistant",
		// Empty content is load-bearing: a contentful error stop is replay-unsafe
		// and would NOT be auto-retried by the session.
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		// "stream stall" makes the transport/session retry classifiers treat this
		// as a transient (retryable) failure with no bespoke rule.
		errorMessage: `${THINKING_LOOP_ERROR_MARKER}: the model repeated near-identical reasoning (${detail}). Treating as a stream stall and retrying.`,
		timestamp: Date.now(),
	};
}

/**
 * Detect a short unit repeated back-to-back at the tail (verbatim loop). Only a
 * unit carrying a letter or pictographic emoji counts — runs of digits,
 * whitespace or punctuation are legitimate in tabular / hex / numeric output.
 */
function detectVerbatimRepetition(text: string): [unit: string, count: number] | null {
	if (text.length < VERBATIM_MIN_REPEATED_CHARS) return null;
	const windowSize = Math.min(text.length, VERBATIM_TAIL_WINDOW);
	const searchSpace = text.slice(-windowSize);

	for (let len = 2; len <= VERBATIM_MAX_UNIT; len++) {
		if (searchSpace.length < len * 4) continue;
		const unit = searchSpace.slice(-len);
		if (!/[\p{L}\p{Extended_Pictographic}]/u.test(unit)) continue;

		let count = 0;
		let pos = searchSpace.length;
		while (pos >= len) {
			if (searchSpace.slice(pos - len, pos) === unit) {
				count++;
				pos -= len;
			} else {
				break;
			}
		}
		if (count >= 4 && len * count >= VERBATIM_MIN_REPEATED_CHARS) return [unit, count];
	}
	return null;
}

/** Lowercase, drop code spans / paths / digits, keep only letter words. */
function normalizeSegment(segment: string): string {
	return segment
		.toLowerCase()
		.replace(/`[^`]*`/g, " ")
		.replace(/\/[^\s`]+/g, " ")
		.replace(/\d+/g, " ")
		.replace(/[^a-z]+/g, " ")
		.trim();
}

/** Word-trigram shingle set of a normalized segment. */
function trigramShingles(normalized: string): Set<string> {
	const words = normalized.split(" ").filter(Boolean);
	if (words.length < 3) return new Set(words.length > 0 ? [words.join(" ")] : []);
	const shingles = new Set<string>();
	for (let i = 0; i + 3 <= words.length; i++) {
		shingles.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
	}
	return shingles;
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	const [small, large] = a.size < b.size ? [a, b] : [b, a];
	let intersection = 0;
	for (const x of small) {
		if (large.has(x)) intersection++;
	}
	const union = a.size + b.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

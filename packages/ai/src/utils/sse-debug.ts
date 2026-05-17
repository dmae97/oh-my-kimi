import type { ServerSentEvent } from "@oh-my-pi/pi-utils";
import type { RawSseEvent } from "../types";

type FetchFunction = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type FetchWithPreconnect = FetchFunction & { preconnect?: typeof fetch.preconnect };

type RawSseObserver = (event: RawSseEvent) => void;

export function notifyRawSseEvent(observer: RawSseObserver | undefined, event: ServerSentEvent | RawSseEvent): void {
	if (!observer) return;
	try {
		// Pass the event through without cloning `raw`. The only wired observer
		// (`RawSseDebugBuffer.recordEvent`) treats `raw` as owned and never
		// mutates it; new observers must adhere to the same contract.
		// `ServerSentEvent` and `RawSseEvent` are structurally identical
		// (`event: string | null`, `data: string`, `raw: string[]`).
		observer(event as RawSseEvent);
	} catch {
		// Raw stream observers are diagnostic only and must not affect generation.
	}
}

function isSseResponse(response: Response): boolean {
	// `response.body` is non-null for any fetch Response with a body, but we
	// still guard because user-supplied `fetch` mocks may return `{ body: null }`
	// for empty responses and we don't want to wrap those.
	if (!response.ok || !response.body) return false;
	const contentType = response.headers.get("content-type");
	// All providers in this repo emit lowercase `text/event-stream` (verified
	// against anthropic, openai-completions, openai-responses, azure-openai-responses,
	// google-shared, google-gemini-cli, openai-codex-responses, pi-native-client,
	// and the auth-gateway server). A canonical `includes` check is sufficient;
	// if a future provider sends mixed case it will fall back to the unwrapped
	// fetch — observably safe, just no debug tee for that response.
	return contentType?.includes("text/event-stream") ?? false;
}

// Reused for every UTF-8 line decode. Safe because lines are split on LF
// (0x0a), which is single-byte ASCII and never appears inside a UTF-8
// multi-byte sequence — each line is a complete UTF-8 run, so the decoder
// carries no state across calls.
const SSE_LINE_DECODER = new TextDecoder("utf-8");

// Decode bytes [start, end) of an SSE line.
//
// A previous revision added an ASCII fast-path using `String.fromCharCode.apply`
// over chunked subarrays, on the theory that skipping `TextDecoder` would save
// the ~9.7% `decode` self-time the profile reported. In practice the swap
// *regressed* total wall time: `fromCharCode` became a new 7.8% hotspot,
// `Uint8Array` allocations grew 5.3%, and `subarray` rose from 11.5% to 18.3%
// — net loss of ~10pp. Bun's `TextDecoder.decode` has a fast C++ ASCII path
// that beats chunked `fromCharCode.apply` for the typical sub-1KB SSE line,
// so we keep the decoder. The line is bounded by LF (0x0a, single-byte
// ASCII), so each [start, end) slice is a complete UTF-8 run and the shared
// stateless decoder is safe to reuse.
function decodeSseLine(buf: Uint8Array, start: number, end: number): string {
	if (start === 0 && end === buf.length) return SSE_LINE_DECODER.decode(buf);
	return SSE_LINE_DECODER.decode(buf.subarray(start, end));
}

/**
 * Inline SSE event splitter. Walks the byte stream as it flows through a
 * `TransformStream`, dispatching parsed events to the debug observer while
 * the bytes are forwarded unchanged to the response consumer. Replaces the
 * previous `body.tee()` + `readSseEvents` re-parse pipeline so the byte
 * stream is parsed exactly once when a debug observer is attached.
 *
 * Field parsing intentionally mirrors `readSseEvents` in `@oh-my-pi/pi-utils`
 * (only `event` and `data` are observed; `id`/`retry` ignored; CR stripped
 * before LF dispatch; leading space after `:` trimmed; `data:` lines join
 * with `\n`). Reusing `readSseEvents` directly would require a second stream
 * pipeline, which is exactly what this class avoids.
 */
class SseTeeParser {
	#observer: RawSseObserver;
	// Trailing bytes from the previous chunk that did not end with LF.
	#partial: Uint8Array | null = null;
	#event: string | null = null;
	#data: string | null = null;
	#raw: string[] = [];

	constructor(observer: RawSseObserver) {
		this.#observer = observer;
	}

	push(chunk: Uint8Array): void {
		// Carry-forward path: concat the partial line with the new chunk so the
		// LF scan walks a single contiguous buffer. The common case (partial is
		// null) skips the allocation entirely.
		let buf: Uint8Array;
		if (this.#partial) {
			buf = new Uint8Array(this.#partial.length + chunk.length);
			buf.set(this.#partial, 0);
			buf.set(chunk, this.#partial.length);
			this.#partial = null;
		} else {
			buf = chunk;
		}

		const len = buf.length;
		let i = 0;
		while (i < len) {
			const lf = buf.indexOf(0x0a, i);
			if (lf === -1) {
				// Retain the tail as a partial line for the next chunk. Copy
				// because the source `chunk` buffer may be reused upstream.
				this.#partial = buf.subarray(i).slice();
				return;
			}
			let end = lf;
			if (end > i && buf[end - 1] === 0x0d) end--;
			this.#consumeLine(buf, i, end);
			i = lf + 1;
		}
	}

	flush(): void {
		// Treat any trailing partial line (no terminating LF) as a complete line.
		if (this.#partial) {
			const tail = this.#partial;
			this.#partial = null;
			let end = tail.length;
			if (end > 0 && tail[end - 1] === 0x0d) end--;
			if (end > 0) this.#consumeLine(tail, 0, end);
		}
		// Real services don't always close on a blank line — flush any pending event.
		this.#dispatch();
	}

	#consumeLine(buf: Uint8Array, start: number, end: number): void {
		if (end === start) {
			this.#dispatch();
			return;
		}
		// Comment line: keep verbatim in `raw` for diagnostic context, skip parsing.
		// SSE spec § 9.2.6: lines beginning with ':' are heartbeats/comments and
		// MUST NOT contribute to the event dispatch state. Heartbeats are the
		// single most common line type on long-poll provider streams, so the
		// early-return here directly avoids ~half the field-parse work.
		if (buf[start] === 0x3a /* ':' */) {
			this.#raw.push(decodeSseLine(buf, start, end));
			return;
		}
		// Byte-level field parse. We avoid `text.indexOf(':')` + two `String.slice`
		// calls (~6% of CPU pre-optimization) by scanning bytes for the field
		// delimiter and matching the field name byte-for-byte. Field-name bytes
		// are ASCII per SSE spec, so byte offsets equal char offsets in the
		// decoded string and we can `slice` the value directly off `text` without
		// re-decoding.
		//
		// ASCII signatures (verified against SSE spec):
		//   "event" = 0x65 0x76 0x65 0x6e 0x74  (5 bytes)
		//   "data"  = 0x64 0x61 0x74 0x61       (4 bytes)
		let colon = -1;
		for (let k = start; k < end; k++) {
			if (buf[k] === 0x3a) {
				colon = k;
				break;
			}
		}
		const fieldEnd = colon === -1 ? end : colon;
		let valueStart = colon === -1 ? end : colon + 1;
		// Per SSE spec, a single leading SP after the colon is stripped.
		if (valueStart < end && buf[valueStart] === 0x20 /* ' ' */) valueStart++;
		const fieldLen = fieldEnd - start;
		const isEvent =
			fieldLen === 5 &&
			buf[start] === 0x65 &&
			buf[start + 1] === 0x76 &&
			buf[start + 2] === 0x65 &&
			buf[start + 3] === 0x6e &&
			buf[start + 4] === 0x74;
		const isData =
			!isEvent &&
			fieldLen === 4 &&
			buf[start] === 0x64 &&
			buf[start + 1] === 0x61 &&
			buf[start + 2] === 0x74 &&
			buf[start + 3] === 0x61;
		// Decode the line exactly once. Raw observers (debug buffer) want it
		// regardless of field kind; `id`/`retry`/unknown lines pay only the
		// decode cost, not any extra slicing.
		const text = decodeSseLine(buf, start, end);
		this.#raw.push(text);
		if (isEvent) {
			// `valueStart - start` is a byte offset into the line; since the
			// "event:" prefix (and the optional SP) are pure ASCII, that byte
			// offset equals the char offset in the decoded `text`.
			this.#event = valueStart === end ? "" : text.slice(valueStart - start);
		} else if (isData) {
			const value = valueStart === end ? "" : text.slice(valueStart - start);
			if (this.#data === null) this.#data = value;
			else this.#data = `${this.#data}\n${value}`;
		}
		// `id` and `retry` are intentionally ignored — providers don't use them
		// and reconnects are handled by the underlying transport.
	}

	// Hands ownership of the accumulated `raw` array to the observer. The
	// observer (currently only `RawSseDebugBuffer.recordEvent`) MAY retain the
	// array; we install a fresh `#raw = []` for the next event before invoking
	// the observer so there is no aliasing across dispatches. This contract is
	// mirrored in `notifyRawSseEvent` (no defensive clone) — see its comment.
	//
	// TODO(BufferOpt): once the buffer-side audit confirms it never mutates
	// `event.raw`, the defensive `[...event.raw]` clone in older call paths
	// (search for `notifyRawSseEvent`) can be dropped repository-wide.
	#dispatch(): void {
		if (this.#event === null && this.#data === null) return;
		const event: RawSseEvent = {
			event: this.#event,
			data: this.#data ?? "",
			raw: this.#raw,
		};
		this.#event = null;
		this.#data = null;
		this.#raw = [];
		try {
			this.#observer(event);
		} catch {
			// Raw stream observers are diagnostic only and must not affect generation.
		}
	}
}

export function wrapFetchForSseDebug(
	fetchImpl: FetchWithPreconnect,
	observer: RawSseObserver | undefined,
): FetchWithPreconnect {
	if (!observer) return fetchImpl;

	const wrapped = Object.assign(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const response = await fetchImpl(input, init);
			if (!isSseResponse(response)) {
				return response;
			}

			const body = response.body;
			if (!body) return response;

			// Single-pass interception. Previously implemented as
			// `body.pipeThrough(new TransformStream({...}))`, but the WHATWG
			// TransformStream machinery imposes a per-chunk Promise boundary
			// (`#handleNumberResult` showed at 8.8% self-time in CPU profile).
			// A manual ReadableStream pulling directly from `body.getReader()`
			// skips that hop: every `read()` immediately feeds both the parser
			// and the controller in the same microtask.
			const parser = new SseTeeParser(observer);
			const reader = body.getReader();
			const teed = new ReadableStream<Uint8Array>({
				async pull(controller) {
					try {
						const { done, value } = await reader.read();
						if (done) {
							parser.flush();
							controller.close();
							return;
						}
						// Enqueue first so the consumer sees bytes ASAP; parser
						// dispatch is best-effort diagnostic and runs after.
						controller.enqueue(value);
						parser.push(value);
					} catch (err) {
						// Mirror TransformStream semantics: surface upstream
						// errors to the consumer; do not flush a partial event.
						controller.error(err);
					}
				},
				cancel(reason) {
					// Propagate downstream cancellation to the source body so the
					// underlying connection is released. Matches `pipeThrough`'s
					// cancel-propagation behavior; `flush()` is intentionally NOT
					// called (TransformStream skips `flush` on abort too).
					return reader.cancel(reason);
				},
			});

			return new Response(teed, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		},
		fetchImpl.preconnect ? { preconnect: fetchImpl.preconnect } : {},
	);

	return wrapped;
}

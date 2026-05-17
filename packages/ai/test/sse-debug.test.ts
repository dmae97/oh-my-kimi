import { describe, expect, it } from "bun:test";
import type { RawSseEvent } from "../src/types";
import { wrapFetchForSseDebug } from "../src/utils/sse-debug";

/**
 * Exercises the inline SSE tee + parser in `sse-debug.ts`. There is no direct
 * export for `SseTeeParser`; we drive it through `wrapFetchForSseDebug`, which
 * is the only production caller. Each test:
 *   1. Builds a mock `fetch` that returns a `text/event-stream` Response whose
 *      body emits a caller-controlled sequence of byte chunks (so we can
 *      exercise partial-line carry-forward and CR-LF handling deterministically).
 *   2. Calls the wrapped fetch.
 *   3. Reads the response body to completion so the `TransformStream` `flush`
 *      runs.
 *   4. Asserts the events the observer received exactly match expectations.
 *
 * The point is to lock in behavior across the ASCII-fast-path / byte-level-
 * field-parse rewrite: the observer MUST receive the same `{ event, data, raw }`
 * shape it received with the prior decode-then-string-slice implementation.
 */

function chunkedStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	let i = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i >= chunks.length) {
				controller.close();
				return;
			}
			controller.enqueue(chunks[i++]);
		},
	});
}

function sseResponse(chunks: Uint8Array[]): Response {
	return new Response(chunkedStream(chunks), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

const enc = new TextEncoder();
const b = (s: string): Uint8Array => enc.encode(s);

async function drain(response: Response): Promise<void> {
	const reader = response.body!.getReader();
	for (;;) {
		const { done } = await reader.read();
		if (done) return;
	}
}

async function collect(chunks: Uint8Array[]): Promise<RawSseEvent[]> {
	const events: RawSseEvent[] = [];
	const fetchImpl = async () => sseResponse(chunks);
	const wrapped = wrapFetchForSseDebug(fetchImpl, event => {
		events.push(event);
	});
	const response = await wrapped("https://example.test/stream");
	await drain(response);
	return events;
}

describe("sse-debug parser", () => {
	it("parses a single event terminated by blank line", async () => {
		const events = await collect([b("event: message\ndata: hello\n\n")]);
		expect(events).toEqual([{ event: "message", data: "hello", raw: ["event: message", "data: hello"] }]);
	});

	it("joins multi-line data fields with newlines", async () => {
		const events = await collect([b("data: line1\ndata: line2\ndata: line3\n\n")]);
		expect(events).toHaveLength(1);
		expect(events[0]!.event).toBe(null);
		expect(events[0]!.data).toBe("line1\nline2\nline3");
		expect(events[0]!.raw).toEqual(["data: line1", "data: line2", "data: line3"]);
	});

	it("strips a single leading SP after the colon but preserves further spaces", async () => {
		const events = await collect([b("data:  two-leading-spaces\n\n")]);
		expect(events[0]!.data).toBe(" two-leading-spaces");
	});

	it("retains comment (`:`-prefixed) lines in raw but does not parse them", async () => {
		const events = await collect([b(": heartbeat\ndata: payload\n\n")]);
		expect(events).toHaveLength(1);
		expect(events[0]!.data).toBe("payload");
		expect(events[0]!.raw).toEqual([": heartbeat", "data: payload"]);
	});

	it("does not dispatch on a blank line if no event/data accumulated (pure heartbeats)", async () => {
		const events = await collect([b(": ping\n\n: ping\n\n")]);
		expect(events).toHaveLength(0);
	});

	it("handles CR-LF line endings and strips the CR before dispatch", async () => {
		const events = await collect([b("event: ping\r\ndata: pong\r\n\r\n")]);
		expect(events).toEqual([{ event: "ping", data: "pong", raw: ["event: ping", "data: pong"] }]);
	});

	it("ignores unknown fields (`id`, `retry`, gibberish) but keeps them in raw", async () => {
		const events = await collect([b("id: 42\nretry: 1000\nfoo: bar\ndata: ok\n\n")]);
		expect(events).toHaveLength(1);
		expect(events[0]!.event).toBe(null);
		expect(events[0]!.data).toBe("ok");
		expect(events[0]!.raw).toEqual(["id: 42", "retry: 1000", "foo: bar", "data: ok"]);
	});

	it("treats a line with no colon as field-with-empty-value (data line still recorded)", async () => {
		// Per SSE spec a bare `data` line is treated as `data:` with empty value.
		const events = await collect([b("data\ndata: x\n\n")]);
		expect(events).toHaveLength(1);
		expect(events[0]!.data).toBe("\nx");
	});

	it("reassembles events split across arbitrary chunk boundaries", async () => {
		// Split a single event across chunks: mid-field-name, mid-value, mid-LF-CRLF.
		const events = await collect([b("eve"), b("nt: x\r"), b("\ndata: a"), b("bc\r\n\r"), b("\n")]);
		expect(events).toEqual([{ event: "x", data: "abc", raw: ["event: x", "data: abc"] }]);
	});

	it("handles a chunk that ends exactly on LF (no partial carried)", async () => {
		const events = await collect([b("data: a\n"), b("data: b\n"), b("\n")]);
		expect(events).toHaveLength(1);
		expect(events[0]!.data).toBe("a\nb");
	});

	it("flushes a trailing event with no terminating blank line", async () => {
		// Stream closes without a final "\n\n". Parser must dispatch on flush.
		const events = await collect([b("event: end\ndata: bye\n")]);
		expect(events).toEqual([{ event: "end", data: "bye", raw: ["event: end", "data: bye"] }]);
	});

	it("flushes a trailing event with no terminating newline at all", async () => {
		const events = await collect([b("event: end\ndata: bye")]);
		expect(events).toEqual([{ event: "end", data: "bye", raw: ["event: end", "data: bye"] }]);
	});

	it("preserves UTF-8 multibyte characters via decoder fallback", async () => {
		// Non-ASCII bytes (emoji, accented chars, CJK) must round-trip identically.
		const events = await collect([b("data: caf\u00e9 \u2014 \u4f60\u597d \ud83d\ude00\n\n")]);
		expect(events[0]!.data).toBe("café — 你好 😀");
	});

	it("handles a UTF-8 multibyte sequence split across chunk boundary", async () => {
		// The 4-byte emoji U+1F600 ("😀") = F0 9F 98 80. Split it between chunks.
		const full = b("data: \ud83d\ude00\n\n");
		const split = full.indexOf(0xf0) + 2;
		const events = await collect([full.subarray(0, split), full.subarray(split)]);
		expect(events[0]!.data).toBe("😀");
	});

	it("emits multiple events in stream order", async () => {
		const events = await collect([b("event: a\ndata: 1\n\nevent: b\ndata: 2\n\nevent: c\ndata: 3\n\n")]);
		expect(events.map(e => [e.event, e.data])).toEqual([
			["a", "1"],
			["b", "2"],
			["c", "3"],
		]);
	});

	it("hands a fresh `raw` array to each observer call (no aliasing)", async () => {
		const events = await collect([b("data: a\n\ndata: b\n\n")]);
		expect(events).toHaveLength(2);
		expect(events[0]!.raw).not.toBe(events[1]!.raw);
		// Observer-side mutation of the first `raw` must not leak into the second.
		events[0]!.raw.push("MUTATED");
		expect(events[1]!.raw).toEqual(["data: b"]);
	});

	it("treats `data:` with no value as empty string and merges further data lines", async () => {
		const events = await collect([b("data:\ndata: x\n\n")]);
		expect(events[0]!.data).toBe("\nx");
	});

	it("returns the unwrapped fetch when observer is undefined", async () => {
		const fetchImpl = async () => sseResponse([b("data: x\n\n")]);
		const wrapped = wrapFetchForSseDebug(fetchImpl, undefined);
		// Identity, not a wrapper: caller relies on this fast path.
		expect(wrapped).toBe(fetchImpl as unknown as typeof wrapped);
	});

	it("passes through non-SSE responses untouched", async () => {
		const events: RawSseEvent[] = [];
		const fetchImpl = async () =>
			new Response(b("not sse"), { status: 200, headers: { "content-type": "text/plain" } });
		const wrapped = wrapFetchForSseDebug(fetchImpl, e => events.push(e));
		const response = await wrapped("https://example.test/plain");
		expect(await response.text()).toBe("not sse");
		expect(events).toHaveLength(0);
	});

	it("forwards the byte stream byte-identically to the consumer", async () => {
		// Critical invariant: tee must not mutate or re-shape bytes for the
		// downstream consumer. Use a payload with UTF-8 + CR-LF + heartbeats to
		// stress the parser without corrupting forwarded bytes.
		const payload = b(": heartbeat\r\nevent: msg\r\ndata: caf\u00e9 \u4f60\u597d\r\n\r\ndata: tail\n\n");
		// Chunk the input awkwardly so the TransformStream sees several chunks.
		const chunks = [payload.subarray(0, 5), payload.subarray(5, 17), payload.subarray(17)];
		const fetchImpl = async () => sseResponse(chunks);
		const wrapped = wrapFetchForSseDebug(fetchImpl, () => {});
		const response = await wrapped("https://example.test/stream");
		const forwarded = new Uint8Array(await response.arrayBuffer());
		expect(Array.from(forwarded)).toEqual(Array.from(payload));
	});
});

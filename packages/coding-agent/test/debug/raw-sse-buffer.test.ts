import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { RawSseDebugBuffer, rawSseRecordLines, resolveRawSseDebugBuffer } from "../../src/debug/raw-sse-buffer";

const model: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

describe("RawSseDebugBuffer", () => {
	it("records response metadata and raw SSE frame lines for diagnostics", () => {
		const buffer = new RawSseDebugBuffer();

		buffer.recordResponse(
			{ status: 200, requestId: "req_123", headers: {}, metadata: { lastTransport: "sse" } },
			model,
		);
		buffer.recordEvent(
			{
				event: "content_block_delta",
				data: '{"type":"content_block_delta"}',
				raw: ["event: content_block_delta", 'data: {"type":"content_block_delta"}'],
			},
			model,
		);

		const snapshot = buffer.snapshot();
		expect(snapshot.totalEvents).toBe(1);
		expect(snapshot.records).toHaveLength(2);
		const [responseLine] = rawSseRecordLines(snapshot.records[0]);
		expect(responseLine).toContain("provider=anthropic model=claude-test");
		expect(rawSseRecordLines(snapshot.records[1])).toEqual([
			"event: content_block_delta",
			'data: {"type":"content_block_delta"}',
		]);
		expect(buffer.toRawText()).toContain("event: content_block_delta");
	});

	it("notifies subscribers when new frames arrive", () => {
		const buffer = new RawSseDebugBuffer();
		let updates = 0;
		const unsubscribe = buffer.subscribe(() => {
			updates += 1;
		});

		buffer.recordEvent({ event: null, data: "{}", raw: ["data: {}"] }, model);
		unsubscribe();
		buffer.recordEvent({ event: null, data: "{}", raw: ["data: {}"] }, model);

		expect(updates).toBe(1);
		expect(buffer.snapshot().totalEvents).toBe(2);
	});

	it("creates a fallback buffer for session objects without a preinstalled buffer", () => {
		const owner = {};
		const buffer = resolveRawSseDebugBuffer(owner);

		buffer.recordEvent({ event: "message", data: "{}", raw: ["event: message", "data: {}"] }, model);

		expect(resolveRawSseDebugBuffer(owner)).toBe(buffer);
		expect(buffer.snapshot().totalEvents).toBe(1);
	});
});

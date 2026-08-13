import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/stream.ts";
import type { Context, Model } from "../src/types.ts";

// claude-code 2.1.177 RE (2026-08-02): Anthropic API는 fallback 라우팅 후
// "sticky" stop reason을 반환한다 (refusal과 동급 1급 취급).
// omk-ai의 mapStopReason이 sticky를 처리하지 못해 throw하던 버그 회귀 테스트.
function makeModel(baseUrl: string): Model<"anthropic-messages"> {
	return {
		id: "re-test-model",
		name: "RE-Test-Model",
		api: "anthropic-messages",
		provider: "re-test-provider",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 1024,
	};
}

function makeContext(): Context {
	return { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] };
}

const SSE_HEADERS = { "content-type": "text/event-stream" };

async function run(chunks: string[]): Promise<{ stopReason: string; content: string }> {
	const server = createServer((_req, response: ServerResponse) => {
		response.writeHead(200, SSE_HEADERS);
		for (const chunk of chunks) response.write(chunk);
		response.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	try {
		const result = await streamSimple(makeModel(`http://127.0.0.1:${port}`), makeContext(), {
			apiKey: "fake-key",
		}).result();
		const text = result.content
			.filter((b) => b.type === "text")
			.map((b) => (b as { text?: string }).text ?? "")
			.join("");
		return { stopReason: result.stopReason, content: text };
	} finally {
		server.close();
	}
}

describe("anthropic sticky stop reason (RE: claude-code 2.1.177)", () => {
	it("maps sticky stop reason without throwing", async () => {
		const sse = [
			'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"re-test-model","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}\n\n',
			'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
			'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"sticky","stop_sequence":null},"usage":{"output_tokens":4}}\n\n',
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		];
		const result = await run(sse);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toBe("ok");
	});

	it("still maps refusal to error (regression)", async () => {
		const sse = [
			'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","type":"message","role":"assistant","model":"re-test-model","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}\n\n',
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		];
		const result = await run(sse);
		expect(result.stopReason).toBe("error");
	});
});

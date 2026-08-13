import { describe, expect, it } from "vitest";
import {
	createLineDecoder,
	encodeMessage,
	formatJsonRpcError,
	isJsonRpcNotification,
	isJsonRpcRequest,
	isJsonRpcResponse,
} from "../../src/core/mcp/protocol.ts";

describe("MCP JSON-RPC framing", () => {
	it("encodes one message per line", () => {
		expect(encodeMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toBe(
			'{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n',
		);
	});

	it("escapes newlines inside payloads so framing survives", () => {
		const encoded = encodeMessage({ jsonrpc: "2.0", id: 1, method: "x", params: { text: "a\nb" } });
		expect(encoded.split("\n").filter((line) => line.length > 0)).toHaveLength(1);
		expect(JSON.parse(encoded).params.text).toBe("a\nb");
	});

	it("decodes messages split across chunk boundaries", () => {
		const decoder = createLineDecoder();
		expect(decoder.push('{"jsonrpc":"2.0","id":1,')).toEqual([]);
		const out = decoder.push('"result":{"ok":true}}\n');
		expect(out).toHaveLength(1);
		expect(out[0].message).toMatchObject({ id: 1, result: { ok: true } });
	});

	it("decodes several messages arriving in one chunk", () => {
		const decoder = createLineDecoder();
		const out = decoder.push('{"jsonrpc":"2.0","id":1,"result":1}\n{"jsonrpc":"2.0","id":2,"result":2}\n');
		expect(out.map((entry) => (entry.message as { id: number }).id)).toEqual([1, 2]);
	});

	it("reports malformed lines instead of dropping them silently", () => {
		const decoder = createLineDecoder();
		const out = decoder.push("not json\n");
		expect(out).toEqual([{ error: "MCP frame is not valid JSON" }]);
	});

	it("rejects well-formed JSON that is not JSON-RPC", () => {
		const decoder = createLineDecoder();
		expect(decoder.push('{"hello":"world"}\n')[0].error).toBe("MCP frame is not a JSON-RPC 2.0 message");
	});

	it("drops an oversized frame and resynchronizes at the next newline", () => {
		const decoder = createLineDecoder(64);
		const overflow = decoder.push(`{"jsonrpc":"2.0","id":1,"result":"${"x".repeat(200)}`);
		expect(overflow[0].error).toMatch(/exceeded 64 bytes/u);

		const after = decoder.push('rest-of-oversized-line\n{"jsonrpc":"2.0","id":2,"result":2}\n');
		expect(after).toHaveLength(1);
		expect(after[0].message).toMatchObject({ id: 2 });
	});

	it("ignores blank lines", () => {
		expect(createLineDecoder().push("\n\n\n")).toEqual([]);
	});

	it("classifies responses, notifications, and requests", () => {
		expect(isJsonRpcResponse({ jsonrpc: "2.0", id: 1, result: null })).toBe(true);
		expect(isJsonRpcResponse({ jsonrpc: "2.0", id: 1, error: { code: 1, message: "x" } })).toBe(true);
		expect(isJsonRpcResponse({ jsonrpc: "2.0", id: 1 })).toBe(false);
		expect(isJsonRpcNotification({ jsonrpc: "2.0", method: "notifications/initialized" })).toBe(true);
		expect(isJsonRpcNotification({ jsonrpc: "2.0", id: 1, method: "x" })).toBe(false);
		expect(isJsonRpcRequest({ jsonrpc: "2.0", id: "a", method: "x" })).toBe(true);
		expect(isJsonRpcRequest({ jsonrpc: "1.0", id: 1, method: "x" })).toBe(false);
	});

	it("formats error bodies with their data payload", () => {
		expect(formatJsonRpcError({ code: -32602, message: "bad params" })).toBe("JSON-RPC error -32602: bad params");
		expect(formatJsonRpcError({ code: -1, message: "x", data: { why: "y" } })).toBe(
			'JSON-RPC error -1: x ({"why":"y"})',
		);
	});
});

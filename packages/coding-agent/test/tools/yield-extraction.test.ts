import { describe, expect, it } from "bun:test";
import "@oh-my-pi/pi-coding-agent/tools/yield";
import { subprocessToolRegistry } from "@oh-my-pi/pi-coding-agent/task/subprocess-tool-registry";

describe("yield subprocess extraction", () => {
	const handler = subprocessToolRegistry.getHandler("yield");

	it("extracts valid yield payloads", () => {
		expect(handler?.extractData).toBeDefined();
		const data = handler?.extractData?.({
			toolName: "yield",
			toolCallId: "call-1",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data: { ok: true } },
			},
			isError: false,
		});
		expect(data).toEqual({ status: "success", data: { ok: true }, error: undefined });
	});

	it("ignores malformed yield details without status", () => {
		const data = handler?.extractData?.({
			toolName: "yield",
			toolCallId: "call-2",
			result: {
				content: [{ type: "text", text: "Tool execution was aborted." }],
				details: {},
			},
			isError: true,
		});
		expect(data).toBeUndefined();
	});
});

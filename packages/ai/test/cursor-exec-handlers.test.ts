import { describe, expect, it } from "bun:test";
import { buildCursorSystemPromptJsons, resolveExecHandler } from "../src/providers/cursor";

describe("Cursor resolveExecHandler execHandlers binding", () => {
	it("invokes handler with correct this when passed as bound method", async () => {
		const sentinel = { tag: "bound-correctly" };
		const handlers = {
			sentinel,
			async read(_args: { path: string }) {
				// Handler methods rely on 'this' (e.g. to access other handlers or state).
				// When passed without .bind(handlers), 'this' is undefined in strict mode.
				return { execResult: (this as typeof handlers).sentinel, toolResult: undefined };
			},
		};

		const { execResult } = await resolveExecHandler(
			{ path: "/tmp/foo" },
			handlers.read.bind(handlers),
			undefined,
			() => ({}),
			() => ({ tag: "rejected" }),
			() => ({ tag: "error" }),
		);

		expect(execResult).toBe(sentinel);
		expect((execResult as { tag: string }).tag).toBe("bound-correctly");
	});

	it("handler loses this when passed unbound and fails or returns wrong result", async () => {
		const sentinel = { tag: "bound-correctly" };
		const handlers = {
			sentinel,
			async read(_args: { path: string }) {
				return { execResult: (this as typeof handlers).sentinel, toolResult: undefined };
			},
		};

		// Pass method reference without .bind(handlers). In strict mode 'this' is undefined
		// when resolveExecHandler calls handler(args), so (this as any).sentinel throws.
		const { execResult } = await resolveExecHandler(
			{ path: "/tmp/foo" },
			handlers.read,
			undefined,
			() => ({}),
			() => ({ tag: "rejected" }),
			(msg: string) => ({ tag: "error", message: msg }),
		);

		// Should get error result (handler threw accessing undefined.sentinel)
		expect(execResult).toEqual({ tag: "error", message: expect.any(String) });
	});
});

describe("Cursor system prompt encoding", () => {
	it("emits one Cursor system blob per ordered prompt", () => {
		const jsons = buildCursorSystemPromptJsons(["Primary instructions.", "Developer constraints."]);
		expect(jsons).toHaveLength(2);
		expect(JSON.parse(jsons[0])).toEqual({ role: "system", content: "Primary instructions." });
		expect(JSON.parse(jsons[1])).toEqual({ role: "system", content: "Developer constraints." });
	});

	it("falls back to a single default system message when all entries are empty", () => {
		const jsons = buildCursorSystemPromptJsons(["", ""]);
		expect(jsons).toHaveLength(1);
		expect(JSON.parse(jsons[0])).toEqual({ role: "system", content: "You are a helpful assistant." });
	});
});

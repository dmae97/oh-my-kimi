import { describe, expect, it } from "bun:test";
import { AppendOnlyContextManager, AppendOnlyLog, StablePrefix } from "@oh-my-pi/pi-agent-core/append-only-context";
import type { AgentContext, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { Message, Tool, ToolExample } from "@oh-my-pi/pi-ai";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import { type } from "arktype";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides?: Partial<AgentContext>): AgentContext {
	return {
		systemPrompt: ["You are a helpful assistant.", "Be concise."],
		messages: [],
		tools: [],
		...overrides,
	};
}

function makeTool(
	name: string,
	description?: string,
	parameters?: Tool["parameters"],
	examples?: readonly ToolExample[],
): AgentTool {
	return {
		name,
		description: description ?? `Tool ${name}`,
		parameters: parameters ?? { type: "object", properties: {} },
		label: name,
		examples,
		execute: async () => ({ content: [{ type: "text", text: "done" }] }),
	} as AgentTool;
}

const BUILD_OPTS = { intentTracing: false } as const;

// ---------------------------------------------------------------------------
// StablePrefix
// ---------------------------------------------------------------------------

describe("StablePrefix", () => {
	it("builds and returns cached system prompt + tools", () => {
		const p = new StablePrefix();
		const ctx = makeContext({
			systemPrompt: ["You are a helpful assistant."],
			tools: [makeTool("read")],
		});

		const changed = p.build(ctx, BUILD_OPTS);
		expect(changed).toBe(true);
		expect(p.built).toBe(true);

		const { systemPrompt, tools } = p.toContext();
		expect(systemPrompt).toEqual(["You are a helpful assistant."]);
		expect(tools).toHaveLength(1);
		expect(tools[0]!.name).toBe("read");
	});

	it("returns false on identical rebuild", () => {
		const p = new StablePrefix();
		const ctx = makeContext({ systemPrompt: ["Hello"] });

		p.build(ctx, BUILD_OPTS);
		const changed = p.build(ctx, BUILD_OPTS);
		expect(changed).toBe(false);
	});

	it("returns true when system prompt changes", () => {
		const p = new StablePrefix();
		const ctx = makeContext({ systemPrompt: ["Old prompt"] });
		p.build(ctx, BUILD_OPTS);

		const changed = p.build(makeContext({ systemPrompt: ["New prompt"] }), BUILD_OPTS);
		expect(changed).toBe(true);
	});

	it("returns true when tools change", () => {
		const p = new StablePrefix();
		p.build(makeContext({ tools: [makeTool("read")] }), BUILD_OPTS);

		const changed = p.build(makeContext({ tools: [makeTool("read"), makeTool("write")] }), BUILD_OPTS);
		expect(changed).toBe(true);
	});

	it("returns true when tool description changes", () => {
		const p = new StablePrefix();
		p.build(makeContext({ tools: [makeTool("read", "Original desc")] }), BUILD_OPTS);

		const changed = p.build(makeContext({ tools: [makeTool("read", "Updated desc")] }), BUILD_OPTS);
		expect(changed).toBe(true);
	});

	it("invalidate forces rebuild", () => {
		const p = new StablePrefix();
		const ctx = makeContext({ systemPrompt: ["Stable"] });
		p.build(ctx, BUILD_OPTS);

		p.invalidate();
		expect(p.built).toBe(false);

		const changed = p.build(ctx, BUILD_OPTS);
		expect(changed).toBe(true);
	});

	it("toContext() throws when not built", () => {
		const p = new StablePrefix();
		expect(() => p.toContext()).toThrow("build()");
	});

	it("fingerprint changes across rebuilds", () => {
		const p = new StablePrefix();
		const ctx1 = makeContext({ systemPrompt: ["Prompt A"] });
		p.build(ctx1, BUILD_OPTS);
		const fp1 = p.fingerprint;

		const ctx2 = makeContext({ systemPrompt: ["Prompt B"] });
		p.build(ctx2, BUILD_OPTS);
		const fp2 = p.fingerprint;

		expect(fp1).not.toBe(fp2);
	});

	it("fingerprint stable for identical context", () => {
		const p = new StablePrefix();
		p.build(makeContext({ systemPrompt: ["Stable"], tools: [makeTool("foo")] }), BUILD_OPTS);
		const fp1 = p.fingerprint;

		p.build(makeContext({ systemPrompt: ["Stable"], tools: [makeTool("foo")] }), BUILD_OPTS);
		const fp2 = p.fingerprint;

		expect(fp1).toBe(fp2);
	});

	it("version increases on each rebuild", () => {
		const p = new StablePrefix();
		expect(p.version).toBe(0);

		p.build(makeContext({ systemPrompt: ["V1"] }), BUILD_OPTS);
		expect(p.version).toBe(1);

		p.build(makeContext({ systemPrompt: ["V2"] }), BUILD_OPTS);
		expect(p.version).toBe(2);

		p.build(makeContext({ systemPrompt: ["V2"] }), BUILD_OPTS);
		expect(p.version).toBe(2); // unchanged = no increment
	});
});

// ---------------------------------------------------------------------------
// AppendOnlyLog
// ---------------------------------------------------------------------------

describe("AppendOnlyLog", () => {
	it("starts empty", () => {
		const log = new AppendOnlyLog();
		expect(log.length).toBe(0);
		expect(log.toMessages()).toEqual([]);
	});

	it("appends messages", () => {
		const log = new AppendOnlyLog();
		log.append({ role: "user", content: "hello" } as any);
		log.append({ role: "assistant", content: "world" } as any);
		expect(log.length).toBe(2);
		expect(log.toMessages()).toHaveLength(2);
	});

	it("toMessages returns a copy of the array", () => {
		const log = new AppendOnlyLog();
		const msg = { role: "user", content: "test" };
		log.append(msg);
		const msgs = log.toMessages();
		// Array is a copy — mutating it doesn't affect the log
		msgs.pop();
		expect(log.length).toBe(1);
	});

	it("replaceTail replaces last entry", () => {
		const log = new AppendOnlyLog();
		log.append({ role: "user", content: "old" });
		log.replaceTail({ role: "user", content: "new" });
		expect(log.toMessages()).toHaveLength(1);
		expect(log.toMessages()[0]!.content).toBe("new");
	});

	it("replaceTail is no-op on empty log", () => {
		const log = new AppendOnlyLog();
		log.replaceTail({ role: "user", content: "nope" });
		expect(log.length).toBe(0);
	});

	it("extend appends multiple messages", () => {
		const log = new AppendOnlyLog();
		log.extend([
			{ role: "user", content: "a" },
			{ role: "assistant", content: "b" },
		]);
		expect(log.length).toBe(2);
	});

	it("clear resets the log", () => {
		const log = new AppendOnlyLog();
		log.append({ role: "user", content: "x" });
		log.clear();
		expect(log.length).toBe(0);
	});

	it("entries readonly access returns internal array", () => {
		const log = new AppendOnlyLog();
		log.append({ role: "user", content: "test" });
		expect(log.entries()).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// AppendOnlyContextManager
// ---------------------------------------------------------------------------

describe("AppendOnlyContextManager", () => {
	it("build() returns context with stable prefix on first call", () => {
		const mgr = new AppendOnlyContextManager();
		const ctx = makeContext({
			systemPrompt: ["You are a bot."],
			tools: [makeTool("read")],
		});

		const result = mgr.build(ctx, BUILD_OPTS);

		expect(result.systemPrompt).toEqual(["You are a bot."]);
		expect(result.tools).toHaveLength(1);
		expect(result.messages).toEqual([]);
	});

	it("build() returns same systemPrompt and tools on subsequent calls", () => {
		const mgr = new AppendOnlyContextManager();
		const ctx = makeContext({
			systemPrompt: ["Original prompt"],
			tools: [makeTool("read")],
		});

		mgr.build(ctx, BUILD_OPTS);

		// Same context — should reuse cached prefix
		const result = mgr.build(ctx, BUILD_OPTS);
		expect(result.systemPrompt).toEqual(["Original prompt"]);
		expect(result.tools).toHaveLength(1);
	});

	it("build() detects changed system prompt and rebuilds", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext({ systemPrompt: ["Old"] }), BUILD_OPTS);

		const result = mgr.build(makeContext({ systemPrompt: ["New"] }), BUILD_OPTS);
		expect(result.systemPrompt).toEqual(["New"]);
	});

	it("prefix.fingerprint changes when tools change", () => {
		const mgr = new AppendOnlyContextManager();

		mgr.build(makeContext({ tools: [makeTool("read")] }), BUILD_OPTS);
		const fp1 = mgr.prefix.fingerprint;

		mgr.build(makeContext({ tools: [makeTool("read"), makeTool("write")] }), BUILD_OPTS);
		const fp2 = mgr.prefix.fingerprint;

		expect(fp1).not.toBe(fp2);
	});

	it("appendMessage grows the log", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		mgr.appendMessage({ role: "user", content: "hello" } as any);
		mgr.appendMessage({ role: "assistant", content: "world" } as any);

		const result = mgr.build(makeContext(), BUILD_OPTS);
		expect(result.messages).toHaveLength(2);
		expect(result.messages[0]!.role).toBe("user");
		expect(result.messages[1]!.role).toBe("assistant");
	});

	it("appendMessage messages appear in every subsequent build()", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		mgr.appendMessage({ role: "user", content: "q1" });
		const r1 = mgr.build(makeContext(), BUILD_OPTS);
		expect(r1.messages).toHaveLength(1);

		mgr.appendMessage({ role: "assistant", content: "a1" });
		const r2 = mgr.build(makeContext(), BUILD_OPTS);
		expect(r2.messages).toHaveLength(2);
		expect(r2.messages[1]!.content).toBe("a1");
	});

	it("invalidate forces prefix rebuild", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext({ systemPrompt: ["V1"] }), BUILD_OPTS);

		mgr.invalidate();
		const result = mgr.build(makeContext({ systemPrompt: ["V2"] }), BUILD_OPTS);
		expect(result.systemPrompt).toEqual(["V2"]);
	});

	it("reset clears log and prefix", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext({ systemPrompt: ["Original"] }), BUILD_OPTS);
		mgr.appendMessage({ role: "user", content: "hello" });

		const freshCtx = makeContext({ systemPrompt: ["Fresh start"] });
		mgr.reset(freshCtx, BUILD_OPTS);

		const result = mgr.build(freshCtx, BUILD_OPTS);
		expect(result.systemPrompt).toEqual(["Fresh start"]);
		expect(result.messages).toHaveLength(0);
	});

	it("replaceTailMessage updates last log entry", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);
		mgr.appendMessage({ role: "user", content: "old" });
		mgr.replaceTailMessage({ role: "user", content: "new" });

		const result = mgr.build(makeContext(), BUILD_OPTS);
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0]!.content).toBe("new");
	});

	it("build propagates tool spec description default", () => {
		const mgr = new AppendOnlyContextManager();
		const toolWithNoDesc = makeTool("bare");
		delete (toolWithNoDesc as any).description;

		const ctx = makeContext({ tools: [toolWithNoDesc] });
		const result = mgr.build(ctx, BUILD_OPTS);

		const tool: Tool | undefined = result.tools?.[0];
		expect(tool).toBeDefined();
		expect(tool!.description).toBe("");
	});

	it("tools returned from build are frozen in the cache", () => {
		const mgr = new AppendOnlyContextManager();
		const ctx = makeContext({ tools: [makeTool("read")] });

		const r1 = mgr.build(ctx, BUILD_OPTS);
		const r2 = mgr.build(ctx, BUILD_OPTS);

		expect(r1.tools).toHaveLength(1);
		expect(r2.tools).toHaveLength(1);
		// Same name, same structure
		expect(r1.tools![0]!.name).toBe(r2.tools![0]!.name);
	});

	it("tolerates context with no tools", () => {
		const mgr = new AppendOnlyContextManager();
		const ctx = makeContext({ tools: undefined as any });

		const result = mgr.build(ctx, BUILD_OPTS);
		expect(result.tools).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Fingerprint determinism
// ---------------------------------------------------------------------------

describe("fingerprint determinism", () => {
	it("identical context produces identical fingerprint", () => {
		const p1 = new StablePrefix();
		const p2 = new StablePrefix();

		const ctx = makeContext({
			systemPrompt: ["Rule 1", "Rule 2"],
			tools: [makeTool("read", "Read files"), makeTool("edit", "Edit files")],
		});

		p1.build(ctx, BUILD_OPTS);
		p2.build(ctx, BUILD_OPTS);

		expect(p1.fingerprint).toBe(p2.fingerprint);
	});

	it("tool order changes fingerprint", () => {
		const p1 = new StablePrefix();
		const p2 = new StablePrefix();

		const tools = [makeTool("a", "Tool A"), makeTool("b", "Tool B")];
		p1.build(makeContext({ tools }), BUILD_OPTS);

		// Create a context where tool b has "Tool B" too
		// so the fingerprint changes with name order
		const otherTools = [makeTool("b", "Tool B"), makeTool("a", "Tool A")];
		p2.build(makeContext({ tools: otherTools }), BUILD_OPTS);

		expect(p1.fingerprint).not.toBe(p2.fingerprint);
	});

	it("system prompt array structure changes fingerprint", () => {
		const p1 = new StablePrefix();
		const p2 = new StablePrefix();

		// ["A", "B"] and ["A\nB"] have the same joined text but different
		// array structure — must produce different fingerprints.
		p1.build(makeContext({ systemPrompt: ["A", "B"] }), BUILD_OPTS);
		p2.build(makeContext({ systemPrompt: ["A\nB"] }), BUILD_OPTS);

		expect(p1.fingerprint).not.toBe(p2.fingerprint);
	});
});

// ---------------------------------------------------------------------------
// AppendOnlyLog message sync
// ---------------------------------------------------------------------------

describe("message sync", () => {
	it("syncMessages on first call appends all messages", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const msgs: Message[] = [
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi" },
		] as any;
		mgr.syncMessages(msgs);

		const result = mgr.build(makeContext(), BUILD_OPTS);
		expect(result.messages).toHaveLength(2);
		expect(result.messages[0]!.content).toBe("Hello");
		expect(result.messages[1]!.content).toBe("Hi");
	});

	it("syncMessages on subsequent calls only appends delta", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		mgr.syncMessages([{ role: "user", content: "q1" }]);
		const r1 = mgr.build(makeContext(), BUILD_OPTS);
		expect(r1.messages).toHaveLength(1);

		mgr.syncMessages([
			{ role: "user", content: "q1" },
			{ role: "assistant", content: "a1" },
		]);
		const r2 = mgr.build(makeContext(), BUILD_OPTS);
		expect(r2.messages).toHaveLength(2);
		expect(r2.messages[1]!.content).toBe("a1");
	});

	it("syncMessages with unchanged messages is a no-op (same length, no new entries)", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);
		mgr.syncMessages([{ role: "user", content: "q1" }]);

		const before = mgr.log.length;

		// Same array length → nothing new to append
		mgr.syncMessages([{ role: "user", content: "q1" }]);
		expect(mgr.log.length).toBe(before);
	});

	it("syncMessages resets log when array shrinks (compaction)", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		mgr.syncMessages([
			{ role: "user", content: "q1" },
			{ role: "assistant", content: "a1" },
			{ role: "user", content: "q2" },
		]);
		expect(mgr.log.length).toBe(3);

		// Simulate compaction — array shrinks
		mgr.syncMessages([{ role: "user", content: "q2" }]);
		expect(mgr.log.length).toBe(1);
		expect(mgr.log.toMessages()[0]!.content).toBe("q2");
	});

	it("build + syncMessages integration: messages come from log, not from context.messages", () => {
		const mgr = new AppendOnlyContextManager();

		// First turn: build with empty context, sync first message
		mgr.build(makeContext(), BUILD_OPTS);
		mgr.syncMessages([{ role: "user", content: "turn1" }]);
		const r1 = mgr.build(makeContext(), BUILD_OPTS);
		expect(r1.messages).toHaveLength(1);
		expect(r1.messages[0]!.content).toBe("turn1");

		// Second turn: sync second message
		mgr.syncMessages([
			{ role: "user", content: "turn1" },
			{ role: "assistant", content: "resp1" },
		]);
		const r2 = mgr.build(makeContext(), BUILD_OPTS);
		expect(r2.messages).toHaveLength(2);
		expect(r2.messages[1]!.content).toBe("resp1");
	});

	it("resetSyncCursor forces full re-sync on next call", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);
		mgr.syncMessages([{ role: "user", content: "old" }]);

		mgr.resetSyncCursor();
		mgr.syncMessages([{ role: "user", content: "fresh" }]);

		const result = mgr.build(makeContext(), BUILD_OPTS);
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0]!.content).toBe("fresh");
	});

	it("detects in-place rewrite of already-synced messages", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		// Sync two messages
		mgr.syncMessages([
			{ role: "user", content: "q1" },
			{ role: "assistant", content: "original long result" },
		]);
		expect(mgr.log.length).toBe(2);

		// Same length, but second message content changed (simulates tool-output pruning)
		mgr.syncMessages([
			{ role: "user", content: "q1" },
			{ role: "assistant", content: "[pruned]" },
		]);
		// Log should have been reset and re-synced with the new content
		expect(mgr.log.length).toBe(2);
		const msgs = mgr.build(makeContext(), BUILD_OPTS).messages;
		expect(msgs[1]!.content).toBe("[pruned]");
	});

	it("detects in-place rewrite via digest mismatch", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		mgr.syncMessages([{ role: "user", content: "hello" }]);
		expect(mgr.log.length).toBe(1);

		// Content changed but length same
		mgr.syncMessages([{ role: "user", content: "world" }]);

		const msgs = mgr.build(makeContext(), BUILD_OPTS).messages;
		expect(msgs).toHaveLength(1);
		expect(msgs[0]!.content).toBe("world");
	});

	it("no-op when content unchanged", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		mgr.syncMessages([
			{ role: "user", content: "q1" },
			{ role: "assistant", content: "a1" },
		]);

		const before = mgr.log.length;
		mgr.syncMessages([
			{ role: "user", content: "q1" },
			{ role: "assistant", content: "a1" },
		]);
		// Length unchanged — no new messages appended, no clear
		expect(mgr.log.length).toBe(before);
	});

	it("invalidateForModelChange resets prefix and log", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext({ systemPrompt: ["Before"] }), BUILD_OPTS);
		mgr.syncMessages([{ role: "user", content: "hello" }]);

		mgr.invalidateForModelChange();

		// Should need a fresh build — prefix was invalidated
		const ctx = makeContext({ systemPrompt: ["After"] });
		const result = mgr.build(ctx, BUILD_OPTS);
		expect(result.systemPrompt).toEqual(["After"]);
		expect(result.messages).toHaveLength(0);

		// Re-sync should work cleanly
		mgr.syncMessages([{ role: "user", content: "new turn" }]);
		const r2 = mgr.build(ctx, BUILD_OPTS);
		expect(r2.messages).toHaveLength(1);
		expect(r2.messages[0]!.content).toBe("new turn");
	});
});

// ---------------------------------------------------------------------------
// Intent injection
// ---------------------------------------------------------------------------

describe("intent injection through build()", () => {
	it("injects required `_i` into tool schemas when intentTracing is true", () => {
		const mgr = new AppendOnlyContextManager();
		const tool = makeTool("read", "Read", {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		});
		const ctx = makeContext({ tools: [tool] });

		const result = mgr.build(ctx, { intentTracing: true });
		const params = result.tools?.[0]?.parameters as { properties?: Record<string, unknown>; required?: string[] };
		expect(params?.properties).toBeDefined();
		expect(params!.properties![INTENT_FIELD]).toBeDefined();
		expect(params!.required).toContain(INTENT_FIELD);
	});

	it("materializes ArkType params and keeps `_i` first in authored order", () => {
		const mgr = new AppendOnlyContextManager();
		const tool = makeTool("write", "Write", type({ path: "string", content: "string" }));
		const ctx = makeContext({ tools: [tool] });

		const result = mgr.build(ctx, { intentTracing: true });
		const params = result.tools?.[0]?.parameters as { properties?: Record<string, unknown>; required?: string[] };
		// `_i` must lead; authored order (path before content) is preserved rather
		// than ArkType's alphabetized-by-hash order (content, path).
		expect(Object.keys(params.properties ?? {})).toEqual([INTENT_FIELD, "path", "content"]);
		expect(params.required).toContain(INTENT_FIELD);
	});

	it("omits `_i` when intentTracing is false", () => {
		const mgr = new AppendOnlyContextManager();
		const tool = makeTool("read", "Read", {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		});
		const ctx = makeContext({ tools: [tool] });

		const result = mgr.build(ctx, { intentTracing: false });
		const params = result.tools?.[0]?.parameters as { properties?: Record<string, unknown>; required?: string[] };
		expect(params?.properties?.[INTENT_FIELD]).toBeUndefined();
		expect(params?.required ?? []).not.toContain(INTENT_FIELD);
	});

	it("intentTracing flip invalidates the fingerprint cache", () => {
		const mgr = new AppendOnlyContextManager();
		const ctx = makeContext({ tools: [makeTool("read")] });

		mgr.build(ctx, { intentTracing: false });
		const fpNoIntent = mgr.prefix.fingerprint;

		mgr.build(ctx, { intentTracing: true });
		const fpWithIntent = mgr.prefix.fingerprint;

		expect(fpNoIntent).not.toBe(fpWithIntent);
	});
});

describe("tool examples injection through build()", () => {
	const findExamples: readonly ToolExample[] = [{ caption: "Find files", call: { paths: ["src/**/*.ts"] } }];
	const findParams = {
		type: "object",
		properties: { paths: { type: "array", items: { type: "string" } } },
	};

	it("injects examples when exampleDialect is provided", () => {
		const mgr = new AppendOnlyContextManager();
		const tool = makeTool("find", "Find files.", findParams, findExamples);
		const ctx = makeContext({ tools: [tool] });

		const result = mgr.build(ctx, { intentTracing: false, exampleDialect: "anthropic" });
		const desc = result.tools?.[0]?.description ?? "";
		expect(desc).toContain("<examples>");
		expect(desc).toContain("# Find files");
		expect(desc).toContain('<invoke name="find">');
	});

	it("omits examples when exampleDialect is undefined", () => {
		const mgr = new AppendOnlyContextManager();
		const tool = makeTool("find", "Find files.", findParams, findExamples);
		const ctx = makeContext({ tools: [tool] });

		const result = mgr.build(ctx, { intentTracing: false });
		const desc = result.tools?.[0]?.description ?? "";
		expect(desc).toBe("Find files.");
	});

	it("injects the `_i` placeholder into examples when intentTracing is on", () => {
		const mgr = new AppendOnlyContextManager();
		const tool = makeTool("find", "Find files.", findParams, findExamples);
		const ctx = makeContext({ tools: [tool] });

		const result = mgr.build(ctx, { intentTracing: true, exampleDialect: "anthropic" });
		const desc = result.tools?.[0]?.description ?? "";
		expect(desc).toContain(`<parameter name="${INTENT_FIELD}"`);
		expect(desc).toContain("…");
	});

	it("exampleDialect flip invalidates the fingerprint cache", () => {
		const mgr = new AppendOnlyContextManager();
		const tool = makeTool("find", "Find files.", undefined, findExamples);
		const ctx = makeContext({ tools: [tool] });

		mgr.build(ctx, { intentTracing: false });
		const fpNoExamples = mgr.prefix.fingerprint;

		mgr.build(ctx, { intentTracing: false, exampleDialect: "anthropic" });
		const fpWithExamples = mgr.prefix.fingerprint;

		expect(fpNoExamples).not.toBe(fpWithExamples);
	});
});

// ---------------------------------------------------------------------------
// Tool-call mutation detection
// ---------------------------------------------------------------------------

describe("syncMessages detects tool_calls mutation", () => {
	it("rebuilds the log when tool_calls is mutated in place", () => {
		const mgr = new AppendOnlyContextManager();
		mgr.build(makeContext(), BUILD_OPTS);

		const assistant: Record<string, unknown> = {
			role: "assistant",
			content: null,
			tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"/a"}' } }],
		};
		const msgs = [{ role: "user", content: "q" }, assistant] as unknown as Message[];
		mgr.syncMessages(msgs);
		expect(mgr.log.length).toBe(2);

		// Mutate tool_calls in place — role+content unchanged, so the old
		// (role+content-only) digest would miss this. The full digest must catch it.
		const tcs = assistant.tool_calls as Array<{ function: { arguments: string } }>;
		tcs[0].function.arguments = '{"path":"/b"}';
		mgr.syncMessages(msgs);

		// Log was rebuilt → length resets to the new normalized message list length.
		expect(mgr.log.length).toBe(2);
		const rebuilt = mgr.log.toMessages()[1] as unknown as Record<string, unknown>;
		const rebuiltTc = (rebuilt.tool_calls as Array<{ function: { arguments: string } }>)[0];
		expect(rebuiltTc.function.arguments).toBe('{"path":"/b"}');
	});
});

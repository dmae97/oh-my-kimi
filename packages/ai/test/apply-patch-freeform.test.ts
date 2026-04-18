import { describe, expect, test } from "bun:test";
import { convertTools, supportsFreeformApplyPatch } from "@oh-my-pi/pi-ai/providers/openai-responses";
import {
	appendResponsesToolResultMessages,
	convertResponsesAssistantMessage,
	processResponsesStream,
} from "@oh-my-pi/pi-ai/providers/openai-responses-shared";
import type { AssistantMessage, Model, Tool, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { Type } from "@sinclair/typebox";

const GRAMMAR = 'start: "*** Begin Patch" LF';

function makeModel(overrides: Partial<Model<"openai-responses">> = {}): Model<"openai-responses"> {
	return {
		id: "gpt-5",
		name: "GPT-5",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
		...overrides,
	};
}

const editTool: Tool = {
	name: "edit",
	customWireName: "apply_patch",
	description: "edit files",
	parameters: Type.Object({ input: Type.String() }),
	customFormat: { syntax: "lark", definition: GRAMMAR },
};

const plainTool: Tool = {
	name: "read_file",
	description: "read a file",
	parameters: Type.Object({ path: Type.String() }),
};

describe("supportsFreeformApplyPatch", () => {
	test("absent flag returns false", () => {
		// No auto-detection — requires explicit opt-in in models.json.
		expect(supportsFreeformApplyPatch(makeModel())).toBe(false);
	});

	test("applyPatchToolType: freeform enables", () => {
		expect(supportsFreeformApplyPatch(makeModel({ applyPatchToolType: "freeform" }))).toBe(true);
	});

	test("applyPatchToolType: function disables", () => {
		expect(supportsFreeformApplyPatch(makeModel({ applyPatchToolType: "function" }))).toBe(false);
	});

	test("flag is the sole signal — id/baseUrl are irrelevant", () => {
		expect(
			supportsFreeformApplyPatch(
				makeModel({ id: "gpt-4", baseUrl: "https://proxy.example/", applyPatchToolType: "freeform" }),
			),
		).toBe(true);
		expect(supportsFreeformApplyPatch(makeModel({ id: "gpt-5", baseUrl: "https://api.openai.com/v1" }))).toBe(false);
	});
});

describe("convertTools: freeform emission", () => {
	const freeformModel = makeModel({ applyPatchToolType: "freeform" });

	test("edit tool with customFormat becomes a custom grammar tool", () => {
		const [out] = convertTools([editTool], false, freeformModel) as unknown as Array<Record<string, unknown>>;
		expect(out.type).toBe("custom");
		expect(out.name).toBe("apply_patch"); // wire name from tool.customWireName
		expect(out.format).toEqual({ type: "grammar", syntax: "lark", definition: GRAMMAR });
	});

	test("regular tools remain function-type alongside a custom one", () => {
		const out = convertTools([editTool, plainTool], false, freeformModel) as unknown as Array<
			Record<string, unknown>
		>;
		expect(out[0].type).toBe("custom");
		expect(out[1].type).toBe("function");
		expect(out[1].name).toBe("read_file");
	});

	test("falls back to function tool when flag is absent", () => {
		const [out] = convertTools([editTool], false, makeModel()) as unknown as Array<Record<string, unknown>>;
		expect(out.type).toBe("function");
		expect(out.name).toBe("edit");
	});

	test("applyPatchToolType=function explicitly disables", () => {
		const [out] = convertTools([editTool], false, makeModel({ applyPatchToolType: "function" })) as unknown as Array<
			Record<string, unknown>
		>;
		expect(out.type).toBe("function");
	});
});

describe("custom_tool_call stream receive", () => {
	async function* makeStream(events: unknown[]): AsyncIterable<any> {
		for (const e of events) yield e;
	}

	test("aggregates delta events into a ToolCall with input arg", async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			timestamp: Date.now(),
			provider: "openai",
			model: "gpt-5",
			api: "openai-responses",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
		};
		const emitted: unknown[] = [];
		const stream = {
			push: (e: unknown) => emitted.push(e),
			end: () => {},
		} as never;

		const events = [
			{
				type: "response.output_item.added",
				item: {
					type: "custom_tool_call",
					id: "ctc_1",
					call_id: "call_1",
					name: "apply_patch",
					input: "",
				},
			},
			{
				type: "response.custom_tool_call_input.delta",
				delta: "*** Begin Patch\n",
			},
			{
				type: "response.custom_tool_call_input.delta",
				delta: "*** End Patch\n",
			},
			{
				type: "response.custom_tool_call_input.done",
				input: "*** Begin Patch\n*** End Patch\n",
			},
			{
				type: "response.output_item.done",
				item: {
					type: "custom_tool_call",
					id: "ctc_1",
					call_id: "call_1",
					name: "apply_patch",
					input: "*** Begin Patch\n*** End Patch\n",
				},
			},
		];

		await processResponsesStream(makeStream(events), output, stream, makeModel());

		const block = output.content[0];
		expect(block?.type).toBe("toolCall");
		const tool = block as {
			type: "toolCall";
			name: string;
			arguments: Record<string, unknown>;
			customWireName?: string;
		};
		// Wire name passes through unchanged — the agent-loop dispatcher
		// matches against both `Tool.name` and `Tool.customWireName`.
		expect(tool.name).toBe("apply_patch");
		expect(tool.customWireName).toBe("apply_patch");
		expect(tool.arguments.input).toBe("*** Begin Patch\n*** End Patch\n");

		// toolcall_end event carries the final ToolCall
		const endEvent = emitted.find(
			(
				e,
			): e is {
				type: string;
				toolCall: { name: string; arguments: Record<string, unknown>; customWireName?: string };
			} => !!e && typeof e === "object" && (e as { type?: string }).type === "toolcall_end",
		);
		expect(endEvent?.toolCall.name).toBe("apply_patch");
		expect(endEvent?.toolCall.customWireName).toBe("apply_patch");
	});
});

describe("codex-backend convertTools (chatgpt.com/backend-api)", () => {
	// Dynamic import: loading the codex provider pulls in heavy SDK code we
	// don't want mixed into module-resolve for unrelated tests.
	async function getCodexConvertTools() {
		const mod = (await import("@oh-my-pi/pi-ai/providers/openai-codex-responses")) as {
			convertTools: (tools: Tool[], model: Model<"openai-codex-responses">) => Array<Record<string, unknown>>;
		};
		return mod.convertTools;
	}

	function makeCodexModel(overrides: Partial<Model<"openai-codex-responses">> = {}): Model<"openai-codex-responses"> {
		return {
			id: "gpt-5",
			name: "GPT-5",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272000,
			maxTokens: 128000,
			...overrides,
		};
	}

	test("edit tool with customFormat becomes a custom grammar tool when flag is set", async () => {
		const codexConvertTools = await getCodexConvertTools();
		const [out] = codexConvertTools([editTool], makeCodexModel({ applyPatchToolType: "freeform" }));
		expect(out.type).toBe("custom");
		expect(out.name).toBe("apply_patch");
		expect(out.format).toEqual({ type: "grammar", syntax: "lark", definition: GRAMMAR });
	});

	test("wire shape matches direct-OpenAI convertTools (single serializer contract)", async () => {
		const codexConvertTools = await getCodexConvertTools();
		const [codexOut] = codexConvertTools([editTool], makeCodexModel({ applyPatchToolType: "freeform" }));
		const [openaiOut] = convertTools(
			[editTool],
			false,
			makeModel({ applyPatchToolType: "freeform" }),
		) as unknown as Array<Record<string, unknown>>;
		expect(codexOut).toEqual(openaiOut);
	});

	test("falls back to function tool when flag is absent", async () => {
		const codexConvertTools = await getCodexConvertTools();
		const [out] = codexConvertTools([editTool], makeCodexModel());
		expect(out.type).toBe("function");
		expect(out.name).toBe("edit");
	});
});

describe("dispatcher wire-name matching", () => {
	test("ToolCall.name matches a Tool via its customWireName", () => {
		// Simulate what agent-loop.ts:455-465 does.
		const editLikeTool: Tool & { customWireName?: string } = {
			name: "edit",
			customWireName: "apply_patch",
			description: "edit files",
			parameters: Type.Object({ input: Type.String() }),
			customFormat: { syntax: "lark", definition: GRAMMAR },
		};
		const readTool: Tool = {
			name: "read_file",
			description: "read",
			parameters: Type.Object({ path: Type.String() }),
		};
		const tools = [editLikeTool, readTool];
		const toolCall = { name: "apply_patch" };

		const matched =
			tools.find(t => t.name === toolCall.name) ??
			tools.find(
				(t): t is typeof t & { customWireName: string } =>
					(t as { customWireName?: string }).customWireName !== undefined &&
					(t as { customWireName?: string }).customWireName === toolCall.name,
			);
		expect(matched).toBe(editLikeTool);
	});

	test("prefers name over customWireName when both would match", () => {
		// A pathological tool set: one tool named `foo`, another with
		// customWireName `foo`. Internal name wins.
		const nameMatch: Tool = {
			name: "foo",
			description: "",
			parameters: Type.Object({}),
		};
		const wireMatch: Tool & { customWireName: string } = {
			name: "bar",
			customWireName: "foo",
			description: "",
			parameters: Type.Object({}),
		};
		const tools = [wireMatch, nameMatch]; // wireMatch listed first
		const toolCall = { name: "foo" };

		const matched =
			tools.find(t => t.name === toolCall.name) ??
			tools.find(
				(t): t is typeof t & { customWireName: string } =>
					(t as { customWireName?: string }).customWireName !== undefined &&
					(t as { customWireName?: string }).customWireName === toolCall.name,
			);
		expect(matched).toBe(nameMatch);
	});
});

describe("history replay: custom_tool_call round-trip", () => {
	test("assistant tool-call block with customWireName replays as custom_tool_call", () => {
		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_1|ctc_1",
					name: "edit",
					arguments: { input: "*** Begin Patch\n*** End Patch\n" },
					customWireName: "apply_patch",
				},
			],
			timestamp: Date.now(),
			provider: "openai",
			model: "gpt-5",
			api: "openai-responses",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
		};
		const knownCallIds = new Set<string>();
		const customCallIds = new Set<string>();
		const items = convertResponsesAssistantMessage(assistantMsg, makeModel(), 0, knownCallIds, true, customCallIds);

		expect(items).toHaveLength(1);
		const item = items[0] as { type: string; name?: string; input?: string };
		expect(item.type).toBe("custom_tool_call");
		expect(item.name).toBe("apply_patch");
		expect(item.input).toBe("*** Begin Patch\n*** End Patch\n");
		expect(customCallIds.has("call_1")).toBe(true);
	});

	test("paired tool result emits custom_tool_call_output when custom id is tracked", () => {
		const messages: unknown[] = [];
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "edit",
			isError: false,
			content: [{ type: "text", text: "Success. Updated the following files:\nM foo.txt" }],
			timestamp: Date.now(),
		};
		const knownCallIds = new Set<string>(["call_1"]);
		const customCallIds = new Set<string>(["call_1"]);

		appendResponsesToolResultMessages(messages as never, toolResult, makeModel(), true, knownCallIds, customCallIds);

		expect(messages).toHaveLength(1);
		const item = messages[0] as { type: string; call_id: string; output: string };
		expect(item.type).toBe("custom_tool_call_output");
		expect(item.call_id).toBe("call_1");
		expect(item.output).toContain("Success");
	});

	test("tool result for a non-custom call still emits function_call_output", () => {
		const messages: unknown[] = [];
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_2",
			toolName: "read_file",
			isError: false,
			content: [{ type: "text", text: "ok" }],
			timestamp: Date.now(),
		};
		const knownCallIds = new Set<string>(["call_2"]);
		const customCallIds = new Set<string>(); // call_2 not custom

		appendResponsesToolResultMessages(messages as never, toolResult, makeModel(), true, knownCallIds, customCallIds);

		const item = messages[0] as { type: string };
		expect(item.type).toBe("function_call_output");
	});
});

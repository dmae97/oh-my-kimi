import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Context, ToolCall, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai";
import {
	createInbandScanner,
	encodeInbandToolHistory,
	type GrammarToolResult,
	getInbandGrammar,
	type InbandScanEvent,
	parseInbandToolMessage,
	renderInbandToolPrompt,
	type ToolCallSyntax,
} from "@oh-my-pi/pi-ai/grammar";

const TOOLS = [
	{
		name: "read",
		description: "Read a file",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, count: { type: "number" } },
			required: ["path"],
		},
	},
	{
		name: "write",
		description: "Write a file",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, content: { type: "string" } },
			required: ["path", "content"],
		},
	},
] as unknown as NonNullable<Context["tools"]>;

const SYNTAXES: readonly ToolCallSyntax[] = [
	"glm",
	"hermes",
	"kimi",
	"xml",
	"anthropic",
	"deepseek",
	"harmony",
	"pi",
	"qwen3",
	"gemini",
	"gemma",
];

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: usage(),
		stopReason: "toolUse",
		timestamp: 0,
	};
}

function result(toolCallId: string, toolName: string, text: string, isError = false): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError, timestamp: 0 };
}

function feedText(syntax: ToolCallSyntax, text: string): InbandScanEvent[] {
	const scanner = createInbandScanner(syntax, { tools: TOOLS, parseThinking: true });
	const events: InbandScanEvent[] = [];
	for (const char of text) events.push(...scanner.feed(char));
	events.push(...scanner.flush());
	return events;
}

function toolEnds(events: readonly InbandScanEvent[]): Extract<InbandScanEvent, { type: "toolEnd" }>[] {
	return events.filter((event): event is Extract<InbandScanEvent, { type: "toolEnd" }> => event.type === "toolEnd");
}

function firstRawBlock(syntax: ToolCallSyntax, text: string): string | undefined {
	return toolEnds(feedText(syntax, text))[0]?.rawBlock;
}

function expectRawBlock(syntax: ToolCallSyntax, text: string, expected: string): void {
	expect(firstRawBlock(syntax, text), syntax).toBe(expected);
}

describe("in-band tool grammars", () => {
	it("renders a tool prompt for every syntax", () => {
		for (const syntax of SYNTAXES) {
			const prompt = renderInbandToolPrompt(TOOLS, syntax);
			expect(prompt).toContain("<tools>");
			expect(prompt).toContain("</tools>");
			expect(prompt).toContain('"name":"read"');
			expect(prompt).toContain(getInbandGrammar(syntax).prompt.trim().split("\n", 1)[0]!);
		}
	});

	it("each grammar renders calls that its scanner parses back", () => {
		const call: ToolCall = {
			type: "toolCall",
			id: "functions.read:0",
			name: "read",
			arguments: { path: "src/a.ts", count: 2 },
		};
		for (const syntax of SYNTAXES) {
			const grammar = getInbandGrammar(syntax);
			const rendered = grammar.renderAssistantToolCalls([call], { tools: TOOLS });
			const calls = toolEnds(feedText(syntax, rendered));
			expect(calls, syntax).toHaveLength(1);
			expect(calls[0]!.name).toBe("read");
			expect(calls[0]!.arguments).toEqual({ path: "src/a.ts", count: 2 });
		}
	});

	it("captures exact raw tool call blocks for debugging", () => {
		expectRawBlock(
			"glm",
			"<tool_call>read\n<arg_key>path</arg_key>\n<arg_value>src/a.ts</arg_value>\n</tool_call>",
			"<tool_call>read\n<arg_key>path</arg_key>\n<arg_value>src/a.ts</arg_value>\n</tool_call>",
		);
		expectRawBlock(
			"kimi",
			'<|tool_calls_section_begin|><|tool_call_begin|>functions.read:0<|tool_call_argument_begin|>  {"path":"src/a.ts"}\n<|tool_call_end|><|tool_calls_section_end|>',
			'<|tool_call_begin|>functions.read:0<|tool_call_argument_begin|>  {"path":"src/a.ts"}\n<|tool_call_end|>',
		);
		expectRawBlock(
			"deepseek",
			'<｜DSML｜tool_calls>\n<｜DSML｜invoke name="read">\n <｜DSML｜parameter name="path" string="true">src/a.ts</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>',
			'<｜DSML｜invoke name="read">\n <｜DSML｜parameter name="path" string="true">src/a.ts</｜DSML｜parameter>\n</｜DSML｜invoke>',
		);
		expectRawBlock(
			"xml",
			'<function_calls>\n<invoke name="read"><parameter name="path" string="true">src/a.ts</parameter></invoke>\n</function_calls>',
			'<invoke name="read"><parameter name="path" string="true">src/a.ts</parameter></invoke>',
		);
		expectRawBlock(
			"harmony",
			'<|start|>assistant<|channel|>commentary to=functions.read<|message|>{"path":"src/a.ts"}<|call|>',
			'<|start|>assistant<|channel|>commentary to=functions.read<|message|>{"path":"src/a.ts"}<|call|>',
		);
		expectRawBlock(
			"pi",
			'<call:write path="out.ts">\nhello\n</call:write>',
			'<call:write path="out.ts">\nhello\n</call:write>',
		);
	});

	it("projects raw tool blocks onto parsed ToolCall content", () => {
		const raw = '<|start|>assistant<|channel|>commentary to=functions.read<|message|>{"path":"src/a.ts"}<|call|>';
		const parsed = parseInbandToolMessage(assistant([{ type: "text", text: raw }]), "harmony", TOOLS);
		const call = parsed.content.find((block): block is ToolCall => block.type === "toolCall");

		expect(call?.rawBlock).toBe(raw);
	});

	it("stops before hallucinated Anthropic function results", () => {
		const parsed = parseInbandToolMessage(
			assistant([
				{
					type: "text",
					text: '<invoke name="read"><parameter name="path">rubygems.ts:85-93</parameter></invoke>\n<function_results>\n<result>\n<tool_name>read</tool_name>\n<stdout>[rubygems.ts#A1B2]</stdout>\n</result>\n</function_results>\n<invoke name="edit"><parameter name="input">[rubygems.ts#A1B2]\nSWAP 89..89:\n+ fake</parameter></invoke>',
				},
			]),
			"anthropic",
			TOOLS,
		);
		const calls = parsed.content.filter((block): block is ToolCall => block.type === "toolCall");

		expect(calls.map(call => call.name)).toEqual(["read"]);
		expect(calls[0]?.arguments).toEqual({ path: "rubygems.ts:85-93" });
	});

	it("keeps result rendering in the owning grammar", () => {
		const resultBlock: GrammarToolResult = {
			id: "functions.read:0",
			name: "read",
			index: 0,
			text: "FILE",
			isError: false,
		};
		expect(getInbandGrammar("glm").renderToolResults([resultBlock])).toBe(
			"<observation>\n<tool_response>\nFILE\n</tool_response>\n</observation>",
		);
		expect(getInbandGrammar("deepseek").renderToolResults([resultBlock])).toBe(
			"<｜tool▁output▁begin｜>FILE<｜tool▁output▁end｜>",
		);
		expect(getInbandGrammar("kimi").renderToolResults([resultBlock])).toBe(
			"<|im_system|>read<|im_middle|>## Return of functions.read:0\nFILE<|im_end|>",
		);
		expect(getInbandGrammar("harmony").renderToolResults([resultBlock])).toBe(
			"<|start|>functions.read to=assistant<|channel|>commentary<|message|>FILE<|end|>",
		);
		expect(getInbandGrammar("anthropic").renderToolResults([resultBlock])).toBe(
			"<function_results>\n<result>\n<tool_name>read</tool_name>\n<stdout>FILE</stdout>\n</result>\n</function_results>",
		);
		expect(getInbandGrammar("qwen3").renderToolResults([resultBlock])).toBe(
			"<tool_response>\nFILE\n</tool_response>",
		);
		expect(getInbandGrammar("pi").renderToolResults([resultBlock])).toBe("<tool_response>\nFILE\n</tool_response>");
		expect(getInbandGrammar("gemini").renderToolResults([resultBlock])).toBe("```tool_outputs\nFILE\n```");
		expect(getInbandGrammar("gemma").renderToolResults([resultBlock])).toBe(
			'<|tool_response>response:read{output:<|"|>FILE<|"|>}<tool_response|>',
		);
	});

	it("encodes assistant calls and tool results through the selected grammar", () => {
		const history: Context["messages"] = [
			{ role: "user", content: "hi", timestamp: 0 },
			assistant([
				{ type: "text", text: "let me read" },
				{ type: "toolCall", id: "functions.read:0", name: "read", arguments: { path: "a.ts" } },
			]),
			result("functions.read:0", "read", "FILE A"),
		];
		const enc = encodeInbandToolHistory(history, "kimi", TOOLS);
		expect(enc[0]).toBe(history[0]);
		expect(enc[1]!.role).toBe("assistant");
		expect(enc[2]!.role).toBe("user");
		const assistantBlock = (enc[1] as AssistantMessage).content[0]!;
		const assistantText = assistantBlock.type === "text" ? assistantBlock.text : "";
		expect(assistantText).toContain("<|tool_calls_section_begin|>");
		expect(assistantText).toContain("functions.read:0");
		const resultText =
			Array.isArray(enc[2]!.content) && enc[2]!.content[0]!.type === "text" ? enc[2]!.content[0]!.text : "";
		expect(resultText).toBe("<|im_system|>read<|im_middle|>## Return of functions.read:0\nFILE A<|im_end|>");
	});

	it("streams string arguments incrementally for GLM", () => {
		const text = getInbandGrammar("glm").renderAssistantToolCalls(
			[
				{
					type: "toolCall",
					id: "c1",
					name: "write",
					arguments: { path: "out.ts", content: "line1\nconst x = `a`;" },
				},
			],
			{ tools: TOOLS },
		);
		const deltas = feedText("glm", text)
			.filter(
				(event): event is Extract<InbandScanEvent, { type: "toolArgDelta" }> =>
					event.type === "toolArgDelta" && event.key === "content",
			)
			.map(event => event.delta)
			.join("");
		expect(deltas).toBe("line1\nconst x = `a`;");
	});
});

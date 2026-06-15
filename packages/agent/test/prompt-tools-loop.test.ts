import { describe, expect, it } from "bun:test";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage, Context, Message, TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { z } from "zod/v4";
import { createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function wireText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return (message.content as (TextContent | { type: string })[])
		.map(b => (b.type === "text" ? (b as TextContent).text : ""))
		.join("");
}

describe("agentLoop with owned in-band tool calls", () => {
	it("executes <tool_call> text, strips native tools from the wire, and re-encodes history as text", async () => {
		const echoArgs: Array<{ msg: string }> = [];
		const toolSchema = z.object({ msg: z.string().describe("message to echo") });
		const echoTool: AgentTool<typeof toolSchema, { msg: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo a message back",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				echoArgs.push(params);
				return { content: [{ type: "text", text: `echoed:${params.msg}` }], details: params };
			},
		};

		const captured: Context[] = [];
		const mock = createMockModel({
			responses: [
				context => {
					captured.push(context);
					return {
						content: [
							"on it\n<tool_call>echo\n<arg_key>msg</arg_key>\n<arg_value>hello world</arg_value>\n</tool_call>",
						],
					};
				},
				context => {
					captured.push(context);
					return { content: ["all done"] };
				},
			],
		});

		const context: AgentContext = { systemPrompt: ["BASE PROMPT"], messages: [], tools: [echoTool] };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter, toolCallSyntax: "glm" };

		const messages = await agentLoop([createUserMessage("say hi")], context, config, undefined, mock.stream).result();

		// The tool was actually executed with the parsed (verbatim) argument.
		expect(echoArgs).toEqual([{ msg: "hello world" }]);
		expect(captured).toHaveLength(2);

		// First request: no native tools on the wire; catalog + grammar injected.
		expect(captured[0].tools).toBeUndefined();
		const sys0 = captured[0].systemPrompt ?? [];
		expect(sys0[0]).toBe("BASE PROMPT");
		const promptSection = sys0.join("\n");
		expect(promptSection).toContain("<tools>");
		expect(promptSection).toContain('"name":"echo"');
		expect(promptSection).toContain("YOU MUST EMIT THE STOP SEQUENCE AND HALT");

		// Second request: the wire carries NO native tool blocks — prior call/result
		// are plain <tool_call> / <tool_response> text, and tools are still stripped.
		const wire2 = captured[1].messages;
		expect(captured[1].tools).toBeUndefined();
		for (const m of wire2) {
			expect(m.role).not.toBe("toolResult");
			if (m.role === "assistant") {
				expect((m.content as { type: string }[]).some(b => b.type === "toolCall")).toBe(false);
			}
		}
		const wireAssistant = wire2.find(m => m.role === "assistant");
		expect(wireAssistant).toBeDefined();
		const at = wireText(wireAssistant!);
		expect(at).toContain("on it");
		expect(at).toContain("<tool_call>echo");
		expect(at).toContain("<arg_value>hello world</arg_value>");
		const resultsText = wire2
			.filter(m => m.role === "user")
			.map(wireText)
			.join("\n");
		expect(resultsText).toContain("<tool_response>");
		expect(resultsText).toContain("echoed:hello world");

		// The internal store stays canonical: native toolCall block + toolResult message.
		const internalAssistant = messages.find(
			(m): m is AssistantMessage => m.role === "assistant" && m.content.some(b => b.type === "toolCall"),
		);
		expect(internalAssistant).toBeDefined();
		const internalResult = messages.find((m): m is ToolResultMessage => m.role === "toolResult");
		expect(internalResult).toBeDefined();
		expect(internalResult!.toolName).toBe("echo");
		expect(wireText(internalResult!)).toBe("echoed:hello world");
	});

	it("executes Hermes/Qwen JSON tool calls when that syntax is selected", async () => {
		const echoArgs: Array<{ msg: string }> = [];
		const toolSchema = z.object({ msg: z.string().describe("message to echo") });
		const echoTool: AgentTool<typeof toolSchema, { msg: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo a message back",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				echoArgs.push(params);
				return { content: [{ type: "text", text: `echoed:${params.msg}` }], details: params };
			},
		};

		const captured: Context[] = [];
		const mock = createMockModel({
			responses: [
				context => {
					captured.push(context);
					return { content: ['<tool_call>\n{"name":"echo","arguments":{"msg":"hi"}}\n</tool_call>'] };
				},
				context => {
					captured.push(context);
					return { content: ["done"] };
				},
			],
		});

		const context: AgentContext = { systemPrompt: ["BASE PROMPT"], messages: [], tools: [echoTool] };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter, toolCallSyntax: "hermes" };

		await agentLoop([createUserMessage("say hi")], context, config, undefined, mock.stream).result();

		expect(echoArgs).toEqual([{ msg: "hi" }]);
		expect(captured[0].tools).toBeUndefined();
		expect((captured[0].systemPrompt ?? []).join("\n")).toContain('"name":"function_name","arguments"');
		const resultsText = captured[1].messages
			.filter(m => m.role === "user")
			.map(wireText)
			.join("\n");
		expect(resultsText).toContain("<tool_response>");
		expect(resultsText).toContain("echoed:hi");
	});
});

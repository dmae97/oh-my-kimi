import type { ToolCall } from "../types";
import { getInbandGrammar } from "./factory";
import type { InbandTool, ToolCallSyntax } from "./types";

const INTENT_PLACEHOLDER = "…";

export function renderToolExamples(tool: InbandTool, syntax: ToolCallSyntax, intentField?: string): string {
	const examples = tool.examples;
	if (!examples?.length) return "";
	const grammar = getInbandGrammar(syntax);
	const renderCall = (args: Record<string, unknown>): string => {
		// When intent tracing injects `_i` into the schema, examples must show a
		// placeholder so the model learns to emit it. Keep it first, matching the
		// schema injection order.
		const finalArgs = intentField ? { [intentField]: INTENT_PLACEHOLDER, ...args } : args;
		const call: ToolCall = {
			type: "toolCall",
			id: "example",
			name: tool.name,
			arguments: finalArgs,
		};
		return `<example>\n${grammar.renderToolCall(call, { tools: [tool], example: true }).trim()}\n</example>`;
	};
	const parts = examples.map(ex => {
		const head = ex.caption ? `# ${ex.caption}\n` : "";
		if ("call" in ex) return head + renderCall(ex.call);
		if ("good" in ex) {
			return `${head}WRONG:\n${renderCall(ex.bad)}\nRIGHT:\n${renderCall(ex.good)}`;
		}
		return head.trimEnd() + (ex.note ? `\n${ex.note}` : "");
	});
	return `<examples>\n${parts.join("\n")}\n</examples>`;
}

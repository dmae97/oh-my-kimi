import { toolWireSchema } from "../utils/schema";
import { getInbandGrammar } from "./factory";
import promptTemplate from "./prompt-template.md" with { type: "text" };
import type { InbandTool, ToolCallSyntax } from "./types";

const TOOLS_TOKEN = "{{TOOLS}}";
const GRAMMAR_TOKEN = "{{GRAMMAR}}";

export function renderToolCatalog(tools: readonly InbandTool[]): string {
	return tools
		.map(tool =>
			JSON.stringify({
				type: "function",
				function: {
					name: tool.name,
					description: tool.description ?? "",
					parameters: toolWireSchema(tool),
				},
			}),
		)
		.join("\n");
}

export function renderInbandToolPrompt(tools: readonly InbandTool[], syntax: ToolCallSyntax): string {
	const prompt = getInbandGrammar(syntax).prompt.trim();
	return promptTemplate.replace(TOOLS_TOKEN, () => renderToolCatalog(tools)).replace(GRAMMAR_TOKEN, () => prompt);
}

import { modelFamilyToken } from "./family";

export type ToolCallSyntax =
	| "glm"
	| "hermes"
	| "kimi"
	| "xml"
	| "anthropic"
	| "deepseek"
	| "harmony"
	| "pi"
	| "qwen3"
	| "gemini"
	| "gemma";

export const FALLBACK_TOOL_SYNTAX: ToolCallSyntax = "xml";

export function preferredToolSyntax(modelId: string): ToolCallSyntax {
	switch (modelFamilyToken(modelId)) {
		case "anthropic":
			return "anthropic";
		case "glm":
			return "glm";
		case "gemini":
			return "gemini";
		case "gemma":
			return "gemma";
		case "kimi":
			return "kimi";
		case "qwen":
			return "qwen3";
		case "deepseek":
			return "deepseek";
		case "openai":
		case "gpt-oss":
			return "harmony";
		default:
			return FALLBACK_TOOL_SYNTAX;
	}
}

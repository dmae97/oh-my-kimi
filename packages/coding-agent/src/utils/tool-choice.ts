import type { Api, Model, ToolChoice } from "@oh-my-pi/pi-ai";

/**
 * Build a provider-aware tool choice that targets one specific tool when supported.
 * Some providers only support "any tool" forcing, not a named tool.
 */
export function buildNamedToolChoice(toolName: string, model?: Model<Api>): ToolChoice | undefined {
	if (!model) return undefined;

	if (model.api === "anthropic-messages" || model.api === "bedrock-converse-stream") {
		return { type: "tool", name: toolName };
	}

	if (
		model.api === "openai-codex-responses" ||
		model.api === "openai-responses" ||
		model.api === "openai-completions" ||
		model.api === "azure-openai-responses"
	) {
		return { type: "function", name: toolName };
	}

	if (
		model.api === "google-generative-ai" ||
		model.api === "google-gemini-cli" ||
		model.api === "google-vertex" ||
		model.api === "ollama-chat"
	) {
		return "required";
	}

	return undefined;
}

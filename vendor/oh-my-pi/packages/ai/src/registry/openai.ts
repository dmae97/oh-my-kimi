import type { ProviderDefinition } from "./types";

export const openaiProvider = {
	id: "openai",
	name: "OpenAI",
} as const satisfies ProviderDefinition;

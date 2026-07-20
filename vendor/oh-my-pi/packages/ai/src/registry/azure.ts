import type { ProviderDefinition } from "./types";

export const azureProvider = {
	id: "azure",
	name: "Azure OpenAI",
} as const satisfies ProviderDefinition;

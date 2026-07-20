import type { ProviderDefinition } from "./types";

export const mistralProvider = {
	id: "mistral",
	name: "Mistral",
} as const satisfies ProviderDefinition;

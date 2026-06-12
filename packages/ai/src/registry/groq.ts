import type { ProviderDefinition } from "./types";

export const groqProvider = {
	id: "groq",
	name: "Groq",
} as const satisfies ProviderDefinition;

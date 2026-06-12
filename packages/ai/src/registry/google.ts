import type { ProviderDefinition } from "./types";

export const googleProvider = {
	id: "google",
	name: "Google Gemini",
} as const satisfies ProviderDefinition;

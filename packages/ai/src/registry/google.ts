import { googleModelManagerOptions } from "../provider-models/google";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

export const googleProvider = {
	id: "google",
	name: "Google Gemini",
	defaultModel: "gemini-2.5-pro",
	createModelManagerOptions: (config: ModelManagerConfig) => googleModelManagerOptions(config),
	envKeys: "GEMINI_API_KEY",
} as const satisfies ProviderDefinition;

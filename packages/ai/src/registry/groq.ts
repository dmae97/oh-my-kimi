import { groqModelManagerOptions } from "../provider-models/openai-compat";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

export const groqProvider = {
	id: "groq",
	name: "Groq",
	defaultModel: "openai/gpt-oss-120b",
	createModelManagerOptions: (config: ModelManagerConfig) => groqModelManagerOptions(config),
	envKeys: "GROQ_API_KEY",
} as const satisfies ProviderDefinition;

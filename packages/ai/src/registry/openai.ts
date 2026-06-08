import { openaiModelManagerOptions } from "../provider-models/openai-compat";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

export const openaiProvider = {
	id: "openai",
	name: "OpenAI",
	defaultModel: "gpt-5.4",
	createModelManagerOptions: (config: ModelManagerConfig) => openaiModelManagerOptions(config),
	envKeys: "OPENAI_API_KEY",
} as const satisfies ProviderDefinition;

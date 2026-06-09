import { xaiModelManagerOptions } from "../provider-models/openai-compat";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

export const xaiProvider = {
	id: "xai",
	name: "xAI",
	defaultModel: "grok-4-fast-non-reasoning",
	createModelManagerOptions: (config: ModelManagerConfig) => xaiModelManagerOptions(config),
	envKeys: "XAI_API_KEY",
} as const satisfies ProviderDefinition;

import { mistralModelManagerOptions } from "../provider-models/openai-compat";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

export const mistralProvider = {
	id: "mistral",
	name: "Mistral",
	defaultModel: "devstral-medium-latest",
	createModelManagerOptions: (config: ModelManagerConfig) => mistralModelManagerOptions(config),
	envKeys: "MISTRAL_API_KEY",
} as const satisfies ProviderDefinition;

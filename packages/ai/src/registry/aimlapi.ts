import { aimlApiModelManagerOptions } from "../provider-models/openai-compat";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

export const aimlApiProvider = {
	id: "aimlapi",
	name: "AIML API",
	defaultModel: "gpt-4o",
	createModelManagerOptions: (config: ModelManagerConfig) => aimlApiModelManagerOptions(config),
	dynamicModelsAuthoritative: true,
	catalogDiscovery: { label: "AIML API", envVars: ["AIMLAPI_API_KEY"] },
	envKeys: "AIMLAPI_API_KEY",
} as const satisfies ProviderDefinition;

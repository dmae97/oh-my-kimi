import { opencodeZenModelManagerOptions } from "../provider-models/openai-compat";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

export const opencodeZenProvider = {
	id: "opencode-zen",
	name: "OpenCode Zen",
	defaultModel: "claude-sonnet-4-6",
	createModelManagerOptions: (config: ModelManagerConfig) => opencodeZenModelManagerOptions(config),
	envKeys: "OPENCODE_API_KEY",
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginOpenCode } = await import("./oauth/opencode");
		return loginOpenCode(cb);
	},
} as const satisfies ProviderDefinition;

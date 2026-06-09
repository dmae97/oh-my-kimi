import { opencodeGoModelManagerOptions } from "../provider-models/openai-compat";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ModelManagerConfig, ProviderDefinition } from "./types";

export const opencodeGoProvider = {
	id: "opencode-go",
	name: "OpenCode Go",
	defaultModel: "kimi-k2.5",
	createModelManagerOptions: (config: ModelManagerConfig) => opencodeGoModelManagerOptions(config),
	envKeys: "OPENCODE_API_KEY",
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginOpenCode } = await import("./oauth/opencode");
		return loginOpenCode(cb);
	},
} as const satisfies ProviderDefinition;

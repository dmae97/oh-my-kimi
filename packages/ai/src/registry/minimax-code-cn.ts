import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const minimaxCodeCnProvider = {
	id: "minimax-code-cn",
	name: "MiniMax Coding Plan (China)",
	defaultModel: "MiniMax-M2.5",
	envKeys: "MINIMAX_CODE_CN_API_KEY",
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginMiniMaxCodeCn } = await import("./oauth/minimax-code");
		return loginMiniMaxCodeCn(cb);
	},
} as const satisfies ProviderDefinition;

import type { ProviderDefinition } from "./types";

export const minimaxProvider = {
	id: "minimax",
	name: "MiniMax",
	defaultModel: "MiniMax-M2.5",
	envKeys: "MINIMAX_API_KEY",
} as const satisfies ProviderDefinition;

import type { Api, Model } from "../../types";

export function createProviderErrorMessage(model: Model<Api>, err: unknown) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error" as const,
		timestamp: Date.now(),
	};
}

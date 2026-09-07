import { describe, expect, it } from "vitest";
import {
	assertModelContract,
	type ModelContract,
	type RouteRequest,
	resolveRouteDecision,
} from "../src/run-model-contract.ts";

const TEXT_MODEL = { provider: "deepseek", id: "deepseek-chat", input: ["text"] as readonly string[] };
const VISION_MODEL = { provider: "openai-codex", id: "gpt-5.6-luna", input: ["text", "image"] as readonly string[] };

const BASE_REQUEST: RouteRequest = {
	model: TEXT_MODEL,
	provider: "deepseek",
	thinking: false,
	maxOutputTokens: 8192,
};

function contract(overrides: Partial<ModelContract> = {}): ModelContract {
	return {
		allowedModels: [{ provider: "deepseek", id: "deepseek-chat" }],
		allowedProviders: ["deepseek"],
		allowedAuthOrigins: ["deepseek"],
		thinking: false,
		maxOutputTokens: 8192,
		...overrides,
	};
}

describe("resolveRouteDecision", () => {
	it("keeps the session model when the transcript has no images", () => {
		const decision = resolveRouteDecision({
			contract: contract(),
			sessionModel: TEXT_MODEL,
			transcriptHasImages: false,
		});

		expect(decision.routeModel).toEqual(TEXT_MODEL);
		expect(decision.routed).toBe(false);
		expect(decision.reason).toBe("no-images");
	});

	it("keeps the session model when it natively supports images", () => {
		const decision = resolveRouteDecision({
			contract: contract({
				allowedModels: [{ provider: "openai-codex", id: "gpt-5.6-luna" }],
				allowedProviders: ["openai-codex"],
				allowedAuthOrigins: ["openai-codex"],
			}),
			sessionModel: VISION_MODEL,
			transcriptHasImages: true,
		});

		expect(decision.routeModel).toEqual(VISION_MODEL);
		expect(decision.routed).toBe(false);
		expect(decision.reason).toBe("native-vision");
	});

	it("routes to the declared vision fallback only when the contract allows it", () => {
		const fallback = { provider: "openai-codex", id: "gpt-5.6-luna" };
		const decision = resolveRouteDecision({
			contract: contract({
				allowedModels: [...contract().allowedModels, fallback],
				allowedProviders: ["deepseek", "openai-codex"],
				allowedAuthOrigins: ["deepseek", "openai-codex"],
				visionFallback: fallback,
			}),
			sessionModel: TEXT_MODEL,
			transcriptHasImages: true,
		});

		expect(decision.routed).toBe(true);
		expect(decision.routeModel.provider).toBe("openai-codex");
		expect(decision.routeModel.id).toBe("gpt-5.6-luna");
		expect(decision.reason).toBe("vision-fallback");
	});

	it("refuses to route when the contract declares no vision fallback", () => {
		const decision = resolveRouteDecision({
			contract: contract(),
			sessionModel: TEXT_MODEL,
			transcriptHasImages: true,
		});

		expect(decision.routed).toBe(false);
		expect(decision.reason).toBe("vision-fallback-denied");
	});

	it("refuses when the fallback is not in the allowed model set", () => {
		const fallback = { provider: "openai-codex", id: "gpt-5.6-luna" };
		const decision = resolveRouteDecision({
			contract: contract({
				allowedProviders: ["deepseek", "openai-codex"],
				allowedAuthOrigins: ["deepseek", "openai-codex"],
				visionFallback: fallback,
			}),
			sessionModel: TEXT_MODEL,
			transcriptHasImages: true,
		});

		expect(decision.reason).toBe("vision-fallback-denied");
	});

	it("refuses when the fallback provider is not in the allowed provider set", () => {
		const fallback = { provider: "openai-codex", id: "gpt-5.6-luna" };
		const decision = resolveRouteDecision({
			contract: contract({
				allowedModels: [...contract().allowedModels, fallback],
				allowedAuthOrigins: ["deepseek", "openai-codex"],
				visionFallback: fallback,
			}),
			sessionModel: TEXT_MODEL,
			transcriptHasImages: true,
		});

		expect(decision.reason).toBe("vision-fallback-denied");
	});

	it("refuses when the fallback provider is not in the allowed auth set", () => {
		const fallback = { provider: "openai-codex", id: "gpt-5.6-luna" };
		const decision = resolveRouteDecision({
			contract: contract({
				allowedModels: [...contract().allowedModels, fallback],
				allowedProviders: ["deepseek", "openai-codex"],
				visionFallback: fallback,
			}),
			sessionModel: TEXT_MODEL,
			transcriptHasImages: true,
		});

		expect(decision.reason).toBe("vision-fallback-denied");
	});
});

describe("assertModelContract", () => {
	it("accepts a request inside the contract", () => {
		expect(() => assertModelContract(contract(), BASE_REQUEST)).not.toThrow();
	});

	it("rejects a model outside the allowed set", () => {
		expect(() =>
			assertModelContract(contract(), { ...BASE_REQUEST, model: VISION_MODEL, provider: "openai-codex" }),
		).toThrow(/not in the allowed model set/);
	});

	it("rejects a provider outside the allowed set", () => {
		expect(() => assertModelContract(contract(), { ...BASE_REQUEST, provider: "evil-relay" })).toThrow(/provider/);
	});

	it("rejects thinking when the contract forbids it", () => {
		expect(() => assertModelContract(contract(), { ...BASE_REQUEST, thinking: true })).toThrow(/thinking/);
	});

	it("rejects output above the contract cap", () => {
		expect(() => assertModelContract(contract(), { ...BASE_REQUEST, maxOutputTokens: 16384 })).toThrow(
			/maxOutputTokens/,
		);
	});

	it("rejects an auth origin outside the allowed set", () => {
		expect(() => assertModelContract(contract(), { ...BASE_REQUEST, authOrigin: "openai-codex" })).toThrow(
			/auth origin/,
		);
	});
});

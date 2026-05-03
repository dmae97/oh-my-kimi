import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import { computeBankScope, deriveBankId, ensureBankMission } from "@oh-my-pi/pi-coding-agent/hindsight/bank";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";

const baseConfig = (overrides: Partial<HindsightConfig> = {}): HindsightConfig => ({
	hindsightApiUrl: "http://localhost:8888",
	hindsightApiToken: null,
	bankId: null,
	bankIdPrefix: "",
	scoping: "global",
	bankMission: "",
	retainMission: null,
	autoRecall: true,
	autoRetain: true,
	retainMode: "full-session",
	retainEveryNTurns: 3,
	retainOverlapTurns: 2,
	retainContext: "omp",
	recallBudget: "mid",
	recallMaxTokens: 1024,
	recallTypes: ["world", "experience"],
	recallContextTurns: 1,
	recallMaxQueryChars: 800,
	recallPromptPreamble: "preamble",
	debug: false,
	...overrides,
});

describe("computeBankScope", () => {
	describe("scoping=global", () => {
		it("returns the configured bank id verbatim", () => {
			expect(computeBankScope(baseConfig({ bankId: "team-a" }), "/work/proj")).toEqual({
				bankId: "team-a",
			});
		});

		it("falls back to the default bank name when bankId is unset", () => {
			expect(computeBankScope(baseConfig(), "/whatever")).toEqual({ bankId: "omp" });
		});

		it("applies the configured prefix", () => {
			expect(computeBankScope(baseConfig({ bankId: "team", bankIdPrefix: "prod" }), "/cwd")).toEqual({
				bankId: "prod-team",
			});
		});

		it("does not surface tag fields", () => {
			const scope = computeBankScope(baseConfig(), "/work/proj");
			expect(scope.retainTags).toBeUndefined();
			expect(scope.recallTags).toBeUndefined();
			expect(scope.recallTagsMatch).toBeUndefined();
		});
	});

	describe("scoping=per-project", () => {
		it("appends the cwd basename to the base bank id", () => {
			expect(computeBankScope(baseConfig({ scoping: "per-project" }), "/work/proj")).toEqual({
				bankId: "omp-proj",
			});
		});

		it("appends `unknown` for an empty cwd", () => {
			expect(computeBankScope(baseConfig({ scoping: "per-project" }), "")).toEqual({
				bankId: "omp-unknown",
			});
		});

		it("composes prefix + bankId + project", () => {
			const scope = computeBankScope(
				baseConfig({ scoping: "per-project", bankId: "team", bankIdPrefix: "prod" }),
				"/work/cool-app",
			);
			expect(scope.bankId).toBe("prod-team-cool-app");
		});

		it("does not surface tag fields (isolation is at the bank level)", () => {
			const scope = computeBankScope(baseConfig({ scoping: "per-project" }), "/work/proj");
			expect(scope.retainTags).toBeUndefined();
			expect(scope.recallTags).toBeUndefined();
		});
	});

	describe("scoping=per-project-tagged", () => {
		it("keeps the base bank id and emits project tags with `any` match", () => {
			expect(computeBankScope(baseConfig({ scoping: "per-project-tagged" }), "/work/proj")).toEqual({
				bankId: "omp",
				retainTags: ["project:proj"],
				recallTags: ["project:proj"],
				recallTagsMatch: "any",
			});
		});

		it("uses the same project label for retain and recall tags", () => {
			const scope = computeBankScope(baseConfig({ scoping: "per-project-tagged" }), "/repo/cool-app");
			expect(scope.retainTags).toEqual(["project:cool-app"]);
			expect(scope.recallTags).toEqual(["project:cool-app"]);
		});

		it("falls back to project:unknown when cwd is empty", () => {
			const scope = computeBankScope(baseConfig({ scoping: "per-project-tagged" }), "");
			expect(scope.retainTags).toEqual(["project:unknown"]);
			expect(scope.recallTags).toEqual(["project:unknown"]);
		});
	});
});

describe("deriveBankId (legacy wrapper)", () => {
	it("returns the bankId field of the resolved scope", () => {
		expect(deriveBankId(baseConfig({ bankId: "team", bankIdPrefix: "prod" }), "/cwd")).toBe("prod-team");
		expect(deriveBankId(baseConfig({ scoping: "per-project" }), "/work/proj")).toBe("omp-proj");
		expect(deriveBankId(baseConfig({ scoping: "per-project-tagged" }), "/work/proj")).toBe("omp");
	});
});

describe("ensureBankMission", () => {
	let client: HindsightApi;
	let createSpy: Mock<HindsightApi["createBank"]> | undefined;

	beforeEach(() => {
		client = new HindsightApi({ baseUrl: "http://localhost:8888" });
	});

	afterEach(() => {
		createSpy?.mockRestore();
	});

	it("calls createBank exactly once per bank id", async () => {
		createSpy = vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const seen = new Set<string>();
		const config = baseConfig({ bankMission: "remember everything", retainMission: "extract facts" });

		await ensureBankMission(client, "bank-a", config, seen);
		await ensureBankMission(client, "bank-a", config, seen);
		await ensureBankMission(client, "bank-b", config, seen);

		expect(createSpy).toHaveBeenCalledTimes(2);
		expect(createSpy).toHaveBeenCalledWith(
			"bank-a",
			expect.objectContaining({ reflectMission: "remember everything", retainMission: "extract facts" }),
		);
		expect(createSpy).toHaveBeenCalledWith("bank-b", expect.any(Object));
		expect(seen.has("bank-a")).toBe(true);
		expect(seen.has("bank-b")).toBe(true);
	});

	it("is a no-op when no mission is configured", async () => {
		createSpy = vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);
		const seen = new Set<string>();
		await ensureBankMission(client, "bank", baseConfig({ bankMission: "" }), seen);
		await ensureBankMission(client, "bank", baseConfig({ bankMission: "   " }), seen);
		expect(createSpy).not.toHaveBeenCalled();
		expect(seen.size).toBe(0);
	});

	it("swallows API failures and does not mark the bank as initialised", async () => {
		createSpy = vi.spyOn(HindsightApi.prototype, "createBank").mockRejectedValue(new Error("HTTP 500"));
		const seen = new Set<string>();
		const config = baseConfig({ bankMission: "do the thing" });

		await expect(ensureBankMission(client, "bank-x", config, seen)).resolves.toBeUndefined();
		expect(seen.has("bank-x")).toBe(false);
	});
});

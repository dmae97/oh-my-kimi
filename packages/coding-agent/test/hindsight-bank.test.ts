import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { deriveBankId, ensureBankMission } from "@oh-my-pi/pi-coding-agent/hindsight/bank";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { HindsightClient } from "@vectorize-io/hindsight-client";

const baseConfig = (overrides: Partial<HindsightConfig> = {}): HindsightConfig => ({
	hindsightApiUrl: "http://localhost:8888",
	hindsightApiToken: null,
	bankId: null,
	bankIdPrefix: "",
	dynamicBankId: false,
	bankMission: "",
	retainMission: null,
	agentName: "omp",
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

describe("deriveBankId", () => {
	const originalChannel = process.env.HINDSIGHT_CHANNEL_ID;
	const originalUser = process.env.HINDSIGHT_USER_ID;

	afterEach(() => {
		if (originalChannel === undefined) delete process.env.HINDSIGHT_CHANNEL_ID;
		else process.env.HINDSIGHT_CHANNEL_ID = originalChannel;
		if (originalUser === undefined) delete process.env.HINDSIGHT_USER_ID;
		else process.env.HINDSIGHT_USER_ID = originalUser;
	});

	it("returns the configured bank id verbatim in static mode", () => {
		expect(deriveBankId(baseConfig({ bankId: "team-a" }), "/some/cwd")).toBe("team-a");
	});

	it("falls back to the default bank name when no bank id is configured", () => {
		expect(deriveBankId(baseConfig(), "/whatever")).toBe("omp");
	});

	it("applies the configured prefix when present", () => {
		expect(deriveBankId(baseConfig({ bankId: "team", bankIdPrefix: "prod" }), "/cwd")).toBe("prod-team");
	});

	it("composes a `agent::project::channel::user` id in dynamic mode", () => {
		delete process.env.HINDSIGHT_CHANNEL_ID;
		delete process.env.HINDSIGHT_USER_ID;
		const id = deriveBankId(baseConfig({ dynamicBankId: true, agentName: "code" }), "/work/proj");
		expect(id).toBe("code::proj::default::anonymous");
	});

	it("uses HINDSIGHT_CHANNEL_ID/USER_ID env overrides for dynamic ids", () => {
		process.env.HINDSIGHT_CHANNEL_ID = "ops";
		process.env.HINDSIGHT_USER_ID = "ada";
		const id = deriveBankId(baseConfig({ dynamicBankId: true }), "/repo/cool-app");
		expect(id).toBe("omp::cool-app::ops::ada");
	});

	it("falls back to `unknown` when the directory is empty in dynamic mode", () => {
		delete process.env.HINDSIGHT_CHANNEL_ID;
		delete process.env.HINDSIGHT_USER_ID;
		const id = deriveBankId(baseConfig({ dynamicBankId: true }), "");
		expect(id).toBe("omp::unknown::default::anonymous");
	});
});

describe("ensureBankMission", () => {
	let client: HindsightClient;
	let createSpy: ReturnType<typeof vi.spyOn> | undefined;

	beforeEach(() => {
		client = new HindsightClient({ baseUrl: "http://localhost:8888" });
	});

	afterEach(() => {
		createSpy?.mockRestore();
	});

	it("calls createBank exactly once per bank id", async () => {
		createSpy = vi.spyOn(HindsightClient.prototype, "createBank").mockResolvedValue({} as never);
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
		createSpy = vi.spyOn(HindsightClient.prototype, "createBank").mockResolvedValue({} as never);
		const seen = new Set<string>();
		await ensureBankMission(client, "bank", baseConfig({ bankMission: "" }), seen);
		await ensureBankMission(client, "bank", baseConfig({ bankMission: "   " }), seen);
		expect(createSpy).not.toHaveBeenCalled();
		expect(seen.size).toBe(0);
	});

	it("swallows API failures and does not mark the bank as initialised", async () => {
		createSpy = vi.spyOn(HindsightClient.prototype, "createBank").mockRejectedValue(new Error("HTTP 500"));
		const seen = new Set<string>();
		const config = baseConfig({ bankMission: "do the thing" });

		await expect(ensureBankMission(client, "bank-x", config, seen)).resolves.toBeUndefined();
		expect(seen.has("bank-x")).toBe(false);
	});
});

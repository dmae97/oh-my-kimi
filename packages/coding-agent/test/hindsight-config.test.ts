import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { isHindsightConfigured, loadHindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";

describe("loadHindsightConfig", () => {
	beforeEach(() => {
		_resetSettingsForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns sane defaults from an empty Settings", () => {
		const settings = Settings.isolated();
		const cfg = loadHindsightConfig(settings, {});
		expect(cfg.hindsightApiUrl).toBe("http://localhost:8888"); // schema default
		expect(cfg.recallBudget).toBe("mid");
		expect(cfg.retainMode).toBe("full-session");
		expect(cfg.recallTypes).toEqual(["world", "experience"]);
		expect(cfg.autoRecall).toBe(true);
		expect(cfg.autoRetain).toBe(true);
		expect(cfg.agentName).toBe("omp");
	});

	it("env overrides win over settings", () => {
		const settings = Settings.isolated({
			"hindsight.apiUrl": "http://settings.example",
			"hindsight.autoRecall": true,
			"hindsight.recallMaxTokens": 256,
			"hindsight.dynamicBankId": false,
			"hindsight.retainMode": "full-session",
		});
		const cfg = loadHindsightConfig(settings, {
			HINDSIGHT_API_URL: "http://env.example",
			HINDSIGHT_AUTO_RECALL: "false",
			HINDSIGHT_RECALL_MAX_TOKENS: "9999",
			HINDSIGHT_DYNAMIC_BANK_ID: "yes",
			HINDSIGHT_RETAIN_MODE: "last-turn",
		});
		expect(cfg.hindsightApiUrl).toBe("http://env.example");
		expect(cfg.autoRecall).toBe(false);
		expect(cfg.recallMaxTokens).toBe(9999);
		expect(cfg.dynamicBankId).toBe(true);
		expect(cfg.retainMode).toBe("last-turn");
	});

	it("ignores invalid retainMode env values and falls back to schema default", () => {
		const settings = Settings.isolated();
		const cfg = loadHindsightConfig(settings, { HINDSIGHT_RETAIN_MODE: "garbage" });
		expect(cfg.retainMode).toBe("full-session");
	});

	it("coerces non-numeric ints back to undefined so settings/default takes over", () => {
		const settings = Settings.isolated({ "hindsight.recallMaxTokens": 512 });
		const cfg = loadHindsightConfig(settings, { HINDSIGHT_RECALL_MAX_TOKENS: "not-a-number" });
		expect(cfg.recallMaxTokens).toBe(512);
	});

	it("respects falsy boolean env strings", () => {
		const settings = Settings.isolated();
		const cfg = loadHindsightConfig(settings, {
			HINDSIGHT_AUTO_RECALL: "no",
			HINDSIGHT_AUTO_RETAIN: "0",
		});
		expect(cfg.autoRecall).toBe(false);
		expect(cfg.autoRetain).toBe(false);
	});
});

describe("isHindsightConfigured", () => {
	it("returns true when an apiUrl is set", () => {
		const cfg = loadHindsightConfig(Settings.isolated({ "hindsight.apiUrl": "http://x" }), {});
		expect(isHindsightConfigured(cfg)).toBe(true);
	});

	it("returns false when apiUrl is missing", () => {
		const cfg = loadHindsightConfig(Settings.isolated({ "hindsight.apiUrl": "" }), {
			HINDSIGHT_API_URL: "",
		});
		expect(isHindsightConfigured(cfg)).toBe(false);
	});
});

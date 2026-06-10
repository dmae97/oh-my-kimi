import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { parseDifficultyBucket, parseDifficultyLevel } from "@oh-my-pi/pi-coding-agent/auto-thinking/classifier";
import {
	AUTO_THINKING,
	clampAutoThinkingEffort,
	parseConfiguredThinkingLevel,
	parseThinkingLevel,
} from "@oh-my-pi/pi-coding-agent/thinking";

describe("auto thinking classifier helpers", () => {
	it("parses configured thinking without widening provider-facing thinking selectors", () => {
		expect(parseConfiguredThinkingLevel(AUTO_THINKING)).toBe(AUTO_THINKING);
		expect(parseConfiguredThinkingLevel(Effort.High)).toBe(Effort.High);
		expect(parseConfiguredThinkingLevel("bogus")).toBeUndefined();
		expect(parseThinkingLevel(AUTO_THINKING)).toBeUndefined();
		expect(parseThinkingLevel(ThinkingLevel.Off)).toBe(ThinkingLevel.Off);
	});

	it("maps online 4-way classifier labels to effort levels", () => {
		expect(parseDifficultyLevel("x-high")).toBe(Effort.XHigh);
		expect(parseDifficultyLevel("The answer is HIGH.")).toBe(Effort.High);
		expect(parseDifficultyLevel("med")).toBe(Effort.Medium);
		expect(parseDifficultyLevel("low")).toBe(Effort.Low);
		expect(parseDifficultyLevel("unknown")).toBeUndefined();
	});

	it("maps local 3-bucket labels to coarse effort levels", () => {
		expect(parseDifficultyBucket("trivial")).toBe(Effort.Low);
		expect(parseDifficultyBucket("moderate")).toBe(Effort.High);
		expect(parseDifficultyBucket("hard")).toBe(Effort.XHigh);
		expect(parseDifficultyBucket("medium")).toBeUndefined();
	});

	it("clamps auto effort to model support while never resolving below low", () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!model) throw new Error("Expected bundled Claude Sonnet 4.6 model");

		expect(clampAutoThinkingEffort(model, Effort.XHigh)).toBe(Effort.High);
		expect(clampAutoThinkingEffort(model, Effort.Minimal)).toBe(Effort.Low);
	});
});

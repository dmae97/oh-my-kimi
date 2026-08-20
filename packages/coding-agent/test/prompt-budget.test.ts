import { describe, expect, it } from "vitest";
import { computePromptTokenBudget, computeResponseReserveTokens } from "../src/core/prompt-budget.ts";

describe("computeResponseReserveTokens", () => {
	it("prefers the model's own maxTokens when it fits the window", () => {
		expect(computeResponseReserveTokens(100000, 8000)).toBe(8000);
	});

	it("falls back to the 0.2 ratio with the legacy floor", () => {
		expect(computeResponseReserveTokens(100000)).toBe(20000);
		expect(computeResponseReserveTokens(10000)).toBe(8192);
	});

	it("honors an override ratio and rejects out-of-window model maxTokens", () => {
		expect(computeResponseReserveTokens(100000, undefined, 0.1)).toBe(10000);
		expect(computeResponseReserveTokens(100000, 200000)).toBe(20000);
	});
});

describe("computePromptTokenBudget", () => {
	it("env max prompt wins and derives the reserve normally", () => {
		expect(computePromptTokenBudget({ contextWindow: 100000, envMaxPromptTokens: 50000 })).toEqual({
			maxPromptTokens: 50000,
			responseReserveTokens: 20000,
		});
	});

	it("derives window-minus-reserve-minus-margin by default", () => {
		expect(computePromptTokenBudget({ contextWindow: 100000 })).toEqual({
			maxPromptTokens: 70000,
			responseReserveTokens: 20000,
		});
	});

	it("honors the env prompt ratio inside (0, 1)", () => {
		expect(computePromptTokenBudget({ contextWindow: 100000, envPromptRatio: 0.5 })).toEqual({
			maxPromptTokens: 50000,
			responseReserveTokens: 20000,
		});
	});

	it("shrinks the prompt budget when the model reserve is small", () => {
		expect(computePromptTokenBudget({ contextWindow: 100000, modelMaxTokens: 8000 })).toEqual({
			maxPromptTokens: 82000,
			responseReserveTokens: 8000,
		});
	});

	it("falls back to legacy defaults without a context window", () => {
		expect(computePromptTokenBudget({ contextWindow: 0 })).toEqual({
			maxPromptTokens: 60000,
			responseReserveTokens: 8192,
		});
	});

	it("enforces the 4000-token prompt floor", () => {
		const budget = computePromptTokenBudget({ contextWindow: 10000 });
		expect(budget.maxPromptTokens).toBe(4000);
	});

	it("caps the reserve at a quarter of the prompt budget with the legacy floor", () => {
		const budget = computePromptTokenBudget({ contextWindow: 0, envMaxPromptTokens: 5000 });
		expect(budget.maxPromptTokens).toBe(5000);
		expect(budget.responseReserveTokens).toBe(8192);
	});

	it("honors the env response reserve override", () => {
		expect(computePromptTokenBudget({ contextWindow: 100000, envResponseReserveTokens: 4000 })).toEqual({
			maxPromptTokens: 86000,
			responseReserveTokens: 4000,
		});
	});
});

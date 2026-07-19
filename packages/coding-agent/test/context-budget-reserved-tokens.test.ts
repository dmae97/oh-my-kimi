import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	computeReservedTokenBudget,
	estimateToolResultReserve,
	MAX_TOOL_RESULT_RESERVE_REQUESTS,
	ReservedTokenBudgetError,
	type ReservedTokenBudgetInput,
	TOOL_RESULT_CLASSES,
	type ToolResultReserveRequest,
} from "../src/core/context-budget-reserved-tokens.ts";

const SOURCE_PATH = fileURLToPath(new URL("../src/core/context-budget-reserved-tokens.ts", import.meta.url));

function baseInput(overrides: Partial<ReservedTokenBudgetInput> = {}): ReservedTokenBudgetInput {
	return {
		modelContextWindow: 8000,
		systemPromptTokens: 1000,
		reservedOutputTokens: 500,
		reservedToolResultTokens: 300,
		safetyMarginTokens: 200,
		imageReserveTokens: 100,
		...overrides,
	};
}

describe("computeReservedTokenBudget", () => {
	it("applies the exact single-subtraction formula", () => {
		const result = computeReservedTokenBudget(baseInput());
		// totalReserved = 500 + 300 + 200 + 100 = 1100
		// consumed = 1000 + 1100 = 2100
		// effective = 8000 - 2100 = 5900
		expect(result.totalReserved).toBe(1100);
		expect(result.effectiveBudget).toBe(5900);
		expect(result.overflow).toBe(false);
	});

	it("returns all terms copied into a frozen terms object", () => {
		const input = baseInput({ modelContextWindow: 4000, systemPromptTokens: 250 });
		const result = computeReservedTokenBudget(input);
		expect(result.terms).toEqual({
			modelContextWindow: 4000,
			systemPromptTokens: 250,
			reservedOutputTokens: 500,
			reservedToolResultTokens: 300,
			safetyMarginTokens: 200,
			imageReserveTokens: 100,
		});
		expect(result.terms).not.toBe(input);
	});

	it("handles the all-zero case (zeroes)", () => {
		const zero = computeReservedTokenBudget({
			modelContextWindow: 0,
			systemPromptTokens: 0,
			reservedOutputTokens: 0,
			reservedToolResultTokens: 0,
			safetyMarginTokens: 0,
			imageReserveTokens: 0,
		});
		expect(zero.totalReserved).toBe(0);
		expect(zero.effectiveBudget).toBe(0);
		expect(zero.overflow).toBe(false);
	});

	it("clamps to 0 and flags overflow when reserves exceed the window", () => {
		const result = computeReservedTokenBudget(
			baseInput({ modelContextWindow: 1000, systemPromptTokens: 100, reservedOutputTokens: 600 }),
		);
		// totalReserved = 600 + 300 + 200 + 100 = 1200; consumed = 100 + 1200 = 1300
		// rawEffective = 1000 - 1300 = -300 -> clamped 0, overflow true
		expect(result.totalReserved).toBe(1200);
		expect(result.effectiveBudget).toBe(0);
		expect(result.overflow).toBe(true);
	});

	it("reports overflow exactly when reserves consume the whole window with nothing left", () => {
		const result = computeReservedTokenBudget(baseInput({ modelContextWindow: 2100, systemPromptTokens: 1000 }));
		// consumed == 2100, rawEffective == 0 -> not overflow, budget 0
		expect(result.effectiveBudget).toBe(0);
		expect(result.overflow).toBe(false);
	});

	it("fails closed on unsafe integers, NaN, Infinity, negatives, and non-integers", () => {
		const cases: Array<[string, Partial<ReservedTokenBudgetInput>]> = [
			["NaN modelContextWindow", { modelContextWindow: Number.NaN }],
			["Infinity systemPromptTokens", { systemPromptTokens: Number.POSITIVE_INFINITY }],
			["-Infinity safetyMarginTokens", { safetyMarginTokens: Number.NEGATIVE_INFINITY }],
			["negative reservedOutputTokens", { reservedOutputTokens: -1 }],
			["negative reservedToolResultTokens", { reservedToolResultTokens: -10 }],
			["negative safetyMarginTokens", { safetyMarginTokens: -5 }],
			["negative imageReserveTokens", { imageReserveTokens: -1 }],
			["negative systemPromptTokens", { systemPromptTokens: -1 }],
			["non-integer modelContextWindow", { modelContextWindow: 1.5 }],
			["unsafe-integer modelContextWindow", { modelContextWindow: Number.MAX_SAFE_INTEGER + 1 }],
		];
		for (const [name, overrides] of cases) {
			expect(() => computeReservedTokenBudget(baseInput(overrides)), name).toThrow(ReservedTokenBudgetError);
		}
	});

	it("accepts the maximum safe integer for every term without overflow", () => {
		const max = Number.MAX_SAFE_INTEGER;
		const result = computeReservedTokenBudget({
			modelContextWindow: max,
			systemPromptTokens: 0,
			reservedOutputTokens: max,
			reservedToolResultTokens: 0,
			safetyMarginTokens: 0,
			imageReserveTokens: 0,
		});
		expect(result.totalReserved).toBe(max);
		expect(result.effectiveBudget).toBe(0);
		expect(result.overflow).toBe(false);
	});

	it("fails closed on arithmetic overflow when summing reserve terms", () => {
		const max = Number.MAX_SAFE_INTEGER;
		expect(() =>
			computeReservedTokenBudget({
				modelContextWindow: max,
				systemPromptTokens: 0,
				reservedOutputTokens: max,
				reservedToolResultTokens: max, // max + max overflows
				safetyMarginTokens: 0,
				imageReserveTokens: 0,
			}),
		).toThrow(ReservedTokenBudgetError);
	});

	it("rejects extra keys and missing keys on the budget input (strict shape)", () => {
		expect(() => computeReservedTokenBudget({ ...baseInput(), extra: 1 } as ReservedTokenBudgetInput)).toThrow(
			ReservedTokenBudgetError,
		);
		expect(() =>
			computeReservedTokenBudget({ modelContextWindow: 1000 } as unknown as ReservedTokenBudgetInput),
		).toThrow(ReservedTokenBudgetError);
		expect(() => computeReservedTokenBudget(null as unknown as ReservedTokenBudgetInput)).toThrow(
			ReservedTokenBudgetError,
		);
	});

	it("is deterministic, deeply frozen, and a copy of the input", () => {
		const input = { ...baseInput() };
		const a = computeReservedTokenBudget(input);
		const b = computeReservedTokenBudget(input);
		expect(a).toEqual(b);
		expect(Object.isFrozen(a)).toBe(true);
		expect(Object.isFrozen(a.terms)).toBe(true);
		// Mutating the caller's object must not affect the already-computed result.
		input.systemPromptTokens = 9999;
		expect(a.terms.systemPromptTokens).toBe(1000);
		expect(b.terms.systemPromptTokens).toBe(1000);
		// Mutating a frozen result throws in strict mode.
		expect(() => {
			(a as { effectiveBudget: number }).effectiveBudget = 1;
		}).toThrow();
		expect(() => {
			(a.terms as { modelContextWindow: number }).modelContextWindow = 1;
		}).toThrow();
	});

	it("keeps imageReserveTokens as a distinct term from the tool-result image class", () => {
		// imageReserveTokens is its own budget term...
		const withImageReserve = computeReservedTokenBudget(baseInput({ imageReserveTokens: 777 }));
		expect(withImageReserve.terms.imageReserveTokens).toBe(777);
		expect(withImageReserve.totalReserved).toBe(500 + 300 + 200 + 777);
		// ...while the tool-result 'image' class is accounted separately by the estimator.
		expect(estimateToolResultReserve([{ class: "image", count: 1, tokensPerResult: 85 }])).toBe(85);
	});
});

describe("estimateToolResultReserve", () => {
	it("computes a total for every supported tool-result class", () => {
		expect(estimateToolResultReserve([{ class: "text", count: 2, tokensPerResult: 10 }])).toBe(20);
		expect(estimateToolResultReserve([{ class: "image", count: 1, tokensPerResult: 85 }])).toBe(85);
		expect(estimateToolResultReserve([{ class: "large-output", count: 1, tokensPerResult: 4000 }])).toBe(4000);
	});

	it("exposes the supported class set", () => {
		expect([...TOOL_RESULT_CLASSES]).toEqual(["text", "image", "large-output"]);
	});

	it("scales linearly with count", () => {
		expect(estimateToolResultReserve([{ class: "text", count: 3, tokensPerResult: 50 }])).toBe(150);
		expect(estimateToolResultReserve([{ class: "text", count: 6, tokensPerResult: 50 }])).toBe(300);
	});

	it("sums multiple additive requests across classes", () => {
		const requests: ToolResultReserveRequest[] = [
			{ class: "text", count: 2, tokensPerResult: 10 },
			{ class: "image", count: 1, tokensPerResult: 85 },
			{ class: "large-output", count: 1, tokensPerResult: 4000 },
			{ class: "text", count: 5, tokensPerResult: 4 },
		];
		// 20 + 85 + 4000 + 20 = 4125
		expect(estimateToolResultReserve(requests)).toBe(4125);
	});

	it("allows empty requests and returns 0", () => {
		expect(estimateToolResultReserve([])).toBe(0);
	});

	it("treats a zero count or zero tokensPerResult as zero reserve", () => {
		expect(estimateToolResultReserve([{ class: "text", count: 0, tokensPerResult: 999 }])).toBe(0);
		expect(estimateToolResultReserve([{ class: "image", count: 9, tokensPerResult: 0 }])).toBe(0);
	});

	it("fails closed on invalid class, count, tokensPerResult", () => {
		expect(() =>
			estimateToolResultReserve([
				{ class: "audio", count: 1, tokensPerResult: 10 },
			] as unknown as ToolResultReserveRequest[]),
		).toThrow(ReservedTokenBudgetError);
		expect(() => estimateToolResultReserve([{ class: "text", count: -1, tokensPerResult: 10 }])).toThrow(
			ReservedTokenBudgetError,
		);
		expect(() => estimateToolResultReserve([{ class: "text", count: 1, tokensPerResult: Number.NaN }])).toThrow(
			ReservedTokenBudgetError,
		);
		expect(() => estimateToolResultReserve([{ class: "text", count: 1.5, tokensPerResult: 10 }])).toThrow(
			ReservedTokenBudgetError,
		);
		expect(() =>
			estimateToolResultReserve([{ class: "text", count: 1, tokensPerResult: Number.MAX_SAFE_INTEGER + 1 }]),
		).toThrow(ReservedTokenBudgetError);
	});

	it("rejects extra keys and missing keys on each request (strict shape)", () => {
		expect(() =>
			estimateToolResultReserve([
				{ class: "text", count: 1, tokensPerResult: 10, extra: 1 } as ToolResultReserveRequest,
			]),
		).toThrow(ReservedTokenBudgetError);
		expect(() =>
			estimateToolResultReserve([{ class: "text", count: 1 }] as unknown as ToolResultReserveRequest[]),
		).toThrow(ReservedTokenBudgetError);
		expect(() => estimateToolResultReserve([null] as unknown as ToolResultReserveRequest[])).toThrow(
			ReservedTokenBudgetError,
		);
		expect(() => estimateToolResultReserve("nope" as unknown as ToolResultReserveRequest[])).toThrow(
			ReservedTokenBudgetError,
		);
	});

	it("fails closed on multiply overflow within a single request", () => {
		expect(() =>
			estimateToolResultReserve([{ class: "text", count: 2, tokensPerResult: Number.MAX_SAFE_INTEGER }]),
		).toThrow(ReservedTokenBudgetError);
	});

	it("fails closed on additive overflow across requests", () => {
		const max = Number.MAX_SAFE_INTEGER;
		expect(() =>
			estimateToolResultReserve([
				{ class: "text", count: 1, tokensPerResult: max },
				{ class: "image", count: 1, tokensPerResult: max },
			]),
		).toThrow(ReservedTokenBudgetError);
	});

	it("composes cleanly into the budget as reservedToolResultTokens", () => {
		const toolReserve = estimateToolResultReserve([
			{ class: "text", count: 2, tokensPerResult: 50 },
			{ class: "large-output", count: 1, tokensPerResult: 4000 },
		]);
		expect(toolReserve).toBe(4100);
		const result = computeReservedTokenBudget(baseInput({ reservedToolResultTokens: toolReserve }));
		// totalReserved = 500 + 4100 + 200 + 100 = 4900
		expect(result.totalReserved).toBe(4900);
		expect(result.effectiveBudget).toBe(8000 - 1000 - 4900);
	});
});

describe("reserved-token input hardening (plain data, caps, freeze)", () => {
	it("TOOL_RESULT_CLASSES is runtime-frozen and rejects mutation", () => {
		expect(Object.isFrozen(TOOL_RESULT_CLASSES)).toBe(true);
		expect(() => {
			(TOOL_RESULT_CLASSES as unknown as string[]).push("audio");
		}).toThrow();
		expect(() => {
			(TOOL_RESULT_CLASSES as unknown as string[]).pop();
		}).toThrow();
		expect(() => {
			(TOOL_RESULT_CLASSES as unknown as { length: number }).length = 0;
		}).toThrow();
		// The supported set is unchanged after every attempted mutation.
		expect([...TOOL_RESULT_CLASSES]).toEqual(["text", "image", "large-output"]);
	});

	it("accepts exactly MAX_TOOL_RESULT_RESERVE_REQUESTS (64) and rejects one more (65)", () => {
		const at = Array.from({ length: MAX_TOOL_RESULT_RESERVE_REQUESTS }, () => ({
			class: "text" as const,
			count: 1,
			tokensPerResult: 1,
		}));
		expect(estimateToolResultReserve(at)).toBe(MAX_TOOL_RESULT_RESERVE_REQUESTS);
		const over = [...at, { class: "text" as const, count: 1, tokensPerResult: 1 }];
		expect(over).toHaveLength(MAX_TOOL_RESULT_RESERVE_REQUESTS + 1);
		expect(() => estimateToolResultReserve(over)).toThrow(ReservedTokenBudgetError);
	});

	it("rejects non-plain-data budget inputs: array, non-standard prototype, accessor property", () => {
		// Object.create({...}) simulates a class instance: a non-Object, non-null prototype.
		const classLike = Object.assign(Object.create({ kind: "budget" }), baseInput());
		expect(Object.getPrototypeOf(classLike)).not.toBe(Object.prototype);
		const withGetter = baseInput();
		Object.defineProperty(withGetter, "reservedOutputTokens", {
			get: () => 500,
			enumerable: true,
			configurable: true,
		});
		expect(() =>
			computeReservedTokenBudget([8000, 1000, 500, 300, 200, 100] as unknown as ReservedTokenBudgetInput),
		).toThrow(ReservedTokenBudgetError);
		expect(() => computeReservedTokenBudget(classLike as unknown as ReservedTokenBudgetInput)).toThrow(
			ReservedTokenBudgetError,
		);
		expect(() => computeReservedTokenBudget(withGetter as unknown as ReservedTokenBudgetInput)).toThrow(
			ReservedTokenBudgetError,
		);
	});

	it("accepts a null-prototype plain data object as the budget input", () => {
		const nullProto = Object.assign(Object.create(null), baseInput());
		expect(Object.getPrototypeOf(nullProto)).toBeNull();
		const result = computeReservedTokenBudget(nullProto);
		expect(result.totalReserved).toBe(1100);
		expect(result.effectiveBudget).toBe(5900);
		expect(result.overflow).toBe(false);
	});

	it("rejects non-plain-data request items: array, non-standard prototype, accessor property", () => {
		const classLike = Object.assign(Object.create({ kind: "request" }), {
			class: "text" as const,
			count: 1,
			tokensPerResult: 10,
		});
		expect(Object.getPrototypeOf(classLike)).not.toBe(Object.prototype);
		const withGetter = { class: "text" as const, count: 1, tokensPerResult: 10 };
		Object.defineProperty(withGetter, "count", {
			get: () => 1,
			enumerable: true,
			configurable: true,
		});
		expect(() => estimateToolResultReserve([[8000, 1000]] as unknown as ToolResultReserveRequest[])).toThrow(
			ReservedTokenBudgetError,
		);
		expect(() => estimateToolResultReserve([classLike] as unknown as ToolResultReserveRequest[])).toThrow(
			ReservedTokenBudgetError,
		);
		expect(() => estimateToolResultReserve([withGetter] as unknown as ToolResultReserveRequest[])).toThrow(
			ReservedTokenBudgetError,
		);
	});
});

describe("context-budget-reserved-tokens source hygiene", () => {
	it("contains no forbidden host/non-deterministic APIs (static source check)", () => {
		const source = readFileSync(SOURCE_PATH, "utf-8");
		const forbidden = [
			"node:",
			"require(",
			"process.",
			"Math.random",
			"Date.now",
			"new Date",
			"crypto",
			"Buffer",
			"setTimeout",
			"setInterval",
			"setImmediate",
			"fetch(",
			"globalThis",
		];
		const found = forbidden.filter((token) => source.includes(token));
		expect(found, `forbidden tokens present in source: ${found.join(", ")}`).toEqual([]);
	});
});

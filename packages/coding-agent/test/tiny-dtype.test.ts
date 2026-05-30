import { describe, expect, it } from "bun:test";
import { normalizeTinyModelDtype, resolveTinyModelDtypeOverride } from "../src/tiny/dtype";

describe("tiny model dtype selection", () => {
	it("returns undefined when unset so callers keep the per-model spec dtype", () => {
		expect(resolveTinyModelDtypeOverride(undefined)).toBeUndefined();
		expect(resolveTinyModelDtypeOverride("")).toBeUndefined();
		expect(resolveTinyModelDtypeOverride("   ")).toBeUndefined();
	});

	it("canonicalizes a valid precision regardless of case/whitespace", () => {
		expect(resolveTinyModelDtypeOverride("  FP16 ")).toBe("fp16");
		expect(resolveTinyModelDtypeOverride("q4f16")).toBe("q4f16");
		expect(normalizeTinyModelDtype("Q8")).toBe("q8");
	});

	it("rejects an unsupported precision", () => {
		expect(() => resolveTinyModelDtypeOverride("int4")).toThrow("Unsupported PI_TINY_DTYPE");
	});
});

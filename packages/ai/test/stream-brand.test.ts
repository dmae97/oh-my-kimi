import { describe, expect, it } from "vitest";
import { isBuiltinStreamFn, streamSimple } from "../src/stream.ts";

describe("built-in stream branding", () => {
	it("recognizes the local built-in stream", () => {
		expect(isBuiltinStreamFn(streamSimple)).toBe(true);
	});

	it("recognizes a built-in stream from another package copy", () => {
		const duplicateStream = () => undefined;
		Object.defineProperty(duplicateStream, Symbol.for("omk-ai.streamSimple"), { value: true });

		expect(isBuiltinStreamFn(duplicateStream)).toBe(true);
	});

	it("rejects unbranded custom streams", () => {
		expect(isBuiltinStreamFn(() => undefined)).toBe(false);
	});
});

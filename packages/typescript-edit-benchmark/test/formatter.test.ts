import { describe, expect, it } from "bun:test";
import { formatContent } from "../src/formatter";

describe("formatContent", () => {
	it("pins .js files to the flow parser (no fallback to babel-ts)", async () => {
		const tsOnlySyntaxInJs = "namespace Foo { export const value = 1; }\n";
		const result = await formatContent("fixture.js", tsOnlySyntaxInJs);

		expect(result.didFormat).toBe(false);
		expect(result.formatted).toBe(tsOnlySyntaxInJs);
	});
});

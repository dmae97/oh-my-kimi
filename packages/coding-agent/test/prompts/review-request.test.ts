import { describe, expect, it } from "bun:test";

describe("review request prompt", () => {
	it("renders the additional instructions block from the template", async () => {
		const template = await Bun.file(new URL("../../src/prompts/review-request.md", import.meta.url)).text();

		expect(template).toContain("{{#if additionalInstructions}}");
		expect(template).toContain("### Additional Instructions");
		expect(template).toContain("{{additionalInstructions}}");
		expect(template).toContain("{{/if}}");
	});

	it("keeps the additional instructions suffix out of TypeScript", async () => {
		const source = await Bun.file(
			new URL("../../src/extensibility/custom-commands/bundled/review/index.ts", import.meta.url),
		).text();

		expect(source).not.toContain("### Additional Instructions");
		expect(source).not.toContain("appendInstructions(");
	});
});

import { describe, expect, it } from "bun:test";
import { TEMPLATE } from "../../src/export/html/template.generated";

describe("HTML export template developer message support", () => {
	it("renders developer-role messages in the main feed", () => {
		expect(TEMPLATE).toContain("msg.role === 'developer'");
		expect(TEMPLATE).toContain("developer-message");
	});

	it("labels developer entries in the sidebar tree", () => {
		expect(TEMPLATE).toContain("tree-role-developer");
		expect(TEMPLATE).toContain("developer:");
	});

	it("counts developer messages in header stats", () => {
		expect(TEMPLATE).toContain("developerMessages");
	});
});

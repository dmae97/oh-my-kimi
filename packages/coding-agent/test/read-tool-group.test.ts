import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { ReadToolGroupComponent } from "../src/modes/components/read-tool-group";
import * as themeModule from "../src/modes/theme/theme";

describe("ReadToolGroupComponent", () => {
	beforeAll(async () => {
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders warning previews with warning styling instead of success styling", () => {
		const component = new ReadToolGroupComponent();
		component.updateArgs({ path: "/tmp/example.ts" }, "read-1");
		component.updateResult(
			{
				content: [{ type: "text", text: "const a = 1;\nconst b = 2;\nconst c = 3;" }],
				details: { suffixResolution: { from: "/tmp/exampl.ts", to: "/tmp/example.ts" } },
			},
			false,
			"read-1",
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));

		expect(rendered).toContain(themeModule.theme.status.warning);
		expect(rendered).not.toContain(themeModule.theme.status.success);
		expect(rendered).toContain("corrected from");
	});

	it("highlights only the collapsed preview lines", () => {
		const highlightSpy = vi.spyOn(themeModule, "highlightCode");
		const component = new ReadToolGroupComponent();
		component.updateArgs({ path: "/tmp/example.ts" }, "read-2");
		component.updateResult(
			{
				content: [
					{
						type: "text",
						text: "line 1\nline 2\nline 3\nline 4\nline 5",
					},
				],
			},
			false,
			"read-2",
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		const highlightedInput = highlightSpy.mock.calls[0]?.[0];

		expect(highlightedInput).toBe("line 1\nline 2\nline 3");
		expect(rendered).toContain("line 1");
		expect(rendered).not.toContain("line 4");
		expect(rendered.toLowerCase()).toContain("ctrl+o");
	});
});

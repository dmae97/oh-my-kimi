import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { editToolRenderer } from "@oh-my-pi/pi-coding-agent/edit/renderer";
import { toolRenderers } from "@oh-my-pi/pi-coding-agent/tools/renderers";
import type { TUI } from "@oh-my-pi/pi-tui";

async function getUiTheme() {
	await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	const theme = await themeModule.getThemeByName("dark");
	expect(theme).toBeDefined();
	return theme!;
}

describe("apply_patch rendering", () => {
	it("registers apply_patch to use the edit renderer", () => {
		expect(toolRenderers.apply_patch).toBe(editToolRenderer);
	});

	it("renders apply_patch results through edit UI instead of generic fallback", async () => {
		await getUiTheme();
		const uiStub = { requestRender() {} } as unknown as TUI;

		const component = new ToolExecutionComponent(
			"apply_patch",
			{
				input: "*** Begin Patch\n*** Update File: src/demo.ts\n@@\n-old\n+new\n*** End Patch",
			},
			{},
			undefined,
			uiStub,
		);

		component.updateResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					path: "src/demo.ts",
					op: "update",
					diff: "@@\n-old\n+new",
				},
			},
			false,
		);

		const rendered = Bun.stripANSI(component.render(140).join("\n"));
		expect(rendered).toContain("src/demo.ts");
		expect(rendered).toContain("+new");
		expect(rendered).not.toContain("(no output)");
	});

	it("derives call path, operation, and file-count hints from apply_patch input", async () => {
		const uiTheme = await getUiTheme();
		const input = [
			"*** Begin Patch",
			"*** Update File: src/first.ts",
			"@@",
			"-before",
			"+after",
			"*** Add File: src/new.ts",
			"+hello",
			"*** End Patch",
		].join("\n");

		const component = editToolRenderer.renderCall({ input }, { expanded: false, isPartial: true }, uiTheme);
		const rendered = Bun.stripANSI(component.render(160).join("\n"));

		expect(rendered).toContain("src/first.ts");
		expect(rendered).toContain("Edit");
		expect(rendered).toContain("(+1 more)");
	});

	it("shows an apply_patch parse error preview for malformed input", async () => {
		const uiTheme = await getUiTheme();
		const malformedInput = ["*** Begin Patch", "*** Update File: src/bad.ts", "*** End Patch"].join("\n");

		const component = editToolRenderer.renderCall({ input: malformedInput }, { expanded: false, isPartial: true }, uiTheme);
		const rendered = Bun.stripANSI(component.render(160).join("\n"));

		expect(rendered).toContain("src/bad.ts");
		expect(rendered).toContain("is empty");
	});

	it("shows apply_patch preview diffs after args complete", async () => {
		await getUiTheme();
		const uiStub = { requestRender() {} } as unknown as TUI;
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "apply-patch-preview-"));
		try {
			await Bun.write(path.join(tmpDir, "preview.ts"), "const value = 1;\n");
			const input = [
				"*** Begin Patch",
				"*** Update File: preview.ts",
				"@@",
				"-const value = 1;",
				"+const value = 2;",
				"*** End Patch",
			].join("\n");

			const component = new ToolExecutionComponent("apply_patch", { input }, {}, undefined, uiStub, tmpDir);
			const before = Bun.stripANSI(component.render(160).join("\n"));
			expect(before).not.toContain("(preview)");

			component.setArgsComplete();
			await Bun.sleep(50);

			const after = Bun.stripANSI(component.render(160).join("\n"));
			expect(after).toContain("(preview)");
			expect(after).toContain("const value = 2;");
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});
});

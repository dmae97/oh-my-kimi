import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import type { TUI } from "@oh-my-pi/pi-tui";
import { theme as activeTheme, getThemeByName, initTheme } from "../../src/modes/theme/theme";
import { readToolRenderer } from "../../src/tools/read";

function extractLinkUris(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/g)].map(match => match[1]!);
}

beforeAll(async () => {
	await initTheme();
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	settings.clearOverride("tui.hyperlinks");
});

afterAll(() => {
	resetSettingsForTest();
});

describe("readToolRenderer hyperlinks", () => {
	it("links local-style read titles to the resolved filesystem path and selected line", async () => {
		settings.override("tui.hyperlinks", "always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const component = readToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "second line" }],
				details: {
					resolvedPath: "/tmp/omp-local/handoff.md",
					displayContent: { text: "second line", startLine: 2 },
					contentType: "text/plain",
				},
			},
			{ expanded: false, isPartial: false },
			theme!,
			{ path: "local://handoff.md:2" },
		);

		const rendered = component.render(200).join("\n");
		expect(rendered).toContain("local://handoff.md");
		expect(rendered).toContain(":2");
		expect(extractLinkUris(rendered)).toContain("file:///tmp/omp-local/handoff.md?line=2");
	});

	it("links HTTP read result headers to the final URL", async () => {
		settings.override("tui.hyperlinks", "always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const component = readToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "---\n\nhello" }],
				details: {
					kind: "url",
					url: "http://example.com/start",
					finalUrl: "http://example.com/final",
					contentType: "text/plain",
					method: "fetch",
					truncated: false,
					notes: [],
				},
			} as never,
			{ expanded: false, isPartial: false },
			theme!,
			{ path: "http://example.com/start" },
		);

		const rendered = component.render(200).join("\n");
		expect(rendered).toContain("example.com /final");
		expect(extractLinkUris(rendered)).toContain("http://example.com/final");
	});
});

describe("read ToolExecutionComponent framing", () => {
	it("renders framed read results inside the standard tool container padding", () => {
		const uiStub = { requestRender() {} } as unknown as TUI;
		const component = new ToolExecutionComponent("read", { path: "src/example.ts" }, {}, undefined, uiStub);
		component.updateResult(
			{
				content: [{ type: "text", text: "export const x = 1;" }],
				details: {
					displayContent: { text: "export const x = 1;", startLine: 1 },
					contentType: "text/plain",
				},
			},
			false,
		);

		try {
			const lines = component.render(80).map(line => Bun.stripANSI(line));
			const topBorderIndex = lines.findIndex(
				line => line.includes(activeTheme.boxSharp.topLeft) && line.includes("Read"),
			);
			const bottomBorderIndex = lines.findIndex(
				(line, index) => index > topBorderIndex && line.includes(activeTheme.boxSharp.bottomLeft),
			);

			expect(topBorderIndex).toBeGreaterThanOrEqual(0);
			expect(lines[topBorderIndex + 1]).toContain("export const x = 1;");
			expect(bottomBorderIndex).toBeGreaterThan(topBorderIndex);
		} finally {
			component.stopAnimation();
		}
	});
});

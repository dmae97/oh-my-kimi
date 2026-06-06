import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { getThemeByName } from "../../src/modes/theme/theme";
import { searchToolRenderer } from "../../src/tools/search";

function extractLinkUris(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/g)].map(match => match[1]!);
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	settings.clearOverride("tui.hyperlinks");
});

afterAll(() => {
	resetSettingsForTest();
});

describe("searchToolRenderer", () => {
	it("keeps summary and truncation rows inside the collapsed line budget", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const result = {
			content: [
				{
					type: "text",
					text: ["alpha:1", "alpha:2", "", "beta:1", "beta:2", "", "gamma:1", "gamma:2"].join("\n"),
				},
			],
			details: {
				matchCount: 6,
				fileCount: 3,
				fileLimitReached: 3,
			},
		};

		const collapsed = searchToolRenderer.renderResult(
			result as never,
			{ expanded: false, isPartial: false },
			uiTheme,
			{
				pattern: "needle",
			},
		);
		const renderedLines = sanitizeText(collapsed.render(200).join("\n")).split("\n");
		const bodyLines = renderedLines.slice(1);

		expect(bodyLines).toHaveLength(6);
		expect(bodyLines.at(-1)).toContain("truncated: first 3 files (skip to paginate)");
		expect(bodyLines.some(line => line.includes("1 more match"))).toBe(true);
		expect(bodyLines.some(line => line.includes("gamma:1"))).toBe(false);
	});

	it("links grouped file headers and code-frame lines to filesystem targets", async () => {
		settings.override("tui.hyperlinks", "always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				matchCount: 1,
				fileCount: 1,
				searchPath: "/tmp/omp-project",
				scopePath: "src",
				displayContent: ["# src/", "## file.ts#abcd", "*12│const needle = true;"].join("\n"),
			},
		};

		const rendered = searchToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { pattern: "needle" })
			.render(240)
			.join("\n");
		const uris = extractLinkUris(rendered);

		expect(uris).toContain("file:///tmp/omp-project/src/file.ts");
		expect(uris).toContain("file:///tmp/omp-project/src/file.ts?line=12");
	});

	it("links single-file code-frame lines to the searched file", async () => {
		settings.override("tui.hyperlinks", "always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;

		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				matchCount: 1,
				fileCount: 1,
				searchPath: "/tmp/omp-project/file.ts",
				scopePath: "file.ts",
				displayContent: "*7│needle();",
			},
		};

		const rendered = searchToolRenderer
			.renderResult(result as never, { expanded: true, isPartial: false }, uiTheme, { pattern: "needle" })
			.render(240)
			.join("\n");

		expect(extractLinkUris(rendered)).toContain("file:///tmp/omp-project/file.ts?line=7");
	});
});

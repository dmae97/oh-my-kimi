import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getDefault } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import {
	ReadToolGroupComponent,
	readArgsTargetInternalUrl,
} from "@oh-my-pi/pi-coding-agent/modes/components/read-tool-group";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

function extractLinkUris(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/g)].map(match => match[1]!);
}

function extractLinkTexts(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;[^\x1b]+\x1b\\([\s\S]*?)\x1b\]8;;\x1b\\/g)].map(match =>
		Bun.stripANSI(match[1]!),
	);
}

describe("ReadToolGroupComponent", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	});

	afterEach(() => {
		settings.clearOverride("tui.hyperlinks");
		vi.restoreAllMocks();
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	it("keeps inline read previews disabled by default", () => {
		expect(getDefault("read.toolResultPreview")).toBe(false);

		const component = new ReadToolGroupComponent();
		component.updateArgs({ path: "/tmp/example.ts" }, "read-0");
		component.updateResult(
			{
				content: [{ type: "text", text: "line 1\nline 2\nline 3\nline 4" }],
			},
			false,
			"read-0",
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));

		expect(rendered).toContain("Read /tmp/example.ts");
		expect(rendered).not.toContain("line 1");
		expect(rendered.toLowerCase()).not.toContain("ctrl+o");
	});

	it("uses the enabled dot for completed reads", () => {
		const component = new ReadToolGroupComponent();
		component.updateArgs({ path: "/tmp/example.ts" }, "read-success");
		component.updateResult(
			{
				content: [{ type: "text", text: "line 1" }],
			},
			false,
			"read-success",
		);

		const rendered = component.render(120).join("\n");
		const plain = Bun.stripANSI(rendered);

		expect(plain).toContain(themeModule.theme.status.enabled);
		expect(plain).not.toContain(themeModule.theme.status.success);
		expect(rendered).toContain(themeModule.theme.fg("text", themeModule.theme.status.enabled));
		expect(rendered).not.toContain(themeModule.theme.fg("success", themeModule.theme.status.enabled));
	});

	it("omits duplicate success marks from multi-read child rows", () => {
		const component = new ReadToolGroupComponent();
		component.updateArgs({ path: "/tmp/one.ts" }, "read-one");
		component.updateArgs({ path: "/tmp/two.ts" }, "read-two");
		component.updateResult({ content: [{ type: "text", text: "one" }] }, false, "read-one");
		component.updateResult({ content: [{ type: "text", text: "two" }] }, false, "read-two");

		const plain = Bun.stripANSI(component.render(120).join("\n"));

		expect(plain).toContain("Read (2)");
		expect(plain).toContain(`${themeModule.theme.tree.branch} /tmp/one.ts`);
		expect(plain).toContain(`${themeModule.theme.tree.last} /tmp/two.ts`);
		expect(plain).not.toContain(`${themeModule.theme.tree.branch} ${themeModule.theme.status.enabled}`);
		expect(plain).not.toContain(`${themeModule.theme.tree.last} ${themeModule.theme.status.enabled}`);
	});

	it("splits a single selector-delimited read argument into child rows", () => {
		const component = new ReadToolGroupComponent();
		component.updateArgs({ path: "/tmp/one.ts:1-2,/tmp/two.ts:3-4;/tmp/three.ts:5-6" }, "read-many");
		component.updateResult({ content: [{ type: "text", text: "combined" }] }, false, "read-many");

		const plain = Bun.stripANSI(component.render(120).join("\n"));

		expect(plain).toContain("Read (3)");
		expect(plain).toContain(`${themeModule.theme.tree.branch} /tmp/one.ts:1-2`);
		expect(plain).toContain(`${themeModule.theme.tree.branch} /tmp/two.ts:3-4`);
		expect(plain).toContain(`${themeModule.theme.tree.last} /tmp/three.ts:5-6`);
	});

	it("merges multi-range selectors into one file row", () => {
		const component = new ReadToolGroupComponent();
		component.updateArgs({ path: "/tmp/example.ts:5-10,20-30" }, "read-ranges");
		component.updateResult({ content: [{ type: "text", text: "ranges" }] }, false, "read-ranges");

		const plain = Bun.stripANSI(component.render(120).join("\n"));

		expect(plain).toContain("Read /tmp/example.ts:5-10,20-30");
		expect(plain).not.toContain("Read (2)");
		expect(plain).not.toContain("full file");
	});

	it("merges repeated same-file ranges and truncates long selector lists", () => {
		const component = new ReadToolGroupComponent();
		component.updateArgs({ path: "/tmp/render.ts:507-605" }, "read-one");
		component.updateArgs({ path: "/tmp/render.ts:1070-1194,1210-1240,1270-1274" }, "read-more");
		component.updateResult({ content: [{ type: "text", text: "one" }] }, false, "read-one");
		component.updateResult({ content: [{ type: "text", text: "more" }] }, false, "read-more");

		const plain = Bun.stripANSI(component.render(120).join("\n"));
		const pathMatches = plain.match(/\/tmp\/render\.ts/g) ?? [];

		expect(pathMatches).toHaveLength(1);
		expect(plain).toContain("/tmp/render.ts:507-605,1070-1194,…,1270-1274");
		expect(plain).not.toContain("1210-1240");
	});

	it("uses result-provided recovered targets for delimited reads", () => {
		const component = new ReadToolGroupComponent();
		component.updateArgs({ path: "/tmp/one.ts /tmp/two.ts" }, "read-recovered");
		component.updateResult(
			{
				content: [{ type: "text", text: "combined" }],
				details: { displayReadTargets: ["/tmp/one.ts", "/tmp/two.ts"] },
			},
			false,
			"read-recovered",
		);

		const plain = Bun.stripANSI(component.render(120).join("\n"));

		expect(plain).toContain("Read (2)");
		expect(plain).toContain(`${themeModule.theme.tree.branch} /tmp/one.ts`);
		expect(plain).toContain(`${themeModule.theme.tree.last} /tmp/two.ts`);
	});

	it("renders warning previews with warning styling instead of success styling", () => {
		const component = new ReadToolGroupComponent({ showContentPreview: true });
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
		const component = new ReadToolGroupComponent({ showContentPreview: true });
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

	it("does not render a duplicate summary row when inline previews are enabled", () => {
		const component = new ReadToolGroupComponent({ showContentPreview: true });
		component.updateArgs({ path: "/tmp/example.ts:L10-L20" }, "read-3");
		component.updateResult(
			{
				content: [{ type: "text", text: "line 1\nline 2\nline 3\nline 4" }],
			},
			false,
			"read-3",
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		const matches = rendered.match(/Read \/tmp\/example\.ts:L10-L20/g) ?? [];

		expect(matches).toHaveLength(1);
	});

	it("links grouped summary paths to resolved filesystem paths and selector lines", () => {
		settings.override("tui.hyperlinks", "always");
		const component = new ReadToolGroupComponent();
		component.updateArgs({ path: "src/example.ts:7-9" }, "read-link");
		component.updateResult(
			{
				content: [{ type: "text", text: "line 7" }],
				details: { meta: { source: { type: "path", value: "/workspace/src/example.ts" } } },
			},
			false,
			"read-link",
		);

		const rendered = component.render(120).join("\n");

		expect(Bun.stripANSI(rendered)).toContain("Read src/example.ts:7-9");
		expect(extractLinkUris(rendered)).toContain("file:///workspace/src/example.ts?line=7");
		expect(extractLinkTexts(rendered)).toContain("src/example.ts");
		expect(extractLinkTexts(rendered)).not.toContain("src/example.ts:7-9");
	});

	it("links inline preview titles when the summary row is suppressed", () => {
		settings.override("tui.hyperlinks", "always");
		const component = new ReadToolGroupComponent({ showContentPreview: true });
		component.updateArgs({ path: "src/preview.ts:20-22" }, "read-preview-link");
		component.updateResult(
			{
				content: [{ type: "text", text: "line 20\nline 21\nline 22" }],
				details: { resolvedPath: "/workspace/src/preview.ts" },
			},
			false,
			"read-preview-link",
		);

		const rendered = component.render(120).join("\n");

		expect(Bun.stripANSI(rendered)).toContain("Read src/preview.ts:20-22");
		expect(extractLinkUris(rendered)).toContain("file:///workspace/src/preview.ts?line=20");
		expect(extractLinkTexts(rendered)).toContain("src/preview.ts");
		expect(extractLinkTexts(rendered)).not.toContain("src/preview.ts:20-22");
	});
});

describe("readArgsTargetInternalUrl", () => {
	it.each([
		["skill://my-skill"],
		["skill://my-skill/file.md"],
		["omp://docs/tools/read.md"],
		["issue://123"],
		["pr://can1357/oh-my-pi/456"],
		["agent://abc"],
		["artifact://abc"],
		["memory://root"],
		["rule://name"],
		["mcp://server/resource"],
		["local://PLAN.md"],
	])("treats %s as an internal URL read", target => {
		expect(readArgsTargetInternalUrl({ path: target })).toBe(true);
		expect(readArgsTargetInternalUrl({ file_path: target })).toBe(true);
	});

	it.each([
		["/tmp/example.ts"],
		["./relative/path.md"],
		["https://example.com/file"],
		[""],
	])("treats %s as a filesystem/external target", target => {
		expect(readArgsTargetInternalUrl({ path: target })).toBe(false);
	});

	it("returns false for non-record / missing arguments", () => {
		expect(readArgsTargetInternalUrl(undefined)).toBe(false);
		expect(readArgsTargetInternalUrl(null)).toBe(false);
		expect(readArgsTargetInternalUrl("skill://x")).toBe(false);
		expect(readArgsTargetInternalUrl(["skill://x"])).toBe(false);
		expect(readArgsTargetInternalUrl({})).toBe(false);
		expect(readArgsTargetInternalUrl({ path: 42 })).toBe(false);
	});
});

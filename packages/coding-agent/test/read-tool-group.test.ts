import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { getDefault } from "../src/config/settings-schema";
import { ReadToolGroupComponent, readArgsTargetInternalUrl } from "../src/modes/components/read-tool-group";
import * as themeModule from "../src/modes/theme/theme";

describe("ReadToolGroupComponent", () => {
	beforeAll(async () => {
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	});

	afterEach(() => {
		vi.restoreAllMocks();
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

	it("uses the read-specific success mark for completed reads", () => {
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

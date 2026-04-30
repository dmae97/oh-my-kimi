import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { RenderResultOptions } from "@oh-my-pi/pi-agent-core";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { bashToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { sanitizeText } from "@oh-my-pi/pi-natives";
import { ImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";

type MutableTerminalInfo = {
	imageProtocol: ImageProtocol | null;
};

const terminal = TERMINAL as unknown as MutableTerminalInfo;

describe("bashToolRenderer", () => {
	const originalProtocol = TERMINAL.imageProtocol;

	afterEach(() => {
		terminal.imageProtocol = originalProtocol;
	});

	it("shows rendered env assignments in the command preview", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const component = bashToolRenderer.renderCall(
			{ command: "printf '%s' \"$MERMAID\"", env: { MERMAID: 'line "one"\ntwo' } },
			{ expanded: false, isPartial: false },
			uiTheme,
		);
		const rendered = sanitizeText(component.render(120).join("\n"));
		expect(rendered).toContain('MERMAID="line \\"one\\"\\ntwo"');
		expect(rendered).toContain("printf '%s' \"$MERMAID\"");
	});

	it("shows partial env assignments while tool args are still streaming", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const component = bashToolRenderer.renderCall(
			{
				command: "printf '%s' \"$MERMAID\"",
				__partialJson: '{"command":"printf \'%s\' "$MERMAID"","env":{"MERMAID":"line 1\\nline 2',
			},
			{ expanded: false, isPartial: true },
			uiTheme,
		);
		const rendered = sanitizeText(component.render(120).join("\n"));
		expect(rendered).toContain('MERMAID="line 1\\nline 2"');
		expect(rendered).toContain("printf '%s' \"$MERMAID\"");
	});

	it("sanitizes command tabs and shortens home cwd in previews", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const component = bashToolRenderer.renderCall(
			{
				command: "printf\t'%s'",
				cwd: path.join(os.homedir(), "projects", "demo"),
			},
			{ expanded: false, isPartial: false },
			uiTheme,
		);
		const rendered = sanitizeText(component.render(120).join("\n"));
		expect(rendered).toContain("~/projects/demo");
		expect(rendered).not.toContain(os.homedir());
		expect(rendered).not.toContain("\t");
	});

	it("shows the effective timeout from result details when it differs from call args", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const component = bashToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details: { timeoutSeconds: 120 }, isError: false },
			{ expanded: false, isPartial: false, renderContext: { timeout: 1200 } },
			uiTheme,
			{ command: "python3 scripts/edit-benchmark.py", timeout: 1200 },
		);
		const rendered = sanitizeText(component.render(120).join("\n"));
		expect(rendered).toContain("Timeout: 120s");
		expect(rendered).not.toContain("Timeout: 1200s");
	});

	it("bypasses truncation/styling for SIXEL lines", async () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		const sixel = "\x1bPqabc\x1b\\";
		const renderOptions: RenderResultOptions & {
			renderContext: {
				output: string;
				expanded: boolean;
				previewLines: number;
			};
		} = {
			expanded: false,
			isPartial: false,
			renderContext: {
				output: `line one\n${sixel}\nline two`,
				expanded: false,
				previewLines: 1,
			},
		};

		const component = bashToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details: {}, isError: false },
			renderOptions,
			uiTheme,
			{ command: "echo sixel" },
		);
		const lines = component.render(80);

		expect(lines.filter(line => line === sixel)).toHaveLength(1);
		expect(lines.some(line => line.includes("ctrl+o to expand"))).toBe(false);
	});
});

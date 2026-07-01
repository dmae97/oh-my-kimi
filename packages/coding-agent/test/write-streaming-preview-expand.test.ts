import { afterEach, describe, expect, it, vi } from "bun:test";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import {
	decodeStreamedToolArgs,
	streamingStringKeysForTool,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/tool-args-reveal";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { writeToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/write";
import type { TUI } from "@oh-my-pi/pi-tui";

const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");
const hasLine = (lines: readonly string[], n: number): boolean =>
	new RegExp(`\\bline ${n}\\b`).test(stripAnsi(lines.join("\n")));

describe("write streaming preview honors Ctrl+O expansion", () => {
	let initialized = false;

	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function makePendingWrite(lineCount: number) {
		if (!initialized) {
			await themeModule.initTheme();
			initialized = true;
		}
		const uiStub = { requestRender() {} } as unknown as TUI;
		const content = Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join("\n");
		// No updateResult() -> the call stays pending, exercising the streaming
		// `renderCall` path (formatStreamingContent), not the merged result render.
		return new ToolExecutionComponent("write", { file_path: "/tmp/foo.ts", content }, {}, undefined, uiStub);
	}

	it("collapses a streaming write to a bounded tail and lifts the cap on expand", async () => {
		// 40 lines > WRITE_STREAMING_PREVIEW_LINES (12): the head must be hidden
		// while collapsed and the streaming edge (tail) kept visible.
		const comp = await makePendingWrite(40);

		const collapsed = comp.render(80);
		// Tail-anchored: the streaming edge (last lines) is visible...
		expect(hasLine(collapsed, 40)).toBe(true);
		// ...but the head is capped away with an "earlier lines" marker.
		expect(hasLine(collapsed, 1)).toBe(false);
		expect(stripAnsi(collapsed.join("\n"))).toContain("earlier line");

		comp.setExpanded(true);
		const expanded = comp.render(80);
		// Ctrl+O lifts the cap: the full file (head through tail) is shown,
		// and the "earlier lines" marker is gone.
		expect(hasLine(expanded, 1)).toBe(true);
		expect(hasLine(expanded, 40)).toBe(true);
		expect(stripAnsi(expanded.join("\n"))).not.toContain("earlier line");
		// Expanding must strictly grow the preview, not just reformat it.
		expect(expanded.length).toBeGreaterThan(collapsed.length);
	});

	it("does not cap a short streaming write that already fits the window", async () => {
		const comp = await makePendingWrite(4);
		const collapsed = comp.render(80);
		expect(hasLine(collapsed, 1)).toBe(true);
		expect(hasLine(collapsed, 4)).toBe(true);
		expect(stripAnsi(collapsed.join("\n"))).not.toContain("earlier line");
	});
	it("reuses the highlighted streaming body across frame renders", async () => {
		if (!initialized) {
			await themeModule.initTheme();
			initialized = true;
		}
		const uiTheme = (await themeModule.getThemeByName("dark")) ?? (await themeModule.getThemeByName("light"));
		expect(uiTheme).toBeDefined();
		const options = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const highlightSpy = vi
			.spyOn(themeModule, "highlightCode")
			.mockImplementation((code: string) => code.split("\n"));
		const component = writeToolRenderer.renderCall(
			{ path: "/tmp/cache.ts", content: "const a = 1;\nconst b = 2;" },
			options,
			uiTheme!,
		);

		component.render(80);
		component.render(120);
		expect(highlightSpy).toHaveBeenCalledTimes(1);

		options.spinnerFrame = 1;
		component.render(120);
		expect(highlightSpy).toHaveBeenCalledTimes(1);
	});

	it("renders execution progress as a partial result without diagnostics", async () => {
		if (!initialized) {
			await themeModule.initTheme();
			initialized = true;
		}
		const uiTheme = (await themeModule.getThemeByName("dark")) ?? (await themeModule.getThemeByName("light"));
		if (!uiTheme) {
			throw new Error("expected an initialized theme");
		}

		const progressText = `Writing 12 bytes to tab\tpath/${"segment/".repeat(20)}UNTRUNCATED_TAIL_SENTINEL.ts...`;
		const component = writeToolRenderer.renderResult(
			{
				content: [{ type: "text", text: progressText }],
				details: {
					resolvedPath: "/tmp/progress.ts",
					diagnostics: {
						errored: true,
						summary: "1 error",
						messages: ["diagnostic sentinel"],
					},
				},
			},
			{ expanded: false, isPartial: true, spinnerFrame: 0 },
			uiTheme,
			{ path: "/tmp/progress.ts", content: "const x = 1;" },
		);

		const rendered = stripAnsi(component.render(100).join("\n"));
		expect(rendered).toContain("Writing 12 bytes to tab");
		expect(rendered).not.toContain("\t");
		expect(rendered).not.toContain("UNTRUNCATED_TAIL_SENTINEL");
		expect(rendered).not.toContain("diagnostic sentinel");
	});

	it("shows content grown past the last throttled parse when rebuilt mid-stream", async () => {
		// Regression: a transcript rebuild (theme change, settings, focus replay)
		// recreates the pending write component while args still stream. The
		// rebuild must decode display args from the raw partialJson buffer — the
		// provider-parsed arguments lag by up to a throttled parse window, and
		// spreading them alone froze the preview at the last full parse.
		if (!initialized) {
			await themeModule.initTheme();
			initialized = true;
		}
		const uiStub = { requestRender() {} } as unknown as TUI;
		const staleContent = "line before throttle";
		// Provider parsed up to here…
		const seenByProvider = `{"path":"/tmp/foo.ts","content":"${staleContent}`;
		// …then the buffer grew, but not enough to re-trigger the 256-byte parse.
		const partialJson = `${seenByProvider}\\nGROWN_TAIL_SENTINEL`;
		const staleProviderArgs = { path: "/tmp/foo.ts", content: staleContent };

		const renderArgs = decodeStreamedToolArgs(partialJson, {
			rawInput: false,
			fullArgs: staleProviderArgs,
			streamingStringKeys: streamingStringKeysForTool("write", false),
		});
		// No updateResult() -> pending, exercising the streaming renderCall path
		// that reads args.content.
		const comp = new ToolExecutionComponent("write", renderArgs, {}, undefined, uiStub);

		const rendered = stripAnsi(comp.render(100).join("\n"));
		expect(rendered).toContain("GROWN_TAIL_SENTINEL");
	});
});

import { afterEach, describe, expect, it, vi } from "bun:test";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
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
			await initTheme();
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
});

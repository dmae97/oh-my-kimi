import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EDIT_MODE_STRATEGIES } from "@oh-my-pi/pi-coding-agent/edit";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";
import { ToolExecutionComponent } from "../src/modes/components/tool-execution";

// Reproduces the streaming-edit "box grows and shrinks repeatedly" stutter and
// proves the render-level high-water reservation holds the box height steady.
//
// A whole-file Myers re-diff is recomputed on every streamed chunk; its optimal
// alignment is not monotonic in payload length, so the visible change region
// gains and loses rows as a partial/just-completed line transiently matches a
// duplicated line further down the file (here, the downstream `}` braces).
describe("streaming edit preview height (monotonic while streaming)", () => {
	const RENDER_WIDTH = 80;
	const oldBlock = ["function foo() {", "  const x = 1;", "  return x;", "}"].join("\n");
	const tail = ["", "function bar() {", "  return 2;", "}", "", "function baz() {", "  return 3;", "}", ""].join("\n");
	const fileContent = `${oldBlock}\n${tail}`;
	const fullNew = [
		"function foo() {",
		"  const x = 1;",
		"  const y = 2;",
		"  const z = 3;",
		"  return x + y + z;",
		"}",
	].join("\n");

	let tmpDir: string;
	let file: string;
	let themed = false;

	beforeEach(async () => {
		if (!themed) {
			await initTheme();
			themed = true;
		}
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stream-height-"));
		file = path.join(tmpDir, "mod.ts");
		await fs.writeFile(file, fileContent);
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tmpDir });
	});

	afterEach(async () => {
		resetSettingsForTest();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	// Char-by-char partials of the new function body.
	const partials = Array.from({ length: fullNew.length }, (_, i) => fullNew.slice(0, i + 1));

	function makeComponent(): { component: ToolExecutionComponent; settle: () => Promise<void> } {
		let resolveRender: (() => void) | null = null;
		const uiStub = {
			requestRender() {
				const r = resolveRender;
				resolveRender = null;
				r?.();
			},
		} as unknown as TUI;
		const tool = { mode: "replace" } as unknown as AgentTool;
		const component = new ToolExecutionComponent(
			"edit",
			{ path: file, edits: [{ old_text: oldBlock, new_text: fullNew.slice(0, 1) }] },
			{},
			tool,
			uiStub,
			tmpDir,
		);
		// Resolve once the next async preview compute lands (or a short cap, so a
		// deduped/no-op tick that never re-renders cannot hang the loop).
		const settle = () =>
			Promise.race([new Promise<void>(res => (resolveRender = res)), Bun.sleep(250).then(() => undefined)]);
		return { component, settle };
	}

	test("rendered height never shrinks across streamed chunks, then collapses on finalize", async () => {
		const { component, settle } = makeComponent();
		await settle();

		const heights: number[] = [];
		for (const newText of partials) {
			const next = settle();
			component.updateArgs({ path: file, edits: [{ old_text: oldBlock, new_text: newText }] });
			await next;
			heights.push(component.render(RENDER_WIDTH).length);
		}

		// A real diff is on screen for the whole stream (not just the title row).
		expect(Math.max(...heights)).toBeGreaterThan(5);

		// Core contract: the box only ever grows while args stream.
		for (let i = 1; i < heights.length; i++) {
			expect(heights[i]).toBeGreaterThanOrEqual(heights[i - 1]);
		}

		// Finalize: args complete → unwrapped render path → the one allowed collapse.
		component.setArgsComplete();
		await settle();
		const finalHeight = component.render(RENDER_WIDTH).length;
		expect(finalHeight).toBeGreaterThan(1); // still shows a real diff
		expect(finalHeight).toBeLessThanOrEqual(Math.max(...heights));
	});

	test("the underlying diff genuinely oscillates (guard against a vacuous test)", async () => {
		const ctx = {
			cwd: tmpDir,
			signal: new AbortController().signal,
			snapshots: undefined as never,
			allowFuzzy: true,
			isStreaming: true,
		};
		const rawLineCounts: number[] = [];
		for (const newText of partials) {
			const previews = await EDIT_MODE_STRATEGIES.replace.computeDiffPreview(
				{ path: file, edits: [{ old_text: oldBlock, new_text: newText }] },
				ctx,
			);
			const first = previews?.[0];
			const diff = first && "diff" in first ? (first.diff ?? "") : "";
			rawLineCounts.push(diff ? diff.split("\n").length : 0);
		}
		const hasDecrease = rawLineCounts.some((count, i) => i > 0 && count < rawLineCounts[i - 1]);
		expect(hasDecrease).toBe(true);
	});
});

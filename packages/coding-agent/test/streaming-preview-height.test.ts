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

	test("real TUI finalization replaces streaming edit preview throughout native scrollback", async () => {
		const previewPrefix = "PREVIEW_ONLY_STREAM_SENTINEL_";
		const finalSentinel = "FINAL_RESULT_SENTINEL_committed_edit";
		const streamedReplacements = Array.from({ length: 18 }, (_unused, i) =>
			[
				"function foo() {",
				"  const x = 1;",
				...Array.from({ length: 10 + (i % 5) }, (_value, j) => `  const p${j} = "${previewPrefix}${i}_${j}";`),
				`  return "${previewPrefix}${i}_tail";`,
				"}",
			].join("\n"),
		);
		const finalDiff = [
			"@@ -1,4 +1,5 @@",
			" function foo() {",
			"   const x = 1;",
			"-  return x;",
			`+  const finalValue = "${finalSentinel}";`,
			"+  return finalValue;",
			" }",
		].join("\n");
		const { component, term, tui } = makeTuiComponent();

		try {
			tui.start();
			await settleTerminal(term);

			let maxStreamingHeight = 0;
			let sawPreviewSentinel = false;
			const streamingStepCount = streamedReplacements.length;
			const lifecycleSteps = [
				...streamedReplacements.map((newText, i) => () => {
					component.updateArgs({ path: file, edits: [{ old_text: oldBlock, new_text: newText }] });
					if (i % 4 === 1) {
						component.setExpanded(true);
					} else if (i % 4 === 3) {
						component.setExpanded(false);
					}
					if (i % 5 === 2) {
						term.resize(68, 7);
					} else if (i % 5 === 4) {
						term.resize(72, 8);
					}
				}),
				() => {
					component.setArgsComplete();
				},
				() => {
					component.updateResult(
						{
							content: [{ type: "text", text: finalSentinel }],
							details: { path: file, diff: finalDiff, firstChangedLine: 3 },
						},
						false,
					);
					component.setExpanded(true);
					term.resize(70, 9);
				},
			];

			for (const [i, applyStep] of lifecycleSteps.entries()) {
				applyStep();
				term.scrollLines(1_000);
				tui.requestRender(i % 3 === 0 || i >= streamingStepCount);
				await settleTerminal(term);

				if (i < streamingStepCount) {
					const rows = normalizedBufferRows(term);
					sawPreviewSentinel ||= rows.some(row => row.includes(previewPrefix));
					maxStreamingHeight = Math.max(maxStreamingHeight, component.render(term.columns).length);
					expect(term.isNativeViewportAtBottom()).toBe(true);
				}
			}

			expect(sawPreviewSentinel).toBe(true);
			expect(maxStreamingHeight).toBeGreaterThan(term.rows);

			const preCheckpointBufferText = normalizedBufferRows(term).join("\n");
			const stalePreviewRowsExistedBeforeCheckpoint = preCheckpointBufferText.includes(previewPrefix);
			term.scrollLines(1_000);
			const checkpointRefreshed = tui.refreshNativeScrollbackIfDirty({ allowUnknownViewport: true });
			await settleTerminal(term);

			const finalBufferText = normalizedBufferRows(term).join("\n");
			expect(finalBufferText).toContain(finalSentinel);
			expect(finalBufferText).not.toContain(previewPrefix);
			if (stalePreviewRowsExistedBeforeCheckpoint) {
				expect(checkpointRefreshed).toBe(true);
			}

			term.scrollLines(-1_000);
			await term.flush();
			const scrolledViewportText = term
				.getViewport()
				.map(row => row.trimEnd())
				.join("\n");
			expect(scrolledViewportText).not.toContain(previewPrefix);
			term.scrollLines(1_000);
			await term.flush();
		} finally {
			component.stopAnimation();
			tui.stop();
			await term.flush();
		}
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

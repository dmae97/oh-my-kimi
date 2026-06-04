import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EDIT_MODE_STRATEGIES } from "@oh-my-pi/pi-coding-agent/edit";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { ToolExecutionComponent } from "../src/modes/components/tool-execution";

// The streaming edit preview is a fixed-height tail window ("cursor"): the last
// EDIT_STREAMING_PREVIEW_LINES rows of the recomputed diff are pinned to the
// bottom, so the box stays a steady, full window of real diff context.
//
// A whole-file Myers re-diff is recomputed on every streamed chunk; its optimal
// alignment is not monotonic in payload length, so a hunk-aware window that kept
// whole change segments grew and shrank tick to tick (the stutter), and the
// earlier high-water fix padded the deficit with blank rows (the "large
// rectangle that is half empty" regression). The tail window has neither.
describe("streaming edit preview height (stable, full tail window)", () => {
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

	// Real TUI + virtual terminal harness: drives the component through the
	// actual differential renderer so native scrollback (not just the in-memory
	// component height) is exercised. Mirrors makeComponent's construction but
	// swaps the stub for a live TUI wired to an xterm-backed terminal.
	function makeTuiComponent(): { component: ToolExecutionComponent; term: VirtualTerminal; tui: TUI } {
		const term = new VirtualTerminal(80, 8);
		const tui = new TUI(term);
		const tool = { mode: "replace" } as unknown as AgentTool;
		const component = new ToolExecutionComponent(
			"edit",
			{ path: file, edits: [{ old_text: oldBlock, new_text: fullNew.slice(0, 1) }] },
			{},
			tool,
			tui,
			tmpDir,
		);
		tui.addChild(component);
		return { component, term, tui };
	}

	// Let the TUI's throttled render pipeline flush, then drain the terminal.
	function settleTerminal(term: VirtualTerminal): Promise<void> {
		return term.waitForRender();
	}

	// Whole native buffer (scrollback + viewport) with trailing padding trimmed.
	function normalizedBufferRows(term: VirtualTerminal): string[] {
		return term.getScrollBuffer().map(row => row.trimEnd());
	}

	test("stays a stable, full window (no half-empty padded box) while streaming", async () => {
		// A large oscillating diff: replace a block of duplicate-ish lines so the
		// recomputed alignment gains and loses rows tick to tick. The diff outgrows
		// the window from the first chunk, so the tail window stays saturated and
		// the box height must hold steady — without padding the deficit with blanks.
		const RENDER_WIDTH_WIDE = 100;
		const dup = Array.from({ length: 24 }, () => "\tstep();").join("\n");
		const bigOld = `function gen() {\n${dup}\n\treturn out;\n}`;
		const bigTail = `\nfunction other() {\n${dup}\n\treturn 0;\n}\n`;
		const bigFile = path.join(tmpDir, "big.ts");
		await fs.writeFile(bigFile, `${bigOld}\n${bigTail}`);
		const bigNew = [
			"function gen() {",
			...Array.from({ length: 24 }, (_v, i) => `\tconst k${i} = ${i};`),
			"\treturn out;",
			"}",
		].join("\n");
		// Stream a line at a time ("as lines come in"): each chunk recomputes the
		// whole-file diff, which the tail window pins to its last rows.
		const bigLines = bigNew.split("\n");
		const bigPartials = bigLines.map((_v, i) => bigLines.slice(0, i + 1).join("\n"));

		const uiStub = { requestRender() {} } as unknown as TUI;
		const tool = { mode: "replace" } as unknown as AgentTool;
		const component = new ToolExecutionComponent(
			"edit",
			{ path: bigFile, edits: [{ old_text: bigOld, new_text: bigNew.slice(0, 1) }] },
			{},
			tool,
			uiStub,
			tmpDir,
		);
		// Await the actual diff recompute rather than racing the spinner's render
		// ticks. The streaming spinner calls requestRender every ~16ms, so on a
		// slow box a tick — not the (file-read + whole-file Myers) compute — would
		// resolve the wait and let us sample a stale, mid-abort preview. That is the
		// CI flake that collapsed Math.min(...steady) to 4. whenPreviewSettled()
		// resolves only when this chunk's recompute has updated the preview.
		await component.whenPreviewSettled();

		const trailingBlankRows = (rows: string[]): number => {
			let n = 0;
			for (let i = rows.length - 1; i >= 0; i--) {
				if (rows[i].replace(/\x1b\[[0-9;]*m/gu, "").trimEnd() === "") n++;
				else break;
			}
			return n;
		};

		const heights: number[] = [];
		let maxTrailingBlank = 0;
		for (const newText of bigPartials) {
			component.updateArgs({ path: bigFile, edits: [{ old_text: bigOld, new_text: newText }] });
			await component.whenPreviewSettled();
			const rows = component.render(RENDER_WIDTH_WIDE);
			heights.push(rows.length);
			maxTrailingBlank = Math.max(maxTrailingBlank, trailingBlankRows(rows));
		}

		// Finalize still renders a real diff.
		component.setArgsComplete();
		await component.whenPreviewSettled();
		const finalizedHeight = component.render(RENDER_WIDTH_WIDE).length;
		component.stopAnimation();

		// The tail window saturates immediately and the box height holds dead
		// steady for the rest of the stream — it neither stutters larger/smaller
		// (the pre-fix overshoot) nor balloons to a high-water peak. Only the very
		// first chunk is a warmup (the unbalanced-removal stabilizer trims the
		// removals-only diff before any addition arrives).
		const steady = heights.slice(1);
		expect(steady.length).toBeGreaterThan(5);
		expect(Math.min(...steady)).toBeGreaterThan(12); // a full window of real diff
		expect(Math.max(...steady) - Math.min(...steady)).toBe(0);
		// And it is never padded into a half-empty rectangle (the regression).
		expect(maxTrailingBlank).toBeLessThanOrEqual(1);
		expect(finalizedHeight).toBeGreaterThan(1);
	});

	test("real TUI finalization replaces streaming edit preview throughout native scrollback", async () => {
		const previewPrefix = "PREVIEW_ONLY_STREAM_SENTINEL_";
		const finalSentinel = "FINAL_RESULT_SENTINEL_committed_edit";
		const streamedReplacements = Array.from({ length: 12 }, (_unused, i) =>
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
		// Real TUI + Ghostty WASM integration can exceed Bun's default budget on CI:
		// startup, repeated native scrollback refreshes, and throttled render frames are
		// intentionally exercised here. Keep the contract assertions above; only widen
		// the integration-test budget.
	}, 30_000);

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

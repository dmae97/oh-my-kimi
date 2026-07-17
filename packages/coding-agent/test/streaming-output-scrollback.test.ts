import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { theme as activeTheme, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { evalToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/eval-render";
import { previewWindowRows } from "@oh-my-pi/pi-coding-agent/tools/render-utils";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

// Long, path-like output that wraps at the box's inner width — the case that
// made a fixed 10-line preview overflow the viewport once committed.
function longLines(count: number): string {
	return Array.from(
		{ length: count },
		(_, i) => `out-line-${i} ${"=".repeat(60)} https://example.com/very/long/path/segment/${i}`,
	).join("\n");
}

type DrainableScheduler = {
	now(): number;
	scheduleImmediate(cb: () => void): void;
	scheduleRender(cb: () => void, delayMs: number): { cancel(): void };
	flush(): void;
};
function makeDrainableScheduler(): DrainableScheduler {
	let clock = 0;
	const queue: Array<{ run: () => void; cancelled: boolean }> = [];
	const enqueue = (cb: () => void) => {
		const item = { run: cb, cancelled: false };
		queue.push(item);
		return item;
	};
	return {
		now: () => clock,
		scheduleImmediate(cb) {
			enqueue(cb);
		},
		scheduleRender(cb) {
			const item = enqueue(cb);
			return {
				cancel() {
					item.cancelled = true;
				},
			};
		},
		flush() {
			let guard = 0;
			while (queue.length > 0) {
				if (++guard > 100_000) throw new Error("scheduler did not settle");
				const item = queue.shift()!;
				clock += 1;
				if (!item.cancelled) item.run();
			}
		},
	};
}

// Plain Component → finalized by default: a settled block above the live region.
class StaticBlock implements Component {
	#lines: string[];
	constructor(lines: string[]) {
		this.#lines = lines;
	}
	invalidate(): void {}
	render(_width: number): string[] {
		return this.#lines;
	}
}

// A still-live predecessor (e.g. a parallel tool that is still running) pins the
// transcript commit boundary, so rows below it stay repaintable until the
// predecessor finalizes.
class LiveBarrier extends StaticBlock {
	isTranscriptBlockFinalized(): boolean {
		return false;
	}
}

// Stand-in for the input editor + status drawn below the transcript.
class Footer implements Component {
	#rows: number;
	constructor(rows: number) {
		this.#rows = rows;
	}
	invalidate(): void {}
	render(_width: number): string[] {
		return Array.from({ length: this.#rows }, (_, i) => `editor-${i}`);
	}
}

const ORIGINAL_ROWS = Object.getOwnPropertyDescriptor(process.stdout, "rows");
function stubStdoutRows(rows: number): void {
	Object.defineProperty(process.stdout, "rows", { configurable: true, value: rows });
}

function makeAssistantMessage(content: AssistantMessage["content"], output = 0): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: output,
			reasoningTokens: output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function streamingPrefixes(text: string, step: number): string[] {
	const prefixes: string[] = [];
	for (let end = Math.min(step, text.length); end < text.length; end += step) {
		prefixes.push(text.slice(0, end));
	}
	prefixes.push(text);
	return prefixes;
}

async function settleFrame(term: VirtualTerminal): Promise<void> {
	// These integration tests use the production TUI scheduler rather than the
	// drainable unit-test scheduler, so the frame timer must elapse for the real
	// differential renderer to write to the Ghostty-backed terminal.
	const nextTick = Promise.withResolvers<void>();
	process.nextTick(nextTick.resolve);
	await nextTick.promise;
	await Bun.sleep(45);
	await term.flush();
}

function plainScrollBuffer(term: VirtualTerminal): string[] {
	return term.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
}

function makeEvalProbeResult(output: string, status: "running" | "complete") {
	return {
		content: [{ type: "text" as const, text: output }],
		details: {
			language: "js" as const,
			languages: ["js" as const],
			cells: [
				{
					index: 0,
					code: "for (const line of probeLines) console.log(line);",
					language: "js" as const,
					output,
					status,
				},
			],
		},
		isError: false,
	};
}
describe("streaming tool output never sprays duplicate scrollback banners", () => {
	beforeAll(async () => {
		await initTheme();
	});
	afterEach(() => {
		if (ORIGINAL_ROWS) Object.defineProperty(process.stdout, "rows", ORIGINAL_ROWS);
		else Reflect.deleteProperty(process.stdout, "rows");
	});

	test("bash: growing partial output under a live predecessor does not duplicate banners", async () => {
		if (process.platform === "win32") return;
		const rows = 14;
		stubStdoutRows(rows);
		const term = new VirtualTerminal(80, rows);
		const scheduler = makeDrainableScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new TranscriptContainer();
		transcript.addChild(new StaticBlock(["user: run the build"]));
		transcript.addChild(new LiveBarrier(["assistant: still working in a parallel tool…"]));
		const bash = new ToolExecutionComponent("bash", { command: "build.sh" }, {}, undefined, tui, process.cwd());
		transcript.addChild(bash);
		tui.addChild(transcript);
		tui.addChild(new Footer(6));

		try {
			tui.start();
			scheduler.flush();
			await term.flush();
			for (let n = 1; n <= 40; n++) {
				bash.updateResult({ content: [{ type: "text", text: longLines(n) }], isError: false }, true);
				term.scrollLines(1000);
				tui.requestRender();
				scheduler.flush();
				await term.flush();
			}
			const buffer = term.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
			const banners = buffer.filter(row => row.includes("ctrl+o")).length;
			// Pre-fix this re-committed a fresh snapshot per streamed frame (~30+).
			expect(banners).toBeLessThanOrEqual(1);
		} finally {
			bash.stopAnimation();
			tui.stop();
			await term.flush();
		}
	}, 30_000);

	test("eval: collapsed cell output stays within the viewport budget", () => {
		const rows = 18;
		stubStdoutRows(rows);
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				cells: [
					{ index: 0, code: "run()", language: "js" as const, output: longLines(60), status: "running" as const },
				],
			},
			isError: false,
		};
		const component = evalToolRenderer.renderResult(result, { expanded: false, isPartial: true }, activeTheme);
		const lines = component.render(80);
		// The collapsed cell box fits the viewport budget: code + output tails are
		// each capped at previewWindowRows() VISUAL rows. Pre-fix the long output
		// wrapped into ~2x its line count and blew past this.
		expect(lines.length).toBeLessThanOrEqual(previewWindowRows() + 10);
		expect(lines.map(line => Bun.stripANSI(line)).join("\n")).toContain("ctrl+o");
	});

	test("streams live assistant thinking and answer rows into native scrollback before finalize", async () => {
		const rows = 8;
		stubStdoutRows(rows);
		const term = new VirtualTerminal(60, rows);
		Object.defineProperty(term, "isNativeViewportAtBottom", { configurable: true, value: () => undefined });
		const tui = new TUI(term);
		const transcript = new TranscriptContainer();
		const assistant = new AssistantMessageComponent(undefined, false);
		transcript.addChild(assistant);
		tui.addChild(transcript);

		const thinking = Array.from(
			{ length: 6 },
			(_, i) => `Thinking paragraph ${i} streaming with plenty of words to wrap here.`,
		).join("\n\n");
		const text = Array.from(
			{ length: 10 },
			(_, i) => `Answer paragraph ${i} with enough content to occupy a full row or two.`,
		).join("\n\n");
		const fullContent: AssistantMessage["content"] = [
			{ type: "thinking", thinking },
			{ type: "text", text },
		];

		try {
			tui.start();
			await settleFrame(term);

			for (const partialThinking of streamingPrefixes(thinking, 300)) {
				assistant.updateContent(makeAssistantMessage([{ type: "thinking", thinking: partialThinking }]), {
					transient: true,
				});
				tui.requestRender();
				await settleFrame(term);
			}

			for (const partialText of streamingPrefixes(text, 300)) {
				assistant.updateContent(
					makeAssistantMessage([
						{ type: "thinking", thinking },
						{ type: "text", text: partialText },
					]),
					{ transient: true },
				);
				tui.requestRender();
				await settleFrame(term);
			}

			const midStreamRows = plainScrollBuffer(term);
			expect(midStreamRows.some(row => row.includes("Thinking paragraph 0"))).toBe(true);
			expect(midStreamRows.some(row => row.includes("Answer paragraph 0 "))).toBe(true);

			assistant.updateContent(makeAssistantMessage(fullContent), { transient: false });
			assistant.markTranscriptBlockFinalized();
			for (let i = 0; i < 2; i++) {
				tui.requestRender();
				await settleFrame(term);
			}

			const finalRows = plainScrollBuffer(term);
			expect(finalRows.filter(row => row.includes("Thinking paragraph 0"))).toHaveLength(1);
			expect(finalRows.filter(row => row.includes("Answer paragraph 0 "))).toHaveLength(1);
		} finally {
			assistant.dispose();
			tui.stop();
			await term.flush();
		}
	}, 30_000);

	test("finalizes a width-growing streamed table exactly once", async () => {
		const rows = 8;
		stubStdoutRows(rows);
		const term = new VirtualTerminal(80, rows);
		Object.defineProperty(term, "isNativeViewportAtBottom", { configurable: true, value: () => undefined });
		const scheduler = makeDrainableScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		// Exercise the default append-only path directly; erase-and-replay would
		// hide the duplicate-history regression this test is meant to catch.
		tui.setScrollbackRebuild(false);
		const transcript = new TranscriptContainer();
		const assistant = new AssistantMessageComponent(undefined, false);
		transcript.addChild(assistant);
		tui.addChild(transcript);

		const entries = [
			"alpha",
			"beta-entry",
			"gamma-component",
			"delta-module",
			"epsilon-adapter",
			"zeta-runner",
			"eta-service",
			"theta-provider",
			"iota-component-with-later-width-growth",
			"kappa-component-with-later-width-growth",
		];
		const markers = entries.map((_, index) => `R${index.toString().padStart(3, "0")}`);
		const table = (count: number): string =>
			[
				"| Entry | Col A | Col B | Col C | Col D |",
				"| --- | --- | --- | --- | --- |",
				...entries.slice(0, count).map((entry, index) => `| ${entry} | - | ${markers[index]} | - | - |`),
			].join("\n");

		try {
			tui.start();
			scheduler.flush();
			await term.flush();

			for (let count = 1; count <= 8; count++) {
				assistant.updateContent(makeAssistantMessage([{ type: "text", text: table(count) }]), {
					transient: true,
				});
				tui.requestRender();
				scheduler.flush();
				await term.flush();
			}

			const midRows = plainScrollBuffer(term);
			const headerIndex = midRows.findIndex(row => row.includes("Entry"));
			expect(headerIndex).toBeGreaterThanOrEqual(0);
			expect(headerIndex).toBeLessThan(term.getBufferPosition().baseY);
			expect(midRows.filter(row => row.includes("Entry"))).toHaveLength(1);

			for (let count = 9; count <= entries.length; count++) {
				assistant.updateContent(makeAssistantMessage([{ type: "text", text: table(count) }]), {
					transient: true,
				});
				tui.requestRender();
				scheduler.flush();
				await term.flush();
			}

			assistant.updateContent(makeAssistantMessage([{ type: "text", text: table(entries.length) }]), {
				transient: false,
			});
			assistant.markTranscriptBlockFinalized();
			for (let i = 0; i < 2; i++) {
				tui.requestRender();
				scheduler.flush();
				await term.flush();
			}

			const finalRows = plainScrollBuffer(term);
			expect(finalRows.filter(row => row.includes("Entry"))).toHaveLength(1);
			expect(markers.map(marker => finalRows.filter(row => row.includes(marker)).length)).toEqual(
				markers.map(() => 1),
			);
		} finally {
			assistant.dispose();
			tui.stop();
			await term.flush();
		}
	}, 30_000);

	test("expanded live eval output records painted rows without spraying after settle", async () => {
		const rows = 8;
		stubStdoutRows(rows);
		const term = new VirtualTerminal(60, rows);
		const tui = new TUI(term);
		const transcript = new TranscriptContainer();
		const component = new ToolExecutionComponent(
			"eval",
			{ code: "probeLines.forEach(console.log)", language: "js" },
			{},
			undefined,
			tui,
		);
		transcript.addChild(component);
		tui.addChild(transcript);
		const probeLines = Array.from({ length: 30 }, (_, i) => `probe-line-${i}`);
		const output = probeLines.join("\n");

		try {
			tui.start();
			await settleFrame(term);

			component.updateResult(makeEvalProbeResult(output, "running"), true);
			component.setExpanded(true);
			for (let i = 0; i < 3; i++) {
				tui.requestRender();
				await settleFrame(term);
			}

			const midRunRows = plainScrollBuffer(term);
			expect(midRunRows.some(row => row.includes("probe-line-0"))).toBe(true);

			component.updateResult(makeEvalProbeResult(output, "complete"), false);
			for (let i = 0; i < 2; i++) {
				tui.requestRender();
				await settleFrame(term);
			}

			const settledRows = plainScrollBuffer(term);
			for (const line of probeLines) {
				expect(settledRows.some(row => row.includes(line))).toBe(true);
			}
			const settledTape = settledRows.join("\n");
			const settledLength = settledRows.length;

			for (let i = 0; i < 2; i++) {
				tui.requestRender();
				await settleFrame(term);
			}

			const repeatedRows = plainScrollBuffer(term);
			expect(repeatedRows).toHaveLength(settledLength);
			expect(repeatedRows.join("\n")).toBe(settledTape);
		} finally {
			component.stopAnimation();
			tui.stop();
			await term.flush();
		}
	}, 30_000);
});

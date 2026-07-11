/**
 * Contracts: vibe tool renderers.
 *
 * 1. spawn/send render a mini composer — the message typed into a tiny CLI
 *    frame with a prompt glyph and (while pending) a blinking cursor.
 * 2. wait/list render the TV wall: one boxed screen per worker, stacked, a
 *    running screen showing its tool-call trace, current tool, and streamed
 *    text tail; an idle screen its last-activity gist; a settled screen its
 *    delivery footer.
 * 3. Every emitted line respects the render width (sanitized, truncated).
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "../../config/settings";
import { getThemeByName, setThemeInstance, type Theme } from "../../modes/theme/theme";
import type { VibeScreenSnapshot } from "../../vibe/runtime";
import { createVibeToolRenderer, type VibeToolDetails } from "../vibe";

const strip = (lines: readonly string[]): string[] =>
	lines.map(line =>
		line.replace(/\x1b\]8;[^\x1b\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;]*m/g, ""),
	);

function makeScreen(overrides: Partial<VibeScreenSnapshot> = {}): VibeScreenSnapshot {
	return {
		id: "Anna",
		cli: "fast",
		state: "running",
		turns: 1,
		queued: 0,
		trace: [],
		outputTail: [],
		lastActivityAt: Date.now(),
		...overrides,
	};
}

function renderLines(component: { render(width: number): readonly string[] }, width = 100): string[] {
	return strip(component.render(width));
}

describe("vibe tool renderers", () => {
	let uiTheme: Theme;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		uiTheme = loaded;
		setThemeInstance(uiTheme);
	});

	it("send composer types the message into a mini CLI frame with a blinking cursor while pending", () => {
		const renderer = createVibeToolRenderer("send");
		const component = renderer.renderCall(
			{ session: "Anna", message: "Focus on the API first.\nThen tests." },
			{ expanded: false, isPartial: true, spinnerFrame: 0 },
			uiTheme,
		) as { render(width: number): readonly string[] };
		const text = renderLines(component).join("\n");

		expect(text).toContain("vibe send → Anna");
		expect(text).toContain("> Focus on the API first.");
		expect(text).toContain("Then tests.▌");
		expect(text).toContain("delivering…");
		// Odd frame: cursor blinks off.
		const off = renderLines(
			renderer.renderCall(
				{ session: "Anna", message: "Hi" },
				{ expanded: false, isPartial: true, spinnerFrame: 1 },
				uiTheme,
			) as { render(width: number): readonly string[] },
		).join("\n");
		expect(off).not.toContain("▌");
	});

	it("send result frames the ack under the composer", () => {
		const renderer = createVibeToolRenderer("send");
		const details: VibeToolDetails = {
			op: "send",
			screens: [makeScreen()],
			send: { id: "Anna", mode: "steered" },
		};
		const component = renderer.renderResult(
			{ content: [{ type: "text", text: "ack" }], details },
			{ expanded: false, isPartial: false },
			uiTheme,
			{ session: "Anna", message: "Focus on the API first." },
		) as { render(width: number): readonly string[] };
		const text = renderLines(component).join("\n");

		expect(text).toContain("vibe send → Anna");
		expect(text).toContain("> Focus on the API first.");
		expect(text).toContain("steered into the running turn");
		expect(text).not.toContain("▌");
	});

	it("wait renders stacked TV screens: live trace + streamed text, idle gist, settled footer", () => {
		const renderer = createVibeToolRenderer("wait");
		const details: VibeToolDetails = {
			op: "wait",
			screens: [
				makeScreen({
					id: "Anna",
					cli: "fast",
					state: "running",
					turnStartedAt: Date.now() - 5000,
					turnMessage: "Build the widget",
					trace: ["read(src/foo.ts)", "bash(bun test)"],
					currentTool: "edit",
					lastIntent: "Fixing the parser",
					outputTail: ["The parser now accepts nested arrays"],
					model: "prov/fast-model",
				}),
				makeScreen({ id: "Bob", cli: "good", state: "idle", turns: 2, lastActivity: "turn 2 completed" }),
			],
			wait: { settled: [{ id: "Bob", jobId: "Bob-t2", status: "completed" }], stillRunning: ["Anna"], timedOut: false },
		};
		const component = renderer.renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: true, isPartial: true, spinnerFrame: 2 },
			uiTheme,
			{ sessions: ["Anna", "Bob"] },
		) as { render(width: number): readonly string[] };
		const lines = renderLines(component);
		const text = lines.join("\n");

		// One framed screen per worker, stacked.
		expect(lines.filter(line => line.includes("╭─")).length).toBe(2);
		expect(lines.filter(line => line.startsWith("╰─")).length).toBe(2);
		// Live screen: header, typed turn message, trace, current tool, streamed tail.
		expect(text).toContain("Anna");
		// Badge glyphs are theme-driven (⟦fast⟧ on dark); assert the flavor label itself.
		expect(text).toMatch(/fast.\s*Anna/u);
		expect(text).toContain("> Build the widget");
		expect(text).toContain("read(src/foo.ts)");
		expect(text).toContain("bash(bun test)");
		expect(text).toContain("edit: Fixing the parser");
		expect(text).toContain("The parser now accepts nested arrays");
		expect(text).toContain("prov/fast-model");
		// Idle screen + settled footer.
		expect(text).toContain("Bob");
		expect(text).toContain("turn 2 completed");
		expect(text).toContain("turn completed — result delivered");
		// Wall header counts what is on air.
		expect(text).toContain("1 on air");
	});

	it("clamps every TV line to the render width", () => {
		const renderer = createVibeToolRenderer("list");
		const details: VibeToolDetails = {
			op: "list",
			screens: [
				makeScreen({
					id: "VeryLongSessionNameForTruncation",
					trace: [`read(${"x".repeat(200)})`],
					outputTail: ["y".repeat(300)],
					currentTool: "bash",
					currentToolArgs: "z".repeat(200),
				}),
			],
		};
		const component = renderer.renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: true, isPartial: false },
			uiTheme,
			{},
		) as { render(width: number): readonly string[] };
		const width = 48;
		for (const line of renderLines(component, width)) {
			expect(line.length).toBeLessThanOrEqual(width);
		}
	});
});

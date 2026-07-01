import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "../config/settings";
import { getThemeByName, setThemeInstance, type Theme } from "../modes/theme/theme";
import { renderResult } from "./render";
import type { AgentProgress, TaskToolDetails } from "./types";

const strip = (lines: readonly string[]): string =>
	lines
		.join("\n")
		.replace(/\x1b\]8;[^\x1b\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-9;]*m/g, "");

const originalRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");

function setViewportRows(rows: number): void {
	Object.defineProperty(process.stdout, "rows", { configurable: true, value: rows });
}

function restoreViewportRows(): void {
	if (originalRowsDescriptor) {
		Object.defineProperty(process.stdout, "rows", originalRowsDescriptor);
		return;
	}
	Reflect.deleteProperty(process.stdout, "rows");
}

function makeProgress(recentOutput: string[]): AgentProgress {
	return {
		index: 0,
		id: "NoisySubagent",
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "produce noisy output",
		recentTools: [],
		recentOutput,
		toolCount: 1,
		requests: 1,
		tokens: 0,
		cost: 0,
		durationMs: 0,
	};
}

function renderProgressText(progress: AgentProgress, expanded: boolean, uiTheme: Theme): string {
	const details: TaskToolDetails = {
		projectAgentsDir: null,
		results: [],
		totalDurationMs: 1,
		progress: [progress],
	};
	const component = renderResult(
		{ content: [{ type: "text", text: "Running 1 agent..." }], details },
		{ expanded, isPartial: true },
		uiTheme,
	);
	return strip(component.render(120));
}

describe("task live progress rendering", () => {
	let uiTheme: Theme;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		uiTheme = loaded;
		setThemeInstance(uiTheme);
	});

	afterEach(() => {
		restoreViewportRows();
	});

	it("caps subagent recent output with the viewport budget instead of a fixed six lines", () => {
		setViewportRows(40);
		const chronological = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`);
		const text = renderProgressText(makeProgress([...chronological].reverse()), true, uiTheme);

		expect(text).toContain("line 1");
		expect(text).toContain("line 8");
		expect(text).not.toContain("more lines");
	});

	it("keeps the newest subagent output when the viewport cap truncates", () => {
		setViewportRows(24);
		const chronological = Array.from({ length: 8 }, (_, index) => `line ${index + 1}`);
		const text = renderProgressText(makeProgress([...chronological].reverse()), true, uiTheme);

		expect(text).toContain("… 3 earlier lines");
		expect(text).not.toContain("line 1");
		expect(text).not.toContain("line 3");
		expect(text).toContain("line 4");
		expect(text).toContain("line 8");
	});

	it("strips bash footer notices from expanded subagent recent output", () => {
		setViewportRows(40);
		const chronological = [
			"line 1",
			"line 2",
			"line 3",
			"line 4",
			"line 5",
			"line 6",
			"Wall time: 0.03 seconds",
			"[raw output: artifact://123]",
		];
		const progress = makeProgress([...chronological].reverse());

		const expandedText = renderProgressText(progress, true, uiTheme);
		expect(expandedText).toContain("line 1");
		expect(expandedText).toContain("line 6");
		expect(expandedText).not.toContain("Wall time:");
		expect(expandedText).not.toContain("raw output:");

		const collapsedText = renderProgressText(progress, false, uiTheme);
		expect(collapsedText).not.toContain("line 1");
		expect(collapsedText).not.toContain("raw output:");
	});
});

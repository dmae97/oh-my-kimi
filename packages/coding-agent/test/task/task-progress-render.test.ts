import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { RenderResultOptions } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { taskToolRenderer } from "@oh-my-pi/pi-coding-agent/task/render";
import type { AgentProgress, TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/types";

function runningProgress(overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id: "KeySettingsHotPaths",
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "investigate hot paths",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function detailsFor(progress: AgentProgress): TaskToolDetails {
	return { projectAgentsDir: null, results: [], totalDurationMs: 0, progress: [progress] };
}

function findRow(component: { render: (w: number) => string[] }, needle: string): string {
	const row = component
		.render(120)
		.join("\n")
		.split("\n")
		.find(line => Bun.stripANSI(line).includes(needle));
	expect(row).toBeDefined();
	return row!;
}

describe("task progress rendering", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});
	it("uses a static bullet and shimmers only the running subagent name", async () => {
		const theme = (await getThemeByName("dark"))!;
		expect(theme).toBeDefined();
		// Pin the sweep so the shimmer crest deterministically lands on the name.
		vi.spyOn(Date, "now").mockReturnValue(683);
		const options: RenderResultOptions = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const progress = runningProgress({ id: "CountPackages", description: "List workspace packages" });

		const rawRow = findRow(
			taskToolRenderer.renderResult(
				{ content: [{ type: "text", text: "" }], details: detailsFor(progress) },
				options,
				theme,
			),
			"CountPackages",
		);
		const strippedRow = Bun.stripANSI(rawRow);

		expect(strippedRow).toContain("• CountPackages: List workspace packages");
		expect(strippedRow).not.toContain(theme.status.running);
		expect(strippedRow).not.toContain(theme.getSpinnerFrames("status")[0]);
		// Bold crest only comes from the shimmer palette; the description remains
		// one solid, non-shimmered run.
		expect(rawRow).toContain("\x1b[1m");
		const descriptionIndex = rawRow.indexOf(": List workspace packages");
		expect(descriptionIndex).toBeGreaterThan(0);
		expect(rawRow.slice(descriptionIndex)).not.toContain("\x1b[1m");
	});

	it("keeps the bullet replacement when shimmer is disabled", async () => {
		const theme = (await getThemeByName("dark"))!;
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "display.shimmer": "disabled" } });
		const options: RenderResultOptions = { expanded: false, isPartial: true, spinnerFrame: 0 };

		const strippedRow = Bun.stripANSI(
			findRow(
				taskToolRenderer.renderResult(
					{ content: [{ type: "text", text: "" }], details: detailsFor(runningProgress()) },
					options,
					theme,
				),
				"KeySettingsHotPaths",
			),
		);

		expect(strippedRow).toContain("• KeySettingsHotPaths");
		expect(strippedRow).not.toContain(theme.status.running);
		expect(strippedRow).not.toContain(theme.getSpinnerFrames("status")[0]);
	});
});

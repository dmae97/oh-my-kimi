import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { RenderResultOptions } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { taskToolRenderer } from "@oh-my-pi/pi-coding-agent/task/render";
import type { AgentProgress, SingleResult, TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/types";

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
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function finishedResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "Agent",
		agent: "task",
		agentSource: "bundled",
		task: "investigate hot paths",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 0,
		tokens: 0,
		requests: 0,
		...overrides,
	};
}

function detailsFor(progress: AgentProgress): TaskToolDetails {
	return { projectAgentsDir: null, results: [], totalDurationMs: 0, progress: [progress] };
}

function findRow(component: { render: (w: number) => readonly string[] }, needle: string): string {
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
	it("keeps the subagent label solid and shimmers the running description", async () => {
		const theme = (await getThemeByName("dark"))!;
		expect(theme).toBeDefined();
		const options: RenderResultOptions = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const progress = runningProgress({ id: "CountPackages", description: "List workspace packages" });

		const renderRow = (timeMs: number): string => {
			vi.spyOn(Date, "now").mockReturnValue(timeMs);
			return findRow(
				taskToolRenderer.renderResult(
					{ content: [{ type: "text", text: "" }], details: detailsFor(progress) },
					options,
					theme,
				),
				"CountPackages",
			);
		};

		const rawRow0 = renderRow(0);
		const rawRow1 = renderRow(700);
		const strippedRow = Bun.stripANSI(rawRow0);

		expect(strippedRow).toContain("• CountPackages: List workspace packages");
		expect(strippedRow).not.toContain(theme.status.running);
		expect(strippedRow).not.toContain(theme.getSpinnerFrames("status")[0]);
		// The label is one solid bold-accent run, identical across shimmer frames.
		const label = theme.fg("accent", theme.bold("CountPackages"));
		expect(rawRow0).toContain(label);
		expect(rawRow1).toContain(label);
		// The description shimmers, so the row as a whole animates between frames.
		expect(rawRow0).not.toBe(rawRow1);
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

	it("shimmers the pending description like a running one (frozen async spawn snapshot)", async () => {
		const theme = (await getThemeByName("dark"))!;
		const options: RenderResultOptions = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const progress = runningProgress({
			id: "BestGpt",
			status: "pending",
			description: "Combine winners for gpt",
		});

		const renderRow = (timeMs: number): string => {
			vi.spyOn(Date, "now").mockReturnValue(timeMs);
			return findRow(
				taskToolRenderer.renderResult(
					{ content: [{ type: "text", text: "" }], details: detailsFor(progress) },
					options,
					theme,
				),
				"BestGpt",
			);
		};

		const rawRow0 = renderRow(0);
		const rawRow1 = renderRow(700);

		expect(Bun.stripANSI(rawRow0)).toContain("BestGpt: Combine winners for gpt");
		// The label stays one solid bold-accent run; the description shimmers,
		// so the row animates across frames exactly like a running agent's.
		const label = theme.fg("accent", theme.bold("BestGpt"));
		expect(rawRow0).toContain(label);
		expect(rawRow1).toContain(label);
		expect(rawRow0).not.toBe(rawRow1);
	});

	it("renders the assignment markdown inside the result frame", async () => {
		const theme = (await getThemeByName("dark"))!;
		setThemeInstance(theme);
		const options: RenderResultOptions = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const progress = runningProgress({ id: "BestGpt", status: "pending", description: "Combine winners" });

		const rendered = Bun.stripANSI(
			taskToolRenderer
				.renderResult(
					{ content: [{ type: "text", text: "Spawned agent BestGpt..." }], details: detailsFor(progress) },
					options,
					theme,
					{ agent: "task", id: "BestGpt", assignment: "# Target\nCombine the winning patches." },
				)
				.render(120)
				.join("\n"),
		);

		// The brief stays visible for the whole task lifecycle, not just while
		// the call args stream in.
		expect(rendered).toContain("Target");
		expect(rendered).toContain("Combine the winning patches.");
	});

	it("pins unfinished tasks below finished ones, finished sorted by runtime asc", async () => {
		const theme = (await getThemeByName("dark"))!;
		const options: RenderResultOptions = { expanded: false, isPartial: true, spinnerFrame: 0 };
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			progress: [
				runningProgress({ index: 0, id: "FirstRunning", status: "running", durationMs: 9000 }),
				runningProgress({ index: 1, id: "DoneSlow", status: "completed", durationMs: 5000 }),
				runningProgress({ index: 2, id: "StillPending", status: "pending" }),
				runningProgress({ index: 3, id: "FailedFast", status: "failed", durationMs: 1000 }),
			],
		};

		const rendered = Bun.stripANSI(
			taskToolRenderer
				.renderResult({ content: [{ type: "text", text: "" }], details }, options, theme)
				.render(120)
				.join("\n"),
		);

		// Finished agents sorted by runtime ascending; pending/running stay at the
		// bottom in dispatch order.
		const positions = ["FailedFast", "DoneSlow", "FirstRunning", "StillPending"].map(id => rendered.indexOf(id));
		expect(positions.every(p => p >= 0)).toBe(true);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
	});

	it("orders finalized results by runtime asc, matching the live view", async () => {
		const theme = (await getThemeByName("dark"))!;
		const options: RenderResultOptions = { expanded: false, isPartial: false };
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [
				finishedResult({ index: 0, id: "SlowFinish", durationMs: 9000 }),
				finishedResult({ index: 1, id: "FastFinish", durationMs: 1000 }),
				finishedResult({ index: 2, id: "MidFinish", durationMs: 4000 }),
			],
			totalDurationMs: 9000,
		};

		const rendered = Bun.stripANSI(
			taskToolRenderer
				.renderResult({ content: [{ type: "text", text: "" }], details }, options, theme)
				.render(120)
				.join("\n"),
		);

		const positions = ["FastFinish", "MidFinish", "SlowFinish"].map(id => rendered.indexOf(id));
		expect(positions.every(p => p >= 0)).toBe(true);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
	});
});

describe("task result detail-less state", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("renders a validation failure with the error glyph, not a success bullet", async () => {
		const theme = (await getThemeByName("dark"))!;
		// The assignment section renders markdown, which reads the active theme.
		setThemeInstance(theme);
		const options: RenderResultOptions = { expanded: false, isPartial: false };
		const component = taskToolRenderer.renderResult(
			{
				content: [{ type: "text", text: 'Validation failed for tool "task": assignment: Invalid input' }],
				isError: true,
			},
			options,
			theme,
			{ agent: "explore", assignment: "Look around." },
		);
		const stripped = Bun.stripANSI(component.render(120).join("\n"));

		// A failed task must surface the error glyph and never the "done" bullet.
		expect(stripped).toContain(theme.status.error);
		expect(stripped).not.toContain(theme.status.done);
		expect(stripped).toContain("Task");
		expect(stripped).toContain("explore");
		expect(stripped).toContain("Validation failed");
	});

	it("renders a detail-less success with the accent bullet, not an error glyph", async () => {
		const theme = (await getThemeByName("dark"))!;
		setThemeInstance(theme);
		const options: RenderResultOptions = { expanded: false, isPartial: false };
		const component = taskToolRenderer.renderResult({ content: [{ type: "text", text: "done" }] }, options, theme, {
			agent: "explore",
			assignment: "Look around.",
		});
		const stripped = Bun.stripANSI(component.render(120).join("\n"));

		expect(stripped).toContain(theme.status.done);
		expect(stripped).not.toContain(theme.status.error);
	});
});

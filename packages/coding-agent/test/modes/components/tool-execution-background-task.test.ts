import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentProgress, SingleResult, TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/types";
import type { TUI } from "@oh-my-pi/pi-tui";

function progressEntry(description: string): AgentProgress {
	return {
		index: 0,
		id: "Anna",
		agent: "explore",
		agentSource: "bundled",
		status: "running",
		task: "investigate the auth flow",
		description,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
	};
}

/** A detached spawn's partial result: `async.state === "running"` plus live progress rows. */
function asyncSnapshot(description: string): {
	content: Array<{ type: string; text: string }>;
	details: TaskToolDetails;
} {
	return {
		content: [{ type: "text", text: "Background job started" }],
		details: {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			progress: [progressEntry(description)],
			async: { state: "running", jobId: "job-1", type: "task" },
		},
	};
}

function finalSnapshot(output: string): {
	content: Array<{ type: string; text: string }>;
	details: TaskToolDetails;
} {
	const result: SingleResult = {
		index: 0,
		id: "Anna",
		agent: "explore",
		agentSource: "bundled",
		task: "investigate the auth flow",
		exitCode: 0,
		output,
		stderr: "",
		truncated: false,
		durationMs: 1234,
		tokens: 10,
		requests: 1,
	};
	return {
		content: [{ type: "text", text: output }],
		details: {
			projectAgentsDir: null,
			results: [result],
			totalDurationMs: 1234,
			async: { state: "completed", jobId: "job-1", type: "task" },
		},
	};
}

// Contract under test: a detached (`async.state === "running"`) task block keeps
// progress rows static, avoids a redraw driver, freezes once a later partial
// snapshot observes that it left the live region, drops further partial
// snapshots, and still applies the final (completed) snapshot.
describe("ToolExecutionComponent detached task freeze", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		await initTheme();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function makeComponent(live: () => boolean) {
		const requestRender = vi.fn();
		const ui = { requestRender } as unknown as TUI;
		const component = new ToolExecutionComponent(
			"task",
			{ agent: "explore", id: "Anna", description: "scout auth", assignment: "investigate the auth flow" },
			{ liveRegion: { isBlockInLiveRegion: () => live() } },
			undefined,
			ui,
		);
		return { component, requestRender };
	}

	it("does not drive redraws while live and keeps progress bytes static", () => {
		vi.useFakeTimers();
		const { component, requestRender } = makeComponent(() => true);

		component.updateResult(asyncSnapshot("scouting the auth flow"), true);
		requestRender.mockClear();
		vi.advanceTimersByTime(500);
		expect(requestRender).not.toHaveBeenCalled();

		vi.spyOn(Date, "now").mockReturnValue(1_000);
		const frameA = component.render(100).join("\n");
		vi.spyOn(Date, "now").mockReturnValue(5_000);
		const frameB = component.render(100).join("\n");
		expect(frameB).toBe(frameA);
		expect(stripVTControlCharacters(frameA)).toContain("scouting the auth flow");
	});

	it("drops partial snapshots after the freeze but still applies the final result", () => {
		vi.useFakeTimers();
		let live = true;
		const { component } = makeComponent(() => live);

		component.updateResult(asyncSnapshot("scouting the auth flow"), true);
		live = false;
		vi.advanceTimersByTime(40);

		// Frozen: later progress snapshots must not repaint commit-eligible rows.
		component.updateResult(asyncSnapshot("a much newer description"), true);
		const frozen = stripVTControlCharacters(component.render(100).join("\n"));
		expect(frozen).toContain("scouting the auth flow");
		expect(frozen).not.toContain("a much newer description");

		// The terminal snapshot is not progress churn — it settles the block.
		component.updateResult(finalSnapshot("found it in src/auth.ts"), false);
		const final = stripVTControlCharacters(component.render(100).join("\n"));
		expect(final).toContain("found it in src/auth.ts");
	});
});

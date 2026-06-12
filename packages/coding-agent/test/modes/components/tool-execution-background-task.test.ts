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

// Contract under test: a detached (`async.state === "running"`) task block
// animates its shimmer at the spinner cadence while it sits inside the
// transcript live region, then freezes — driver stopped, bytes static, further
// partial snapshots dropped — the moment it leaves the region. The final
// (completed) snapshot still applies.
describe("ToolExecutionComponent detached task shimmer freeze", () => {
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

	it("drives redraws while in the live region, then freezes once out and stays byte-stable", () => {
		vi.useFakeTimers();
		let live = true;
		const { component, requestRender } = makeComponent(() => live);

		component.updateResult(asyncSnapshot("scouting the auth flow"), true);
		requestRender.mockClear();
		vi.advanceTimersByTime(200);
		// ~30fps driver: 200ms must produce several redraw requests.
		expect(requestRender.mock.calls.length).toBeGreaterThanOrEqual(4);

		// Block leaves the live region: the next tick freezes it and clears the interval.
		live = false;
		vi.advanceTimersByTime(40);
		requestRender.mockClear();
		vi.advanceTimersByTime(500);
		expect(requestRender).not.toHaveBeenCalled();

		// Frozen rows no longer sample the clock: bytes identical across time.
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

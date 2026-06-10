import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TaskParams } from "@oh-my-pi/pi-coding-agent/task";
import { taskToolRenderer } from "@oh-my-pi/pi-coding-agent/task/render";

describe("task renderer: streaming call preview", () => {
	let theme: Theme;

	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		const resolved = await getThemeByName("dark");
		expect(resolved).toBeDefined();
		theme = resolved!;
		setThemeInstance(theme);
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	function render(args: TaskParams, expanded = false): string {
		const component = taskToolRenderer.renderCall(args, { expanded, isPartial: true }, theme);
		return Bun.stripANSI(component.render(160).join("\n"));
	}

	// The preview must surface the agent id + ui description so the user can
	// see what is being dispatched while args stream in.
	it("shows the agent id, description, and assignment preview", () => {
		const args: TaskParams = {
			agent: "reviewer",
			id: "ReviewAuth",
			description: "Audit the auth module",
			assignment: "Review packages/server/src/auth for missing 401 handling.\nReport findings.",
		};
		const out = render(args);

		expect(out).toContain("reviewer");
		expect(out).toContain("ReviewAuth");
		expect(out).toContain("Audit the auth module");
		expect(out).toContain("Review packages/server/src/auth for missing 401 handling.");
	});

	it("renders partially-streamed args without crashing", () => {
		const args = {
			agent: "task",
			id: "First",
			// description/assignment not yet arrived.
		} as unknown as TaskParams;

		const out = render(args);

		expect(out).toContain("First");
		expect(out).toContain("task");
	});

	it("always renders the full assignment markdown, collapsed or expanded", () => {
		const assignmentLines = Array.from({ length: 6 }, (_, i) => `Step ${i + 1}: do the thing.`);
		const args: TaskParams = {
			agent: "task",
			id: "Worker",
			assignment: assignmentLines.join("\n"),
		};

		// The assignment is the brief handed to the subagent; it renders as
		// markdown in full regardless of the expanded toggle.
		const collapsed = render(args, false);
		expect(collapsed).toContain("Step 1");
		expect(collapsed).toContain("Step 6");

		const expanded = render(args, true);
		expect(expanded).toContain("Step 1");
		expect(expanded).toContain("Step 6");
	});

	it("surfaces the isolation flag in the header bar", () => {
		const args: TaskParams = {
			agent: "task",
			isolated: true,
			id: "Only",
			description: "Single task",
			assignment: "...",
		};
		const out = render(args);
		const lines = out.split("\n");

		expect(out).toContain("Only");
		// Isolation is surfaced as header meta in the frame's top bar (first line),
		// not as a trailing child row under the task list.
		expect(lines[0]).toContain("isolated");
	});

	// Once the tool produces a result, the container suppresses the call entirely
	// via `mergeCallAndResult` and `renderResult` draws the agent. As a safety
	// net, `renderCall` also drops its preview when a result snapshot is present,
	// so the two never stack.
	it("drops the preview once a result snapshot exists", () => {
		const args: TaskParams = {
			agent: "reviewer",
			id: "ReviewAuth",
			description: "Audit the auth module",
			assignment: "Review the auth module.",
		};
		const component = taskToolRenderer.renderCall(
			args,
			{ expanded: false, isPartial: true, renderContext: { hasResult: true } },
			theme,
		);
		const out = Bun.stripANSI(component.render(160).join("\n"));

		expect(out).not.toContain("Audit the auth module");
		expect(out).not.toContain("Review the auth module.");
	});
});

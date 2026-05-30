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

	// The preview must surface each agent's id + ui description so the user can
	// see which agents are being dispatched, not a bare "N agents" count.
	it("lists each task's id and description instead of only a count", () => {
		const args: TaskParams = {
			agent: "reviewer",
			tasks: [
				{ id: "ReviewAuth", description: "Audit the auth module", assignment: "..." },
				{ id: "ReviewDb", description: "Audit the db layer", assignment: "..." },
			],
		};
		const out = render(args);

		expect(out).toContain("ReviewAuth");
		expect(out).toContain("Audit the auth module");
		expect(out).toContain("ReviewDb");
		expect(out).toContain("Audit the db layer");
		// Count is kept as a compact header, but the old flat "N agents" line is gone.
		expect(out).toContain("Tasks (2)");
		expect(out).not.toContain("2 agents");
	});

	it("renders a partially-streamed entry without a description and missing trailing entry", () => {
		const args = {
			agent: "task",
			// Trailing entry mimics streaming JSON: id arrived, description not yet,
			// plus a not-yet-materialized slot.
			tasks: [{ id: "First", description: "Do the first thing", assignment: "..." }, { id: "Second" }, undefined],
		} as unknown as TaskParams;

		const out = render(args);

		expect(out).toContain("First");
		expect(out).toContain("Do the first thing");
		expect(out).toContain("Second");
		// Missing-id slot falls back to a positional placeholder rather than crashing.
		expect(out).toContain("#3");
		expect(out).toContain("Tasks (3)");
	});

	it("caps the collapsed list and reports the overflow as agents", () => {
		const tasks = Array.from({ length: 15 }, (_, i) => ({
			id: `Agent${i + 1}`,
			description: `Task ${i + 1}`,
			assignment: "...",
		}));
		const args: TaskParams = { agent: "task", tasks };

		const collapsed = render(args, false);
		expect(collapsed).toContain("Agent1");
		expect(collapsed).toContain("Agent12");
		expect(collapsed).not.toContain("Agent13");
		expect(collapsed).toContain("3 more agents");

		const expanded = render(args, true);
		expect(expanded).toContain("Agent13");
		expect(expanded).toContain("Agent15");
		expect(expanded).not.toContain("more agents");
	});

	it("keeps the isolation flag as the final child after the task list", () => {
		const args: TaskParams = {
			agent: "task",
			isolated: true,
			tasks: [{ id: "Only", description: "Single task", assignment: "..." }],
		};
		const out = render(args);
		const lines = out.split("\n");

		expect(out).toContain("Only");
		expect(out).toContain("Isolated");
		// Isolation flag is rendered last, after every task entry.
		expect(lines.at(-1)).toContain("Isolated");
	});

	// Once the tool produces a result, `renderResult` draws each agent as a
	// progress/result line. The call preview must drop its own per-agent list
	// so the non-streaming path doesn't render every task twice.
	it("suppresses the per-task preview list once a result snapshot exists", () => {
		const args: TaskParams = {
			agent: "reviewer",
			tasks: [
				{ id: "ReviewAuth", description: "Audit the auth module", assignment: "..." },
				{ id: "ReviewDb", description: "Audit the db layer", assignment: "..." },
			],
		};
		const component = taskToolRenderer.renderCall(
			args,
			{ expanded: false, isPartial: true, renderContext: { hasResult: true } },
			theme,
		);
		const out = Bun.stripANSI(component.render(160).join("\n"));

		// Header stays as a section label, but the duplicated agent rows are gone.
		expect(out).toContain("Tasks (2)");
		expect(out).not.toContain("Audit the auth module");
		expect(out).not.toContain("Audit the db layer");
	});
});

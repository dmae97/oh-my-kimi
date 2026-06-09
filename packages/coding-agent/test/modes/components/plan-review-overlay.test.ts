import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import type { HookSelectorSlider } from "@oh-my-pi/pi-coding-agent/modes/components/hook-selector";
import { PlanReviewOverlay } from "@oh-my-pi/pi-coding-agent/modes/components/plan-review-overlay";
import { getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { setKeybindings } from "@oh-my-pi/pi-tui";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const ENTER = "\r";
const TAB = "\t";
const SHIFT_DOWN = "\x1b[1;2B";
const CANCEL = "\x07"; // ctrl+g, remapped to tui.select.cancel below

let darkTheme = await getThemeByName("dark");

function render(component: PlanReviewOverlay): string {
	return stripVTControlCharacters(component.render(80).join("\n"));
}

const APPROVAL_OPTIONS = [
	"Approve and execute",
	"Approve and compact context",
	"Approve and keep context",
	"Refine plan",
];

describe("PlanReviewOverlay", () => {
	beforeAll(async () => {
		darkTheme = await getThemeByName("dark");
		if (!darkTheme) throw new Error("Failed to load dark theme");
	});

	beforeEach(() => {
		setThemeInstance(darkTheme!);
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "ctrl+g" }));
	});

	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
		vi.restoreAllMocks();
	});

	it("renders the plan body, prompt, options and footer inside one outlined box", () => {
		const overlay = new PlanReviewOverlay(
			"# My Plan\n\nstep one then step two",
			{ promptTitle: "Plan mode - next step", options: APPROVAL_OPTIONS, helpText: "esc cancel" },
			{ onPick: vi.fn(), onCancel: vi.fn() },
		);
		const out = render(overlay);
		expect(out).toContain("Plan Review");
		expect(out).toContain("My Plan");
		expect(out).toContain("step one then step two");
		expect(out).toContain("Plan mode - next step");
		for (const option of APPROVAL_OPTIONS) expect(out).toContain(option);
		expect(out).toContain("esc cancel");
		// Outlined like the /copy overlay.
		expect(out).toContain("┌");
		expect(out).toContain("│");
		expect(out).toContain("└");
	});

	it("confirms the highlighted option on Enter", () => {
		const onPick = vi.fn();
		const overlay = new PlanReviewOverlay(
			"plan",
			{ promptTitle: "next", options: APPROVAL_OPTIONS },
			{ onPick, onCancel: vi.fn() },
		);
		overlay.handleInput(ENTER);
		expect(onPick).toHaveBeenCalledTimes(1);
		expect(onPick).toHaveBeenCalledWith("Approve and execute");
	});

	it("moves the option cursor with up/down and confirms the new target", () => {
		const onPick = vi.fn();
		const overlay = new PlanReviewOverlay(
			"plan",
			{ promptTitle: "next", options: APPROVAL_OPTIONS },
			{ onPick, onCancel: vi.fn() },
		);
		overlay.handleInput(DOWN);
		overlay.handleInput(ENTER);
		expect(onPick).toHaveBeenCalledWith("Approve and compact context");

		onPick.mockClear();
		overlay.handleInput(UP);
		overlay.handleInput(ENTER);
		expect(onPick).toHaveBeenCalledWith("Approve and execute");
	});

	it("skips disabled options and never confirms them", () => {
		const onPick = vi.fn();
		// Disable index 2 ("Approve and keep context").
		const overlay = new PlanReviewOverlay(
			"plan",
			{ promptTitle: "next", options: APPROVAL_OPTIONS, disabledIndices: [2] },
			{ onPick, onCancel: vi.fn() },
		);
		// 0 -> 1 -> (skip 2) -> 3.
		overlay.handleInput(DOWN);
		overlay.handleInput(DOWN);
		overlay.handleInput(ENTER);
		expect(onPick).toHaveBeenCalledTimes(1);
		expect(onPick).toHaveBeenCalledWith("Refine plan");
	});

	it("cancels on the cancel key", () => {
		const onCancel = vi.fn();
		const overlay = new PlanReviewOverlay(
			"plan",
			{ promptTitle: "next", options: APPROVAL_OPTIONS },
			{ onPick: vi.fn(), onCancel },
		);
		overlay.handleInput(CANCEL);
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("drives the model-tier slider with left/right without changing the option cursor", () => {
		const changes: number[] = [];
		const slider: HookSelectorSlider = {
			caption: "continue with",
			index: 0,
			segments: [{ label: "default" }, { label: "slow", detail: "opus" }],
			onChange: index => changes.push(index),
		};
		const onPick = vi.fn();
		const overlay = new PlanReviewOverlay(
			"plan",
			{ promptTitle: "next", options: APPROVAL_OPTIONS, slider },
			{ onPick, onCancel: vi.fn() },
		);
		overlay.handleInput(RIGHT);
		expect(changes).toEqual([1]);
		// Clamped at the right edge.
		overlay.handleInput(RIGHT);
		expect(changes).toEqual([1]);
		overlay.handleInput(LEFT);
		expect(changes).toEqual([1, 0]);

		// The slider must not have moved the option cursor.
		overlay.handleInput(ENTER);
		expect(onPick).toHaveBeenCalledWith("Approve and execute");
	});

	it("invokes the external-editor callback on its key", () => {
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "ctrl+g", "app.editor.external": "ctrl+e" }));
		const onExternalEditor = vi.fn();
		const overlay = new PlanReviewOverlay(
			"plan",
			{ promptTitle: "next", options: APPROVAL_OPTIONS },
			{ onPick: vi.fn(), onCancel: vi.fn(), onExternalEditor },
		);
		overlay.handleInput("\x05"); // ctrl+e
		expect(onExternalEditor).toHaveBeenCalledTimes(1);
	});

	it("scrolls a long plan to bottom and back to top", () => {
		const longPlan = Array.from({ length: 200 }, (_, i) => `para ${i}`).join("\n\n");
		const overlay = new PlanReviewOverlay(
			longPlan,
			{ promptTitle: "next", options: APPROVAL_OPTIONS },
			{ onPick: vi.fn(), onCancel: vi.fn() },
		);
		const top = render(overlay);
		expect(top).toContain("para 0");
		expect(top).not.toContain("para 199");

		overlay.handleInput("G");
		const bottom = render(overlay);
		expect(bottom).toContain("para 199");
		expect(bottom).not.toContain("para 0");

		overlay.handleInput("g");
		const backToTop = render(overlay);
		expect(backToTop).toContain("para 0");
		expect(backToTop).not.toContain("para 199");
	});

	it("swaps the displayed plan and resets scroll on setPlanContent", () => {
		const longPlan = Array.from({ length: 200 }, (_, i) => `para ${i}`).join("\n\n");
		const overlay = new PlanReviewOverlay(
			longPlan,
			{ promptTitle: "next", options: APPROVAL_OPTIONS },
			{ onPick: vi.fn(), onCancel: vi.fn() },
		);
		overlay.handleInput("G"); // scroll away from the top
		overlay.setPlanContent("# Fresh plan\n\nbrand new body");
		const out = render(overlay);
		expect(out).toContain("Fresh plan");
		expect(out).toContain("brand new body");
		expect(out).not.toContain("para 199");
	});

	// Plan with ≥2 headings + nesting, wide enough for the sidebar at width 80.
	const SECTION_PLAN =
		"# Overview\n\nintro body\n\n## Goal\n\ngoal body\n\n## Steps\n\nstep body\n\n# Risks\n\nrisk body\n";
	it("renders no per-line ellipsis in the plan body", () => {
		const overlay = new PlanReviewOverlay(
			"# Plan\n\nshort line one\n\nshort line two",
			{ promptTitle: "next", options: APPROVAL_OPTIONS },
			{ onPick: vi.fn(), onCancel: vi.fn() },
		);
		const body = render(overlay)
			.split("\n")
			.filter(line => line.includes("short line"));
		expect(body.length).toBeGreaterThan(0);
		for (const line of body) expect(line).not.toContain("…");
	});

	it("shows a header-less section sidebar and cycles focus regions with Tab", () => {
		const overlay = new PlanReviewOverlay(
			SECTION_PLAN,
			{ promptTitle: "next", options: APPROVAL_OPTIONS },
			{ onPick: vi.fn(), onCancel: vi.fn() },
		);
		const out = render(overlay);
		// Two-column split chrome (┬ joins the title rule over the divider) and the
		// bare section list — no "Contents" label.
		expect(out).toContain("┬");
		expect(out).not.toContain("Contents");
		expect(out).toContain("Overview");
		// Tab into the ToC region surfaces its focus-specific help.
		overlay.handleInput(TAB);
		const tocFocused = render(overlay);
		expect(tocFocused).toContain("a annotate");
		expect(tocFocused).toContain("d delete");
	});

	it("omits the single plan-title heading from the ToC", () => {
		// One shallow H1 title + two H2 sections: the title is redundant in the ToC.
		const overlay = new PlanReviewOverlay(
			"# Plan: build the thing\n\nintro\n\n## Design\n\nd\n\n## Rollout\n\nr\n",
			{ promptTitle: "next", options: APPROVAL_OPTIONS },
			{ onPick: vi.fn(), onCancel: vi.fn() },
		);
		const sidebar = render(overlay)
			.split("\n")
			.map(line => line.split("│")[1] ?? "")
			.join("\n");
		expect(sidebar).toContain("Design");
		expect(sidebar).toContain("Rollout");
		expect(sidebar).not.toContain("build the thing");
	});

	it("flows past the end of a region into the actions on Down", () => {
		const overlay = new PlanReviewOverlay(
			SECTION_PLAN,
			{ promptTitle: "next", options: APPROVAL_OPTIONS },
			{ onPick: vi.fn(), onCancel: vi.fn() },
		);
		render(overlay);
		overlay.handleInput(TAB); // -> toc, first section
		// Walk to the last ToC entry, then one more Down drops into the actions.
		for (let i = 0; i < 10; i++) overlay.handleInput(DOWN);
		const out = render(overlay);
		// Actions focus restores the option cursor highlight + actions help.
		expect(out).toContain("⏎ confirm");
		expect(out).not.toContain("a annotate");
	});

	it("scrolls the body exactly one line per keystroke in body focus", () => {
		// Tall enough to overflow any test viewport, so the body genuinely scrolls.
		const rows = Array.from({ length: 400 }, (_, i) => `L${String(i).padStart(3, "0")}`).join("\n");
		const overlay = new PlanReviewOverlay(
			`# Plan\n\n\`\`\`\n${rows}\n\`\`\`\n`,
			{ promptTitle: "next", options: APPROVAL_OPTIONS },
			{ onPick: vi.fn(), onCancel: vi.fn() },
		);
		const visibleRows = (): string[] =>
			render(overlay)
				.split("\n")
				.map(line => line.match(/L\d\d\d/)?.[0])
				.filter((m): m is string => m !== undefined);
		render(overlay); // first render loads the body lines into the ScrollView
		overlay.handleInput(TAB); // actions -> body (no sidebar with a single heading)
		// Scroll well past the heading/fence so the window is pure code rows.
		for (let i = 0; i < 12; i++) overlay.handleInput(DOWN);
		const before = visibleRows();
		overlay.handleInput(DOWN);
		const after = visibleRows();
		// One-line scroll: the window advances by exactly one row.
		expect(after[0]).toBe(before[1]);
	});

	it("jumps the body to a section when the ToC cursor moves", () => {
		const overlay = new PlanReviewOverlay(
			SECTION_PLAN,
			{ promptTitle: "next", options: APPROVAL_OPTIONS },
			{ onPick: vi.fn(), onCancel: vi.fn() },
		);
		render(overlay);
		overlay.handleInput(TAB); // -> toc (Overview)
		overlay.handleInput(DOWN); // -> Goal, scrubbing the body to it
		const body = render(overlay).split("\n").slice(1, 5).join(" ");
		expect(body).toContain("Goal");
	});

	it("deletes the selected section and restores it with undo", () => {
		const onPlanEdited = vi.fn();
		const overlay = new PlanReviewOverlay(
			SECTION_PLAN,
			{ promptTitle: "next", options: APPROVAL_OPTIONS },
			{ onPick: vi.fn(), onCancel: vi.fn(), onPlanEdited },
		);
		render(overlay);
		overlay.handleInput(TAB); // -> toc (Overview)
		overlay.handleInput(DOWN); // -> Goal
		overlay.handleInput("d");
		expect(onPlanEdited).toHaveBeenCalled();
		const edited = onPlanEdited.mock.calls.at(-1)?.[0] as string;
		expect(edited).not.toContain("## Goal");
		expect(edited).toContain("## Steps");
		expect(render(overlay)).not.toContain("goal body");

		overlay.handleInput("u");
		const restored = render(overlay);
		expect(restored).toContain("Goal");
		expect(restored).toContain("goal body");
	});

	it("annotates a section and emits feedback for the Refine loop", () => {
		const onFeedbackChange = vi.fn();
		const overlay = new PlanReviewOverlay(
			SECTION_PLAN,
			{ promptTitle: "next", options: APPROVAL_OPTIONS },
			{ onPick: vi.fn(), onCancel: vi.fn(), onFeedbackChange },
		);
		render(overlay);
		overlay.handleInput(TAB); // -> toc (Overview)
		overlay.handleInput("a"); // annotate Overview
		for (const ch of "needs detail") overlay.handleInput(ch);
		overlay.handleInput(ENTER); // submit
		const out = render(overlay);
		expect(out).toContain("needs detail"); // callout in the body
		expect(out).toContain("✎"); // marker in the sidebar
		expect(onFeedbackChange).toHaveBeenCalled();
		const feedback = onFeedbackChange.mock.calls.at(-1)?.[0] as string;
		expect(feedback).toContain("Overview");
		expect(feedback).toContain("needs detail");
	});

	// Click a rendered row. The fullscreen overlay paints from screen row 0, so a
	// 1-based SGR mouse row equals the rendered-line index + 1.
	const clickRow = (overlay: PlanReviewOverlay, needle: string, col = 4): boolean => {
		const lines = overlay.render(80);
		const row = lines.findIndex(line => stripVTControlCharacters(line).includes(needle));
		if (row < 0) return false;
		overlay.handleInput(`\x1b[<0;${col};${row + 1}M`);
		return true;
	};

	it("activates an approval option on click", () => {
		const onPick = vi.fn();
		const overlay = new PlanReviewOverlay(
			SECTION_PLAN,
			{ promptTitle: "next", options: APPROVAL_OPTIONS },
			{ onPick, onCancel: vi.fn() },
		);
		render(overlay);
		expect(clickRow(overlay, "Refine plan", 10)).toBe(true);
		expect(onPick).toHaveBeenCalledWith("Refine plan");
	});

	it("selects a ToC section on click and scrubs the body to it", () => {
		const overlay = new PlanReviewOverlay(
			SECTION_PLAN,
			{ promptTitle: "next", options: APPROVAL_OPTIONS },
			{ onPick: vi.fn(), onCancel: vi.fn() },
		);
		render(overlay);
		// Click the "Steps" entry in the sidebar column.
		expect(clickRow(overlay, "Steps", 4)).toBe(true);
		const out = render(overlay);
		expect(out).toContain("a annotate"); // ToC focus
		// The body scrubbed to the clicked section.
		expect(out.split("\n").slice(1, 5).join(" ")).toContain("Steps");
	});

	it("includes deleted sections in the refinement feedback", () => {
		const onFeedbackChange = vi.fn();
		const overlay = new PlanReviewOverlay(
			SECTION_PLAN,
			{ promptTitle: "next", options: APPROVAL_OPTIONS },
			{ onPick: vi.fn(), onCancel: vi.fn(), onPlanEdited: vi.fn(), onFeedbackChange },
		);
		render(overlay);
		overlay.handleInput(TAB); // -> toc (Overview)
		overlay.handleInput(DOWN); // -> Goal
		overlay.handleInput("d"); // delete Goal
		const feedback = onFeedbackChange.mock.calls.at(-1)?.[0] as string;
		expect(feedback).toContain("Remove these sections:");
		expect(feedback).toContain("Goal");
	});

	it("drives the slider with both arrows even when a sidebar is present", () => {
		const changes: number[] = [];
		const slider: HookSelectorSlider = {
			caption: "continue with",
			index: 0,
			segments: [{ label: "default" }, { label: "slow", detail: "opus" }],
			onChange: index => changes.push(index),
		};
		const overlay = new PlanReviewOverlay(
			SECTION_PLAN,
			{ promptTitle: "next", options: APPROVAL_OPTIONS, slider },
			{ onPick: vi.fn(), onCancel: vi.fn() },
		);
		render(overlay); // establish the sidebar
		// The sidebar sits beside the body, not the slider, so left must still step
		// the tier back instead of being stolen to focus the ToC.
		overlay.handleInput(RIGHT); // 0 -> 1
		overlay.handleInput(LEFT); // 1 -> 0
		expect(changes).toEqual([1, 0]);
		// Focus stayed on the actions region (left did not jump to the ToC).
		expect(render(overlay)).not.toContain("a annotate");
	});

	it("fast-scrolls the body with Shift+Arrow", () => {
		const rows = Array.from({ length: 400 }, (_, i) => `L${String(i).padStart(3, "0")}`).join("\n");
		const overlay = new PlanReviewOverlay(
			`# Plan\n\n\`\`\`\n${rows}\n\`\`\`\n`,
			{ promptTitle: "next", options: APPROVAL_OPTIONS },
			{ onPick: vi.fn(), onCancel: vi.fn() },
		);
		const firstRow = (): number =>
			Number(
				(
					render(overlay)
						.split("\n")
						.map(line => line.match(/L\d\d\d/)?.[0])
						.find((m): m is string => m !== undefined) ?? "L000"
				).slice(1),
			);
		render(overlay); // first render loads the body lines into the ScrollView
		overlay.handleInput(TAB); // -> body
		// Scroll into the pure-code region so the leading heading rows don't skew
		// the absolute row math, then compare a single step to a Shift step.
		for (let i = 0; i < 10; i++) overlay.handleInput(DOWN);
		const base = firstRow();
		overlay.handleInput(SHIFT_DOWN); // Shift+Down — fastScrollLines (5) at once
		expect(firstRow() - base).toBe(5);
	});

	// SGR button 35 = no-button motion (0x20 motion flag | 0x03 no-button): the
	// hover report a terminal sends while the pointer moves with no button held.
	const hoverRow = (overlay: PlanReviewOverlay, needle: string, col = 6): boolean => {
		const lines = overlay.render(80);
		const row = lines.findIndex(line => stripVTControlCharacters(line).includes(needle));
		if (row < 0) return false;
		overlay.handleInput(`\x1b[<35;${col};${row + 1}M`);
		return true;
	};

	const optionLineRaw = (overlay: PlanReviewOverlay, needle: string): string | undefined =>
		overlay.render(80).find(line => stripVTControlCharacters(line).includes(needle));

	it("paints a hover band on the option the pointer is over and clears it on leave", () => {
		const onPick = vi.fn();
		const overlay = new PlanReviewOverlay(
			"plan body text",
			{ promptTitle: "next", options: APPROVAL_OPTIONS },
			{ onPick, onCancel: vi.fn() },
		);
		const selectedBg = theme.getBgAnsi("selectedBg");
		render(overlay); // populate the click maps before hit-testing

		// Hover a non-selected option (selection rests on index 0).
		expect(optionLineRaw(overlay, "Approve and keep context")).not.toContain(selectedBg);
		expect(hoverRow(overlay, "Approve and keep context")).toBe(true);
		expect(optionLineRaw(overlay, "Approve and keep context")).toContain(selectedBg);

		// Hover is visual only: the keyboard cursor stays on index 0, so Enter still
		// confirms the first option rather than the hovered one.
		overlay.handleInput(ENTER);
		expect(onPick).toHaveBeenCalledWith("Approve and execute");

		// Pointer onto the top border (a non-option row) drops the highlight.
		overlay.handleInput("\x1b[<35;6;1M");
		expect(optionLineRaw(overlay, "Approve and keep context")).not.toContain(selectedBg);
	});

	it("never hovers a disabled option", () => {
		const overlay = new PlanReviewOverlay(
			"plan body text",
			{ promptTitle: "next", options: APPROVAL_OPTIONS, disabledIndices: [2] },
			{ onPick: vi.fn(), onCancel: vi.fn() },
		);
		const selectedBg = theme.getBgAnsi("selectedBg");
		render(overlay);
		expect(hoverRow(overlay, "Approve and keep context")).toBe(true);
		expect(optionLineRaw(overlay, "Approve and keep context")).not.toContain(selectedBg);
	});
});

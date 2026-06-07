import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import type { HookSelectorSlider } from "@oh-my-pi/pi-coding-agent/modes/components/hook-selector";
import { PlanReviewOverlay } from "@oh-my-pi/pi-coding-agent/modes/components/plan-review-overlay";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { setKeybindings } from "@oh-my-pi/pi-tui";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const ENTER = "\r";
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
});

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import type { ExtensionAskDialogQuestion } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AskDialogComponent } from "@oh-my-pi/pi-coding-agent/modes/components/ask-dialog";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { setKeybindings } from "@oh-my-pi/pi-tui";

const DOWN = "\x1b[B";
const ENTER = "\n";
const CANCEL = "\x07";
const SPACE = " ";
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";

let darkTheme = await getThemeByName("dark");

function render(component: AskDialogComponent): string {
	return stripVTControlCharacters(component.render(80).join("\n"));
}

describe("AskDialogComponent", () => {
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
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("single-question, single-select: Enter on option submits immediately", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const onChat = vi.fn();
		const onPrompt = vi.fn();

		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }, { label: "Option B" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel,
			onChat,
			onPrompt,
		});

		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0]).toEqual({
			kind: "submit",
			results: [
				{
					id: "q1",
					question: "Choose one?",
					options: ["Option A", "Option B"],
					multi: false,
					selectedOptions: ["Option A"],
					customInput: undefined,
					note: undefined,
					timedOut: undefined,
				},
			],
		});
	});

	it("single-question, single-select: DOWN then Enter selects second option and submits", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const onChat = vi.fn();
		const onPrompt = vi.fn();

		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }, { label: "Option B" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel,
			onChat,
			onPrompt,
		});

		component.handleInput(DOWN);
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Option B"]);
	});

	it("multi-question, single-select: Enter on option advances tab, does not submit", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const onChat = vi.fn();
		const onPrompt = vi.fn();

		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Q1?",
				options: [{ label: "A1" }, { label: "B1" }],
			},
			{
				id: "q2",
				question: "Q2?",
				options: [{ label: "A2" }, { label: "B2" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel,
			onChat,
			onPrompt,
		});

		// Press Enter on A1 - should advance tab to Q2 (tab 1), not submit
		component.handleInput(ENTER);
		expect(onSubmit).not.toHaveBeenCalled();

		// On Q2: Down to B2 and Enter - should advance tab to Submit (tab 2), not submit
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		expect(onSubmit).not.toHaveBeenCalled();

		// On Submit tab: Enter on Submit row - should submit
		component.handleInput(ENTER);
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results).toEqual([
			{
				id: "q1",
				question: "Q1?",
				options: ["A1", "B1"],
				multi: false,
				selectedOptions: ["A1"],
				customInput: undefined,
				note: undefined,
				timedOut: undefined,
			},
			{
				id: "q2",
				question: "Q2?",
				options: ["A2", "B2"],
				multi: false,
				selectedOptions: ["B2"],
				customInput: undefined,
				note: undefined,
				timedOut: undefined,
			},
		]);
	});

	it("multi-select: Space and Enter toggle without advancing, Next row advances", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const onChat = vi.fn();
		const onPrompt = vi.fn();

		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose multiple?",
				options: [{ label: "Option A" }, { label: "Option B" }],
				multi: true,
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel,
			onChat,
			onPrompt,
		});

		// Space on Option A - toggles A
		component.handleInput(SPACE);

		// Down to Option B, Enter - toggles B
		component.handleInput(DOWN);
		component.handleInput(ENTER);

		expect(onSubmit).not.toHaveBeenCalled();

		// Down to Other
		component.handleInput(DOWN);
		// Down to Next
		component.handleInput(DOWN);
		// Enter on Next to submit
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Option A", "Option B"]);
	});

	it("tab-state persistence: answer question 0, Tab forward, Tab back, answer still present", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const onChat = vi.fn();
		const onPrompt = vi.fn();

		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Q1?",
				options: [{ label: "A1" }, { label: "B1" }],
			},
			{
				id: "q2",
				question: "Q2?",
				options: [{ label: "A2" }, { label: "B2" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel,
			onChat,
			onPrompt,
		});

		// Enter on A1 selects it and auto-advances to Q2 (tab 1)
		component.handleInput(ENTER);

		// Shift+Tab back to Q1 (tab 0)
		component.handleInput(SHIFT_TAB);

		// Enter again on Q1's currently selected option (which will re-select/keep it and auto-advance to Q2)
		component.handleInput(ENTER);

		// On Q2: select B2 and advance to Submit
		component.handleInput(DOWN);
		component.handleInput(ENTER);

		// On Submit: Enter to submit
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["A1"]);
		expect(onSubmit.mock.calls[0][0].results[1].selectedOptions).toEqual(["B2"]);
	});

	it("Tab and Shift+Tab switches tabs", () => {
		const onSubmit = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Q1?",
				options: [{ label: "A1" }, { label: "B1" }],
			},
			{
				id: "q2",
				question: "Q2?",
				options: [{ label: "A2" }, { label: "B2" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onChat: vi.fn(),
			onPrompt: vi.fn(),
		});

		// Tab from Q1 -> Q2
		component.handleInput(TAB);
		// Tab from Q2 -> Submit
		component.handleInput(TAB);
		// Shift+Tab from Submit -> Q2
		component.handleInput(SHIFT_TAB);

		// Down to B2, Enter -> Submit
		component.handleInput(DOWN);
		component.handleInput(ENTER);

		// Enter on Submit
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual([]);
		expect(onSubmit.mock.calls[0][0].results[1].selectedOptions).toEqual(["B2"]);
	});

	it("Submit tab shows unanswered warning but Enter still submits", () => {
		const onSubmit = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Q1?",
				options: [{ label: "A1" }, { label: "B1" }],
			},
			{
				id: "q2",
				question: "Q2?",
				options: [{ label: "A2" }, { label: "B2" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onChat: vi.fn(),
			onPrompt: vi.fn(),
		});

		// Tab to Submit
		component.handleInput(TAB);
		component.handleInput(TAB);

		const output = render(component);
		expect(output.toLowerCase()).toContain("unanswered");

		// Enter on Submit
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual([]);
		expect(onSubmit.mock.calls[0][0].results[1].selectedOptions).toEqual([]);
	});

	it("Esc/cancel fires onCancel", () => {
		const onCancel = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit: vi.fn(),
			onCancel,
			onChat: vi.fn(),
			onPrompt: vi.fn(),
		});

		component.handleInput(CANCEL);
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("selecting 'Chat about this' on a question tab fires onChat", () => {
		const onChat = vi.fn();
		const onSubmit = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Q1?",
				options: [{ label: "A1" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onChat,
			onPrompt: vi.fn(),
		});

		// Cursor positions:
		// 0: A1
		// 1: Other
		// 2: Chat about this
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		component.handleInput(ENTER);

		expect(onChat).toHaveBeenCalledTimes(1);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("selecting 'Chat about this' on Submit tab fires onChat", () => {
		const onChat = vi.fn();
		const onSubmit = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Q1?",
				options: [{ label: "A1" }],
			},
			{
				id: "q2",
				question: "Q2?",
				options: [{ label: "A2" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onChat,
			onPrompt: vi.fn(),
		});

		// Tab to Submit
		component.handleInput(TAB);
		component.handleInput(TAB);

		// Cursor positions on Submit tab:
		// 0: Submit
		// 1: Chat about this
		component.handleInput(DOWN);
		component.handleInput(ENTER);

		expect(onChat).toHaveBeenCalledTimes(1);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("n on an option calls onPrompt and stores note with marker", async () => {
		const onPrompt = vi.fn().mockReturnValue(Promise.resolve("My Custom Note"));
		const onSubmit = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onChat: vi.fn(),
			onPrompt,
		});

		// Highlight is on Option A. Press 'n'.
		component.handleInput("n");

		// Await microtasks so the async #promptForNote runs
		await Promise.resolve();
		await Promise.resolve();

		expect(onPrompt).toHaveBeenCalledTimes(1);
		expect(onPrompt.mock.calls[0][0]).toBe("Note for Option A: Choose one?");

		// Verify note is saved by submitting
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].note).toBe("My Custom Note");
	});

	it("omits a note when a single-select answer changes to a different option", async () => {
		const onPrompt = vi.fn().mockReturnValue(Promise.resolve("Note for A"));
		const onSubmit = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }, { label: "Option B" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onChat: vi.fn(),
			onPrompt,
		});

		component.handleInput("n");
		await Promise.resolve();
		await Promise.resolve();

		component.handleInput(DOWN);
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Option B"]);
		expect(onSubmit.mock.calls[0][0].results[0].note).toBeUndefined();
	});

	it("clears the note when a noted multi-select option is toggled off", async () => {
		const onPrompt = vi.fn().mockReturnValue(Promise.resolve("Note for A"));
		const onSubmit = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose multiple?",
				options: [{ label: "Option A" }, { label: "Option B" }],
				multi: true,
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onChat: vi.fn(),
			onPrompt,
		});

		component.handleInput("n");
		await Promise.resolve();
		await Promise.resolve();

		component.handleInput(SPACE);
		component.handleInput(SPACE);
		expect(render(component)).not.toContain("✎ note");
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual([]);
		expect(onSubmit.mock.calls[0][0].results[0].note).toBeUndefined();
	});

	it("shows selected multi-select options together with custom input on Submit", async () => {
		const onPrompt = vi.fn().mockReturnValue(Promise.resolve("custom detail"));
		const onSubmit = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose multiple?",
				options: [{ label: "Option A" }, { label: "Option B" }],
				multi: true,
			},
			{
				id: "q2",
				question: "Second question?",
				options: [{ label: "Option C" }],
			},
		];

		const component = new AskDialogComponent(questions, {
			onSubmit,
			onCancel: vi.fn(),
			onChat: vi.fn(),
			onPrompt,
		});

		component.handleInput(SPACE);
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		await Promise.resolve();
		await Promise.resolve();

		component.handleInput(TAB);
		const review = render(component);
		expect(review).toContain("Option A");
		expect(review).toContain("custom detail");

		component.handleInput(ENTER);

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0].results[0].selectedOptions).toEqual(["Option A"]);
		expect(onSubmit.mock.calls[0][0].results[0].customInput).toBe("custom detail");
	});

	it("defers a timeout that fires during a pending prompt and honors the resolved custom input", async () => {
		vi.useFakeTimers();
		const deferred = Promise.withResolvers<string | undefined>();
		const onPrompt = vi.fn().mockReturnValue(deferred.promise);
		const onSubmit = vi.fn();
		const onTimeout = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "First?",
				options: [{ label: "Option A" }, { label: "Option B" }],
			},
			{
				id: "q2",
				question: "Second?",
				options: [{ label: "Option C" }, { label: "Option D" }],
				recommended: 1,
			},
		];

		const component = new AskDialogComponent(
			questions,
			{ onSubmit, onCancel: vi.fn(), onChat: vi.fn(), onPrompt },
			{ timeout: 1000, onTimeout },
		);

		// Open the "Other (type your own)" prompt on question 1.
		component.handleInput(DOWN);
		component.handleInput(DOWN);
		component.handleInput(ENTER);
		expect(onPrompt).toHaveBeenCalledTimes(1);

		// Timer expires while the prompt is pending: the timeout must be deferred,
		// not submit the recommended fallback out from under the user.
		vi.advanceTimersByTime(1000);
		expect(onTimeout).not.toHaveBeenCalled();
		expect(onSubmit).not.toHaveBeenCalled();

		// Resolving the prompt honors the typed answer, then runs the deferred
		// timeout handling exactly once.
		deferred.resolve("my answer");
		await Promise.resolve();
		await Promise.resolve();

		expect(onTimeout).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledTimes(1);
		const results = onSubmit.mock.calls[0][0].results;
		expect(results[0].customInput).toBe("my answer");
		expect(results[0].selectedOptions).toEqual([]);
		expect(results[0].timedOut).toBeUndefined();
		expect(results[1].selectedOptions).toEqual(["Option D"]);
		expect(results[1].timedOut).toBe(true);
	});

	it("keeps a single-question custom prompt answer when timeout expires while the prompt is pending", async () => {
		vi.useFakeTimers();
		const deferred = Promise.withResolvers<string | undefined>();
		const onPrompt = vi.fn().mockReturnValue(deferred.promise);
		const onSubmit = vi.fn();
		const onTimeout = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Only question?",
				options: [{ label: "Fallback" }],
			},
		];

		const component = new AskDialogComponent(
			questions,
			{ onSubmit, onCancel: vi.fn(), onChat: vi.fn(), onPrompt },
			{ timeout: 1000, onTimeout },
		);

		component.handleInput(DOWN);
		component.handleInput(ENTER);
		expect(onPrompt).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(1000);
		expect(onTimeout).not.toHaveBeenCalled();
		expect(onSubmit).not.toHaveBeenCalled();

		deferred.resolve("my answer");
		await Promise.resolve();
		await Promise.resolve();

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onTimeout).not.toHaveBeenCalled();
		const result = onSubmit.mock.calls[0][0].results[0];
		expect(result.customInput).toBe("my answer");
		expect(result.selectedOptions).toEqual([]);
		expect(result.timedOut).toBeUndefined();
	});

	it("uses a noted non-recommended option as the timeout fallback", async () => {
		vi.useFakeTimers();
		const onPrompt = vi.fn().mockReturnValue(Promise.resolve("why B"));
		const onSubmit = vi.fn();
		const onTimeout = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }, { label: "Option B" }],
				recommended: 0,
			},
		];

		const component = new AskDialogComponent(
			questions,
			{ onSubmit, onCancel: vi.fn(), onChat: vi.fn(), onPrompt },
			{ timeout: 1000, onTimeout },
		);

		component.handleInput(DOWN);
		component.handleInput("n");
		await Promise.resolve();
		await Promise.resolve();

		vi.advanceTimersByTime(1000);

		expect(onTimeout).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledTimes(1);
		const result = onSubmit.mock.calls[0][0].results[0];
		expect(result.selectedOptions).toEqual(["Option B"]);
		expect(result.note).toBe("why B");
		expect(result.timedOut).toBe(true);
	});

	it("preserves a pending note on a non-recommended option when deferred timeout submits", async () => {
		vi.useFakeTimers();
		const deferred = Promise.withResolvers<string | undefined>();
		const onPrompt = vi.fn().mockReturnValue(deferred.promise);
		const onSubmit = vi.fn();
		const onTimeout = vi.fn();
		const questions: ExtensionAskDialogQuestion[] = [
			{
				id: "q1",
				question: "Choose one?",
				options: [{ label: "Option A" }, { label: "Option B" }],
				recommended: 0,
			},
		];

		const component = new AskDialogComponent(
			questions,
			{ onSubmit, onCancel: vi.fn(), onChat: vi.fn(), onPrompt },
			{ timeout: 1000, onTimeout },
		);

		component.handleInput(DOWN);
		component.handleInput("n");
		expect(onPrompt).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(1000);
		expect(onTimeout).not.toHaveBeenCalled();
		expect(onSubmit).not.toHaveBeenCalled();

		deferred.resolve("why B");
		await Promise.resolve();
		await Promise.resolve();

		expect(onTimeout).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledTimes(1);
		const result = onSubmit.mock.calls[0][0].results[0];
		expect(result.selectedOptions).toEqual(["Option B"]);
		expect(result.note).toBe("why B");
		expect(result.timedOut).toBe(true);
	});
});

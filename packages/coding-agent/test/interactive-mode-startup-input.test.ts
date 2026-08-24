import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => void };
	editor: {
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
	};
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		resourceLoader: {
			getSkills: () => { skills: Array<{ name: string }> };
		};
		prompt: (text: string, options?: unknown) => Promise<void>;
	};
	flushPendingBashComponents: () => void;
	handleBashCommand: (command: string, excludeFromContext?: boolean) => Promise<void>;
	showWarning: (message: string) => void;
	updateEditorBorderColor: () => void;
	isBashMode: boolean;
	onInputCallback?: (payload: { text: string }) => void;
	pendingPromptPayloads: Array<{ text: string }>;
};

type InputContext = {
	onInputCallback?: (payload: { text: string }) => void;
	pendingPromptPayloads: Array<{ text: string }>;
};

type InteractiveModePrivate = {
	setupEditorSubmitHandler(this: SubmitContext): void;
	getUserInput(this: InputContext): Promise<{ text: string }>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createSubmitContext(skillNames: string[] = []): SubmitContext {
	return {
		defaultEditor: {},
		editor: {
			addToHistory: vi.fn(),
			setText: vi.fn(),
		},
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			resourceLoader: {
				getSkills: () => ({ skills: skillNames.map((name) => ({ name })) }),
			},
			prompt: vi.fn(async () => {}),
		},
		flushPendingBashComponents: vi.fn(),
		handleBashCommand: vi.fn(async () => {}),
		showWarning: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		isBashMode: false,
		pendingPromptPayloads: [],
	};
}

describe("InteractiveMode startup input", () => {
	it("queues a normal prompt submitted before the input callback is installed", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" early prompt ");

		expect(context.pendingPromptPayloads).toEqual([{ text: "early prompt" }]);
		expect(context.editor.addToHistory).toHaveBeenCalledWith("early prompt");
	});

	it("routes known bang skill submissions through normal prompt queue", async () => {
		const context = createSubmitContext(["browser-feedback"]);
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("!browser-feedback inspect");

		expect(context.pendingPromptPayloads).toEqual([{ text: "!browser-feedback inspect" }]);
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
	});

	it("runs unknown bang shorthand as context bash", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("!git status");

		expect(context.handleBashCommand).toHaveBeenCalledWith("git status", false);
		expect(context.pendingPromptPayloads).toEqual([]);
	});

	it("runs double bang as no-context bash", async () => {
		const context = createSubmitContext(["git"]);
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("!! git status");

		expect(context.handleBashCommand).toHaveBeenCalledWith("git status", true);
		expect(context.pendingPromptPayloads).toEqual([]);
	});

	it("does not run explicit unknown bang skills as bash", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("!skill:missing inspect");

		expect(context.showWarning).toHaveBeenCalledWith("Unknown skill: missing");
		expect(context.editor.setText).toHaveBeenCalledWith("!skill:missing inspect");
		expect(context.handleBashCommand).not.toHaveBeenCalled();
		expect(context.pendingPromptPayloads).toEqual([]);
	});

	it("returns queued startup input before installing a new input callback", async () => {
		const context: InputContext = {
			pendingPromptPayloads: [{ text: "queued prompt" }],
		};

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toEqual({ text: "queued prompt" });
		expect(context.onInputCallback).toBeUndefined();
		expect(context.pendingPromptPayloads).toEqual([]);
	});
});

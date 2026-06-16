import { describe, expect, it } from "bun:test";
import { type Component, type Focusable, type OverlayFocusOwner, TUI } from "@oh-my-pi/pi-tui";
import type { Terminal, TerminalAppearance } from "@oh-my-pi/pi-tui/terminal";

class MinimalTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	kittyEnableSequence: string | null = null;
	appearance: TerminalAppearance | undefined;
	#onInput: ((data: string) => void) | undefined;
	#onResize: (() => void) | undefined;
	output = "";
	cursorHidden = false;
	cursorTransitions = 0;

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.#onInput = onInput;
		this.#onResize = onResize;
	}

	stop(): void {
		this.#onInput = undefined;
		this.#onResize = undefined;
	}

	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

	write(data: string): void {
		this.output += data;
		if (data.length === 0) this.output += "";
	}

	moveBy(_lines: number): void {}

	hideCursor(): void {
		this.cursorHidden = true;
		this.cursorTransitions += 1;
	}

	showCursor(): void {
		this.cursorHidden = false;
		this.cursorTransitions += 1;
	}

	clearLine(): void {}

	clearFromCursor(): void {}

	clearScreen(): void {}

	setTitle(_title: string): void {}

	setProgress(_active: boolean): void {}

	onAppearanceChange(_callback: (appearance: TerminalAppearance) => void): void {}

	sendInput(data: string): void {
		const onInput = this.#onInput;
		if (onInput) onInput(data);
	}

	emitResize(): void {
		const onResize = this.#onResize;
		if (onResize) onResize();
	}
}

class FocusRecorder implements Component, Focusable {
	focused = false;
	inputs: string[] = [];
	lastInput = "";

	constructor(readonly label: string) {}

	handleInput(data: string): void {
		this.inputs.push(data);
		this.lastInput = data;
	}

	render(_width: number): string[] {
		const suffix = this.focused ? "-focused" : "";
		return [`${this.label}${suffix}`];
	}
}

class OwningOverlay extends FocusRecorder implements OverlayFocusOwner {
	focusTarget: Component | undefined;

	ownsOverlayFocusTarget(component: Component): boolean {
		if (component !== this.focusTarget) return false;
		return true;
	}
}

describe("TUI overlay focus", () => {
	it("keeps keyboard focus on the visible overlay when a hidden surface requests focus", () => {
		const terminal = new MinimalTerminal();
		const tui = new TUI(terminal);
		const editor = new FocusRecorder("editor");
		const settingsOverlay = new FocusRecorder("settings");
		const approvalPrompt = new FocusRecorder("approval");

		tui.addChild(editor);
		tui.setFocus(editor);

		try {
			tui.start();
			tui.showOverlay(settingsOverlay, { fullscreen: true });

			tui.setFocus(approvalPrompt);
			terminal.sendInput("x");

			expect(tui.getFocused()).toBe(settingsOverlay);
			expect(settingsOverlay.inputs).toEqual(["x"]);
			expect(approvalPrompt.inputs).toEqual([]);
		} finally {
			tui.stop();
		}
	});

	it("allows a visible overlay to delegate focus to an owned prompt", () => {
		const terminal = new MinimalTerminal();
		const tui = new TUI(terminal);
		const editor = new FocusRecorder("editor");
		const wizardOverlay = new OwningOverlay("wizard");
		const authorizationCodeInput = new FocusRecorder("code");
		const approvalPrompt = new FocusRecorder("approval");

		tui.addChild(editor);
		tui.setFocus(editor);

		try {
			tui.start();
			tui.showOverlay(wizardOverlay, { fullscreen: true });

			wizardOverlay.focusTarget = authorizationCodeInput;
			tui.setFocus(authorizationCodeInput);
			terminal.sendInput("code");

			expect(tui.getFocused()).toBe(authorizationCodeInput);
			expect(authorizationCodeInput.inputs).toEqual(["code"]);
			expect(wizardOverlay.inputs).toEqual([]);

			tui.setFocus(approvalPrompt);
			terminal.sendInput("still-code");

			expect(tui.getFocused()).toBe(authorizationCodeInput);
			expect(authorizationCodeInput.inputs).toEqual(["code", "still-code"]);
			expect(approvalPrompt.inputs).toEqual([]);
		} finally {
			tui.stop();
		}
	});
});

import { describe, expect, it } from "bun:test";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	findLeadingSlashCommandStart,
} from "@oh-my-pi/pi-tui/autocomplete";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { defaultEditorTheme } from "./test-themes";

class HashActionProvider implements AutocompleteProvider {
	async getSuggestions(
		lines: string[],
		_cursorLine: number,
		cursorCol: number,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		const prefix = (lines[0] || "").slice(0, cursorCol);
		if (prefix !== "#") {
			return null;
		}

		return {
			prefix,
			items: [{ value: "action", label: "Do action" }],
		};
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		_item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number; onApplied?: () => void } {
		const line = lines[cursorLine] || "";
		return {
			lines: [line.slice(0, cursorCol - prefix.length) + line.slice(cursorCol)],
			cursorLine,
			cursorCol: cursorCol - prefix.length,
			onApplied: () => {
				this.calls += 1;
			},
		};
	}

	calls = 0;
}

describe("Editor hash autocomplete actions", () => {
	it("auto-triggers # suggestions and runs autocomplete callbacks on selection", async () => {
		const provider = new HashActionProvider();
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(provider);

		editor.handleInput("#");
		await Bun.sleep(0);
		editor.handleInput("\r");

		expect(editor.getText()).toBe("");
		expect(provider.calls).toBe(1);
	});
});

describe("Editor slash autocomplete acceptance", () => {
	it("replaces characters typed after the rendered prefix before accepting with Tab", async () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider([{ name: "skills:fix-bug", description: "Fix a bug" }], "/tmp"),
		);

		editor.handleInput("/");
		await Bun.sleep(0);
		expect(editor.isShowingAutocomplete()).toBe(true);

		editor.handleInput("s");
		editor.handleInput("k");
		editor.handleInput("i");
		editor.handleInput("\t");

		expect(editor.getText()).toBe("/skills:fix-bug ");
	});
});
class SyncSlashProvider implements AutocompleteProvider {
	async getSuggestions(
		_lines: string[],
		_cursorLine: number,
		_cursorCol: number,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		return null;
	}

	trySyncSlashCompletion(textBeforeCursor: string): { items: AutocompleteItem[]; prefix: string } | null {
		this.callCount += 1;
		const slashStart = findLeadingSlashCommandStart(textBeforeCursor);
		if (slashStart === null) return null;
		const commandText = textBeforeCursor.slice(slashStart);
		if (commandText.length <= 1) return null;
		if (commandText.includes(" ")) return null;
		// Only match known slash commands: /mo or /model
		const name = commandText.slice(1);
		if (name === "mo" || name === "model") {
			return {
				prefix: textBeforeCursor,
				items: [{ value: "model", label: "/model" }],
			};
		}
		return null;
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		_item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number; onApplied?: () => void } {
		const line = lines[cursorLine] || "";
		const slashStart = findLeadingSlashCommandStart(prefix);
		// Anchor the replacement at the slash so leading whitespace survives,
		// matching CombinedAutocompleteProvider's behavior.
		const replaceStart = slashStart === null ? cursorCol - prefix.length : cursorCol - prefix.length + slashStart;
		const beforeSlash = line.slice(0, replaceStart);
		const afterCursor = line.slice(cursorCol);
		const nextLines = [...lines];
		nextLines[cursorLine] = `${beforeSlash}/${_item.value} ${afterCursor}`;
		return {
			lines: nextLines,
			cursorLine,
			cursorCol: beforeSlash.length + _item.value.length + 2,
		};
	}

	callCount = 0;
}

describe("Editor Enter handler sync slash completion", () => {
	it("opens mid-prompt skill autocomplete and replaces the draft on Tab", async () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider(
				[
					{ name: "skill:security-scan", description: "Security scan" },
					{ name: "model", description: "Switch model" },
				],
				"/tmp",
			),
		);

		editor.setText("explain this\n");
		editor.handleInput("/");
		await Bun.sleep(0);

		expect(editor.isShowingAutocomplete()).toBe(true);

		editor.handleInput("security");
		editor.handleInput("\t");

		expect(editor.getText()).toBe("/skill:security-scan");
	});

	it("completes slash command synchronously before async resolves and submits", () => {
		const provider = new SyncSlashProvider();
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(provider);
		let submitted = "";
		editor.onSubmit = text => {
			submitted = text;
		};

		editor.handleInput("/mo");
		editor.handleInput("\r");

		expect(submitted).toBe("/model");
	});

	it("completes slash command after leading blank lines", () => {
		const provider = new SyncSlashProvider();
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(provider);
		let submitted = "";
		editor.onSubmit = text => {
			submitted = text;
		};

		editor.setText("\n/mo");
		editor.handleInput("\r");

		expect(submitted).toBe("/model");
		expect(provider.callCount).toBe(1);
	});

	it("completes slash command after leading spaces", () => {
		const provider = new SyncSlashProvider();
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(provider);
		let submitted = "";
		editor.onSubmit = text => {
			submitted = text;
		};

		editor.handleInput("  /mo");
		editor.handleInput("\r");

		// `#submitValue` trims the joined lines, so the leading spaces survive
		// the apply but the submitted command itself is the trimmed `/model`.
		expect(submitted).toBe("/model");
		expect(provider.callCount).toBe(1);
	});

	it("does not complete slash command after prior prompt text", () => {
		const provider = new SyncSlashProvider();
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(provider);
		let submitted = "";
		editor.onSubmit = text => {
			submitted = text;
		};

		editor.setText("explain this\n/mo");
		editor.handleInput("\r");

		expect(submitted).toBe("explain this\n/mo");
		expect(provider.callCount).toBe(0);
	});

	it("submits raw text when slash command has no sync match", () => {
		const provider = new SyncSlashProvider();
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(provider);
		let submitted = "";
		editor.onSubmit = text => {
			submitted = text;
		};

		editor.handleInput("/xyz");
		editor.handleInput("\r");

		expect(submitted).toBe("/xyz");
	});

	it("does not interfere with non-slash text submission", () => {
		const provider = new SyncSlashProvider();
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(provider);
		let submitted = "";
		editor.onSubmit = text => {
			submitted = text;
		};

		editor.handleInput("hello");
		editor.handleInput("\r");

		expect(submitted).toBe("hello");
	});

	it("applies completion from autocomplete list when autocomplete is already showing, then submits", async () => {
		// Create a provider that returns results from getSuggestions too,
		// so after a yield the autocomplete state is set and the autocomplete
		// block in the Enter handler applies the completion before submitting.
		let suggestionsCallCount = 0;
		const provider = new SyncSlashProvider();
		provider.getSuggestions = async (lines, _cursorLine, cursorCol) => {
			suggestionsCallCount++;
			const line = lines[0] || "";
			const textBeforeCursor = line.slice(0, cursorCol);
			if (textBeforeCursor.startsWith("/")) {
				return { prefix: textBeforeCursor, items: [{ value: "model", label: "/model" }] };
			}
			return null;
		};

		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(provider);
		let submitted = "";
		editor.onSubmit = text => {
			submitted = text;
		};

		editor.handleInput("/mo");
		await Bun.sleep(0); // Let async autocomplete resolve and set state
		editor.handleInput("\r");

		// When autocomplete shows a slash command, Enter applies the completion
		// (turning /mo into /model via the autocomplete block at line ~1005)
		// then cancels autocomplete and submits the completed text.
		expect(submitted).toBe("/model");
		expect(suggestionsCallCount).toBeGreaterThan(0);
	});

	it("applies the popup slash completion on Enter when slash is preceded by spaces", async () => {
		const provider = new CombinedAutocompleteProvider([{ name: "model", description: "Switch AI model" }], "/tmp");
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(provider);
		let submitted = "";
		editor.onSubmit = text => {
			submitted = text;
		};

		editor.handleInput("  /mo");
		await Bun.sleep(0);
		expect(editor.isShowingAutocomplete()).toBe(true);

		editor.handleInput("\r");

		expect(submitted).toBe("/model");
	});
});

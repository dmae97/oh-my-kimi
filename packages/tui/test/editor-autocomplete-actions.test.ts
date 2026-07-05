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
	const skillCommands = [
		{ name: "skill:security-scan", description: "Security scan" },
		{ name: "model", description: "Switch model" },
	];

	function createSkillEditor(): Editor {
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(new CombinedAutocompleteProvider(skillCommands, "/tmp"));
		return editor;
	}

	async function openMidPromptSkillAutocomplete(editor: Editor, prose: string): Promise<void> {
		editor.handleInput(prose);
		editor.handleInput("/");
		await Promise.resolve();

		expect(editor.getText()).toBe(`${prose}/`);
		expect(editor.isShowingAutocomplete()).toBe(true);
	}

	it("accepts a bare mid-prompt skill slash with Tab without replacing prose", async () => {
		const editor = createSkillEditor();

		await openMidPromptSkillAutocomplete(editor, "run a ");
		editor.handleInput("\t");

		expect(editor.getText()).toBe("run a /skill:security-scan ");
		expect(editor.isShowingAutocomplete()).toBe(false);
	});

	it("accepts a bare mid-prompt skill slash with Enter and submits the completed prompt", async () => {
		const editor = createSkillEditor();
		let submitted = "";
		editor.onSubmit = text => {
			submitted = text;
		};

		await openMidPromptSkillAutocomplete(editor, "run a ");
		editor.handleInput("\r");

		expect(submitted).toBe("run a /skill:security-scan");
		expect(editor.getText()).toBe("");
	});

	it("hides mid-prompt skill autocomplete immediately when Backspace removes the slash", async () => {
		const editor = createSkillEditor();

		await openMidPromptSkillAutocomplete(editor, "run a ");
		editor.handleInput("\x7f");

		expect(editor.getText()).toBe("run a ");
		expect(editor.isShowingAutocomplete()).toBe(false);
	});

	it("opens mid-prompt skill autocomplete and inserts the skill token without wiping the draft on Tab", async () => {
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
		await Promise.resolve();

		expect(editor.isShowingAutocomplete()).toBe(true);

		editor.handleInput("security");
		editor.handleInput("\t");

		// Regression for issue #3913: the prior prose ("explain this\n") MUST
		// survive a mid-prompt skill acceptance — only the partial `/sec` slash
		// token at the cursor is replaced with `/skill:security-scan `.
		expect(editor.getText()).toBe("explain this\n/skill:security-scan ");
	});

	it("preserves Tab file completion for an absolute path token after prose", async () => {
		let forceFileCalls = 0;
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider({
			async getSuggestions() {
				return null;
			},
			applyCompletion(lines, cursorLine, cursorCol) {
				return { lines, cursorLine, cursorCol };
			},
			async getForceFileSuggestions() {
				forceFileCalls += 1;
				return {
					prefix: "/tmp",
					items: [
						{ value: "/tmp/", label: "tmp/" },
						{ value: "/tmpfile", label: "tmpfile" },
					],
				};
			},
			shouldTriggerFileCompletion() {
				return true;
			},
		});

		editor.setText("see /tmp");
		editor.handleInput("\t");
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(forceFileCalls).toBe(1);
		expect(editor.isShowingAutocomplete()).toBe(true);
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

/**
 * Stub provider that recognises `/todo <sub>` slash commands and supports fuzzy prefixes
 * used to exercise stale autocomplete acceptance (issue #4295).
 */
class TodoSubcommandProvider implements AutocompleteProvider {
	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
		const line = lines[cursorLine] || "";
		const before = line.slice(0, cursorCol);
		if (before.startsWith("/todo ") && !before.includes("\n")) {
			const query = before.slice("/todo ".length);
			const all: AutocompleteItem[] = [
				{ value: "start", label: "start" },
				{ value: "done", label: "done" },
			];
			const items = query ? all.filter(i => i.value.startsWith(query)) : all;
			if (items.length === 0) return null;
			return { prefix: before, items };
		}
		return null;
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const line = lines[cursorLine] || "";
		// Anchor replacement at the end of the "/todo " literal, so only the query tail
		// gets rewritten with the selected subcommand value.
		const replaceStart = cursorCol - prefix.length + "/todo ".length;
		const before = line.slice(0, replaceStart);
		const after = line.slice(cursorCol);
		const nextLines = [...lines];
		nextLines[cursorLine] = before + item.value + after;
		return {
			lines: nextLines,
			cursorLine,
			cursorCol: before.length + item.value.length,
		};
	}
}

describe("Editor autocomplete invalidation on destructive edits (issue #4295)", () => {
	async function primeAutocomplete(editor: Editor) {
		editor.handleInput("/todo s");
		await Bun.sleep(0);
		expect(editor.isShowingAutocomplete()).toBe(true);
	}

	it("does not insert a stale suggestion when Tab follows Ctrl+W", async () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(new TodoSubcommandProvider());
		await primeAutocomplete(editor);

		editor.handleInput("\x17"); // Ctrl+W: delete word backward
		expect(editor.getText()).toBe("/todo ");

		editor.handleInput("\t");
		// Tab must NOT insert the stale "start" suggestion; buffer stays as-is.
		expect(editor.getText()).toBe("/todo ");
	});

	it("does not insert a stale suggestion when Tab follows Ctrl+U", async () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(new TodoSubcommandProvider());
		await primeAutocomplete(editor);

		editor.handleInput("\x15"); // Ctrl+U: delete to start of line
		expect(editor.getText()).toBe("");

		editor.handleInput("\t");
		expect(editor.getText()).toBe("");
	});

	it("does not insert a stale suggestion when Tab follows Alt+Backspace", async () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(new TodoSubcommandProvider());
		await primeAutocomplete(editor);

		editor.handleInput("\x1b\x7f"); // Alt+Backspace: delete word backward
		expect(editor.getText()).toBe("/todo ");

		editor.handleInput("\t");
		expect(editor.getText()).toBe("/todo ");
	});

	it("does not insert a stale suggestion when Tab follows Alt+D", async () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(new TodoSubcommandProvider());

		// Prime with `/todo start` and move cursor between "/todo " and "start"
		editor.setText("/todo start");
		editor.handleInput("\x01"); // Ctrl+A: cursor to line start
		for (const _ of "/todo ") editor.handleInput("\x06"); // Ctrl+F: forward one char
		editor.handleInput("s"); // trigger autocomplete for "/todo s"
		await Bun.sleep(0);
		expect(editor.isShowingAutocomplete()).toBe(true);

		editor.handleInput("\x1bd"); // Alt+D: delete word forward (consumes remaining "tart")
		// Only the forward "tart" is consumed; cursor sits after "/todo s" and the popup is now stale
		// because further reduction of the buffer (e.g. following Ctrl+W) should still invalidate.
		editor.handleInput("\x17"); // Ctrl+W: back through the "s" and "/todo "
		editor.handleInput("\t");
		expect(editor.getText()).not.toContain("start");
	});

	it("does not insert a stale suggestion after Ctrl+Y yank replaces the prefix", async () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(new TodoSubcommandProvider());

		// Seed the kill ring with "hello " via type-then-Ctrl+U
		editor.setText("hello ");
		editor.handleInput("\x15"); // Ctrl+U kills into ring
		expect(editor.getText()).toBe("");

		await primeAutocomplete(editor);

		// Yank inserts "hello " and should invalidate the prefix (`/todo s` no longer at cursor).
		editor.handleInput("\x19"); // Ctrl+Y
		expect(editor.getText()).toBe("/todo shello ");

		editor.handleInput("\t");
		// Tab must not paste the stale "start" over the yanked text.
		expect(editor.getText()).toBe("/todo shello ");
	});

	it("falls through to submission when Enter presses on a stale file-path popup", async () => {
		let forceFileCalls = 0;
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider({
			async getSuggestions() {
				return null;
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				const line = lines[cursorLine] || "";
				const nextLines = [...lines];
				nextLines[cursorLine] = line.slice(0, cursorCol - prefix.length) + item.value + line.slice(cursorCol);
				return { lines: nextLines, cursorLine, cursorCol: cursorCol - prefix.length + item.value.length };
			},
			async getForceFileSuggestions() {
				forceFileCalls += 1;
				return {
					prefix: "tmp",
					items: [
						{ value: "tmpA", label: "tmpA" },
						{ value: "tmpB", label: "tmpB" },
					],
				};
			},
			shouldTriggerFileCompletion() {
				return true;
			},
		});

		let submitted = "";
		editor.onSubmit = text => {
			submitted = text;
		};

		editor.setText("hello tmp");
		editor.handleInput("\t"); // Force file completion (opens popup with "tmp" prefix)
		for (let i = 0; i < 10; i += 1) {
			await Promise.resolve();
		}
		expect(editor.isShowingAutocomplete()).toBe(true);
		expect(forceFileCalls).toBe(1);

		// Destructive edit removes the "tmp" prefix; popup is now stale.
		editor.handleInput("\x17"); // Ctrl+W: removes "tmp"
		expect(editor.getText()).toBe("hello ");

		// Enter must fall through to submit, not paste the stale file suggestion.
		editor.handleInput("\r");
		expect(submitted).toBe("hello");
	});
});

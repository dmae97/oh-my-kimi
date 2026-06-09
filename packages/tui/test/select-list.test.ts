import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SelectList } from "@oh-my-pi/pi-tui/components/select-list";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@oh-my-pi/pi-tui/keybindings";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";

const testTheme = {
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
	noMatch: (text: string) => text,
	symbols: {
		cursor: "→",
		inputCursor: "|",
		hrChar: "─",
		quoteBorder: "│",
		boxRound: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
		boxSharp: {
			topLeft: "┌",
			topRight: "┐",
			bottomLeft: "└",
			bottomRight: "┘",
			horizontal: "─",
			vertical: "│",
			teeDown: "┬",
			teeUp: "┴",
			teeLeft: "┤",
			teeRight: "├",
			cross: "┼",
		},
		table: {
			topLeft: "┌",
			topRight: "┐",
			bottomLeft: "└",
			bottomRight: "┘",
			horizontal: "─",
			vertical: "│",
			teeDown: "┬",
			teeUp: "┴",
			teeLeft: "┤",
			teeRight: "├",
			cross: "┼",
		},
		spinnerFrames: ["|"],
	},
};

const visibleIndexOf = (line: string, text: string): number => {
	const index = line.indexOf(text);
	expect(index).not.toBe(-1);
	return visibleWidth(line.slice(0, index));
};

describe("SelectList", () => {
	beforeEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});

	afterEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});

	it("normalizes multiline descriptions to single line", () => {
		const items = [
			{
				value: "test",
				label: "test",
				description: "Line one\nLine two\nLine three",
			},
		];

		const list = new SelectList(items, 5, testTheme);
		const rendered = list.render(80);

		expect(rendered.length).toBeGreaterThanOrEqual(1);
		expect(rendered[0]).not.toContain("\n");
		expect(rendered[0]).toContain("Line one Line two Line three");
	});

	it("keeps descriptions aligned when the primary text is truncated", () => {
		const items = [
			{ value: "short", label: "short", description: "short description" },
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "long description",
			},
		];

		const list = new SelectList(items, 5, testTheme);
		const rendered = list.render(80);

		expect(visibleIndexOf(rendered[0], "short description")).toBe(visibleIndexOf(rendered[1], "long description"));
	});

	it("uses the configured minimum primary column width", () => {
		const items = [
			{ value: "a", label: "a", description: "first" },
			{ value: "bb", label: "bb", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 20,
		});
		const rendered = list.render(80);

		expect(rendered[0].indexOf("first")).toBe(14);
		expect(rendered[1].indexOf("second")).toBe(14);
	});

	it("uses the configured maximum primary column width", () => {
		const items = [
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "first",
			},
			{ value: "short", label: "short", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 20,
		});
		const rendered = list.render(80);

		expect(visibleIndexOf(rendered[0], "first")).toBe(22);
		expect(visibleIndexOf(rendered[1], "second")).toBe(22);
	});

	it("allows overriding primary truncation while preserving description alignment", () => {
		const items = [
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "first",
			},
			{ value: "short", label: "short", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 12,
			truncatePrimary: ({ text, maxWidth }) => {
				if (text.length <= maxWidth) {
					return text;
				}

				return `${text.slice(0, Math.max(0, maxWidth - 1))}…`;
			},
		});
		const rendered = list.render(80);

		expect(rendered[0]).toContain("…");
		expect(visibleIndexOf(rendered[0], "first")).toBe(visibleIndexOf(rendered[1], "second"));
	});

	it("confirms the selected item when Enter arrives as LF", () => {
		const items = [{ value: "run", label: "run" }];
		const list = new SelectList(items, 5, testTheme);
		let selectedValue: string | undefined;
		list.onSelect = item => {
			selectedValue = item.value;
		};

		list.handleInput("\n");

		expect(selectedValue).toBe("run");
	});

	it("fuzzy-filters overflowing lists from typed input", () => {
		const items = [
			{ value: "ollama", label: "Ollama" },
			{ value: "kagi", label: "Kagi" },
			{ value: "opencode-go", label: "OpenCode Go" },
			{ value: "tavily", label: "Tavily" },
		];
		const list = new SelectList(items, 3, testTheme);

		list.handleInput("o");
		list.handleInput("g");

		const rendered = list.render(80).join("\n");
		expect(rendered).toContain("OpenCode Go");
		expect(rendered).not.toContain("Ollama");
		expect(rendered).toContain("Search: og");
		expect(list.getSelectedItem()?.value).toBe("opencode-go");
	});

	it("keeps printable keys inert when the list does not overflow", () => {
		const items = [
			{ value: "alpha", label: "Alpha" },
			{ value: "beta", label: "Beta" },
		];
		const list = new SelectList(items, 2, testTheme);

		list.handleInput("b");

		const rendered = list.render(80).join("\n");
		expect(rendered).toContain("Alpha");
		expect(rendered).toContain("Beta");
		expect(rendered).not.toContain("Search:");
		expect(list.getSelectedItem()?.value).toBe("alpha");
	});

	it("renders a right-edge scrollbar when the list overflows maxVisible", () => {
		const items = Array.from({ length: 8 }, (_, i) => ({ value: `v${i}`, label: `Item ${i}` }));
		const list = new SelectList(items, 3, testTheme);

		const rendered = list.render(40);

		// Default ScrollView glyphs: track │, thumb █. Overflow must surface the bar
		// and drop the old (N/M) text indicator.
		expect(rendered.join("\n")).toContain("█");
		expect(rendered.join("\n")).not.toContain("(1/8)");
	});

	it("omits the scrollbar when every item fits", () => {
		const items = [
			{ value: "alpha", label: "Alpha" },
			{ value: "beta", label: "Beta" },
		];
		const list = new SelectList(items, 5, testTheme);

		expect(list.render(40).join("\n")).not.toContain("█");
	});

	describe("wrapDescription", () => {
		const longDescription =
			"Plan and execute non-trivial architectural improvements to the codebase. Use this skill when you need to refactor existing systems, restructure modules, or change interfaces across multiple files.";

		it("keeps short descriptions on a single row", () => {
			const items = [{ value: "short", label: "short", description: "fits easily" }];
			const list = new SelectList(items, 5, testTheme, { wrapDescription: true });

			const rendered = list.render(80);

			expect(rendered).toHaveLength(1);
			expect(rendered[0]).toContain("fits easily");
		});

		it("wraps long descriptions under the description column", () => {
			const items = [{ value: "long", label: "long-skill-name", description: longDescription }];
			const list = new SelectList(items, 5, testTheme, {
				minPrimaryColumnWidth: 12,
				maxPrimaryColumnWidth: 32,
				wrapDescription: true,
			});

			const rendered = list.render(80);

			// Long description must materialize as multiple rows; truncation would
			// silently drop the tail (the issue).
			expect(rendered.length).toBeGreaterThan(1);
			// Every visual row must fit within the picker width.
			for (const row of rendered) {
				expect(visibleWidth(row)).toBeLessThanOrEqual(80);
			}
			// The first row carries the primary label and the wrapped tail must
			// reach the closing words of the description.
			expect(rendered[0]).toContain("long-skill-name");
			expect(rendered.join("\n")).toContain("across multiple files.");
			// Continuation rows align under the description column. The cursor
			// column on the first row is occupied; continuation rows lead with
			// spaces up to the same offset where the description starts.
			const descStart = visibleIndexOf(rendered[0], "Plan");
			for (let i = 1; i < rendered.length; i++) {
				expect(rendered[i].slice(0, descStart)).toBe(" ".repeat(descStart));
			}
		});

		it("falls back to the no-description layout at narrow widths", () => {
			const items = [{ value: "long", label: "long", description: longDescription }];
			const list = new SelectList(items, 5, testTheme, { wrapDescription: true });

			// width <= 40 trips the existing primary-only fallback.
			const rendered = list.render(40);

			expect(rendered).toHaveLength(1);
			expect(rendered[0]).not.toContain("Plan and execute");
		});

		it("advances selection by one item even when items wrap", () => {
			const items = [
				{ value: "a", label: "a", description: longDescription },
				{ value: "b", label: "b", description: "short" },
			];
			const list = new SelectList(items, 5, testTheme, { wrapDescription: true });

			expect(list.getSelectedItem()?.value).toBe("a");
			// Press Down once → second item, regardless of how many visual rows
			// the first item spans.
			list.handleInput("\x1b[B");
			expect(list.getSelectedItem()?.value).toBe("b");
		});

		it("renders the scrollbar when wrapped items overflow the visible window", () => {
			const items = Array.from({ length: 6 }, (_, i) => ({
				value: `v${i}`,
				label: `Item ${i}`,
				description: longDescription,
			}));
			const list = new SelectList(items, 3, testTheme, { wrapDescription: true });

			const rendered = list.render(80).join("\n");
			expect(rendered).toContain("█");
		});
	});
});

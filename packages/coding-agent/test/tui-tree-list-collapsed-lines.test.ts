import { describe, expect, it } from "bun:test";
import { renderTreeList } from "@oh-my-pi/pi-coding-agent/tui/tree-list";

const stubTheme = {
	fg: (_color: string, text: string) => text,
	tree: { branch: "├", last: "└", vertical: "│", horizontal: "─", hook: "╰" },
} as Parameters<typeof renderTreeList>[1];

function expectWithinBudget(lines: string[], budget: number) {
	expect(lines.length).toBeLessThanOrEqual(budget);
}

describe("renderTreeList maxCollapsedLines", () => {
	it("skips oversized first item instead of rendering broken fragments", () => {
		const largeGroup = Array.from({ length: 15 }, (_, i) => `line-${i}`);
		const smallGroup = ["a", "b"];

		const collapsed = renderTreeList(
			{
				items: [largeGroup, smallGroup],
				expanded: false,
				maxCollapsedLines: 6,
				itemType: "match",
				renderItem: group => group,
			},
			stubTheme,
		);

		expectWithinBudget(collapsed, 6);
		expect(collapsed).toHaveLength(1);
		expect(collapsed[0]).toContain("2 more matches");
	});

	it("counts the summary row inside the collapsed line budget", () => {
		const items = [["a", "b"], ["c", "d", "e"], ["f"]];

		const collapsed = renderTreeList(
			{
				items,
				expanded: false,
				maxCollapsedLines: 4,
				itemType: "match",
				renderItem: group => group,
			},
			stubTheme,
		);

		expectWithinBudget(collapsed, 4);
		expect(collapsed).toHaveLength(3);
		expect(collapsed[0]).toContain("a");
		expect(collapsed[1]).toContain("b");
		expect(collapsed[2]).toContain("2 more matches");
	});

	it("does not cap lines in expanded mode", () => {
		const largeGroup = Array.from({ length: 15 }, (_, i) => `line-${i}`);

		const expanded = renderTreeList(
			{
				items: [largeGroup],
				expanded: true,
				maxCollapsedLines: 6,
				itemType: "match",
				renderItem: group => group,
			},
			stubTheme,
		);

		expect(expanded.length).toBe(15);
		expect(expanded.some(l => l.includes("more"))).toBe(false);
	});

	it("shows correct remaining count when multiple items are hidden", () => {
		const items = [
			["a1", "a2", "a3"],
			["b1", "b2", "b3"],
			["c1", "c2"],
		];

		const collapsed = renderTreeList(
			{
				items,
				expanded: false,
				maxCollapsedLines: 4,
				itemType: "change",
				renderItem: group => group,
			},
			stubTheme,
		);

		expectWithinBudget(collapsed, 4);
		expect(collapsed).toHaveLength(4);
		expect(collapsed.at(-1)).toContain("2 more changes");
	});

	it("renders all items when total lines fit within budget", () => {
		const items = [["a"], ["b"], ["c"]];

		const collapsed = renderTreeList(
			{
				items,
				expanded: false,
				maxCollapsedLines: 10,
				itemType: "item",
				renderItem: group => group,
			},
			stubTheme,
		);

		expect(collapsed.length).toBe(3);
		expect(collapsed.some(l => l.includes("more"))).toBe(false);
	});

	it("uses non-last tree branch when summary line follows", () => {
		const items = [["a"], ["b", "c"]];

		const collapsed = renderTreeList(
			{
				items,
				expanded: false,
				maxCollapsedLines: 2,
				itemType: "item",
				renderItem: group => group,
			},
			stubTheme,
		);

		expectWithinBudget(collapsed, 2);
		expect(collapsed).toHaveLength(2);
		expect(collapsed[0]).toContain("├");
		expect(collapsed[0]).toContain("a");
		expect(collapsed[1]).toContain("└");
		expect(collapsed[1]).toContain("1 more item");
	});

	it("uses last tree branch when no summary follows", () => {
		const items = [["a"]];

		const collapsed = renderTreeList(
			{
				items,
				expanded: false,
				maxCollapsedLines: 10,
				itemType: "item",
				renderItem: group => group,
			},
			stubTheme,
		);

		expect(collapsed.length).toBe(1);
		expect(collapsed[0]).toContain("└");
		expect(collapsed.some(l => l.includes("more"))).toBe(false);
	});

	it("budget=0 renders nothing instead of exceeding the limit", () => {
		const items = [["a"], ["b"]];

		const collapsed = renderTreeList(
			{
				items,
				expanded: false,
				maxCollapsedLines: 0,
				itemType: "item",
				renderItem: group => group,
			},
			stubTheme,
		);

		expect(collapsed).toHaveLength(0);
	});

	it("budget exactly matching total lines shows no summary", () => {
		const items = [["a", "b"], ["c"]];

		const collapsed = renderTreeList(
			{
				items,
				expanded: false,
				maxCollapsedLines: 3,
				itemType: "item",
				renderItem: group => group,
			},
			stubTheme,
		);

		expect(collapsed.length).toBe(3);
		expect(collapsed.some(l => l.includes("more"))).toBe(false);
	});

	it("empty items do not inflate remaining count", () => {
		const items = [["a"], [], ["b"]];

		const collapsed = renderTreeList(
			{
				items,
				expanded: false,
				maxCollapsedLines: 10,
				itemType: "item",
				renderItem: group => group,
			},
			stubTheme,
		);

		expect(collapsed.length).toBe(2);
		expect(collapsed.some(l => l.includes("more"))).toBe(false);
	});

	it("maxCollapsed limits items even when line budget has room", () => {
		const items = [["a"], ["b"], ["c"], ["d"]];

		const collapsed = renderTreeList(
			{
				items,
				expanded: false,
				maxCollapsed: 2,
				maxCollapsedLines: 100,
				itemType: "item",
				renderItem: group => group,
			},
			stubTheme,
		);

		expectWithinBudget(collapsed, 100);
		expect(collapsed).toHaveLength(3);
		expect(collapsed[2]).toContain("2 more items");
	});
});

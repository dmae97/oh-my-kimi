import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { TreeSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tree-selector";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-manager";

let counter = 0;
function makeNode(role: "user" | "assistant", text: string, parentId: string | null = null): SessionTreeNode {
	const id = `e${counter++}`;
	const message: AgentMessage =
		role === "user"
			? { role: "user", content: text, timestamp: counter }
			: ({
					role: "assistant",
					content: [{ type: "text", text }],
					timestamp: counter,
					stopReason: "stop",
				} as AgentMessage);
	const entry: SessionEntry = {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message,
	};
	return { entry, children: [] };
}

function chain(parent: SessionTreeNode, ...specs: Array<["user" | "assistant", string]>): SessionTreeNode {
	let cur = parent;
	for (const [role, text] of specs) {
		const n = makeNode(role, text, cur.entry.id);
		cur.children.push(n);
		cur = n;
	}
	return cur;
}

function renderStripped(tree: SessionTreeNode[], leafId: string, width = 120): string[] {
	const selector = new TreeSelectorComponent(
		tree,
		leafId,
		60,
		() => {},
		() => {},
	);
	return selector.render(width).map(line => Bun.stripANSI(line));
}

// Issue #2325 tree shape: a parent that branches into several sub-sessions
// where the LAST sibling (`└─`) carries a chain of flattened message rows
// that itself branches again deeper down.
describe("issue #2325: connectors terminate at `└─` and chain columns stay stable", () => {
	beforeAll(async () => {
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	});

	it("renders no vertical in the `└─` corner column and keeps chain rows on one anchor column", () => {
		counter = 0;
		const root = makeNode("user", "proceed with implementation");
		const asst = chain(root, ["assistant", "resp"]);
		const b1 = makeNode("user", "first review head", asst.entry.id);
		const b2 = makeNode("user", "plain review head", asst.entry.id);
		const b3 = makeNode("user", "second review head", asst.entry.id);
		asst.children.push(b1, b2, b3);
		const leaf = chain(b1, ["assistant", "b1 reply"], ["user", "active leaf"]);

		// Chain under the LAST sibling b3, with a branch point partway down.
		const fixIt = chain(b3, ["assistant", "fix-asst"], ["user", "fix it all"]);
		const revAsst = chain(fixIt, ["assistant", "rev-asst"]);
		const t1 = makeNode("user", "review the fixes", revAsst.entry.id);
		const t2 = makeNode("user", "other thread", revAsst.entry.id);
		revAsst.children.push(t1, t2);
		chain(t1, ["user", "all findings done"], ["user", "still have findings"]);

		const rendered = renderStripped([root], leaf.entry.id);
		const findRow = (needle: string): string => {
			const row = rendered.find(line => line.includes(needle));
			if (!row) throw new Error(`row containing ${JSON.stringify(needle)} not rendered`);
			return row;
		};

		// b3 is the last sibling: its connector is `└─` at column 2.
		expect(findRow("user: second review head")).toMatch(/^\s{2}└─ \S/);

		// Chain rows under the `└─` head: the corner column (col 2) must stay
		// blank — no `│` running down from the `└─` — and every chain row is
		// anchored by `│` on the same column, one level right (below the head's
		// content). Exact prefix: 5 spaces, `│`, 2 spaces, then content.
		for (const needle of ["assistant: fix-asst", "user: fix it all", "assistant: rev-asst"]) {
			const row = findRow(needle);
			expect(row).not.toMatch(/^\s{2}│/);
			expect(row).toMatch(/^\s{5}│\s{2}\S/);
		}

		// The deeper branch point keeps stable columns: connectors sit directly
		// below the chain content column (col 8), with nothing dangling in the
		// outer corner columns.
		expect(findRow("user: review the fixes")).toMatch(/^\s{8}├─ \S/);
		expect(findRow("user: other thread")).toMatch(/^\s{8}└─ \S/);

		// Continuations of the non-last grandchild ride its sibling line at the
		// same column (col 8) — no drift back into outer columns.
		for (const needle of ["user: all findings done", "user: still have findings"]) {
			const row = findRow(needle);
			expect(row).toMatch(/^\s{8}│\s{5}\S/);
		}
	});
});

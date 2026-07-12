import { describe, expect, it } from "bun:test";
import { renderMermaidAscii, renderMermaidAsciiSafe } from "../src/mermaid-ascii";
import { getPath } from "../src/vendor/mermaid-ascii/ascii/pathfinder";
import { type AsciiNode, type GridCoord, gridKey } from "../src/vendor/mermaid-ascii/ascii/types";

describe("renderMermaidAscii", () => {
	it("preserves an existing emoji edge label when a later narrow label collides with it", () => {
		const rendered = renderMermaidAscii(["flowchart LR", "  A -->|🚀| B", "  A -->|A| B"].join("\n"), {
			colorMode: "none",
		});

		expect(rendered).toContain("─🚀─");
		expect(rendered).not.toContain("──A─");
	});

	it("returns a bounded fallback for declaration orders that make a clean route unreachable", () => {
		const rendered = renderMermaidAsciiSafe(
			[
				"flowchart TD",
				"  Worker[Worker]",
				"  Archive[Archive]",
				"  Gateway[Gateway]",
				"  Audit[Audit]",
				"",
				"  Worker --> Archive",
				"  Gateway --> Worker",
				"  Gateway --> Audit",
			].join("\n"),
			{ colorMode: "none" },
		);

		if (rendered === null) {
			throw new Error("expected Mermaid ASCII renderer to return fallback output");
		}

		expect(rendered).toContain("Archive");
		expect(rendered).toContain("Gateway");
		expect(rendered).toContain("Audit");
	});

	it("returns null when the destination attachment point is enclosed", () => {
		const node: AsciiNode = {
			name: "blocker",
			displayLabel: "blocker",
			shape: "rectangle",
			index: 0,
			gridCoord: null,
			drawingCoord: null,
			drawing: null,
			drawn: false,
			styleClassName: "",
			styleClass: { name: "", styles: {} },
		};
		const enclosed: GridCoord = { x: 2, y: 2 };
		const blockers: GridCoord[] = [enclosed, { x: 1, y: 2 }, { x: 3, y: 2 }, { x: 2, y: 1 }, { x: 2, y: 3 }];
		const grid = new Map<string, AsciiNode>();

		for (const blocker of blockers) {
			grid.set(gridKey(blocker), node);
		}

		expect(getPath(grid, { x: 0, y: 2 }, enclosed)).toBeNull();
	});
});

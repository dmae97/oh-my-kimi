import { describe, expect, it } from "bun:test";
import { renderMermaidAscii } from "../src/mermaid-ascii";

describe("renderMermaidAscii", () => {
	it("preserves an existing emoji edge label when a later narrow label collides with it", () => {
		const rendered = renderMermaidAscii(["flowchart LR", "  A -->|🚀| B", "  A -->|A| B"].join("\n"), {
			colorMode: "none",
		});

		expect(rendered).toContain("─🚀─");
		expect(rendered).not.toContain("──A─");
	});
});

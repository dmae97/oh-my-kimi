/**
 * Contract: the compaction point renders as a slim horizontal divider —
 * `── 📷 compacted · ctrl+o ──` — instead of a full summary box, keeping the
 * transcript visually continuous. Expansion (ctrl+o) reveals the summary.
 * The render cache must honor the pi-tui same-reference contract: unchanged
 * components return the identical array so containers can memoize.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { createCompactionSummaryMessage } from "@oh-my-pi/pi-agent-core/compaction";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { CompactionSummaryMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/compaction-summary-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(() => {
	initTheme();
});

const SUMMARY = "Earlier the user fixed the login TTL bug.";

function makeComponent(images?: ImageContent[]): CompactionSummaryMessageComponent {
	return new CompactionSummaryMessageComponent(
		createCompactionSummaryMessage(SUMMARY, 84000, new Date().toISOString(), undefined, undefined, images),
	);
}

describe("CompactionSummaryMessageComponent", () => {
	it("collapsed: a single full-width divider carrying the expand affordance", () => {
		const lines = makeComponent().render(80);
		expect(lines.length).toBe(3); // breathing room above and below the rule
		const rule = Bun.stripANSI(lines[1]);
		expect(rule).toContain("compacted");
		expect(rule).toContain("ctrl+o");
		// The rule spans the full width and hides the summary body.
		expect(Bun.stringWidth(rule)).toBe(80);
		expect(rule).not.toContain(SUMMARY);
	});

	it("expanded: reveals the summary (and snapcompact frame count) below the divider", () => {
		const component = makeComponent([{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }]);
		component.setExpanded(true);
		const text = Bun.stripANSI(component.render(80).join("\n"));
		expect(text).toContain("compacted");
		expect(text).toContain(SUMMARY);
		expect(text).toContain("tokens");
		expect(text).toContain("1 snapcompact frame attached");
	});

	it("degrades to a bare label when the viewport is too narrow for a framed rule", () => {
		const lines = makeComponent().render(10);
		expect(Bun.stripANSI(lines[1])).toContain("compacted");
	});

	it("honors the same-reference render cache and busts it on expansion toggle", () => {
		const component = makeComponent();
		const first = component.render(80);
		expect(component.render(80)).toBe(first);
		component.setExpanded(true);
		const expanded = component.render(80);
		expect(expanded).not.toBe(first);
		expect(component.render(80)).toBe(expanded);
	});
});

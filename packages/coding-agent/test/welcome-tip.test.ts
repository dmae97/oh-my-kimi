import { describe, expect, it } from "bun:test";
import { renderWelcomeTip } from "@oh-my-pi/pi-coding-agent/modes/components/welcome";
import { visibleWidth } from "@oh-my-pi/pi-tui";

describe("renderWelcomeTip", () => {
	it("wraps long tips under the label instead of truncating", () => {
		const tip = "Next time you see spaghetti try creating a TTSR rule that prevents this pattern before it spreads";
		const width = 44;
		const lines = renderWelcomeTip(tip, width);
		const plain = lines.map(line => Bun.stripANSI(line));

		expect(plain.length).toBeGreaterThan(1);
		expect(plain.join(" ")).not.toContain("…");
		expect(plain[0]).toStartWith(" Tip: Next time");
		expect(plain[1]).toStartWith("      ");
		for (const line of plain) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});

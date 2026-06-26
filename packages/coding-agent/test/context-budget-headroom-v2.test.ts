import { describe, expect, it } from "vitest";
import type { ContextBudgetItemV2 } from "../src/core/context-budget-governor-v2.ts";
import { chooseHeadroomRepresentation, getHeadroomRuntimeStatus } from "../src/core/context-budget-headroom.ts";

function item(
	over: Partial<ContextBudgetItemV2> & Pick<ContextBudgetItemV2, "id" | "tier" | "text">,
): ContextBudgetItemV2 {
	const { id, tier, text, ...rest } = over;
	return {
		priority: "medium",
		...rest,
		id,
		tier,
		text,
	};
}

describe("context budget headroom v2", () => {
	it("keeps hard-pinned items full under tight budget", () => {
		const chosen = chooseHeadroomRepresentation(
			item({ id: "h", tier: "system", priority: "hard", text: "h", tokenEstimate: 1000 }),
			{ tierUsedTokens: 0, tierCeilingTokens: 5, remainingGlobalTokens: 5 },
		);

		expect(chosen.kind).toBe("full");
	});

	it("exposes runtime status for the TUI control panel", () => {
		const status = getHeadroomRuntimeStatus();

		expect(status.policyId).toBe("context-budget-v2");
		expect(status.selector).toBe("headroom-selector");
		expect(status.representations).toContain("headroom-compressed");
		expect(status.headroomThresholdTokens).toBeGreaterThan(0);
	});

	it("does not choose lossy summaries that cost at least as much as full text", () => {
		const chosen = chooseHeadroomRepresentation(
			item({
				id: "short-old-evidence",
				tier: "evidence",
				priority: "medium",
				text: "short evidence",
				tokenEstimate: 8,
				ageTurns: 10,
			}),
			{ tierUsedTokens: 0, tierCeilingTokens: 100, remainingGlobalTokens: 100 },
		);

		expect(chosen.kind).toBe("full");
	});

	it("rejects caller-supplied lossy representations that are not cheaper than raw full text", () => {
		const chosen = chooseHeadroomRepresentation(
			item({
				id: "custom-summary",
				tier: "evidence",
				priority: "medium",
				text: "raw full",
				tokenEstimate: 8,
				representations: [
					{
						kind: "summary",
						text: "same cost summary",
						estimatedTokens: 8,
						fidelity: "lossy",
					},
				],
			}),
			{ tierUsedTokens: 0, tierCeilingTokens: 100, remainingGlobalTokens: 100 },
		);

		expect(chosen.kind).toBe("omit");
	});
});

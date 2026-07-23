import { describe, expect, it } from "vitest";
import type { ContextBudgetItemV2 } from "../src/core/context-budget-governor-v2.ts";
import {
	chooseHeadroomRepresentation,
	deriveRepresentationCandidates,
	getHeadroomRuntimeStatus,
	heuristicTokenCount,
} from "../src/core/context-budget-headroom.ts";

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

	it("quotes and escapes generated pointer metadata", () => {
		const uri = `file:///repo/A&B"notes<draft>.md`;
		const candidates = deriveRepresentationCandidates(
			item({
				id: "metadata",
				tier: "current-files",
				text: "safe context ".repeat(400),
				tokenEstimate: 1000,
				sourceRef: {
					uri,
					symbol: `section&"<draft>`,
					contentHash: `h&"<>`,
					retrievable: true,
				},
			}),
		);
		const pointer = candidates.find((candidate) => candidate.kind === "pointer");
		const compressed = candidates.find((candidate) => candidate.kind === "headroom-compressed");

		expect(pointer?.text).toBe(
			'<pointer uri="file:///repo/A&amp;B&quot;notes&lt;draft&gt;.md" symbol="section&amp;&quot;&lt;draft&gt;" hash="h&amp;&quot;&lt;&gt;" />',
		);
		expect(pointer?.text).not.toContain(uri);
		expect(pointer?.estimatedTokens).toBe(heuristicTokenCount(pointer?.text ?? ""));
		expect(compressed?.text).toContain('uri="file:///repo/A&amp;B&quot;notes&lt;draft&gt;.md" hash="');
		expect(compressed?.estimatedTokens).toBeGreaterThanOrEqual(heuristicTokenCount(compressed?.text ?? ""));
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

	it("lets cache hits change the selected representation", () => {
		const chosen = chooseHeadroomRepresentation(
			item({
				id: "cache-aware-summary",
				tier: "evidence",
				priority: "medium",
				text: "raw full evidence ".repeat(40),
				tokenEstimate: 120,
				ageTurns: 10,
				representations: [
					{
						kind: "summary",
						text: "uncached summary",
						estimatedTokens: 40,
						fidelity: "lossy",
					},
					{
						kind: "summary",
						text: "cached summary",
						estimatedTokens: 40,
						fidelity: "lossy",
						cache: {
							hit: true,
							key: "context-representation-materialized:cached",
							keyKind: "materialized",
							layer: "turn",
						},
					},
				],
			}),
			{ tierUsedTokens: 0, tierCeilingTokens: 200, remainingGlobalTokens: 200 },
		);

		expect(chosen.text).toBe("cached summary");
		expect(chosen.cache?.hit).toBe(true);
	});
});

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { latestRelevantWorkspaceMutationSeq } from "../src/guardrails/evidence-attestation.ts";
import type { ReplayEvent, WorkspaceScope } from "../src/types/evidence.ts";

const SCOPE: WorkspaceScope = { root: "/workspace", artifactPaths: ["dist/result.txt"] };
type EventKind = "receipt" | "relevant" | "parent" | "outside" | "foreign-root" | "malformed";

function replayEvent(kind: EventKind, seq: number): ReplayEvent {
	const payloadByKind: Record<EventKind, unknown> = {
		receipt: { receiptId: `receipt-${seq}` },
		relevant: { root: SCOPE.root, paths: ["dist/result.txt"] },
		parent: { root: SCOPE.root, paths: ["dist"] },
		outside: { root: SCOPE.root, paths: ["docs/readme.md"] },
		"foreign-root": { root: "/other-workspace", paths: ["docs/readme.md"] },
		malformed: { paths: "dist/result.txt" },
	};
	return {
		seq,
		type: kind === "receipt" ? "evidence_receipt" : "workspace_mutation",
		timestamp: "2026-08-16T00:00:00.000Z",
		goalId: "property-goal",
		payload: payloadByKind[kind],
		payloadHash: "0".repeat(64),
		prevHash: seq === 1 ? "genesis" : "1".repeat(64),
		eventHash: "1".repeat(64),
	};
}

function isRelevantMutation(kind: EventKind): boolean {
	return kind === "relevant" || kind === "parent" || kind === "foreign-root" || kind === "malformed";
}

describe("evidence freshness properties", () => {
	it("always resolves the latest relevant or fail-closed workspace mutation", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.constantFrom<EventKind>("receipt", "relevant", "parent", "outside", "foreign-root", "malformed"),
					{
						maxLength: 100,
					},
				),
				(kinds) => {
					const events = kinds.map((kind, index) => replayEvent(kind, index + 1));
					const expected = kinds.reduce<number | null>(
						(latest, kind, index) => (isRelevantMutation(kind) ? index + 1 : latest),
						null,
					);
					expect(latestRelevantWorkspaceMutationSeq(events, SCOPE)).toBe(expected);
				},
			),
			{ numRuns: 250, seed: 0x0fc52026 },
		);
	});

	it("treats every relevant mutation at or after a receipt sequence as stale", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.constantFrom<EventKind>("receipt", "relevant", "parent", "outside", "foreign-root", "malformed"),
					{
						minLength: 1,
						maxLength: 100,
					},
				),
				fc.nat(),
				(kinds, seed) => {
					const receiptSeq = (seed % kinds.length) + 1;
					const events = kinds.map((kind, index) => replayEvent(kind, index + 1));
					const latestMutation = latestRelevantWorkspaceMutationSeq(events, SCOPE);
					const hasInvalidatingMutation = kinds.some(
						(kind, index) => isRelevantMutation(kind) && index + 1 >= receiptSeq,
					);
					expect(latestMutation !== null && latestMutation >= receiptSeq).toBe(hasInvalidatingMutation);
				},
			),
			{ numRuns: 250, seed: 0x0fc52026 },
		);
	});
});

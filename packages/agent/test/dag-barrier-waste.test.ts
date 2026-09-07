import { describe, expect, it } from "vitest";
import { type CallTiming, computeBarrierWaste } from "../src/dag-barrier-waste.ts";
import { assignDagDependencies, type ResolvedClaimEntry } from "../src/tool-dag-scheduler.ts";

function entry(index: number, kind: "read" | "write" | "exclusive", key = "a"): ResolvedClaimEntry {
	const claims = kind === "exclusive" ? [] : [{ kind: "path" as const, key, access: kind as "read" | "write" }];
	return {
		sourceIndex: index,
		resolution: kind === "exclusive" ? { kind: "exclusive" as const } : { kind: "claims" as const, claims },
		canonicalClaims: claims as never,
	};
}

describe("computeBarrierWaste", () => {
	it("reports zero waste for a single level with no predecessors", () => {
		const entries = [entry(0, "read"), entry(1, "read", "b")];
		const timings: CallTiming[] = [
			{ startMs: 0, finishMs: 100 },
			{ startMs: 0, finishMs: 50 },
		];

		expect(computeBarrierWaste(entries, timings)).toBe(0);
	});

	it("measures waiting past predecessor finish under a level barrier", () => {
		// Call 0 (slow read of A) and call 1 (fast read of B) share level 0.
		// Call 2 writes B: it depends on call 1, not call 0 — but the
		// barrier holds it until call 0 finishes too.
		const entries = [entry(0, "read", "a"), entry(1, "read", "b"), entry(2, "write", "b")];
		const timings: CallTiming[] = [
			{ startMs: 0, finishMs: 1000 },
			{ startMs: 0, finishMs: 100 },
			{ startMs: 1000, finishMs: 1100 },
		];

		// Dependency finish = max over true predecessors (call 1 @100).
		// Actual start = 1000. Waste = 900.
		expect(computeBarrierWaste(entries, timings)).toBe(900);
	});

	it("ignores waiting explained by the concurrency cap", () => {
		const entries = [entry(0, "read", "a"), entry(1, "read", "b"), entry(2, "write", "b")];
		const timings: CallTiming[] = [
			{ startMs: 0, finishMs: 1000 },
			{ startMs: 0, finishMs: 100 },
			{ startMs: 1000, finishMs: 1100 },
		];

		// With cap=1 the level-0 pair serializes legitimately; only the
		// remaining barrier hold counts. Cap accounting is the caller's job —
		// here the pure function sees only true-predecessor finish.
		const deps = assignDagDependencies(entries);
		expect(deps[2]).toEqual([1]);
		expect(computeBarrierWaste(entries, timings)).toBe(900);
	});

	it("returns zero when timings are missing or inconsistent", () => {
		const entries = [entry(0, "read"), entry(1, "read")];

		expect(computeBarrierWaste(entries, [])).toBe(0);
		expect(
			computeBarrierWaste(entries, [
				{ startMs: 500, finishMs: 100 },
				{ startMs: 0, finishMs: 50 },
			]),
		).toBe(0);
	});
});

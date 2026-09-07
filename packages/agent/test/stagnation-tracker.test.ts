import { describe, expect, it } from "vitest";
import { StagnationTracker } from "../src/stagnation-tracker.ts";

describe("StagnationTracker", () => {
	it("starts clear", () => {
		const tracker = new StagnationTracker(3);

		expect(tracker.check({ fingerprint: "err:ENOENT:src/a.ts" })).toEqual({
			stagnated: false,
			repeats: 1,
		});
	});

	it("flags stagnation at the threshold with no new observation", () => {
		const tracker = new StagnationTracker(3);
		const fp = "err:exit-1:src/a.ts:deadbeef";

		expect(tracker.check({ fingerprint: fp }).stagnated).toBe(false);
		expect(tracker.check({ fingerprint: fp }).stagnated).toBe(false);
		const third = tracker.check({ fingerprint: fp });

		expect(third.stagnated).toBe(true);
		expect(third.repeats).toBe(3);
	});

	it("resets the count when the fingerprint changes", () => {
		const tracker = new StagnationTracker(2);

		tracker.check({ fingerprint: "err:A" });
		tracker.check({ fingerprint: "err:A" });
		const changed = tracker.check({ fingerprint: "err:B" });

		expect(changed).toEqual({ stagnated: false, repeats: 1 });
	});

	it("treats new observations as progress even on the same fingerprint", () => {
		const tracker = new StagnationTracker(2);

		tracker.check({ fingerprint: "err:A", observationHash: "out-1" });
		const progress = tracker.check({ fingerprint: "err:A", observationHash: "out-2" });

		expect(progress).toEqual({ stagnated: false, repeats: 1 });
	});

	it("recommends an alternative instead of a retry on stagnation", () => {
		const tracker = new StagnationTracker(2);

		tracker.check({ fingerprint: "err:A" });
		const result = tracker.check({ fingerprint: "err:A" });

		expect(result.stagnated).toBe(true);
		expect(result.recommendation).toBe("divert");
	});
});

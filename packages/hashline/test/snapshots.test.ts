import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore } from "@oh-my-pi/hashline";

const PATH = "/tmp/__hashline-snapshots__.ts";
const TAG_RE = /^[0-9A-F]{3}$/;

function nextHex(tag: string): string {
	return ((Number.parseInt(tag, 16) + 1) & 0xfff).toString(16).toUpperCase().padStart(3, "0");
}

describe("InMemorySnapshotStore", () => {
	it("reuses a prior tag when that snapshot is a content-matching superset", () => {
		const store = new InMemorySnapshotStore();
		const tag = store.recordContiguous(PATH, 1, ["L1", "L2", "L3"]);

		expect(tag).toMatch(TAG_RE);
		expect(store.recordContiguous(PATH, 2, ["L2"])).toBe(tag);
		expect(store.recordSparse(PATH, [[3, "L3"]])).toBe(tag);
	});

	it("coalesces overlapping consistent reads into one tag spanning the union", () => {
		const store = new InMemorySnapshotStore();
		const file = Array.from({ length: 200 }, (_, index) => `L${index + 1}`);
		// read a.ts:50-100 then a.ts:100-200 — share line 100, file unchanged.
		const first = store.recordContiguous(PATH, 50, file.slice(49, 100));
		const second = store.recordContiguous(PATH, 100, file.slice(99, 200));

		expect(first).toMatch(TAG_RE);
		expect(second).toBe(first);
		const snap = store.byHash(PATH, first);
		expect(snap?.get(50)).toBe("L50");
		expect(snap?.get(100)).toBe("L100");
		expect(snap?.get(150)).toBe("L150");
		expect(snap?.get(200)).toBe("L200");
		expect(snap?.get(201)).toBeUndefined();
	});

	it("coalesces non-contiguous reads into a sparse snapshot under one tag", () => {
		const store = new InMemorySnapshotStore();
		const file = Array.from({ length: 200 }, (_, index) => `L${index + 1}`);
		// read a.ts:1-100 then a.ts:150-200 — disjoint, gap 101..149.
		const first = store.recordContiguous(PATH, 1, file.slice(0, 100));
		const second = store.recordContiguous(PATH, 150, file.slice(149, 200));

		expect(second).toBe(first);
		const snap = store.byHash(PATH, first);
		expect(snap?.get(1)).toBe("L1");
		expect(snap?.get(100)).toBe("L100");
		expect(snap?.get(125)).toBeUndefined();
		expect(snap?.get(150)).toBe("L150");
		expect(snap?.get(200)).toBe("L200");
	});

	it("mints a new tag when a shared line disagrees, then dedups against it", () => {
		const store = new InMemorySnapshotStore();
		const first = store.recordContiguous(PATH, 50, ["L50", "L51", "L52"]);
		// re-read 52-54 but line 52 drifted — the file changed on disk.
		const second = store.recordContiguous(PATH, 52, ["CHANGED", "L53", "L54"]);

		expect(second).not.toBe(first);
		expect(store.byHash(PATH, first)?.get(52)).toBe("L52");
		expect(store.byHash(PATH, second)?.get(52)).toBe("CHANGED");
		// A follow-up read consistent with the newer view dedups onto its tag.
		expect(store.recordContiguous(PATH, 53, ["L53"])).toBe(second);
	});

	it("scrambles slot tags so the first and next tags are not predictable counters", () => {
		const store = new InMemorySnapshotStore();
		const first = store.recordContiguous(PATH, 1, ["value 0"]);
		const second = store.recordContiguous(PATH, 1, ["value 1"]);

		expect(first).toMatch(TAG_RE);
		expect(second).toMatch(TAG_RE);
		expect(first).not.toBe("000");
		expect(second).not.toBe(nextHex(first));
	});

	it("pushes new views into distinct ring slots", () => {
		const store = new InMemorySnapshotStore();
		const first = store.recordContiguous(PATH, 1, ["one"]);
		const second = store.recordContiguous(PATH, 1, ["two"]);

		expect(first).toMatch(TAG_RE);
		expect(second).toMatch(TAG_RE);
		expect(second).not.toBe(first);
		expect(store.head(PATH)?.get(1)).toBe("two");
		expect(store.byHash(PATH, first)?.get(1)).toBe("one");
		expect(store.byHash(PATH, second)?.get(1)).toBe("two");
	});

	it("rejects cross-path lookups even when the tag slot is occupied", () => {
		const store = new InMemorySnapshotStore();
		const tag = store.recordContiguous(PATH, 1, ["one"]);

		expect(store.byHash("/tmp/other.ts", tag)).toBeNull();
	});

	it("wraps after 4096 pushes and byHash returns the new slot occupant", () => {
		const store = new InMemorySnapshotStore();
		const first = store.recordContiguous(PATH, 1, ["value 0"]);
		let previous = first;

		for (let index = 1; index < 4096; index++) {
			const tag = store.recordContiguous(PATH, 1, [`value ${index}`]);
			expect(tag).toMatch(TAG_RE);
			expect(tag).not.toBe(previous);
			previous = tag;
		}
		const wrapped = store.recordContiguous(PATH, 1, ["value 4096"]);

		expect(wrapped).toBe(first);
		expect(store.byHash(PATH, first)?.get(1)).toBe("value 4096");
		expect(store.byHash(PATH, previous)?.get(1)).toBe("value 4095");
	});
});

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

	it("picks the newest matching superset", () => {
		const store = new InMemorySnapshotStore();
		const older = store.recordSparse(PATH, [
			[1, "L1"],
			[2, "L2"],
		]);
		const newer = store.recordSparse(PATH, [
			[2, "L2"],
			[3, "L3"],
		]);

		expect(older).toMatch(TAG_RE);
		expect(newer).toMatch(TAG_RE);
		expect(newer).not.toBe(older);
		expect(store.recordSparse(PATH, [[2, "L2"]])).toBe(newer);
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

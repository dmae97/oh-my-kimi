import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Box, type Component, Container, Text } from "@oh-my-pi/pi-tui";

/**
 * Leaf component that returns a stable cached array and counts render calls.
 * Used to prove the memo skips rebuilding the concatenation, not the child
 * renders themselves (renders carry side effects per the Component contract).
 */
class Probe implements Component {
	renderCount = 0;
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = lines;
	}

	setLines(lines: string[]): void {
		this.#lines = lines;
	}

	render(_width: number): readonly string[] {
		this.renderCount++;
		return this.#lines;
	}
}

function plain(lines: readonly string[]): string[] {
	return lines.map(line => stripVTControlCharacters(line).trimEnd());
}

describe("Container render memoization", () => {
	it("returns the identical reference across renders while children are ref-stable", () => {
		const container = new Container();
		container.addChild(new Text("alpha", 0, 0));
		container.addChild(new Text("beta", 0, 0));

		const first = container.render(40);
		expect(plain(first)).toEqual(["alpha", "beta"]);
		expect(container.render(40)).toBe(first);
		expect(container.render(40)).toBe(first);
	});

	it("returns a new reference with updated rows after a child setText", () => {
		const container = new Container();
		const text = new Text("before", 0, 0);
		container.addChild(text);

		const before = container.render(40);
		text.setText("after");
		const after = container.render(40);

		expect(after).not.toBe(before);
		expect(plain(after)).toEqual(["after"]);
		// Stable again at the new content.
		expect(container.render(40)).toBe(after);
	});

	it("drops the memo on addChild", () => {
		const container = new Container();
		container.addChild(new Text("first", 0, 0));
		const before = container.render(40);

		container.addChild(new Text("second", 0, 0));
		const after = container.render(40);

		expect(after).not.toBe(before);
		expect(plain(after)).toEqual(["first", "second"]);
	});

	it("drops the memo on removeChild", () => {
		const container = new Container();
		const keep = new Text("keep", 0, 0);
		const drop = new Text("drop", 0, 0);
		container.addChild(keep);
		container.addChild(drop);
		const before = container.render(40);

		container.removeChild(drop);
		const after = container.render(40);

		expect(after).not.toBe(before);
		expect(plain(after)).toEqual(["keep"]);
	});

	it("drops the memo on clear", () => {
		const container = new Container();
		container.addChild(new Text("gone", 0, 0));
		const before = container.render(40);

		container.clear();
		const after = container.render(40);

		expect(after).not.toBe(before);
		expect(after.length).toBe(0);
	});

	it("drops the memo on invalidate even when content is unchanged", () => {
		const container = new Container();
		container.addChild(new Text("same", 0, 0));
		const before = container.render(40);

		container.invalidate();
		const after = container.render(40);

		expect(after).not.toBe(before);
		expect(plain(after)).toEqual(plain(before));
	});

	it("still renders every child on every call when the memo hits", () => {
		const container = new Container();
		const a = new Probe(["probe-a"]);
		const b = new Probe(["probe-b"]);
		container.addChild(a);
		container.addChild(b);

		const first = container.render(40);
		const second = container.render(40);
		const third = container.render(40);

		// Memo hit: identical reference…
		expect(second).toBe(first);
		expect(third).toBe(first);
		// …but children were rendered each frame regardless.
		expect(a.renderCount).toBe(3);
		expect(b.renderCount).toBe(3);
	});

	it("misses the memo on width change", () => {
		const container = new Container();
		container.addChild(new Probe(["constant-row"]));

		const narrow = container.render(40);
		const wide = container.render(60);
		expect(wide).not.toBe(narrow);
		// Stable at the new width.
		expect(container.render(60)).toBe(wide);
	});
});

describe("Box render memoization", () => {
	it("returns the identical reference across renders at a fixed width", () => {
		const box = new Box(1, 1);
		box.addChild(new Text("content", 0, 0));

		const first = box.render(40);
		expect(plain(first)).toEqual(["", " content", ""]);
		expect(box.render(40)).toBe(first);
	});

	it("returns a new reference with updated rows after a child change", () => {
		const box = new Box(1, 0);
		const text = new Text("old", 0, 0);
		box.addChild(text);

		const before = box.render(40);
		text.setText("new");
		const after = box.render(40);

		expect(after).not.toBe(before);
		expect(plain(after)).toEqual([" new"]);
		expect(box.render(40)).toBe(after);
	});

	it("misses the cache when the bgFn output changes without the function reference changing", () => {
		let tag = "A";
		const box = new Box(0, 0, text => `<${tag}>${text}</${tag}>`);
		box.addChild(new Probe(["row"]));

		const first = box.render(10);
		expect(first[0]).toBe("<A>row       </A>");
		// Same closure state → cache hit.
		expect(box.render(10)).toBe(first);

		// Mutate the closure: same function reference, different output. The
		// bg sample in the cache key must force a rebuild.
		tag = "B";
		const second = box.render(10);
		expect(second).not.toBe(first);
		expect(second[0]).toBe("<B>row       </B>");
	});
});

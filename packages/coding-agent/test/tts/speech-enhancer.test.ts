import { describe, expect, it } from "bun:test";
import { BlockAccumulator } from "@oh-my-pi/pi-coding-agent/tts/speech-enhancer";

/** Push each delta in order; returns blocks completed by pushes plus the flush tail. */
function feed(...deltas: string[]): { blocks: string[]; tail: string | null } {
	const acc = new BlockAccumulator();
	const blocks = deltas.flatMap(delta => acc.push(delta));
	return { blocks, tail: acc.flush() };
}

describe("BlockAccumulator paragraph splitting", () => {
	it("emits blank-line-delimited paragraphs in order", () => {
		const acc = new BlockAccumulator();
		expect(acc.push("First paragraph.\n\nSecond paragraph.\n\n")).toEqual(["First paragraph.", "Second paragraph."]);
	});

	it("keeps single-newline lines (a multi-line list) in one block", () => {
		const { blocks, tail } = feed("- item one\n- item two\n- item three\n");
		expect(blocks).toEqual([]);
		expect(tail).toBe("- item one\n- item two\n- item three");
	});
});

describe("BlockAccumulator fence atomicity", () => {
	it("a ``` fence with an internal blank line stays one whole block between prose blocks", () => {
		const { blocks } = feed("Intro text.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nOutro text.\n\n");
		expect(blocks).toEqual(["Intro text.", "```ts\nconst a = 1;\n\nconst b = 2;\n```", "Outro text."]);
	});

	it("~~~ fences hold a block together like ``` fences", () => {
		const { blocks } = feed("~~~\nfirst line\n\nsecond line\n~~~\n\nAfter the fence.\n\n");
		expect(blocks).toEqual(["~~~\nfirst line\n\nsecond line\n~~~", "After the fence."]);
	});

	it("a ``` line inside an open ~~~ fence does not close it", () => {
		const { blocks } = feed("~~~\n```\nstill code\n\nstill code too\n~~~\n\nAfter the fence.\n\n");
		expect(blocks).toEqual(["~~~\n```\nstill code\n\nstill code too\n~~~", "After the fence."]);
	});
});

describe("BlockAccumulator delta splitting", () => {
	it("one-character deltas yield the same blocks and flush tail as a single push", () => {
		const input = "Intro text.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nOutro text.\nTrailing partial";
		expect(feed(...input.split(""))).toEqual(feed(input));
	});
});

describe("BlockAccumulator flushPartial", () => {
	it("returns null mid-fence and preserves fence state for the eventual close", () => {
		const acc = new BlockAccumulator();
		expect(acc.push("```ts\nconst x = 1;\nconst y")).toEqual([]);
		expect(acc.flushPartial()).toBeNull();
		expect(acc.push(" = 2;\n```\n\n")).toEqual(["```ts\nconst x = 1;\nconst y = 2;\n```"]);
	});

	it("drains a pending partial line outside a fence, and later pushes continue cleanly", () => {
		const acc = new BlockAccumulator();
		expect(acc.push("Stalled sentence with no newline")).toEqual([]);
		expect(acc.flushPartial()).toBe("Stalled sentence with no newline");
		expect(acc.push("Fresh paragraph after the stall.\n\n")).toEqual(["Fresh paragraph after the stall."]);
		expect(acc.flush()).toBeNull();
	});
});

describe("BlockAccumulator flush", () => {
	it("drops an unterminated fence from its opening line but keeps preceding prose in the same block", () => {
		const acc = new BlockAccumulator();
		expect(acc.push("Prose before the code:\n```ts\nconst broken = ")).toEqual([]);
		expect(acc.flush()).toBe("Prose before the code:");
	});

	it("returns null with no pending content, both fresh and after a drain", () => {
		const acc = new BlockAccumulator();
		expect(acc.flush()).toBeNull();
		acc.push("Some text\n");
		acc.flush();
		expect(acc.flush()).toBeNull();
	});
});

import { describe, expect, it } from "bun:test";
import { reduceFailingOperations } from "./render-stress-reducer";

describe("render stress reducer", () => {
	it("shrinks a failing prefix while preserving failure", async () => {
		const reduced = await reduceFailingOperations(
			["a", "b", "c", "d", "e"],
			async candidate => candidate.includes("b") && candidate.includes("d"),
		);
		expect(reduced).toEqual(["b", "d"]);
	});
});

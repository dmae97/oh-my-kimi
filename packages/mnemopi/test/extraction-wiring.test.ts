import { afterEach, describe, expect, it } from "bun:test";
import { Mnemopi } from "../src/core/memory";
import type { MnemopiLlmCompletion } from "../src/core/runtime-options";

const instances: Mnemopi[] = [];

afterEach(async () => {
	for (const memory of instances) {
		await memory.flushExtractions();
		memory.close();
	}
	instances.length = 0;
});

function makeMemory(llm: false | { complete: MnemopiLlmCompletion }): Mnemopi {
	const memory = new Mnemopi({
		sessionId: "extract-wiring",
		dbPath: ":memory:",
		llm: llm === false ? false : { enabled: true, complete: llm.complete },
	});
	instances.push(memory);
	return memory;
}

describe("remember(extract) wires the LLM fact extractor", () => {
	it("runs the configured completion and makes extracted facts recallable", async () => {
		let calls = 0;
		const memory = makeMemory({
			complete: prompt => {
				calls += 1;
				expect(prompt).toContain("dark roast");
				return "The user loves coffee\nThe user prefers dark roast";
			},
		});

		const id = memory.remember("I love coffee, especially dark roast.", {
			source: "test",
			extract: true,
		});
		expect(id).toBeTruthy();

		// Extraction is fired-and-forgotten by the synchronous `remember`; drain it.
		await memory.flushExtractions();

		expect(calls).toBe(1);
		expect(memory.beam.factRecall("coffee", 5).some(fact => fact.content.includes("coffee"))).toBe(true);
		expect(memory.beam.factRecall("dark roast", 5).some(fact => fact.content.includes("dark roast"))).toBe(true);
	});

	it("does not invoke the extractor when extract is not requested", async () => {
		let calls = 0;
		const memory = makeMemory({
			complete: () => {
				calls += 1;
				return "The user loves coffee";
			},
		});

		memory.remember("I love coffee, especially dark roast.", { source: "test" });
		await memory.flushExtractions();

		expect(calls).toBe(0);
		expect(memory.beam.factRecall("coffee", 5)).toHaveLength(0);
	});

	it("stores the memory without throwing when extraction has no LLM", async () => {
		const memory = makeMemory(false);

		const id = memory.remember("Some opaque payload with no extractable facts: zzz qqq.", {
			source: "test",
			extract: true,
		});
		expect(id).toBeTruthy();

		// Must resolve cleanly even though no LLM is configured.
		await expect(memory.flushExtractions()).resolves.toBeUndefined();

		// The memory itself is still durably stored and recallable.
		const recalled = memory.recall("opaque payload", 5);
		expect(recalled.some(row => row.id === id)).toBe(true);
	});
});

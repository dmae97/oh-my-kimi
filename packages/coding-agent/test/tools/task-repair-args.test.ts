import { describe, expect, it } from "bun:test";
import { repairDoubleEncodedJsonString, repairTaskParams } from "../../src/task/repair-args";
import type { TaskParams } from "../../src/task/types";

describe("repairDoubleEncodedJsonString", () => {
	it("decodes a uniformly double-encoded prose value", () => {
		// One JSON decode already applied by the provider; the value still
		// carries literal `\n`, `\"`, and `\u2014` because the model escaped twice.
		const doubled = '# Role\\nYou are a judge \\"describe this\\" return \\u2014';
		expect(repairDoubleEncodedJsonString(doubled)).toBe('# Role\nYou are a judge "describe this" return —');
	});

	it("decodes a double-encoded multi-line plain-text value", () => {
		expect(repairDoubleEncodedJsonString("line one\\nline two\\nline three")).toBe("line one\nline two\nline three");
	});

	it("preserves a Windows path (bare backslashes are not valid escapes)", () => {
		expect(repairDoubleEncodedJsonString("C:\\Users\\me")).toBe("C:\\Users\\me");
	});

	it("preserves a regex with a backslash class", () => {
		expect(repairDoubleEncodedJsonString("match \\d+ digits")).toBe("match \\d+ digits");
	});

	it("preserves text containing a bare double quote", () => {
		expect(repairDoubleEncodedJsonString('she said "hi" loudly')).toBe('she said "hi" loudly');
	});

	it("leaves a lone literal \\n mention alone (no double-encode signature)", () => {
		expect(repairDoubleEncodedJsonString("split lines on \\n then count")).toBe("split lines on \\n then count");
	});

	it("is a no-op for plain text without escapes", () => {
		const plain = "just some normal instructions";
		expect(repairDoubleEncodedJsonString(plain)).toBe(plain);
	});

	it("leaves a partially-decoded value (real newline mixed with literal escape) untouched", () => {
		// A real newline cannot appear inside a JSON string literal unescaped, so
		// the round-trip parse throws and the value is preserved as-is.
		const mixed = "real\nnewline with \\t tab";
		expect(repairDoubleEncodedJsonString(mixed)).toBe(mixed);
	});
});

describe("repairTaskParams", () => {
	it("repairs context and each task's assignment/description, leaving ids intact", () => {
		const params = {
			agent: "task",
			context: "# Goal\\nDo the thing \\u2014 carefully",
			tasks: [
				{
					id: "FirstTask",
					description: 'judge \\"sketch\\" accuracy',
					assignment: "Score 0-100.\\nUse the full range.\\nNo bunching.",
				},
			],
		} as unknown as TaskParams;

		const repaired = repairTaskParams(params);
		expect(repaired.context).toBe("# Goal\nDo the thing — carefully");
		expect(repaired.tasks[0].id).toBe("FirstTask");
		expect(repaired.tasks[0].description).toBe('judge "sketch" accuracy');
		expect(repaired.tasks[0].assignment).toBe("Score 0-100.\nUse the full range.\nNo bunching.");
	});

	it("returns the same reference when nothing needs repair", () => {
		const params = {
			agent: "task",
			context: "plain context",
			tasks: [{ id: "A", description: "label", assignment: "do work" }],
		} as unknown as TaskParams;
		expect(repairTaskParams(params)).toBe(params);
	});

	it("tolerates partially-streamed args without throwing", () => {
		const partial = { agent: "task", tasks: [{ id: "A" }, undefined] } as unknown as TaskParams;
		expect(() => repairTaskParams(partial)).not.toThrow();
	});
});

import { describe, expect, it } from "bun:test";
import { parseArgs } from "../src/cli/args";

describe("parseArgs — --cwd flag", () => {
	it("parses --cwd with a space-separated directory", () => {
		const result = parseArgs(["--cwd", "/work/project", "hello"]);

		expect(result.cwd).toBe("/work/project");
		expect(result.messages).toEqual(["hello"]);
	});

	it("parses --cwd=value without leaking the value into messages", () => {
		const result = parseArgs(["--cwd=/work/project", "hello"]);

		expect(result.cwd).toBe("/work/project");
		expect(result.messages).toEqual(["hello"]);
	});
});

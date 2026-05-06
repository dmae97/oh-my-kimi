import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveEquivalentPath } from "../src/dirs";

describe("issue #935 path equivalence", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("preserves the lexical project path instead of canonicalizing symlink or junction targets", () => {
		const inputPath = path.resolve("/sessions/link-project");
		const targetPath = path.resolve("/sessions/real-project");
		const realpathSpy = vi.spyOn(fs, "realpathSync").mockImplementation(((p: fs.PathLike) => {
			if (path.resolve(String(p)) === inputPath) return targetPath;
			return path.resolve(String(p));
		}) as typeof fs.realpathSync);

		expect(resolveEquivalentPath(inputPath)).toBe(inputPath);
		expect(realpathSpy).not.toHaveBeenCalled();
	});
});

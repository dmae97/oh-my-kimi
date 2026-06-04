import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectDir, setProjectDir } from "../src/dirs";
import { Snowflake } from "../src/snowflake";
import { getIndentation, setDefaultTabWidth } from "../src/tab-spacing";

describe("spacing", () => {
	let tempDir = "";
	let previousProjectDir = "";

	beforeEach(async () => {
		previousProjectDir = getProjectDir();
		tempDir = path.join(os.tmpdir(), "pi-utils-spacing", Snowflake.next());
		await fs.mkdir(tempDir, { recursive: true });
		setProjectDir(tempDir);
		setDefaultTabWidth(3);
	});

	afterEach(async () => {
		setDefaultTabWidth(3);
		setProjectDir(previousProjectDir);
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("resolves editorconfig rules for file path and falls back to default", async () => {
		const filePath = path.join(tempDir, "src", "feature.ts");
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(
			path.join(tempDir, ".editorconfig"),
			["root = true", "", "[*]", "indent_size = 2", "", "[*.md]", "indent_size = 4"].join("\n"),
		);

		expect(" ".repeat(getIndentation(filePath))).toBe("  ");
		expect(" ".repeat(getIndentation(path.join(tempDir, "README.md")))).toBe("    ");
		expect(" ".repeat(getIndentation(path.join(tempDir, "missing.txt")))).toBe("  ");
	});

	it("merges nested editorconfig files from root to leaf", async () => {
		const nestedDir = path.join(tempDir, "packages", "feature");
		const filePath = path.join(nestedDir, "index.ts");
		await fs.mkdir(nestedDir, { recursive: true });

		await fs.writeFile(path.join(tempDir, ".editorconfig"), ["root = true", "", "[*]", "indent_size = 2"].join("\n"));
		await fs.writeFile(path.join(tempDir, "packages", ".editorconfig"), ["[*.ts]", "indent_size = 6"].join("\n"));

		expect(" ".repeat(getIndentation(filePath))).toBe("      ");
	});

	it("does not throw when the path's segment exceeds NAME_MAX (#1871)", () => {
		// A garbage path segment (e.g. 2KiB of garbage Unicode produced by a
		// hallucinating model) makes `fs.readFileSync` reject with
		// ENAMETOOLONG. The editorconfig probe MUST swallow it and fall back to
		// the default tab width — anything else crashes the TUI mid-render.
		const huge = "a".repeat(2048);
		const phonyPath = path.join(tempDir, huge, "leaf.ts");
		expect(() => getIndentation(phonyPath)).not.toThrow();
		expect(getIndentation(phonyPath)).toBe(3);
	});
});

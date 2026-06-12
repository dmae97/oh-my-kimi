import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils/dirs";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";
import { getEditorConfigFormatting, getIndentation, setDefaultTabWidth } from "@oh-my-pi/pi-utils/tab-spacing";

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

	it("returns the default tab width for paths with an overlong component (no syscall)", () => {
		// Repro of #1872: a malformed edit tool call lands a long gibberish
		// string in `file_path`, the renderer routes it through `replaceTabs ->
		// getIndentation`, and `readFileSync` of `<dir>/.editorconfig` would
		// throw `ENAMETOOLONG`. The path gate must short-circuit before any
		// syscall so renderers never see the exception.
		const longSegment = "amálpthgadasJennzier".repeat(40);
		const overlong = `${longSegment}/inner.ts`;
		expect(Buffer.byteLength(longSegment)).toBeGreaterThan(255);
		expect(() => getIndentation(overlong)).not.toThrow();
		expect(getIndentation(overlong)).toBe(3);
	});

	it("normalizes paths before rejecting overlong components", async () => {
		const longSegment = "amálpthgadasJennzier".repeat(40);
		const noisyPath = path.join(tempDir, longSegment, "..", "src", "feature.ts");
		await fs.writeFile(path.join(tempDir, ".editorconfig"), ["root = true", "", "[*]", "indent_size = 2"].join("\n"));

		expect(Buffer.byteLength(longSegment)).toBeGreaterThan(255);
		expect(" ".repeat(getIndentation(noisyPath))).toBe("  ");
	});

	it("tolerates filesystem errors while walking the editorconfig chain (ENOTDIR)", async () => {
		// Defense in depth: when a non-directory sits where a directory is
		// expected, `parseCachedEditorConfig` previously caught only `ENOENT`
		// and let `ENOTDIR` (and `ENAMETOOLONG`, `EACCES`, `ELOOP`, …)
		// escape. Editorconfig discovery is best-effort and must absorb any
		// `FsError`.
		const notADir = path.join(tempDir, "not-a-dir");
		await fs.writeFile(notADir, "");
		const fakeChild = path.join(notADir, "inner.ts");
		expect(() => getIndentation(fakeChild)).not.toThrow();
		expect(getIndentation(fakeChild)).toBe(3);
	});
});

describe("getEditorConfigFormatting", () => {
	let tempDir = "";
	let previousProjectDir = "";

	beforeEach(async () => {
		previousProjectDir = getProjectDir();
		tempDir = path.join(os.tmpdir(), "pi-utils-editorconfig-formatting", Snowflake.next());
		await fs.mkdir(tempDir, { recursive: true });
		setProjectDir(tempDir);
	});

	afterEach(async () => {
		setProjectDir(previousProjectDir);
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("returns an empty object when no .editorconfig is present", () => {
		expect(getEditorConfigFormatting(path.join(tempDir, "a.yaml"))).toEqual({});
	});

	it("derives tabSize and insertSpaces from `indent_size = <n>` (insertSpaces inferred)", async () => {
		await fs.writeFile(
			path.join(tempDir, ".editorconfig"),
			["root = true", "", "[*]", "indent_size = 2", ""].join("\n"),
		);
		expect(getEditorConfigFormatting(path.join(tempDir, "a.yaml"))).toEqual({
			tabSize: 2,
			insertSpaces: true,
		});
	});

	it("derives insertSpaces=false and tabSize from `indent_style = tab` + `tab_width`", async () => {
		await fs.writeFile(
			path.join(tempDir, ".editorconfig"),
			["root = true", "", "[*]", "indent_style = tab", "tab_width = 4", ""].join("\n"),
		);
		expect(getEditorConfigFormatting(path.join(tempDir, "Makefile"))).toEqual({
			tabSize: 4,
			insertSpaces: false,
		});
	});

	it("treats `indent_size = tab` as tabs", async () => {
		await fs.writeFile(
			path.join(tempDir, ".editorconfig"),
			["root = true", "", "[*]", "indent_size = tab", "tab_width = 8", ""].join("\n"),
		);
		expect(getEditorConfigFormatting(path.join(tempDir, "x.go"))).toEqual({
			tabSize: 8,
			insertSpaces: false,
		});
	});

	it("leaves tabSize undefined when only indent_style = tab is set (no tab_width)", async () => {
		await fs.writeFile(
			path.join(tempDir, ".editorconfig"),
			["root = true", "", "[*]", "indent_style = tab", ""].join("\n"),
		);
		const result = getEditorConfigFormatting(path.join(tempDir, "x.go"));
		expect(result.insertSpaces).toBe(false);
		expect(result.tabSize).toBeUndefined();
	});

	it("returns the deepest section's values when sections overlap", async () => {
		// `[*.md]` should win for markdown files; the more general `[*]` block
		// supplies the indent_style default.
		await fs.writeFile(
			path.join(tempDir, ".editorconfig"),
			["root = true", "", "[*]", "indent_size = 2", "", "[*.md]", "indent_size = 4", ""].join("\n"),
		);
		expect(getEditorConfigFormatting(path.join(tempDir, "README.md")).tabSize).toBe(4);
		expect(getEditorConfigFormatting(path.join(tempDir, "a.yaml")).tabSize).toBe(2);
	});

	it("never throws on null/empty paths or paths with overlong components", () => {
		expect(getEditorConfigFormatting(null)).toEqual({});
		expect(getEditorConfigFormatting("")).toEqual({});
		const overlong = `${"a".repeat(2048)}/leaf.ts`;
		expect(() => getEditorConfigFormatting(overlong)).not.toThrow();
		expect(getEditorConfigFormatting(overlong)).toEqual({});
	});
});

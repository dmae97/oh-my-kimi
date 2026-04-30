import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getDefaultTabWidth, getIndentation, Snowflake, setDefaultTabWidth } from "@oh-my-pi/pi-utils";

describe("indentation resolver", () => {
	let tempDir = "";

	beforeEach(async () => {
		_resetSettingsForTest();
		setDefaultTabWidth(3);
		tempDir = path.join(os.tmpdir(), "pi-spacing", Snowflake.next());
		await fs.mkdir(tempDir, { recursive: true });
	});

	afterEach(async () => {
		_resetSettingsForTest();
		setDefaultTabWidth(3);
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("falls back to hard default when settings are not initialized", () => {
		expect(getDefaultTabWidth()).toBe(3);
		expect(getIndentation()).toBe(3);
	});

	it("uses configured default tab width from settings", async () => {
		const runtimeSettings = await Settings.init({ inMemory: true, cwd: tempDir });
		runtimeSettings.set("display.tabWidth", 5);
		expect(getDefaultTabWidth()).toBe(5);
		expect(getIndentation()).toBe(5);
	});

	it("applies current display tab width during initial settings load", async () => {
		await Settings.init({ inMemory: true, cwd: tempDir, overrides: { "display.tabWidth": 7 } });
		expect(getDefaultTabWidth()).toBe(7);
		expect(getIndentation()).toBe(7);
	});

	it("applies nearest editorconfig rules for the target file", async () => {
		const filePath = path.join(tempDir, "src", "feature.ts");
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, "\tconst x = 1;\n");
		await fs.writeFile(
			path.join(tempDir, ".editorconfig"),
			["root = true", "", "[*]", "indent_size = 2", "", "[*.md]", "indent_size = 4"].join("\n"),
		);

		expect(getIndentation(filePath)).toBe(2);
		expect(getIndentation(path.join(tempDir, "README.md"))).toBe(4);
	});

	it("merges editorconfig files from root to leaf", async () => {
		const nestedDir = path.join(tempDir, "packages", "feature");
		const filePath = path.join(nestedDir, "index.ts");
		await fs.mkdir(nestedDir, { recursive: true });
		await fs.writeFile(filePath, "\tconst y = 2;\n");

		await fs.writeFile(path.join(tempDir, ".editorconfig"), ["root = true", "", "[*]", "indent_size = 2"].join("\n"));
		await fs.writeFile(path.join(tempDir, "packages", ".editorconfig"), ["[*.ts]", "indent_size = 6"].join("\n"));

		expect(getIndentation(filePath)).toBe(6);
	});
});

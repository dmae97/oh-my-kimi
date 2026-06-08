import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RenderResultOptions } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { getThemeByName, initTheme, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { findToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/find";
import {
	expandDelimitedPathEntries,
	parseFindPattern,
	splitDelimitedPathEntry,
} from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import type { Component } from "@oh-my-pi/pi-tui";

let uiTheme: Theme;

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "dark", "light");
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("Missing dark theme");
	uiTheme = theme;
});
const renderOptions: RenderResultOptions = {
	expanded: false,
	isPartial: true,
};

function renderText(component: Component): string {
	return Bun.stripANSI(component.render(160).join("\n"));
}

describe("delimited path expansion", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "delimited-paths-"));
		await fs.mkdir(path.join(tempDir, "apps"), { recursive: true });
		await fs.mkdir(path.join(tempDir, "packages"), { recursive: true });
		await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
		await fs.mkdir(path.join(tempDir, "folder with spaces"), { recursive: true });
		await Bun.write(path.join(tempDir, "apps", "a.txt"), "apps\n");
		await Bun.write(path.join(tempDir, "packages", "b.txt"), "packages\n");
		await Bun.write(path.join(tempDir, "folder with spaces", "file.txt"), "spaces\n");
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("splits comma, semicolon, and space delimited entries when parts resolve", async () => {
		expect(await splitDelimitedPathEntry("apps/a.txt, packages/b.txt", tempDir)).toEqual([
			"apps/a.txt",
			"packages/b.txt",
		]);
		expect(await splitDelimitedPathEntry("apps/a.txt;packages/b.txt", tempDir)).toEqual([
			"apps/a.txt",
			"packages/b.txt",
		]);
		expect(await splitDelimitedPathEntry("apps/a.txt packages/b.txt", tempDir)).toEqual([
			"apps/a.txt",
			"packages/b.txt",
		]);
	});

	it("keeps an existing path with spaces intact", async () => {
		expect(await splitDelimitedPathEntry("folder with spaces/file.txt", tempDir)).toBeNull();
		expect(await expandDelimitedPathEntries(["folder with spaces/file.txt"], tempDir)).toEqual([
			"folder with spaces/file.txt",
		]);
	});

	it("does not split commas inside brace globs", async () => {
		expect(await splitDelimitedPathEntry("src/{a,b}.txt", tempDir)).toBeNull();
		expect(await splitDelimitedPathEntry("src/{a,b}.txt, packages/b.txt", tempDir)).toEqual([
			"src/{a,b}.txt",
			"packages/b.txt",
		]);
	});

	it("does not split backslash-escaped delimiters", async () => {
		expect(await splitDelimitedPathEntry("apps/a.txt\\,packages/b.txt", tempDir)).toBeNull();
		expect(await splitDelimitedPathEntry("apps/a.txt\\;packages/b.txt", tempDir)).toBeNull();
		expect(await splitDelimitedPathEntry("folder\\ with\\ spaces/file.txt packages/b.txt", tempDir)).toBeNull();
	});

	it("uses strong delimiters leniently and whitespace delimiters conservatively", async () => {
		expect(await splitDelimitedPathEntry("missing.txt, packages/b.txt", tempDir)).toEqual([
			"missing.txt",
			"packages/b.txt",
		]);
		expect(await splitDelimitedPathEntry("missing.txt;packages/b.txt", tempDir)).toEqual([
			"missing.txt",
			"packages/b.txt",
		]);
		expect(await splitDelimitedPathEntry("missing.txt packages/b.txt", tempDir)).toBeNull();
	});

	it("cleans trailing strong delimiters and expands glob entries", async () => {
		expect(await expandDelimitedPathEntries(["apps/a.txt,"], tempDir)).toEqual(["apps/a.txt"]);
		expect(
			await expandDelimitedPathEntries(["apps/**/*.txt, packages/**/*.txt"], tempDir, {
				splitter: parseFindPattern,
			}),
		).toEqual(["apps/**/*.txt", "packages/**/*.txt"]);
	});
});

describe("findToolRenderer", () => {
	it("accepts a single string paths value before validation", async () => {
		const args = { paths: "src/**/*.ts" };
		const renderings = [
			findToolRenderer.renderCall(args, renderOptions, uiTheme),
			findToolRenderer.renderResult(
				{ content: [{ type: "text", text: "src/index.ts\n" }] },
				renderOptions,
				uiTheme,
				args,
			),
			findToolRenderer.renderResult(
				{ content: [{ type: "text", text: "" }], details: { fileCount: 0, files: [] } },
				renderOptions,
				uiTheme,
				args,
			),
			findToolRenderer.renderResult(
				{ content: [{ type: "text", text: "src/index.ts" }], details: { fileCount: 1, files: ["src/index.ts"] } },
				renderOptions,
				uiTheme,
				args,
			),
		];

		for (const component of renderings) {
			expect(renderText(component)).toContain("src/**/*.ts");
		}
	});
});

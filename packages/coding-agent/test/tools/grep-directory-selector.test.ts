import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

describe("grep explicit line selector on directory searches", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-directory-selector-"));
	});

	afterEach(async () => {
		await removeWithRetries(testDir);
	});

	function createSession(): ToolSession {
		return {
			cwd: testDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "grep.contextBefore": 0, "grep.contextAfter": 0 }),
		};
	}

	it("filters matches by per-file line number instead of rejecting the directory", async () => {
		const appDir = path.join(testDir, "scripts", "app");
		await fs.mkdir(appDir, { recursive: true });
		await Bun.write(path.join(appDir, "one.ts"), "outside one\ninside one\noutside one again\n");
		await Bun.write(path.join(appDir, "two.ts"), "outside two\ninside two\noutside two again\n");

		const result = await new GrepTool(createSession()).execute("grep-directory-selector", {
			pattern: "inside|outside",
			path: "scripts/app",
			selector: "2-2",
		});

		const text = resultText(result);
		expect(text).toContain("inside one");
		expect(text).toContain("inside two");
		expect(text).not.toContain("outside one");
		expect(text).not.toContain("outside two");
		expect(text).not.toContain("Line-range selector requires a single file");
	});

	it("fetches enough directory matches before applying an explicit later line selector", async () => {
		const appDir = path.join(testDir, "scripts", "hot");
		await fs.mkdir(appDir, { recursive: true });
		const content = `${Array.from(
			{ length: 30 },
			(_, index) => `cap-needle line ${String(index + 1).padStart(2, "0")}`,
		).join("\n")}\n`;
		await Bun.write(path.join(appDir, "many.ts"), content);

		const result = await new GrepTool(createSession()).execute("grep-directory-selector-cap", {
			pattern: "cap-needle",
			path: "scripts/hot",
			selector: "25-25",
		});

		const text = resultText(result);
		expect(text).toContain("cap-needle line 25");
		expect(text).not.toContain("cap-needle line 24");
		expect(text).not.toContain("cap-needle line 26");
	});

	it("supports open-ended selectors on directories with a finite fetch budget", async () => {
		const appDir = path.join(testDir, "scripts", "tail");
		await fs.mkdir(appDir, { recursive: true });
		const content = `${Array.from(
			{ length: 60 },
			(_, index) => `open-needle line ${String(index + 1).padStart(2, "0")}`,
		).join("\n")}\n`;
		await Bun.write(path.join(appDir, "long.ts"), content);

		const result = await new GrepTool(createSession()).execute("grep-directory-selector-open", {
			pattern: "open-needle",
			path: "scripts/tail",
			selector: "35-",
		});

		const text = resultText(result);
		expect(text).toContain("open-needle line 35");
		expect(text).not.toContain("open-needle line 34");
		expect(text).not.toContain("Line-range selector requires a single file");
	});
});

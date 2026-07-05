import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		settings: Settings.isolated({
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bash.autoBackground.thresholdMs": 60_000,
			"bashInterceptor.enabled": false,
			"astGrep.enabled": true,
			"astEdit.enabled": true,
			"grep.enabled": true,
			"glob.enabled": true,
			"edit.mode": "patch",
			readLineNumbers: true,
		}),
		getClientBridge: () => undefined,
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

function expectAlternationGuidance(description: string, goodPattern: string, escapedPattern: string): void {
	expect(description).toContain(goodPattern);
	expect(description).toContain(escapedPattern);
	const goodIndex = description.indexOf(goodPattern);
	const escapedIndex = description.indexOf(escapedPattern);
	const start = Math.max(0, Math.min(goodIndex, escapedIndex) - 160);
	const end = Math.min(description.length, Math.max(goodIndex, escapedIndex) + escapedPattern.length + 160);
	const localGuidance = description.slice(start, end);
	expect(localGuidance).toMatch(/\b(?:not|avoid|rather than|instead of|don't|do not)\b/i);
}
function expectEscapedBreWarning(description: string, escapedToken: string): void {
	expect(description).toContain(escapedToken);
	const tokenIndex = description.indexOf(escapedToken);
	const localGuidance = description.slice(Math.max(0, tokenIndex - 120), tokenIndex + escapedToken.length + 120);
	expect(localGuidance).toMatch(/\b(?:not|avoid|rather than|instead of|don't|do not|not guaranteed)\b/i);
}

describe("tool regex guidance", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
	});

	it("advertises Rust-style alternation for the built-in grep pattern", () => {
		const description = new GrepTool(makeSession("/tmp")).description;

		expect(description).toContain("Rust");
		expect(description).toContain("RE2");
		expectAlternationGuidance(description, "foo|bar", String.raw`foo\|bar`);
		expect(description).toContain(String.raw`\bword\b`);
	});

	it("advertises grep -E for shell commands that need alternation", () => {
		const description = new BashTool(makeSession("/tmp")).description;

		expect(description).toContain("grep -E 'json|tool'");
		expectEscapedBreWarning(description, String.raw`\|`);
	});

	it("runs an extended-grep command through BashTool", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bash-grep-guidance-"));
		tempDirs.push(cwd);
		await Bun.write(path.join(cwd, "fixture.txt"), "json contract\ntool description\nignored line\njson later\n");

		const result = await new BashTool(makeSession(cwd)).execute("grep-e-command", {
			command: "grep -E 'json|tool' fixture.txt",
		});

		expect(result.isError).toBeUndefined();
		const output = textOf(result);
		expect(output).toContain("json contract");
		expect(output).toContain("tool description");
		expect(output).toContain("json later");
		expect(output).not.toContain("ignored line");
	});
});

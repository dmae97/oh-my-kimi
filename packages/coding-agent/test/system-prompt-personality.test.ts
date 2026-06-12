import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Personality } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

describe("system prompt personality block", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-personality-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-personality-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	async function render(personality?: Personality): Promise<string> {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			personality,
		});
		return systemPrompt.join("\n\n");
	}

	it("injects the default personality when the option is unset", async () => {
		const rendered = await render();
		expect(rendered).toContain("<personality>");
		expect(rendered).toContain("</personality>");
		expect(rendered).toContain("terse, evidence-first engineer");
	});

	it("replaces the default spec when a non-default personality is selected", async () => {
		const rendered = await render("friendly");
		expect(rendered).toContain("<personality>");
		expect(rendered).toContain("warm, supportive collaborator");
		expect(rendered).not.toContain("terse, evidence-first engineer");
	});

	it('omits the personality block entirely for "none"', async () => {
		const rendered = await render("none");
		expect(rendered).not.toContain("<personality>");
		expect(rendered).not.toContain("</personality>");
	});
});

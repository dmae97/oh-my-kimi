import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "open-multi-agent-kit";
import { describe, expect, it, vi } from "vitest";
import bookToSkillExtension, { createCompilePrompt, createUpdatePrompt } from "../src/extension.ts";
import { COMPILER_IDENTITY } from "../src/metadata.ts";
import { recordProvenance } from "../src/provenance.ts";

type CommandOptions = {
	description?: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
};

function extensionHarness() {
	const commands = new Map<string, CommandOptions>();
	const sendUserMessage = vi.fn();
	const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "scan passed", stderr: "" });
	const api = {
		registerCommand(name: string, options: CommandOptions) {
			commands.set(name, options);
		},
		sendUserMessage,
		exec,
	} as unknown as ExtensionAPI;
	bookToSkillExtension(api);
	return { commands, exec, sendUserMessage };
}

function commandContext(idle = true): ExtensionCommandContext {
	return {
		cwd: "/workspace",
		hasUI: true,
		isIdle: () => idle,
		ui: { notify: vi.fn() },
	} as unknown as ExtensionCommandContext;
}

describe("book-to-skill OMK adapter", () => {
	it("registers explicit compile, update, and verify commands", () => {
		const { commands } = extensionHarness();
		expect([...commands.keys()]).toEqual(["book-to-skill-compile", "book-to-skill-update", "book-to-skill-verify"]);
	});

	it("dispatches compile through the bundled skill without interpreting user arguments", async () => {
		const { commands, sendUserMessage } = extensionHarness();
		const command = commands.get("book-to-skill-compile");
		if (!command) throw new Error("compile command was not registered");

		await command.handler('./docs/book.pdf --name "systems-book"', commandContext());

		expect(sendUserMessage).toHaveBeenCalledOnce();
		const prompt = sendUserMessage.mock.calls[0]?.[0];
		expect(prompt).toContain("Mode: Full Conversion");
		expect(prompt).toContain("skills/book-to-skill/SKILL.md");
		expect(prompt).toContain(JSON.stringify('./docs/book.pdf --name "systems-book"'));
	});

	it("keeps update mode distinct and refuses to queue work while the agent is busy", async () => {
		const { commands, sendUserMessage } = extensionHarness();
		const command = commands.get("book-to-skill-update");
		if (!command) throw new Error("update command was not registered");
		const ctx = commandContext(false);

		await command.handler("./skills/systems-book ./docs/appendix.pdf", ctx);

		expect(sendUserMessage).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith("Agent is busy; retry when the current turn finishes.", "warning");
	});

	it("runs local artifact verification and the pinned advisory scanner", async () => {
		const root = mkdtempSync(join(tmpdir(), "omk-book-to-skill-extension-"));
		const skillDir = join(root, "compiled");
		const source = join(root, "source.md");
		mkdirSync(skillDir);
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: compiled\ndescription: Test.\n---\n");
		writeFileSync(source, "source\n");
		try {
			recordProvenance({ compiler: COMPILER_IDENTITY, skillDir, sources: [source] });
			const { commands, exec } = extensionHarness();
			const command = commands.get("book-to-skill-verify");
			if (!command) throw new Error("verify command was not registered");
			const ctx = commandContext();

			await command.handler(skillDir, ctx);

			expect(exec).toHaveBeenCalledWith(
				"python3",
				expect.arrayContaining([skillDir]),
				expect.objectContaining({ timeout: 120_000 }),
			);
			expect(ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("Artifact integrity and advisory scan passed"),
				"info",
			);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	});

	it("builds mode prompts with fixed instructions and JSON-encoded argument data", () => {
		const skillPath = "/pkg/skills/book-to-skill/SKILL.md";
		expect(createCompilePrompt("a.pdf", skillPath)).toContain('User arguments: "a.pdf"');
		expect(createUpdatePrompt("old-skill new.pdf", skillPath)).toContain("Mode: Update / Fold-in");
	});
});

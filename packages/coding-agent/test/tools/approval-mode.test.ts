import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";

const BASE_SETTINGS = {
	"async.enabled": false,
	"bash.autoBackground.enabled": false,
	"bashInterceptor.enabled": false,
} as const;

async function makeSession(extraSettings: Record<string, unknown> = {}) {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-approval-mode-${Snowflake.next()}-`));
	const cwd = path.join(tempDir, "cwd");
	fs.mkdirSync(cwd, { recursive: true });
	const sessionManager = SessionManager.create(cwd, path.join(tempDir, "sessions"));
	const settings = Settings.isolated({ ...BASE_SETTINGS, ...extraSettings });
	const { session } = await createAgentSession({
		cwd,
		agentDir: tempDir,
		sessionManager,
		settings,
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		toolNames: ["bash"],
	});
	return { tempDir, session, settings };
}

function textOf(result: { content?: ReadonlyArray<{ type: string; text?: string }> }): string {
	const blocks = result.content ?? [];
	for (const block of blocks) {
		if (block.type === "text" && typeof block.text === "string") return block.text;
	}
	return "";
}

describe("tools.approvalMode setting", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("auto mode (default) bypasses approval", async () => {
		const { tempDir, session, settings } = await makeSession();
		tempDirs.push(tempDir);
		try {
			const bash = session.getToolByName("bash");
			if (!bash) throw new Error("Expected bash tool");
			const result = await bash.execute("auto", { command: "echo ok" }, undefined, undefined, {
				settings,
			} as AgentToolContext);
			expect(textOf(result)).toContain("ok");
		} finally {
			await session.dispose();
		}
	});

	it("prompt mode rejects destructive tools when no UI is available", async () => {
		const { tempDir, session, settings } = await makeSession({
			"tools.approvalMode": "prompt",
		});
		tempDirs.push(tempDir);
		try {
			const bash = session.getToolByName("bash");
			if (!bash) throw new Error("Expected bash tool");
			await expect(
				bash.execute("prompt", { command: "echo blocked" }, undefined, undefined, {
					settings,
				} as AgentToolContext),
			).rejects.toThrow(/requires approval but no interactive UI available/);
		} finally {
			await session.dispose();
		}
	});

	it("prompt mode ignores tools.approval.<tool>: allow overrides", async () => {
		const { tempDir, session, settings } = await makeSession({
			"tools.approvalMode": "prompt",
			"tools.approval": { bash: "allow" },
		});
		tempDirs.push(tempDir);
		try {
			const bash = session.getToolByName("bash");
			if (!bash) throw new Error("Expected bash tool");
			await expect(
				bash.execute("prompt-with-allow", { command: "echo still-blocked" }, undefined, undefined, {
					settings,
				} as AgentToolContext),
			).rejects.toThrow(/requires approval but no interactive UI available/);
		} finally {
			await session.dispose();
		}
	});

	it("custom mode honours tools.approval.<tool>: allow overrides", async () => {
		const { tempDir, session, settings } = await makeSession({
			"tools.approvalMode": "custom",
			"tools.approval": { bash: "allow" },
		});
		tempDirs.push(tempDir);
		try {
			const bash = session.getToolByName("bash");
			if (!bash) throw new Error("Expected bash tool");
			const result = await bash.execute("custom-allow", { command: "echo custom" }, undefined, undefined, {
				settings,
			} as AgentToolContext);
			expect(textOf(result)).toContain("custom");
		} finally {
			await session.dispose();
		}
	});

	it("custom mode falls back to built-in defaults for unconfigured tools", async () => {
		const { tempDir, session, settings } = await makeSession({
			"tools.approvalMode": "custom",
			// Empty config — bash should fall back to built-in "prompt".
			"tools.approval": {},
		});
		tempDirs.push(tempDir);
		try {
			const bash = session.getToolByName("bash");
			if (!bash) throw new Error("Expected bash tool");
			await expect(
				bash.execute("custom-default", { command: "echo unconfigured" }, undefined, undefined, {
					settings,
				} as AgentToolContext),
			).rejects.toThrow(/requires approval but no interactive UI available/);
		} finally {
			await session.dispose();
		}
	});

	it("custom mode keeps critical bash patterns prompting even when bash is user-allowed", async () => {
		const { tempDir, session, settings } = await makeSession({
			"tools.approvalMode": "custom",
			"tools.approval": { bash: "allow" },
		});
		tempDirs.push(tempDir);
		try {
			const bash = session.getToolByName("bash");
			if (!bash) throw new Error("Expected bash tool");
			await expect(
				bash.execute("critical", { command: "rm -rf /" }, undefined, undefined, {
					settings,
				} as AgentToolContext),
			).rejects.toThrow(/requires approval but no interactive UI available/);
		} finally {
			await session.dispose();
		}
	});

	it("CLI --auto-approve wins over mode=prompt", async () => {
		const { tempDir, session, settings } = await makeSession({
			"tools.approvalMode": "prompt",
		});
		tempDirs.push(tempDir);
		try {
			const bash = session.getToolByName("bash");
			if (!bash) throw new Error("Expected bash tool");
			const result = await bash.execute("cli-override", { command: "echo override" }, undefined, undefined, {
				settings,
				autoApprove: true,
			} as AgentToolContext);
			expect(textOf(result)).toContain("override");
		} finally {
			await session.dispose();
		}
	});
});

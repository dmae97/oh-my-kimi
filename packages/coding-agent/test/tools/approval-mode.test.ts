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

function emptyWorkspaceTree(cwd: string) {
	return { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] };
}

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
		workspaceTree: emptyWorkspaceTree(cwd),
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

	afterEach(async () => {
		for (const tempDir of tempDirs.splice(0)) {
			// Windows can briefly hold tempdir handles after session.dispose(); retry a few times.
			for (let attempt = 0; attempt < 5; attempt++) {
				try {
					fs.rmSync(tempDir, { recursive: true, force: true });
					break;
				} catch (err) {
					const code = (err as NodeJS.ErrnoException).code;
					if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM") throw err;
					if (attempt === 4) break; // best-effort: OS will reclaim
					await Bun.sleep(50 * (attempt + 1));
				}
			}
		}
	});

	it("yolo mode (default) bypasses approval for non-overriding tool calls", async () => {
		const { tempDir, session, settings } = await makeSession();
		tempDirs.push(tempDir);
		try {
			const bash = session.getToolByName("bash");
			if (!bash) throw new Error("Expected bash tool");
			const result = await bash.execute("yolo", { command: "echo ok" }, undefined, undefined, {
				settings,
			} as AgentToolContext);
			expect(textOf(result)).toContain("ok");
		} finally {
			await session.dispose();
		}
	});

	it("always-ask mode rejects exec tools when no UI is available", async () => {
		const { tempDir, session, settings } = await makeSession({
			"tools.approvalMode": "always-ask",
		});
		tempDirs.push(tempDir);
		try {
			const bash = session.getToolByName("bash");
			if (!bash) throw new Error("Expected bash tool");
			await expect(
				bash.execute("always-ask", { command: "echo blocked" }, undefined, undefined, {
					settings,
				} as AgentToolContext),
			).rejects.toThrow(/requires approval but no interactive UI available/);
		} finally {
			await session.dispose();
		}
	});

	it("per-tool allow overrides are honored in every mode", async () => {
		const { tempDir, session, settings } = await makeSession({
			"tools.approvalMode": "always-ask",
			"tools.approval": { bash: "allow" },
		});
		tempDirs.push(tempDir);
		try {
			const bash = session.getToolByName("bash");
			if (!bash) throw new Error("Expected bash tool");
			const result = await bash.execute("always-ask-allow", { command: "echo allowed" }, undefined, undefined, {
				settings,
			} as AgentToolContext);
			expect(textOf(result)).toContain("allowed");
		} finally {
			await session.dispose();
		}
	});

	it("per-tool prompt overrides can tighten yolo mode", async () => {
		const { tempDir, session, settings } = await makeSession({
			"tools.approvalMode": "yolo",
			"tools.approval": { bash: "prompt" },
		});
		tempDirs.push(tempDir);
		try {
			const bash = session.getToolByName("bash");
			if (!bash) throw new Error("Expected bash tool");
			await expect(
				bash.execute("yolo-prompt", { command: "echo blocked" }, undefined, undefined, {
					settings,
				} as AgentToolContext),
			).rejects.toThrow(/requires approval but no interactive UI available/);
		} finally {
			await session.dispose();
		}
	});

	it("write mode still prompts exec-tier tools", async () => {
		const { tempDir, session, settings } = await makeSession({
			"tools.approvalMode": "write",
			"tools.approval": {},
		});
		tempDirs.push(tempDir);
		try {
			const bash = session.getToolByName("bash");
			if (!bash) throw new Error("Expected bash tool");
			await expect(
				bash.execute("write-mode", { command: "echo unconfigured" }, undefined, undefined, {
					settings,
				} as AgentToolContext),
			).rejects.toThrow(/requires approval but no interactive UI available/);
		} finally {
			await session.dispose();
		}
	});

	it("critical bash patterns do not prompt in yolo mode with bash allowed", async () => {
		const { tempDir, session, settings } = await makeSession({
			"tools.approvalMode": "yolo",
			"tools.approval": { bash: "allow" },
		});
		tempDirs.push(tempDir);
		try {
			const bash = session.getToolByName("bash");
			if (!bash) throw new Error("Expected bash tool");

			const result = await bash.execute(
				"critical",
				{ command: "rm -f /tmp/bun-fake-timer-probe.test.ts" },
				undefined,
				undefined,
				{
					settings,
				} as AgentToolContext,
			);
			expect(textOf(result)).toContain("(no output)");
		} finally {
			await session.dispose();
		}
	});

	it("CLI --auto-approve forces yolo mode for non-overriding tool calls", async () => {
		const { tempDir, session, settings } = await makeSession({
			"tools.approvalMode": "always-ask",
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

	it("CLI --auto-approve also bypasses safety-override patterns", async () => {
		const { tempDir, session, settings } = await makeSession({
			"tools.approvalMode": "always-ask",
		});
		tempDirs.push(tempDir);
		try {
			const bash = session.getToolByName("bash");
			if (!bash) throw new Error("Expected bash tool");
			const result = await bash.execute(
				"cli-critical",
				{ command: "rm -f /tmp/bun-fake-timer-probe.test.ts" },
				undefined,
				undefined,
				{
					settings,
					autoApprove: true,
				} as AgentToolContext,
			);
			expect(textOf(result)).toContain("(no output)");
		} finally {
			await session.dispose();
		}
	});

	it("constructs an extensionRunner unconditionally so the approval gate is always installed", async () => {
		// Regression lock for the architectural fix: the per-tool approval gate is implemented
		// inside `ExtensionToolWrapper`, which is only attached when `session.extensionRunner` exists.
		// Historically the runner was conditional on `extensionsResult.extensions.length > 0`, which
		// meant the entire approval system silently disappeared for users with no extensions loaded —
		// any non-yolo approval mode setting would be a no-op without feedback. The
		// fix is to construct the runner unconditionally; this test makes that contract explicit so
		// a future change to make the runner optional again cannot silently re-open the hole.
		const { tempDir, session } = await makeSession();
		tempDirs.push(tempDir);
		try {
			expect(session.extensionRunner).toBeDefined();
		} finally {
			await session.dispose();
		}
	});
});

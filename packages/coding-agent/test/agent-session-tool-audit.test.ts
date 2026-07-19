import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "omk-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * ALG004-A/B/E: timeout and late-settlement policies must persist durable
 * `tool_timeout` / `tool_late_settlement` audit events through the production
 * AgentSession run journal; a late completion never replaces the committed
 * terminal result; a late potentially-writing tool raises session risk and
 * emits a workspace mutation/invalidation signal consumable by evidence
 * freshness.
 */
describe("AgentSession tool timeout / late-settlement audit (ALG004-A/B)", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	let sessionDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `omk-tool-audit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		sessionDir = join(tempDir, "sessions");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function createSessionWithLateTool(toolName: string) {
		// Per-name timeout of 30ms for the late tool; everything else default.
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ agent: { toolTimeouts: { [toolName]: 30 } } }));

		const faux = registerFauxProvider();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(toolName, {}, { id: "call-late" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const result = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			model: faux.getModel(),
			sessionManager: SessionManager.create(cwd, sessionDir),
			settingsManager: SettingsManager.create(cwd, agentDir),
			customTools: [
				{
					name: toolName,
					label: toolName,
					description: "settles ~60ms after its 30ms timeout",
					parameters: Type.Object({}),
					async execute() {
						// Ignores the abort signal on purpose; settles late.
						await new Promise((resolve) => setTimeout(resolve, 90));
						return { content: [{ type: "text" as const, text: "late success" }], details: {} };
					},
				},
			],
		});
		return result.session;
	}

	it("persists tool_timeout and tool_late_settlement audits, raises risk, and emits a workspace mutation signal", async () => {
		const session = await createSessionWithLateTool("deploy_writer");
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => void events.push(event));

		expect(session.sessionRiskLevel).toBe("normal");
		expect(session.workspaceMutationCount).toBe(0);

		await session.prompt("run the late tool");
		await session.agent.waitForIdle();
		// Give the late settlement (~90ms) time to land and be audited.
		await new Promise((resolve) => setTimeout(resolve, 150));

		// Durable audit records flow through the production run journal.
		const journalEvents = session.runJournalRecords.map((record) => record.event);
		expect(journalEvents).toContain("tool_timeout");
		expect(journalEvents).toContain("tool_late_settlement");

		const timeoutRecord = session.runJournalRecords.find((record) => record.event === "tool_timeout");
		expect(timeoutRecord).toMatchObject({
			details: { toolCallId: "call-late", toolName: "deploy_writer", timeoutMs: 30, executionStarted: true },
		});
		const lateRecord = session.runJournalRecords.find((record) => record.event === "tool_late_settlement");
		expect(lateRecord).toMatchObject({
			details: {
				toolCallId: "call-late",
				toolName: "deploy_writer",
				disposition: "timeout",
				outcome: "resolved",
				sessionRisk: "elevated",
			},
		});

		// The journal is durable on disk next to the session file.
		const sessionFile = session.sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const journalFile = `${sessionFile}.runjournal`;
		expect(existsSync(journalFile)).toBe(true);
		const journalText = readFileSync(journalFile, "utf8");
		expect(journalText).toContain("tool_timeout");
		expect(journalText).toContain("tool_late_settlement");

		// Late potentially-writing tool raises session risk and emits the
		// workspace mutation/invalidation signal for evidence freshness.
		expect(session.sessionRiskLevel).toBe("elevated");
		expect(session.workspaceMutationCount).toBe(1);
		const mutation = events.find((event) => event.type === "workspace_mutation");
		expect(mutation).toMatchObject({
			type: "workspace_mutation",
			source: "tool_late_settlement",
			toolCallId: "call-late",
			toolName: "deploy_writer",
			payload: { root: cwd, paths: [] },
		});

		// The committed terminal result was never replaced by the late completion.
		const terminal = session.agent.state.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "call-late",
		);
		expect(terminal).toBeDefined();
		if (terminal?.role === "toolResult") {
			expect(terminal.isError).toBe(true);
			expect(terminal.content).toEqual([
				{ type: "text", text: 'Tool "deploy_writer" timed out after 30ms and was terminated.' },
			]);
			expect(terminal.details).toMatchObject({
				omk: { schema: "tool-result/v2", synthetic: true, disposition: "timeout", executionStarted: true },
			});
		}
		session.dispose();
	});

	it("audits a late read-category settlement without raising risk or mutating workspace state", async () => {
		const session = await createSessionWithLateTool("search");
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => void events.push(event));

		await session.prompt("run the late read tool");
		await session.agent.waitForIdle();
		await new Promise((resolve) => setTimeout(resolve, 150));

		const journalEvents = session.runJournalRecords.map((record) => record.event);
		expect(journalEvents).toContain("tool_timeout");
		expect(journalEvents).toContain("tool_late_settlement");

		// Read-only late settlement is audit-only: no risk raise, no mutation signal.
		expect(session.sessionRiskLevel).toBe("normal");
		expect(session.workspaceMutationCount).toBe(0);
		expect(events.some((event) => event.type === "workspace_mutation")).toBe(false);
		const lateRecord = session.runJournalRecords.find((record) => record.event === "tool_late_settlement");
		expect(lateRecord).toMatchObject({
			details: { toolCallId: "call-late", toolName: "search", disposition: "timeout", outcome: "resolved" },
		});
		expect(lateRecord?.event === "tool_late_settlement" ? lateRecord.details.sessionRisk : undefined).toBeUndefined();
		session.dispose();
	});
});

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getModel } from "omk-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { ReplayLedgerManager } from "../src/guardrails/evidence-system.ts";

describe("createAgentSession session manager defaults", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses agentDir for the default persisted session path", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected test model");

		const { session } = await createAgentSession({ cwd, agentDir, model });

		const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		const expectedSessionDir = join(agentDir, "sessions", safePath);
		const sessionDir = session.sessionManager.getSessionDir();
		const sessionFile = session.sessionManager.getSessionFile();

		expect(sessionDir).toBe(expectedSessionDir);
		expect(sessionFile?.startsWith(`${expectedSessionDir}/`)).toBe(true);

		session.dispose();
	});

	it("persists transcript repair evidence in the default deterministic replay sidecar", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected test model");
		const secretMessageBody = "session-body-secret-must-not-enter-replay";

		const { session: author } = await createAgentSession({ cwd, agentDir, model });
		author.sessionManager.appendMessage({ role: "user", content: secretMessageBody, timestamp: Date.now() });
		author.sessionManager.appendMessage(
			fauxAssistantMessage([fauxToolCall("read", { path: "artifact.txt" }, { id: "call-default-repair" })], {
				stopReason: "toolUse",
			}),
		);
		const sessionFile = author.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("expected default persisted session file");
		const sessionId = author.sessionManager.getSessionId();
		author.dispose();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			sessionManager: SessionManager.open(sessionFile),
		});
		const replayPath = `${sessionFile}.replay.jsonl`;
		const events = new ReplayLedgerManager(sessionId, replayPath).getEvents();

		expect(events.map((event) => event.type)).toEqual(["transcript_repaired"]);
		expect(events[0]?.goalId).toBe(sessionId);
		expect(events[0]?.goalId).toMatch(/^[A-Za-z0-9._-]+$/);
		expect(readFileSync(replayPath, "utf8")).not.toContain(secretMessageBody);
		session.dispose();
	});

	it("fails closed when the default replay sidecar is tampered before resume", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected test model");
		const sessionManager = SessionManager.create(cwd, join(tempDir, "sessions"));
		sessionManager.appendMessage({ role: "user", content: "persist before resume", timestamp: Date.now() });
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("expected persisted session file");
		const replayPath = `${sessionFile}.replay.jsonl`;
		const ledger = new ReplayLedgerManager(sessionManager.getSessionId(), replayPath);
		ledger.append({
			type: "tool_timeout",
			goalId: sessionManager.getSessionId(),
			payload: { toolCallId: "call-1", toolName: "read", timeoutMs: 1, executionStarted: true },
		});
		ledger.persist();
		writeFileSync(replayPath, readFileSync(replayPath, "utf8").replace("call-1", "call-tampered"));

		await expect(
			createAgentSession({ cwd, agentDir, model, sessionManager: SessionManager.open(sessionFile) }),
		).rejects.toThrow("Replay ledger corrupted at line 1: invalid JSON");
	});

	it("does not create a replay sidecar for an in-memory session repair", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected test model");
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.appendMessage({ role: "user", content: "repair in memory", timestamp: Date.now() });
		sessionManager.appendMessage(
			fauxAssistantMessage([fauxToolCall("read", {}, { id: "call-memory" })], { stopReason: "toolUse" }),
		);

		const { session } = await createAgentSession({ cwd, agentDir, model, sessionManager });

		expect(session.transcriptRepair?.insertedToolCallIds).toEqual(["call-memory"]);
		expect(
			readdirSync(tempDir, { recursive: true }).filter((path) => String(path).endsWith(".replay.jsonl")),
		).toEqual([]);
		session.dispose();
	});

	it("keeps an explicit sessionManager override", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected test model");

		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({ cwd, agentDir, model, sessionManager });

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.sessionManager.isPersisted()).toBe(false);

		session.dispose();
	});

	it("derives cwd from an explicit sessionManager when cwd is omitted", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected test model");

		const sessionCwd = join(tempDir, "session-project");
		mkdirSync(sessionCwd, { recursive: true });
		const sessionManager = SessionManager.inMemory(sessionCwd);
		const { session } = await createAgentSession({ agentDir, model, sessionManager });

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.systemPrompt).toContain(`Current working directory: ${sessionCwd}`);

		const bashTool = session.agent.state.tools.find((tool) => tool.name === "bash");
		if (!bashTool) throw new Error("expected bash tool");
		const result = await bashTool.execute("test", { command: "pwd" });
		const output = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");

		expect(realpathSync(output.trim())).toBe(realpathSync(sessionCwd));

		session.dispose();
	});
});

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultMessage } from "omk-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "omk-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SessionTerminationError } from "../src/core/session-termination.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * ALG001-A: the live session open/resume path must inspect the transcript,
 * auto-repair unambiguous missing-only tool results idempotently (with the
 * tool-result/v2 envelope and a durable transcript_repaired audit), and fail
 * closed with a durable corruption mark for ambiguous corruption.
 */
describe("live session open/resume transcript repair (ALG001-A)", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	let sessionDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `omk-resume-repair-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

	function authorDanglingSession(): string {
		const author = SessionManager.create(cwd, sessionDir);
		author.appendMessage({ role: "user", content: "please read a file", timestamp: Date.now() });
		author.appendMessage(
			fauxAssistantMessage([fauxToolCall("read", { path: "a.ts" }, { id: "call-dangling" })], {
				stopReason: "toolUse",
			}),
		);
		const file = author.getSessionFile();
		if (!file) throw new Error("expected a persisted session file");
		return file;
	}

	async function openSession(sessionFile: string) {
		const faux = registerFauxProvider();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		return createAgentSession({
			cwd,
			agentDir,
			authStorage,
			model: faux.getModel(),
			sessionManager: SessionManager.open(sessionFile, sessionDir),
			settingsManager: SettingsManager.create(cwd, agentDir),
		});
	}

	it("auto-repairs a missing-only tool result on open, durably and idempotently", async () => {
		const sessionFile = authorDanglingSession();

		const { session } = await openSession(sessionFile);
		const messages = session.agent.state.messages;
		const last = messages[messages.length - 1] as ToolResultMessage;

		// The restored agent transcript is closed by a synthetic terminal result.
		expect(last.role).toBe("toolResult");
		expect(last.toolCallId).toBe("call-dangling");
		expect(last.isError).toBe(true);
		expect(last.details).toMatchObject({
			omk: {
				schema: "tool-result/v2",
				synthetic: true,
				disposition: "aborted",
				executionStarted: false,
			},
		});

		// The synthetic result and the transcript_repaired audit are durable.
		const persisted = readFileSync(sessionFile, "utf8");
		expect(persisted).toContain("call-dangling");
		expect(persisted).toContain("transcript_repaired");

		// The repair is observable on the session and in the durable run journal.
		expect(session.transcriptRepair).toMatchObject({
			insertedToolCallIds: ["call-dangling"],
			reason: "resume",
		});
		expect(session.runJournalRecords.some((record) => record.event === "transcript_repaired")).toBe(true);
		const journalFile = `${sessionFile}.runjournal`;
		expect(existsSync(journalFile)).toBe(true);
		expect(readFileSync(journalFile, "utf8")).toContain("transcript_repaired");
		session.dispose();

		// Second open: the transcript is already closed; no second repair happens.
		const { session: session2 } = await openSession(sessionFile);
		const resultCount = session2.agent.state.messages.filter((message) => message.role === "toolResult").length;
		expect(resultCount).toBe(1);
		expect(session2.transcriptRepair).toBeUndefined();
		const repairedEntryCount = (readFileSync(sessionFile, "utf8").match(/transcript_repaired/g) ?? []).length;
		expect(repairedEntryCount).toBe(1);
		session2.dispose();
	});

	it("marks the session and fails closed for duplicate-result corruption", async () => {
		const author = SessionManager.create(cwd, sessionDir);
		author.appendMessage({ role: "user", content: "go", timestamp: Date.now() });
		author.appendMessage(
			fauxAssistantMessage([fauxToolCall("read", { path: "a.ts" }, { id: "call-dup" })], {
				stopReason: "toolUse",
			}),
		);
		const duplicate: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-dup",
			toolName: "read",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: Date.now(),
		};
		author.appendMessage(duplicate);
		author.appendMessage({ ...duplicate, timestamp: Date.now() + 1 });
		const sessionFile = author.getSessionFile();
		if (!sessionFile) throw new Error("expected a persisted session file");

		const failure = await openSession(sessionFile).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(SessionTerminationError);
		expect((failure as SessionTerminationError).termination).toMatchObject({
			kind: "transcript_invalid",
			causeCode: "transcript.duplicate_result",
			source: "inferred_on_resume",
		});

		// The corruption mark is durable and idempotent across repeated opens.
		expect(readFileSync(sessionFile, "utf8")).toContain("session_corrupt");
		await expect(openSession(sessionFile)).rejects.toThrow(/duplicate_result/);
		const markCount = (readFileSync(sessionFile, "utf8").match(/session_corrupt/g) ?? []).length;
		expect(markCount).toBe(1);

		// The corrupt session was never silently repaired.
		expect(readFileSync(sessionFile, "utf8")).not.toContain("transcript_repaired");
	});

	it("leaves a clean session untouched on open", async () => {
		const author = SessionManager.create(cwd, sessionDir);
		author.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		author.appendMessage(fauxAssistantMessage("hi there"));
		const sessionFile = author.getSessionFile();
		if (!sessionFile) throw new Error("expected a persisted session file");
		const before = readFileSync(sessionFile, "utf8");

		const { session } = await openSession(sessionFile);
		expect(session.transcriptRepair).toBeUndefined();
		const after = readFileSync(sessionFile, "utf8");
		expect(after).not.toContain("transcript_repaired");
		expect(after).not.toContain("session_corrupt");
		expect(after.startsWith(before.split("\n")[0])).toBe(true);
		session.dispose();
	});
});

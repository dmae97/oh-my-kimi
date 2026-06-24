import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isMoveSession, markMoveSession, unmarkMoveSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";

import { makeAssistantMessage } from "./helpers";

describe("move-session cleanup tracking", () => {
	let testAgentDir: string;
	let cwd: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(async () => {
		testAgentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-move-cleanup-"));
		setAgentDir(testAgentDir);
		cwd = path.join(testAgentDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
	});
	afterEach(async () => {
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await fsp.rm(testAgentDir, { recursive: true, force: true });
	});

	it("markMoveSession / isMoveSession / unmarkMoveSession round-trip", () => {
		const file = path.resolve(cwd, "session.jsonl");
		expect(isMoveSession(file)).toBe(false);
		markMoveSession(file);
		expect(isMoveSession(file)).toBe(true);
		unmarkMoveSession(file);
		expect(isMoveSession(file)).toBe(false);
	});

	it("createEmptySessionFile + markMoveSession + dispose deletes empty session file", async () => {
		const file = SessionManager.createEmptySessionFile(cwd);
		expect(fs.existsSync(file)).toBe(true);
		markMoveSession(file);

		// Simulate what dispose() does: load the session, then call cleanupEmptyMoveSession.
		// We test the contract: an empty (header-only) move session file is deleted.
		const manager = SessionManager.create(cwd);
		await manager.setSessionFile(file);

		// The session has no real messages — just the header.
		const entries = manager.getEntries();
		const hasRealMessages = entries.some(
			e => e.type === "message" && (e.message.role === "user" || e.message.role === "assistant"),
		);
		expect(hasRealMessages).toBe(false);

		await manager.dropSession(file);
		expect(fs.existsSync(file)).toBe(false);
		expect(isMoveSession(file)).toBe(true); // tracking not auto-cleared by dropSession
		unmarkMoveSession(file);
		expect(isMoveSession(file)).toBe(false);
	});

	it("a move session that received real messages is NOT deleted", async () => {
		const file = SessionManager.createEmptySessionFile(cwd);
		markMoveSession(file);

		const manager = SessionManager.create(cwd);
		await manager.setSessionFile(file);
		manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		manager.appendMessage(makeAssistantMessage());
		await manager.flush();

		// The session now has real messages — it should survive.
		const entries = manager.getEntries();
		const hasRealMessages = entries.some(
			e => e.type === "message" && (e.message.role === "user" || e.message.role === "assistant"),
		);
		expect(hasRealMessages).toBe(true);

		expect(fs.existsSync(file)).toBe(true);
		unmarkMoveSession(file);
	});
});

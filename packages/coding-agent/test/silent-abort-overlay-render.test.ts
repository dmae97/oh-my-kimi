/**
 * Regression: the agent-hub chat transcript must not render SILENT_ABORT_MARKER verbatim.
 *
 * Codex review flagged that the old observer overlay rendered `errorMessage`
 * without filtering the silent-abort sentinel; the renderer now lives in
 * `agent-hub.ts`. This test exercises the full `#buildTranscriptLines` path
 * through a real JSONL session file and an isolated agent registry.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentHubOverlayComponent } from "@oh-my-pi/pi-coding-agent/modes/components/agent-hub";
import type { ObservableSession } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SILENT_ABORT_MARKER } from "@oh-my-pi/pi-coding-agent/session/messages";

const SESSION_ID = "test-session-1";

function makeJsonlSessionFile(dirPath: string, entries: object[]): string {
	const filePath = path.join(dirPath, "session.jsonl");
	const lines = entries.map(e => JSON.stringify(e));
	fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8");
	return filePath;
}

function makeSubagentRegistry(sessions: ObservableSession[]) {
	return {
		getSessions: () => sessions,
		onChange: () => () => {},
		setMainSession: () => {},
		getActiveSubagentCount: () => sessions.filter(s => s.status === "active").length,
	} as unknown as import("@oh-my-pi/pi-coding-agent/modes/session-observer-registry").SessionObserverRegistry;
}

function makeHub(sessionFile: string, observed: ObservableSession[]): AgentHubOverlayComponent {
	const agents = new AgentRegistry();
	agents.register({
		id: SESSION_ID,
		displayName: SESSION_ID,
		kind: "sub",
		parentId: "Main",
		session: null,
		sessionFile,
		status: "parked",
	});
	const hub = new AgentHubOverlayComponent({
		observers: makeSubagentRegistry(observed),
		hubKeys: ["ctrl+s"],
		onDone: () => {},
		requestRender: () => {},
		registry: agents,
	});
	hub.openChat(SESSION_ID);
	return hub;
}

describe("Agent hub silent-abort regression", () => {
	let tmpDir: string;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-overlay-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("does not render ✗ Error: for silent-abort assistant messages with empty content", () => {
		const sessionFile = makeJsonlSessionFile(tmpDir, [
			{ type: "session", version: 3, id: SESSION_ID, timestamp: new Date().toISOString() },
			{
				type: "message",
				id: "msg-user-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "hello", timestamp: Date.now() },
			},
			{
				type: "message",
				id: "msg-assistant-1",
				parentId: "msg-user-1",
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					content: [],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					stopReason: "aborted",
					errorMessage: SILENT_ABORT_MARKER,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				},
			},
		]);

		const hub = makeHub(sessionFile, [
			{
				id: SESSION_ID,
				kind: "subagent",
				label: "Test Subagent",
				status: "active",
				sessionFile,
				lastUpdate: Date.now(),
			},
		]);

		// Render with a reasonable width — the hub chat view reads the session
		// file and calls #buildTranscriptLines internally.
		const rendered = hub.render(120);
		hub.dispose();
		const renderedText = rendered.join("\n");

		// The sentinel MUST NOT appear verbatim in any rendered line
		expect(renderedText).not.toContain(SILENT_ABORT_MARKER);
		// The error prefix MUST NOT appear for a silent-abort message
		expect(renderedText).not.toContain("✗ Error:");
	});

	it("renders normal error messages with ✗ Error: prefix", () => {
		const sessionFile = makeJsonlSessionFile(tmpDir, [
			{ type: "session", version: 3, id: SESSION_ID, timestamp: new Date().toISOString() },
			{
				type: "message",
				id: "msg-user-2",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "hello", timestamp: Date.now() },
			},
			{
				type: "message",
				id: "msg-assistant-2",
				parentId: "msg-user-2",
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					content: [],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					stopReason: "error",
					errorMessage: "Connection timed out",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				},
			},
		]);

		const hub = makeHub(sessionFile, [
			{
				id: SESSION_ID,
				kind: "subagent",
				label: "Test Subagent",
				status: "failed",
				sessionFile,
				lastUpdate: Date.now(),
			},
		]);

		const rendered = hub.render(120);
		hub.dispose();
		const renderedText = rendered.join("\n");

		// A real error message SHOULD be rendered with the ✗ Error: prefix
		expect(renderedText).toContain("✗ Error:");
		expect(renderedText).toContain("Connection timed out");
	});
});

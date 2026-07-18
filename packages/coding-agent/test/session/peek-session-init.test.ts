import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

function assistantMessage(text: string) {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

describe("SessionManager.peekSessionInit", () => {
	it("returns the latest session_init contract (tools/spawns/readSummarize) and the header cwd", async () => {
		const cwd = makeTempDir("@pi-peek-cwd-");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");

		manager.appendSessionInit({ systemPrompt: "first", task: "t1", tools: ["read"], spawns: "" });
		manager.appendSessionInit({
			systemPrompt: "second",
			task: "t2",
			tools: ["read", "bash", "yield"],
			spawns: "task",
			readSummarize: false,
			restrictToolNames: true,
		});
		// Flush buffered entries (header + inits) so the lock-free peek can read them off disk.
		manager.appendMessage(assistantMessage("flush"));

		const peek = await SessionManager.peekSessionInit(sessionFile);
		expect(peek?.cwd).toBe(manager.getCwd());
		// Latest init wins — the reviver must rebuild from the most recent contract.
		expect(peek?.init?.systemPrompt).toBe("second");
		expect(peek?.init?.tools).toEqual(["read", "bash", "yield"]);
		expect(peek?.init?.spawns).toBe("task");
		expect(peek?.init?.readSummarize).toBe(false);
		expect(peek?.init?.restrictToolNames).toBe(true);
	});

	it("returns init: null for a session file with no session_init (a main/legacy session)", async () => {
		const cwd = makeTempDir("@pi-peek-legacy-");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");
		manager.appendMessage(assistantMessage("hi"));

		const peek = await SessionManager.peekSessionInit(sessionFile);
		expect(peek?.cwd).toBe(manager.getCwd());
		expect(peek?.init).toBeNull();
	});

	it("returns null for a file that cannot be read", async () => {
		const peek = await SessionManager.peekSessionInit(path.join(makeTempDir("@pi-peek-missing-"), "nope.jsonl"));
		expect(peek).toBeNull();
	});
});

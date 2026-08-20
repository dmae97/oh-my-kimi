import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSdkSessionCli, type SessionHandle } from "../src/commands/sdk-session-cli.ts";
import { type SessionEntry, type SessionInfo, SessionManager } from "../src/core/session-manager.ts";
import { acquireSessionOwnerLeaseSync } from "../src/core/session-owner-lease.ts";
import { assistantMsg } from "./utilities.ts";

function sessionInfo(id: string, path: string): SessionInfo {
	return {
		path,
		id,
		cwd: "/tmp/project",
		created: new Date("2026-08-18T00:00:00.000Z"),
		modified: new Date("2026-08-18T01:00:00.000Z"),
		messageCount: 1,
		firstMessage: "hello",
		allMessagesText: "hello",
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOutput(lines: readonly string[]): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(lines[0] ?? "{}");
	} catch (error) {
		throw new Error("expected JSON output", { cause: error });
	}
	if (!isRecord(value)) throw new Error("expected JSON object");
	return value;
}

function handle(entries: SessionEntry[] = []): SessionHandle & { appended: string[] } {
	const appended: string[] = [];
	return {
		appended,
		getSessionId: () => "sess-1",
		getSessionFile: () => "/tmp/sess-1.jsonl",
		getCwd: () => "/tmp/project",
		getEntries: () => entries,
		appendMessage: (message) => {
			appended.push(message.content);
			return "entry-1";
		},
	};
}

describe("omk sdk session CLI", () => {
	it("ignores unrelated argv", async () => {
		expect(await runSdkSessionCli(["stats"])).toEqual({ handled: false, exitCode: 0 });
	});

	it("documents the required send arguments", async () => {
		const out: string[] = [];
		expect(
			await runSdkSessionCli(["sdk", "session", "--help"], {
				writeLine: (line) => out.push(line),
			}),
		).toEqual({ handled: true, exitCode: 0 });
		expect(out.join("\n")).toContain("send <id> <message>");
	});

	it("requires a session id for send", async () => {
		const out: string[] = [];
		expect(
			await runSdkSessionCli(["sdk", "session", "send"], {
				writeLine: (line) => out.push(line),
			}),
		).toEqual({ handled: true, exitCode: 2 });
		expect(parseOutput(out).error).toBe("send requires a session id");
	});

	it("prints status for listed sessions", async () => {
		const out: string[] = [];
		const result = await runSdkSessionCli(["sdk", "session", "status"], {
			writeLine: (line) => out.push(line),
			listSessions: async () => [sessionInfo("sess-1", "/tmp/sess-1.jsonl")],
		});
		expect(result).toEqual({ handled: true, exitCode: 0 });
		expect(out.join("\n")).toContain("sess-1");
		expect(out.join("\n")).toContain("hello");
	});

	it("appends a user message with send", async () => {
		const opened = handle();
		const out: string[] = [];
		const result = await runSdkSessionCli(["sdk", "session", "send", "sess-1", "keep going"], {
			writeLine: (line) => out.push(line),
			listSessions: async () => [sessionInfo("sess-1", "/tmp/sess-1.jsonl")],
			openSession: () => opened,
		});
		expect(result).toEqual({ handled: true, exitCode: 0 });
		expect(opened.appended).toEqual(["keep going"]);
		expect(parseOutput(out).entryId).toBe("entry-1");
	});

	it("requires an exact session id for send", async () => {
		const opened = handle();
		const out: string[] = [];
		const result = await runSdkSessionCli(["sdk", "session", "send", "sess", "keep going"], {
			writeLine: (line) => out.push(line),
			listSessions: async () => [sessionInfo("sess-1", "/tmp/sess-1.jsonl")],
			openSession: () => opened,
		});
		expect(result).toEqual({ handled: true, exitCode: 1 });
		expect(opened.appended).toEqual([]);
		expect(parseOutput(out).error).toBe("send requires an exact session id: sess");
	});

	it("rejects ambiguous session prefixes instead of selecting the first match", async () => {
		const out: string[] = [];
		const result = await runSdkSessionCli(["sdk", "session", "status", "sess"], {
			writeLine: (line) => out.push(line),
			listSessions: async () => [
				sessionInfo("sess-1", "/tmp/sess-1.jsonl"),
				sessionInfo("sess-2", "/tmp/sess-2.jsonl"),
			],
		});
		expect(result).toEqual({ handled: true, exitCode: 1 });
		expect(parseOutput(out).error).toBe("session id is ambiguous: sess");
	});

	it("redacts credential-shaped text from session status output", async () => {
		const out: string[] = [];
		const secret = `ghp_${"A".repeat(36)}`;
		const info = { ...sessionInfo("sess-1", "/tmp/sess-1.jsonl"), firstMessage: `token=${secret}` };
		const result = await runSdkSessionCli(["sdk", "session", "status"], {
			writeLine: (line) => out.push(line),
			listSessions: async () => [info],
		});
		expect(result).toEqual({ handled: true, exitCode: 0 });
		expect(out.join("\n")).not.toContain(secret);
		expect(out.join("\n")).toContain("[REDACTED]");
	});

	it("reports a live session owner without throwing", async () => {
		const out: string[] = [];
		const ownerError = new Error("owner details must not be exposed");
		ownerError.name = "SessionOwnerLeaseHeldError";
		const result = await runSdkSessionCli(["sdk", "session", "send", "sess-1", "keep going"], {
			writeLine: (line) => out.push(line),
			listSessions: async () => [sessionInfo("sess-1", "/tmp/sess-1.jsonl")],
			openSession: () => {
				throw ownerError;
			},
		});
		expect(result).toEqual({ handled: true, exitCode: 1 });
		expect(parseOutput(out).error).toBe("session is active; stop it before appending: sess-1");
	});

	it("refuses an actual held session owner lease", async () => {
		const root = mkdtempSync(join(tmpdir(), "omk-sdk-session-cli-"));
		const manager = SessionManager.create(root, root);
		manager.appendMessage(assistantMsg("seed"));
		const sessionPath = manager.getSessionFile();
		if (!sessionPath) throw new Error("expected persisted session path");
		const lease = acquireSessionOwnerLeaseSync(sessionPath);
		try {
			const out: string[] = [];
			const id = manager.getSessionId();
			const result = await runSdkSessionCli(["sdk", "session", "send", id, "keep going"], {
				cwd: root,
				writeLine: (line) => out.push(line),
				listSessions: async () => [sessionInfo(id, sessionPath)],
			});
			expect(result).toEqual({ handled: true, exitCode: 1 });
			expect(parseOutput(out).error).toBe(`session is active; stop it before appending: ${id}`);
		} finally {
			lease.release();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses unknown actions", async () => {
		const out: string[] = [];
		expect(await runSdkSessionCli(["sdk", "session", "explode"], { writeLine: (line) => out.push(line) })).toEqual({
			handled: true,
			exitCode: 2,
		});
		expect(parseOutput(out).status).toBe("refused");
	});
});

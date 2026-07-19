import { linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_SESSION_VERSION, SessionManager } from "../../src/core/session-manager.ts";

describe("SessionManager complete-prefix loading", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("loads only complete JSONL records and quarantines exact trailing bytes before rewriting", () => {
		const root = join(tmpdir(), `omk-session-prefix-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		roots.push(root);
		const cwd = join(root, "project");
		const sessionDir = join(root, "sessions");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
		const path = join(sessionDir, "session.jsonl");
		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "session-prefix",
			timestamp: "2026-07-17T00:00:00.000Z",
			cwd,
		};
		const entry = {
			type: "thinking_level_change",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-07-17T00:00:01.000Z",
			thinkingLevel: "medium",
		};
		const prefix = `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`;
		const fragment = Buffer.from('{"type":"message","id":"partial"}', "utf8");
		writeFileSync(path, Buffer.concat([Buffer.from(prefix), fragment]));

		const manager = SessionManager.open(path, sessionDir);

		expect(manager.getEntries()).toHaveLength(1);
		expect(manager.getEntries()[0]?.id).toBe("entry-1");
		expect(manager.getQuarantineReport()).toMatchObject({
			artifact: "session",
			path,
			byteCount: fragment.byteLength,
			completePrefixByteCount: Buffer.byteLength(prefix),
		});
		const quarantinePath = manager.getQuarantineReport()?.quarantinePath;
		if (!quarantinePath) throw new Error("expected quarantine path");
		expect(readFileSync(quarantinePath)).toEqual(fragment);
		if (process.platform !== "win32") expect(statSync(quarantinePath).mode & 0o777).toBe(0o600);
		expect(readFileSync(path, "utf8")).toBe(prefix);

		const cleanReload = SessionManager.open(path, sessionDir);
		expect(cleanReload.getQuarantineReport()).toBeNull();
	});

	it.skipIf(process.platform === "win32")("refuses to quarantine a session target with an unknown hardlink", () => {
		const root = join(tmpdir(), `omk-session-hardlink-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		roots.push(root);
		mkdirSync(root, { recursive: true });
		const path = join(root, "session.jsonl");
		const alias = join(root, "alias.jsonl");
		const prefix = `${JSON.stringify({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "hardlink-session",
			timestamp: "2026-07-17T00:00:00.000Z",
			cwd: root,
		})}\n`;
		const bytes = `${prefix}{"partial":`;
		writeFileSync(path, bytes);
		linkSync(path, alias);

		expect(() => SessionManager.open(path, root)).toThrow(/hard ?link/i);
		expect(readFileSync(path, "utf8")).toBe(bytes);
		expect(readFileSync(alias, "utf8")).toBe(bytes);
		expect(readdirSync(root).sort()).toEqual(["alias.jsonl", "session.jsonl"]);
	});
});

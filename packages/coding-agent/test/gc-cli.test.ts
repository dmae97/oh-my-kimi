import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { runGcCommand } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import { getDefault } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { getAgentDir, getBlobsDir, getHistoryDbPath, getSessionsDir, setAgentDir } from "@oh-my-pi/pi-utils";

let root: string;
let writes: string[] = [];
let stdoutSpy: { mockRestore(): void } | undefined;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gc-"));
	writes = [];
	stdoutSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
		writes.push(String(chunk));
		return true;
	});
});

afterEach(async () => {
	stdoutSpy?.mockRestore();
	stdoutSpy = undefined;
	await fs.rm(root, { recursive: true, force: true });
});

function hashFor(label: string): string {
	return new Bun.SHA256().update(label).digest("hex");
}

async function writeSession(
	agentDir: string,
	project: string,
	id: string,
	status: "complete" | "pending" | "interrupted",
	options: { blobRef?: string; ageDays?: number } = {},
): Promise<string> {
	const sessionDir = path.join(getSessionsDir(agentDir), project);
	await fs.mkdir(sessionDir, { recursive: true });
	const file = path.join(sessionDir, `${id}.jsonl`);
	const lines = [
		JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }),
	];
	if (options.blobRef) {
		lines.push(JSON.stringify({ type: "message", message: { role: "user", content: options.blobRef } }));
	}
	if (status === "complete") {
		lines.push(JSON.stringify({ type: "message", message: { role: "assistant", content: [] } }));
	} else if (status === "pending") {
		lines.push(JSON.stringify({ type: "message", message: { role: "user", content: "waiting" } }));
	} else {
		lines.push(
			JSON.stringify({
				type: "message",
				message: { role: "assistant", content: [{ type: "toolCall", id: "tool-1" }] },
			}),
		);
	}
	await Bun.write(file, `${lines.join("\n")}\n`);
	if (options.ageDays !== undefined) {
		const ts = new Date(Date.now() - options.ageDays * 86_400_000);
		await fs.utimes(file, ts, ts);
	}
	return file;
}

async function writeBlob(agentDir: string, hash: string, content: string): Promise<string> {
	const file = path.join(getBlobsDir(agentDir), hash);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, content);
	return file;
}

describe("runGcCommand blob sweep", () => {
	test("keeps automatic gc disabled by default", () => {
		expect(getDefault("gc.auto")).toBe(false);
	});

	test("uses the active configured agent dir when --agent-dir is omitted", async () => {
		const originalAgentDir = getAgentDir();
		try {
			setAgentDir(root);
			await writeBlob(root, hashFor("orphan"), "orphan");

			const result = await runGcCommand({ flags: { blobs: true } });

			expect(result.agentDir).toBe(root);
			expect(result.blobs?.wouldDelete).toBe(1);
		} finally {
			setAgentDir(originalAgentDir);
		}
	});

	test("dry-run reports unreferenced blobs without deleting them", async () => {
		const hash = hashFor("orphan");
		const blob = await writeBlob(root, hash, "orphan");

		const result = await runGcCommand({ flags: { agentDir: root, blobs: true } });

		expect(result.blobs?.wouldDelete).toBe(1);
		expect(result.blobs?.deleted).toBe(0);
		expect(await Bun.file(blob).exists()).toBe(true);
	});

	test("--apply deletes unreferenced blobs and keeps referenced blobs", async () => {
		const orphanHash = hashFor("orphan");
		const referencedHash = hashFor("referenced");
		const orphan = await writeBlob(root, orphanHash, "orphan");
		const referenced = await writeBlob(root, referencedHash, "referenced");
		await writeSession(root, "project", "session-1", "complete", {
			blobRef: `blob:sha256:${referencedHash}`,
		});

		const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

		expect(result.blobs?.wouldDelete).toBe(1);
		expect(result.blobs?.deleted).toBe(1);
		expect(await Bun.file(orphan).exists()).toBe(false);
		expect(await Bun.file(referenced).exists()).toBe(true);
	});
});

describe("runGcCommand history checkpoint", () => {
	test("dry-run reports WAL checkpoint without truncating it", async () => {
		const dbPath = getHistoryDbPath(root);
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		const db = new Database(dbPath);
		db.run("PRAGMA journal_mode=WAL");
		db.run("CREATE TABLE history (id INTEGER PRIMARY KEY, prompt TEXT)");
		db.run("INSERT INTO history (prompt) VALUES ('hello')");
		const walPath = `${dbPath}-wal`;
		const walBytes = (await fs.stat(walPath)).size;

		const result = await runGcCommand({ flags: { agentDir: root, wal: true } });
		const afterBytes = (await fs.stat(walPath)).size;
		db.close();

		expect(result.wal?.wouldCheckpoint).toBe(true);
		expect(result.wal?.checkpointed).toBe(false);
		expect(result.wal?.walBytes).toBeGreaterThan(0);
		expect(afterBytes).toBe(walBytes);
	});

	test("--apply checkpoints history WAL", async () => {
		const dbPath = getHistoryDbPath(root);
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		const db = new Database(dbPath);
		db.run("PRAGMA journal_mode=WAL");
		db.run("CREATE TABLE history (id INTEGER PRIMARY KEY, prompt TEXT)");
		db.run("INSERT INTO history (prompt) VALUES ('hello')");
		db.close();

		const result = await runGcCommand({ flags: { agentDir: root, wal: true, apply: true } });

		expect(result.wal?.checkpointed).toBe(true);
		expect((await fs.stat(`${dbPath}-wal`)).size).toBe(0);
	});
});

describe("runGcCommand cold-session archive", () => {
	test("archives old completed sessions while honoring keep-count and active-status skips", async () => {
		const archiveMe = await writeSession(root, "project", "archive-me", "complete", { ageDays: 90 });
		const keepRecent = await writeSession(root, "project", "keep-recent", "complete", { ageDays: 90 });
		const pending = await writeSession(root, "project", "pending", "pending", { ageDays: 90 });
		const interrupted = await writeSession(root, "project", "interrupted", "interrupted", { ageDays: 90 });
		await fs.mkdir(archiveMe.slice(0, -".jsonl".length), { recursive: true });
		await Bun.write(path.join(archiveMe.slice(0, -".jsonl".length), "0.bash.log"), "artifact");

		const result = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 1,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});
		const archived = path.join(root, "archive", "sessions", "project", "archive-me.jsonl.gz");

		expect(result.archive?.archived).toBe(1);
		expect(result.archive?.skippedActive).toBe(2);
		expect(await Bun.file(archiveMe).exists()).toBe(false);
		expect(await Bun.file(archived).exists()).toBe(true);
		expect(new TextDecoder().decode(gunzipSync(await Bun.file(archived).bytes()))).toContain('"archive-me"');
		expect(await Bun.file(path.join(archived.slice(0, -".jsonl.gz".length), "0.bash.log")).exists()).toBe(true);
		expect(await Bun.file(keepRecent).exists()).toBe(true);
		expect(await Bun.file(pending).exists()).toBe(true);
		expect(await Bun.file(interrupted).exists()).toBe(true);
	});

	test("removes archived session rows from history and rebuilds FTS", async () => {
		await writeSession(root, "project", "archive-me", "complete", { ageDays: 90 });
		const dbPath = getHistoryDbPath(root);
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		const db = new Database(dbPath);
		db.run("CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT NOT NULL, session_id TEXT)");
		db.run("CREATE VIRTUAL TABLE history_fts USING fts5(prompt, content='history', content_rowid='id')");
		db.run("INSERT INTO history (prompt, session_id) VALUES ('old prompt', 'archive-me')");
		db.run("INSERT INTO history (prompt, session_id) VALUES ('new prompt', 'keep-me')");
		db.run("INSERT INTO history_fts(history_fts) VALUES('rebuild')");
		db.close();

		const result = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});

		const check = new Database(dbPath);
		const rows = check.prepare("SELECT session_id FROM history ORDER BY id").all() as Array<{ session_id: string }>;
		const ftsRows = check
			.prepare("SELECT h.session_id FROM history_fts f JOIN history h ON h.id = f.rowid ORDER BY h.id")
			.all() as Array<{ session_id: string }>;
		check.close();

		expect(result.archive?.historyRowsDeleted).toBe(1);
		expect(result.archive?.ftsRebuilt).toBe(true);
		expect(rows.map(row => row.session_id)).toEqual(["keep-me"]);
		expect(ftsRows.map(row => row.session_id)).toEqual(["keep-me"]);
	});

	test("archives sessions when legacy history has no session_id column", async () => {
		const session = await writeSession(root, "project", "legacy-history", "complete", { ageDays: 90 });
		const dbPath = getHistoryDbPath(root);
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		const db = new Database(dbPath);
		db.run("CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT NOT NULL)");
		db.run("INSERT INTO history (prompt) VALUES ('old prompt')");
		db.close();

		const result = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});

		expect(result.archive?.archived).toBe(1);
		expect(result.archive?.historyRowsDeleted).toBe(0);
		expect(result.archive?.errors).toEqual([]);
		expect(await Bun.file(session).exists()).toBe(false);
	});

	test("dry-run does not recover orphaned session backups", async () => {
		const sessionDir = path.join(getSessionsDir(root), "project");
		await fs.mkdir(sessionDir, { recursive: true });
		const primary = path.join(sessionDir, "lost.jsonl");
		const backup = path.join(sessionDir, "lost.jsonl.1234567890.bak");
		await Bun.write(
			backup,
			`${JSON.stringify({ type: "session", version: 3, id: "lost", timestamp: "2026-01-01T00:00:00.000Z" })}\n`,
		);

		const result = await runGcCommand({ flags: { agentDir: root, archive: true } });

		expect(result.archive?.scanned).toBe(0);
		expect(await Bun.file(backup).exists()).toBe(true);
		expect(await Bun.file(primary).exists()).toBe(false);
	});

	test("sweeps blobs only after scanning references in compressed archived sessions", async () => {
		const referencedHash = hashFor("archived-reference");
		const referenced = await writeBlob(root, referencedHash, "referenced");
		await writeBlob(root, hashFor("orphan"), "orphan");
		await writeSession(root, "project", "archive-me", "complete", {
			ageDays: 90,
			blobRef: `blob:sha256:${referencedHash}`,
		});

		await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});
		const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

		expect(result.blobs?.wouldDelete).toBe(1);
		expect(await Bun.file(referenced).exists()).toBe(true);
	});
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type FileEntry,
	findMostRecentSession,
	loadEntriesFromFile,
	resolveResumableSession,
	type SessionHeader,
	SessionManager,
} from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getConfigRootDir, getSessionsDir, Snowflake, setAgentDir } from "@oh-my-pi/pi-utils";

describe("loadEntriesFromFile", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `session-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns empty array for non-existent file", async () => {
		const entries = await loadEntriesFromFile(path.join(tempDir, "nonexistent.jsonl"));
		expect(entries).toEqual([]);
	});

	it("returns empty array for empty file", async () => {
		const file = path.join(tempDir, "empty.jsonl");
		fs.writeFileSync(file, "");
		expect(await loadEntriesFromFile(file)).toEqual([]);
	});

	it("returns empty array for file without valid session header", async () => {
		const file = path.join(tempDir, "no-header.jsonl");
		fs.writeFileSync(file, '{"type":"message","id":"1"}\n');
		expect(await loadEntriesFromFile(file)).toEqual([]);
	});

	it("returns empty array for malformed JSON", async () => {
		const file = path.join(tempDir, "malformed.jsonl");
		fs.writeFileSync(file, "not json\n");
		expect(await loadEntriesFromFile(file)).toEqual([]);
	});

	it("loads valid session file", async () => {
		const file = path.join(tempDir, "valid.jsonl");
		fs.writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = await loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
		expect(entries[0].type).toBe("session");
		expect(entries[1].type).toBe("message");
	});

	it("skips malformed lines but keeps valid ones", async () => {
		const file = path.join(tempDir, "mixed.jsonl");
		fs.writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				"not valid json\n" +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = await loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
	});
});

describe("findMostRecentSession", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `session-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns null for empty directory", async () => {
		expect(await findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns null for non-existent directory", async () => {
		expect(await findMostRecentSession(path.join(tempDir, "nonexistent"))).toBeNull();
	});

	it("ignores non-jsonl files", async () => {
		fs.writeFileSync(path.join(tempDir, "file.txt"), "hello");
		fs.writeFileSync(path.join(tempDir, "file.json"), "{}");
		expect(await findMostRecentSession(tempDir)).toBeNull();
	});

	it("ignores jsonl files without valid session header", async () => {
		fs.writeFileSync(path.join(tempDir, "invalid.jsonl"), '{"type":"message"}\n');
		expect(await findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns single valid session file", async () => {
		const file = path.join(tempDir, "session.jsonl");
		fs.writeFileSync(file, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		expect(await findMostRecentSession(tempDir)).toBe(file);
	});

	it("returns most recently modified session", async () => {
		const file1 = path.join(tempDir, "older.jsonl");
		const file2 = path.join(tempDir, "newer.jsonl");

		fs.writeFileSync(file1, '{"type":"session","id":"old","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		// Small delay to ensure different mtime
		await new Promise(r => setTimeout(r, 10));
		fs.writeFileSync(file2, '{"type":"session","id":"new","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(await findMostRecentSession(tempDir)).toBe(file2);
	});

	it("skips invalid files and returns valid one", async () => {
		const invalid = path.join(tempDir, "invalid.jsonl");
		const valid = path.join(tempDir, "valid.jsonl");

		fs.writeFileSync(invalid, '{"type":"not-session"}\n');
		await new Promise(r => setTimeout(r, 10));
		fs.writeFileSync(valid, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(await findMostRecentSession(tempDir)).toBe(valid);
	});
});

describe("resolveResumableSession", () => {
	let tempDir: string;
	let sessionDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `session-test-${Snowflake.next()}`);
		sessionDir = path.join(tempDir, "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function writeSession(fileName: string, headerCwd: string, id: string = Snowflake.next()): string {
		const filePath = path.join(sessionDir, fileName);
		fs.writeFileSync(
			filePath,
			`${[
				JSON.stringify({ type: "session", id, timestamp: "2025-01-01T00:00:00Z", cwd: headerCwd }),
				JSON.stringify({
					type: "message",
					id: "msg-1",
					parentId: null,
					timestamp: "2025-01-01T00:00:01Z",
					message: { role: "user", content: "hello", timestamp: 1 },
				}),
			].join("\n")}\n`,
		);
		return id;
	}

	it("returns undefined when no local session matches", async () => {
		writeSession("2025-01-01_demo.jsonl", "/tmp/project", "demo1234");

		const match = await resolveResumableSession("missing", "/tmp/project", sessionDir);

		expect(match).toBeUndefined();
	});

	it("matches by session id prefix", async () => {
		const id = writeSession("2025-01-01_resume.jsonl", "/tmp/project", "resume1234");

		const match = await resolveResumableSession(id.slice(0, 6), "/tmp/project", sessionDir);

		expect(match?.scope).toBe("local");
		expect(match?.session.id).toBe(id);
	});

	it("matches legacy timestamped filename prefixes and id suffixes", async () => {
		writeSession("2025-02-03T04-05-06-789Z_legacyabcd.jsonl", "/tmp/project", "legacyabcd");

		const byFilePrefix = await resolveResumableSession("2025-02-03T04-05", "/tmp/project", sessionDir);
		expect(byFilePrefix?.session.id).toBe("legacyabcd");

		const byFileSuffix = await resolveResumableSession("legacy", "/tmp/project", sessionDir);
		expect(byFileSuffix?.session.id).toBe("legacyabcd");
	});

	it("keeps local matches resumable when header cwd differs", async () => {
		writeSession("2025-01-01_moved.jsonl", "/Users/old-user/project", "moved1234");

		const match = await resolveResumableSession("moved", "/Users/new-user/project", sessionDir);

		expect(match?.scope).toBe("local");
		expect(match?.session.path).toBe(path.join(sessionDir, "2025-01-01_moved.jsonl"));
	});
});

describe("SessionManager temp cwd session dirs", () => {
	let testAgentDir: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	function expectedTempSessionDirName(tempCwd: string): string {
		return `-tmp-${path.relative(os.tmpdir(), path.resolve(tempCwd)).replace(/[/\\:]/g, "-")}`;
	}

	function toLegacyAbsoluteSessionDirName(cwd: string): string {
		return `--${path
			.resolve(cwd)
			.replace(/^[/\\]/, "")
			.replace(/[/\\:]/g, "-")}--`;
	}

	beforeEach(() => {
		testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-session-dir-test-"));
		setAgentDir(testAgentDir);
	});

	afterEach(() => {
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		fs.rmSync(testAgentDir, { recursive: true, force: true });
	});

	it("stores symlink-equivalent home cwd sessions under home-relative directories", () => {
		if (process.platform === "win32") return;

		const projectsRoot = path.join(os.homedir(), "Projects");
		fs.mkdirSync(projectsRoot, { recursive: true });
		const realProjectDir = fs.mkdtempSync(path.join(projectsRoot, "omp-session-home-"));
		const nestedDir = path.join(realProjectDir, "nested");
		const aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-session-home-alias-"));
		const homeAlias = path.join(aliasRoot, "home-link");

		try {
			fs.mkdirSync(nestedDir, { recursive: true });
			fs.symlinkSync(os.homedir(), homeAlias, "dir");

			const aliasedCwd = path.join(homeAlias, "Projects", path.basename(realProjectDir), "nested");
			const session = SessionManager.create(aliasedCwd);
			const sessionFile = session.getSessionFile();
			if (!sessionFile) throw new Error("Expected session file path");

			const expectedDir = path.join(
				getSessionsDir(),
				`-${path.relative(os.homedir(), fs.realpathSync(aliasedCwd)).replace(/[/\\:]/g, "-")}`,
			);
			expect(path.dirname(sessionFile)).toBe(expectedDir);
		} finally {
			fs.rmSync(aliasRoot, { recursive: true, force: true });
			fs.rmSync(realProjectDir, { recursive: true, force: true });
		}
	});

	it("stores temp-root cwd sessions under -tmp-prefixed directories", () => {
		const tempCwd = path.join(testAgentDir, `temp-cwd-${Snowflake.next()}`);
		fs.mkdirSync(tempCwd, { recursive: true });

		const session = SessionManager.create(tempCwd);
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file path");

		expect(path.dirname(sessionFile)).toBe(path.join(getSessionsDir(), expectedTempSessionDirName(tempCwd)));
	});

	it("migrates legacy temp-root absolute session dirs to -tmp prefixes", () => {
		const tempCwd = path.join(testAgentDir, `legacy-cwd-${Snowflake.next()}`);
		fs.mkdirSync(tempCwd, { recursive: true });

		const legacyDir = path.join(getSessionsDir(), toLegacyAbsoluteSessionDirName(tempCwd));
		const markerFile = path.join(legacyDir, "carried.jsonl");
		fs.mkdirSync(legacyDir, { recursive: true });
		fs.writeFileSync(markerFile, "marker\n");

		const session = SessionManager.create(tempCwd);
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file path");

		const expectedDir = path.join(getSessionsDir(), expectedTempSessionDirName(tempCwd));
		expect(fs.existsSync(legacyDir)).toBe(false);
		expect(path.dirname(sessionFile)).toBe(expectedDir);
		expect(fs.existsSync(path.join(expectedDir, "carried.jsonl"))).toBe(true);
	});
});

describe("SessionManager legacy session migration persistence", () => {
	let tempDir: string;

	function makeAssistantMessage() {
		return {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "legacy reply" }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-20250514",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: Date.now(),
		};
	}

	function getHeader(entries: FileEntry[]): SessionHeader | undefined {
		return entries.find((entry): entry is SessionHeader => entry.type === "session");
	}

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-session-manager-legacy-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("keeps legacy migration in memory until later persisted activity rewrites the file", async () => {
		const sessionFile = path.join(tempDir, "legacy.jsonl");
		fs.writeFileSync(
			sessionFile,
			`${[
				JSON.stringify({ type: "session", id: "legacy-session", timestamp: "2025-01-01T00:00:00Z", cwd: tempDir }),
				JSON.stringify({
					type: "message",
					timestamp: "2025-01-01T00:00:01Z",
					message: { role: "user", content: "hello", timestamp: 1 },
				}),
				JSON.stringify({
					type: "message",
					timestamp: "2025-01-01T00:00:02Z",
					message: makeAssistantMessage(),
				}),
			].join("\n")}\n`,
		);
		const initialMtimeMs = fs.statSync(sessionFile).mtimeMs;

		const session = await SessionManager.open(sessionFile, tempDir);
		const migratedEntries = session.getEntries();

		expect(migratedEntries).toHaveLength(2);
		for (const entry of migratedEntries) {
			expect(entry.id).toBeDefined();
		}
		expect(migratedEntries[0]?.parentId).toBeNull();
		expect(migratedEntries[1]?.parentId).toBe(migratedEntries[0]?.id);

		await new Promise(resolve => setTimeout(resolve, 20));
		await session.flush();
		expect(fs.statSync(sessionFile).mtimeMs).toBe(initialMtimeMs);

		await new Promise(resolve => setTimeout(resolve, 20));
		session.appendMessage({ role: "user", content: "follow up", timestamp: Date.now() });
		await session.flush();

		const persistedEntries = await loadEntriesFromFile(sessionFile);
		const header = getHeader(persistedEntries);
		if (!header) throw new Error("Expected session header");

		expect(fs.statSync(sessionFile).mtimeMs).toBeGreaterThan(initialMtimeMs);
		expect(header.version).toBe(3);
		expect(persistedEntries).toHaveLength(4);
		for (const entry of persistedEntries.filter(entry => entry.type !== "session")) {
			expect(entry.id).toBeDefined();
		}
	});

	it("still rewrites immediately when explicitly requested", async () => {
		const sessionFile = path.join(tempDir, "legacy-rewrite.jsonl");
		fs.writeFileSync(
			sessionFile,
			`${[
				JSON.stringify({ type: "session", id: "legacy-session", timestamp: "2025-01-01T00:00:00Z", cwd: tempDir }),
				JSON.stringify({
					type: "message",
					timestamp: "2025-01-01T00:00:01Z",
					message: { role: "user", content: "hello", timestamp: 1 },
				}),
			].join("\n")}\n`,
		);
		const initialMtimeMs = fs.statSync(sessionFile).mtimeMs;

		const session = await SessionManager.open(sessionFile, tempDir);
		await new Promise(resolve => setTimeout(resolve, 20));
		await session.rewriteEntries();

		const persistedEntries = await loadEntriesFromFile(sessionFile);
		const header = getHeader(persistedEntries);
		if (!header) throw new Error("Expected session header");

		expect(fs.statSync(sessionFile).mtimeMs).toBeGreaterThan(initialMtimeMs);
		expect(header.version).toBe(3);
		expect(persistedEntries).toHaveLength(2);
		expect(persistedEntries[1]?.type).toBe("message");
		if (persistedEntries[1]?.type !== "message") throw new Error("Expected message entry");
		expect(persistedEntries[1].id).toBeDefined();
		expect(persistedEntries[1].parentId).toBeNull();
	});

	it("forces a deferred legacy rewrite when ensureOnDisk is requested", async () => {
		const sessionFile = path.join(tempDir, "legacy-ensure-on-disk.jsonl");
		fs.writeFileSync(
			sessionFile,
			`${[
				JSON.stringify({ type: "session", id: "legacy-session", timestamp: "2025-01-01T00:00:00Z", cwd: tempDir }),
				JSON.stringify({
					type: "message",
					timestamp: "2025-01-01T00:00:01Z",
					message: { role: "user", content: "hello", timestamp: 1 },
				}),
			].join("\n")}\n`,
		);
		const initialMtimeMs = fs.statSync(sessionFile).mtimeMs;

		const session = await SessionManager.open(sessionFile, tempDir);
		await new Promise(resolve => setTimeout(resolve, 20));
		await session.ensureOnDisk();

		const persistedEntries = await loadEntriesFromFile(sessionFile);
		const header = getHeader(persistedEntries);
		if (!header) throw new Error("Expected session header");

		expect(fs.statSync(sessionFile).mtimeMs).toBeGreaterThan(initialMtimeMs);
		expect(header.version).toBe(3);
		expect(persistedEntries).toHaveLength(2);
		expect(persistedEntries[1]?.type).toBe("message");
		if (persistedEntries[1]?.type !== "message") throw new Error("Expected message entry");
		expect(persistedEntries[1].id).toBeDefined();
		expect(persistedEntries[1].parentId).toBeNull();
	});
	it("keeps the last non-empty session resumable after starting a fresh session", async () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage({ role: "user", content: "hello", timestamp: Date.now() - 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const previousSessionFile = session.getSessionFile();
		if (!previousSessionFile) throw new Error("Expected persisted session file");

		const freshSessionFile = await session.newSession();
		expect(freshSessionFile).toBeDefined();
		expect(fs.existsSync(freshSessionFile!)).toBe(false);

		const resumed = await SessionManager.continueRecent(tempDir, tempDir);
		try {
			expect(resumed.getSessionFile()).toBe(previousSessionFile);
		} finally {
			await resumed.close();
			await session.close();
		}
	});
});

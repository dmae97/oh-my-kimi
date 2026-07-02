import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { type SessionTitleUpdate, serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";

class ControlledTitleUpdateBackend implements SessionStorageBackend {
	readonly #sessionPath: string;
	readonly #initialEntry: SessionStorageIndexEntry;
	#content: string;
	#firstUpdate: PromiseWithResolvers<void> | undefined;
	#updateCount = 0;

	constructor(sessionPath: string, content: string) {
		this.#sessionPath = sessionPath;
		this.#content = content;
		this.#initialEntry = {
			path: sessionPath,
			size: content.length,
			mtimeMs: 1,
			title: "Old",
			titleSource: "auto",
			titleUpdatedAt: "t0",
		};
	}

	init(): Promise<void> {
		return Promise.resolve();
	}

	loadIndex(): Promise<Iterable<SessionStorageIndexEntry>> {
		return Promise.resolve([this.#initialEntry]);
	}

	readFull(path: string): Promise<string | null> {
		return Promise.resolve(path === this.#sessionPath ? this.#content : null);
	}

	readSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		if (path !== this.#sessionPath) return Promise.resolve(["", ""]);
		const suffix = suffixBytes > 0 ? this.#content.slice(-suffixBytes) : "";
		return Promise.resolve([this.#content.slice(0, prefixBytes), suffix]);
	}

	writeFull(_path: string, content: string, _mtimeMs: number, _title?: SessionTitleUpdate): Promise<void> {
		this.#content = content;
		return Promise.resolve();
	}

	append(_path: string, line: string, _mtimeMs: number): Promise<void> {
		this.#content += line;
		return Promise.resolve();
	}

	updateSessionTitle(_path: string, _title: SessionTitleUpdate, _mtimeMs: number): Promise<void> {
		this.#updateCount++;
		if (this.#updateCount === 1) {
			this.#firstUpdate = Promise.withResolvers<void>();
			return this.#firstUpdate.promise;
		}
		return Promise.resolve();
	}

	truncate(_path: string, _mtimeMs: number): Promise<void> {
		this.#content = "";
		return Promise.resolve();
	}

	remove(_paths: string[]): Promise<void> {
		this.#content = "";
		return Promise.resolve();
	}

	move(_src: string, _dst: string, _mtimeMs: number): Promise<void> {
		return Promise.resolve();
	}

	rejectFirstUpdate(error: Error): void {
		if (!this.#firstUpdate) throw new Error("First title update has not started");
		this.#firstUpdate.reject(error);
	}
}
describe("FileSessionStorage.deleteSessionWithArtifacts", () => {
	let tempDir: string;
	let storage: FileSessionStorage;

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-storage-"));
		storage = new FileSessionStorage();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fsp.rm(tempDir, { recursive: true, force: true });
	});

	async function createSessionFile(name: string): Promise<string> {
		const sessionPath = path.join(tempDir, `${name}.jsonl`);
		await Bun.write(
			sessionPath,
			`${JSON.stringify({ type: "session", id: "session-id", timestamp: "2025-01-01T00:00:00Z", cwd: tempDir })}\n`,
		);
		return sessionPath;
	}

	it("succeeds when the artifact directory is already absent", async () => {
		const sessionPath = await createSessionFile("missing-artifacts");
		const artifactsDir = sessionPath.slice(0, -6);

		expect(fs.existsSync(sessionPath)).toBe(true);
		expect(fs.existsSync(artifactsDir)).toBe(false);

		await expect(storage.deleteSessionWithArtifacts(sessionPath)).resolves.toBeUndefined();
		expect(fs.existsSync(sessionPath)).toBe(false);
		expect(fs.existsSync(artifactsDir)).toBe(false);
	});

	it("throws when artifact cleanup fails after the session file is deleted", async () => {
		const sessionPath = await createSessionFile("cleanup-failure");
		const artifactsDir = sessionPath.slice(0, -6);
		await fsp.mkdir(artifactsDir, { recursive: true });
		await Bun.write(path.join(artifactsDir, "artifact.txt"), "artifact payload");

		const rmError = new Error("permission denied");
		const rmSpy = vi.spyOn(fsp, "rm").mockRejectedValueOnce(rmError);

		await expect(storage.deleteSessionWithArtifacts(sessionPath)).rejects.toThrow(
			`Session file deleted but failed to remove artifacts directory ${artifactsDir}: permission denied`,
		);
		expect(rmSpy).toHaveBeenCalledWith(artifactsDir, { recursive: true, force: true });
		expect(fs.existsSync(sessionPath)).toBe(false);
		expect(fs.existsSync(artifactsDir)).toBe(true);
	});
});

describe("FileSessionStorage.writeTextSync", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-storage-"));
	});

	afterEach(async () => {
		await fsp.rm(tempDir, { recursive: true, force: true });
	});

	it("replaces the file identity so transcript tailers detect rewrites", async () => {
		const storage = new FileSessionStorage();
		const sessionPath = path.join(tempDir, "session.jsonl");

		storage.writeTextSync(sessionPath, "first\n");
		const first = fs.statSync(sessionPath);
		storage.writeTextSync(sessionPath, "second\n");
		const second = fs.statSync(sessionPath);

		expect(second.ino).not.toBe(first.ino);
		expect(await Bun.file(sessionPath).text()).toBe("second\n");
	});
});

describe("FileSessionStorage.updateSessionTitle", () => {
	let tempDir: string;
	let storage: FileSessionStorage;

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-storage-"));
		storage = new FileSessionStorage();
	});

	afterEach(async () => {
		await fsp.rm(tempDir, { recursive: true, force: true });
	});

	it("updates the fixed title slot without truncating the tail", async () => {
		const sessionPath = path.join(tempDir, "session.jsonl");
		const tail = `${JSON.stringify({ type: "session", id: "s", timestamp: "t", cwd: tempDir })}\n`;
		storage.writeTextSync(
			sessionPath,
			`${serializeTitleSlot({ title: "Old", source: "auto", updatedAt: "t1" })}${tail}`,
		);

		await storage.updateSessionTitle(sessionPath, { title: "New", source: "user", updatedAt: "t2" });

		const content = await Bun.file(sessionPath).text();
		const [slotLine, ...rest] = content.split("\n");
		expect(JSON.parse(slotLine)).toMatchObject({ type: "title", title: "New", source: "user", updatedAt: "t2" });
		expect(`${rest.join("\n")}`).toBe(tail);
		expect(fs.statSync(sessionPath).size).toBe(
			Buffer.byteLength(`${serializeTitleSlot({ title: "Old", source: "auto", updatedAt: "t1" })}${tail}`, "utf-8"),
		);
	});

	it("uses the existing file-open error for missing paths", async () => {
		const sessionPath = path.join(tempDir, "missing.jsonl");

		await expect(
			storage.updateSessionTitle(sessionPath, { title: "New", source: "user", updatedAt: "t2" }),
		).rejects.toThrow(/ENOENT|no such file/i);
	});
});

describe("IndexedSessionStorage.updateSessionTitle", () => {
	it("does not roll a newer optimistic title back when an older backend write fails", async () => {
		const sessionPath = "/sessions/session.jsonl";
		const content = `${serializeTitleSlot({ title: "Old", source: "auto", updatedAt: "t0" })}${JSON.stringify({
			type: "session",
			id: "session-id",
			timestamp: "t0",
			cwd: "/cwd",
		})}\n`;
		const backend = new ControlledTitleUpdateBackend(sessionPath, content);
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();

		const first = storage.updateSessionTitle(sessionPath, { title: "First", source: "auto", updatedAt: "t1" });
		const second = storage.updateSessionTitle(sessionPath, { title: "Second", source: "user", updatedAt: "t2" });
		for (let i = 0; i < 10; i++) await Promise.resolve();

		backend.rejectFirstUpdate(new Error("first title write failed"));
		await expect(first).rejects.toThrow("first title write failed");
		await expect(second).resolves.toBeUndefined();

		const [slotLine] = (await storage.readText(sessionPath)).split("\n");
		expect(JSON.parse(slotLine)).toMatchObject({ type: "title", title: "Second", source: "user", updatedAt: "t2" });
	});
});

class PausableWriteFullBackend implements SessionStorageBackend {
	readonly writeFullCalls: Array<{ content: string; mtimeMs: number }> = [];
	readonly firstWriteStarted = Promise.withResolvers<void>();
	readonly firstWriteRelease = Promise.withResolvers<void>();
	#firstReleased = false;

	init(): Promise<void> {
		return Promise.resolve();
	}
	loadIndex(): Promise<Iterable<SessionStorageIndexEntry>> {
		return Promise.resolve([]);
	}
	readFull(): Promise<string | null> {
		return Promise.resolve(null);
	}
	readSlices(): Promise<[string, string]> {
		return Promise.resolve(["", ""]);
	}
	async writeFull(_path: string, content: string, mtimeMs: number): Promise<void> {
		if (!this.#firstReleased) {
			this.#firstReleased = true;
			this.firstWriteStarted.resolve();
			await this.firstWriteRelease.promise;
		}
		this.writeFullCalls.push({ content, mtimeMs });
	}
	append(): Promise<void> {
		return Promise.resolve();
	}
	updateSessionTitle(): Promise<void> {
		return Promise.resolve();
	}
	truncate(): Promise<void> {
		return Promise.resolve();
	}
	remove(): Promise<void> {
		return Promise.resolve();
	}
	move(): Promise<void> {
		return Promise.resolve();
	}
}

describe("IndexedSessionStorage.writeTextAtomic commitGuard", () => {
	it("aborts before touching the backend when the guard rejects up front", async () => {
		const backend = new PausableWriteFullBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();

		await storage.writeTextAtomic("/sessions/s.jsonl", "stale", { commitGuard: () => false });
		expect(backend.writeFullCalls).toEqual([]);
		expect(storage.existsSync("/sessions/s.jsonl")).toBe(false);
	});

	it("re-checks the guard inside the enqueued task so a concurrent write cannot be overwritten", async () => {
		const backend = new PausableWriteFullBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();

		// First write parks the backend inside writeFull, holding the per-path
		// tail. The second write awaits behind it. When the first releases,
		// the second's awaitPath resumes — but by then the guard has flipped
		// (simulated flushSync epoch bump), and the backend MUST NOT see the
		// stale second body.
		const first = storage.writeTextAtomic("/sessions/s.jsonl", "seed", {});
		let epochBumped = false;
		const second = storage.writeTextAtomic("/sessions/s.jsonl", "stale", {
			commitGuard: () => !epochBumped,
		});

		await backend.firstWriteStarted.promise;
		epochBumped = true;
		backend.firstWriteRelease.resolve();
		await first;
		await second;

		expect(backend.writeFullCalls.map(call => call.content)).toEqual(["seed"]);
	});
});

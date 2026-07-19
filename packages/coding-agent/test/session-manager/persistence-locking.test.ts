import { chmodSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicRewriteFileSync } from "../../src/core/atomic-session-file.ts";
import { sameDurableFileGeneration } from "../../src/core/durable-file-io.ts";
import { loadEntriesFromFile, SessionManager, SessionManagerStaleWriteError } from "../../src/core/session-manager.ts";
import { acquireSessionOwnerLeaseSync, SessionOwnerLeaseHeldError } from "../../src/core/session-owner-lease.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

describe("SessionManager interprocess persistence CAS", () => {
	let root: string;
	let sessionFile: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "session-persistence-cas-"));
		const author = SessionManager.create(root, root);
		author.appendMessage(userMsg("seed user"));
		author.appendMessage(assistantMsg("seed assistant"));
		const path = author.getSessionFile();
		if (!path) throw new Error("expected persisted session file");
		sessionFile = path;
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it.skipIf(process.platform === "win32")("creates new session files with private mode 0600", () => {
		expect(statSync(sessionFile).mode & 0o777).toBe(0o600);
	});

	it.skipIf(process.platform === "win32")("rejects a real metadata-only ctime change", () => {
		// Given: a manager accepted the file while its bytes and inode were stable.
		const manager = SessionManager.open(sessionFile, root);
		const acceptedEntries = manager.getEntries();
		const acceptedBytes = readFileSync(sessionFile);
		const accepted = statSync(sessionFile, { bigint: true });

		// When: chmod changes only inode metadata.
		chmodSync(sessionFile, 0o640);
		const changed = statSync(sessionFile, { bigint: true });

		// Then: real ctime distinguishes the generation and CAS rejects memory publication.
		expect(changed.dev).toBe(accepted.dev);
		expect(changed.ino).toBe(accepted.ino);
		expect(changed.birthtimeNs).toBe(accepted.birthtimeNs);
		expect(changed.ctimeNs).not.toBe(accepted.ctimeNs);
		expect(
			sameDurableFileGeneration(
				{
					dev: accepted.dev.toString(),
					ino: accepted.ino.toString(),
					birthtimeNs: accepted.birthtimeNs.toString(),
					ctimeNs: accepted.ctimeNs.toString(),
				},
				{
					dev: changed.dev.toString(),
					ino: changed.ino.toString(),
					birthtimeNs: changed.birthtimeNs.toString(),
					ctimeNs: changed.ctimeNs.toString(),
				},
			),
		).toBe(false);
		expect(() => manager.appendMessage(userMsg("metadata race"))).toThrow(SessionManagerStaleWriteError);
		expect(manager.getEntries()).toEqual(acceptedEntries);
		expect(readFileSync(sessionFile)).toEqual(acceptedBytes);
	});

	it("keeps the accepted session state when switching files fails", () => {
		const manager = SessionManager.open(sessionFile, root);
		const acceptedFile = manager.getSessionFile();
		const acceptedId = manager.getSessionId();
		const acceptedLeaf = manager.getLeafId();
		const target = SessionManager.create(root, root);
		target.appendMessage(userMsg("target seed"));
		target.appendMessage(assistantMsg("target seeded"));
		const targetFile = target.getSessionFile();
		if (!targetFile) throw new Error("expected target session file");
		const targetLease = acquireSessionOwnerLeaseSync(targetFile);

		try {
			expect(() => manager.setSessionFile(targetFile)).toThrow(SessionOwnerLeaseHeldError);
			expect(manager.getSessionFile()).toBe(acceptedFile);
			expect(manager.getSessionId()).toBe(acceptedId);
			expect(manager.getLeafId()).toBe(acceptedLeaf);
		} finally {
			targetLease.release();
		}
	});

	it("keeps the accepted leaf when a branch summary write fails", () => {
		const manager = SessionManager.open(sessionFile, root);
		const competitor = SessionManager.open(sessionFile, root);
		const acceptedEntries = manager.getEntries();
		const acceptedLeaf = manager.getLeafId();
		const branchFromId = acceptedEntries[0]?.id;
		if (!branchFromId) throw new Error("expected branch source");
		competitor.appendMessage(userMsg("advance durable head"));

		expect(() => manager.branchWithSummary(branchFromId, "must roll back")).toThrow(SessionManagerStaleWriteError);
		expect(manager.getEntries()).toEqual(acceptedEntries);
		expect(manager.getLeafId()).toBe(acceptedLeaf);
	});

	it("rejects a stale second manager without accepting its entry in memory", () => {
		// Given: two process-like managers accepted the same durable head.
		const first = SessionManager.open(sessionFile, root);
		const stale = SessionManager.open(sessionFile, root);
		const staleEntries = stale.getEntries();
		const staleLeaf = stale.getLeafId();

		// When: the first manager advances the durable head before the stale writer.
		const firstId = first.appendMessage(userMsg("first writer wins"));

		// Then: the stale append is rejected and neither its memory nor the durable file advances.
		expect(() => stale.appendMessage(userMsg("lost update"))).toThrow(/stale|changed|compare-and-swap/i);
		expect(stale.getEntries()).toEqual(staleEntries);
		expect(stale.getLeafId()).toBe(staleLeaf);
		const durable = loadEntriesFromFile(sessionFile);
		expect(durable.at(-1)).toMatchObject({ id: firstId });
		expect(readFileSync(sessionFile, "utf8")).not.toContain("lost update");
	});

	it.skipIf(process.platform === "win32")(
		"serializes two managers opened through symlink and hardlink aliases",
		() => {
			// Given: managers accepted one inode through three path aliases.
			const hardlink = join(root, "session-hardlink.jsonl");
			const symlink = join(root, "session-symlink.jsonl");
			linkSync(sessionFile, hardlink);
			symlinkSync(sessionFile, symlink);
			const winner = SessionManager.open(sessionFile, root);
			const hardStale = SessionManager.open(hardlink, root);
			const symlinkStale = SessionManager.open(symlink, root);

			// When: one manager advances the shared durable head.
			const winnerId = winner.appendMessage(userMsg("alias winner"));

			// Then: both alias managers reject their stale mutation.
			expect(() => hardStale.appendMessage(userMsg("hardlink lost"))).toThrow(/stale|changed/i);
			expect(() => symlinkStale.appendMessage(userMsg("symlink lost"))).toThrow(/stale|changed/i);
			expect(loadEntriesFromFile(sessionFile).at(-1)).toMatchObject({ id: winnerId });
		},
	);

	it.skipIf(process.platform === "win32")("rejects replacement of the durable session file identity", () => {
		// Given: a manager accepted the current inode and bytes.
		const manager = SessionManager.open(sessionFile, root);
		const acceptedEntries = manager.getEntries();
		const acceptedLeaf = manager.getLeafId();
		const sameBytes = readFileSync(sessionFile);

		// When: another process atomically replaces the file with identical bytes.
		atomicRewriteFileSync(sessionFile, sameBytes);

		// Then: identity CAS rejects the append even though the textual head is unchanged.
		expect(() => manager.appendMessage(userMsg("identity-lost-update"))).toThrow(/stale|identity|changed/i);
		expect(manager.getEntries()).toEqual(acceptedEntries);
		expect(manager.getLeafId()).toBe(acceptedLeaf);
		expect(readFileSync(sessionFile)).toEqual(sameBytes);
	});
});

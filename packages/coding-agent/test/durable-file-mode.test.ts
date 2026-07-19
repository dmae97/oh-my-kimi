import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atomicRewriteFileSync } from "../src/core/atomic-session-file.ts";
import { appendFileDurablySync, writeExclusiveFileDurablySync } from "../src/core/durable-file-io.ts";
import { RunJournalStore } from "../src/core/run-journal-store.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { classifySessionTermination } from "../src/core/session-termination.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

const modeFault = vi.hoisted(() => ({ enabled: false }));
vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>();
	return {
		...actual,
		fchmodSync: (fd: number, mode: number): void => {
			if (modeFault.enabled) throw Object.assign(new Error("injected chmod failure"), { code: "EPERM" });
			actual.fchmodSync(fd, mode);
		},
	};
});

const isWindows = process.platform === "win32";
const T0 = "2026-07-19T00:00:00.000Z";
const T1 = "2026-07-19T00:00:01.000Z";

describe.skipIf(isWindows)("private durable artifact modes", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "omk-private-mode-"));
		modeFault.enabled = false;
	});

	afterEach(() => {
		modeFault.enabled = false;
		rmSync(root, { recursive: true, force: true });
	});

	it("normalizes an existing session to exact 0600 including special bits on open", () => {
		// Given: a complete valid session has group access and a special bit.
		const author = SessionManager.create(root, root);
		author.appendMessage(userMsg("seed"));
		author.appendMessage(assistantMsg("seeded"));
		const path = author.getSessionFile();
		if (!path) throw new Error("expected session path");
		chmodSync(path, 0o4600);

		// When: the existing artifact is opened.
		SessionManager.open(path, root);

		// Then: its mode is exactly owner read/write with no special bits.
		expect(statSync(path).mode & 0o7777).toBe(0o600);
	});

	it("normalizes an existing journal to exact 0600 on open", () => {
		// Given: a valid closed journal was made world-readable.
		const path = join(root, "session.runjournal");
		const writer = RunJournalStore.open({ journalPath: path, sessionId: "session", now: () => T0 });
		writer.start({ runId: "run", sessionRevision: 0, timestamp: T0 });
		writer.finish({
			termination: classifySessionTermination({
				sessionId: "session",
				runId: "run",
				timestamp: T1,
				source: "observed",
				message: "Run completed.",
				cause: { area: "completed" },
				sideEffects: "none",
			}),
			sessionRevision: 1,
			timestamp: T1,
		});
		chmodSync(path, 0o644);

		// When: the accepted journal is reopened.
		RunJournalStore.open({ journalPath: path, sessionId: "session", now: () => T1 });

		// Then: opening itself restores exact privacy.
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("normalizes an existing artifact before append", () => {
		// Given: an existing private artifact has a permissive mode.
		const path = join(root, "append.jsonl");
		writeFileSync(path, "before\n", { mode: 0o644 });
		chmodSync(path, 0o644);

		// When: durable append opens it for mutation.
		appendFileDurablySync(path, Buffer.from("after\n"));

		// Then: content is appended and mode is exact 0600.
		expect(readFileSync(path, "utf8")).toBe("before\nafter\n");
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("normalizes an existing artifact during atomic rewrite", () => {
		// Given: an existing rewrite target is world-readable.
		const path = join(root, "rewrite.jsonl");
		writeFileSync(path, "before\n", { mode: 0o644 });
		chmodSync(path, 0o644);

		// When: it is atomically replaced.
		atomicRewriteFileSync(path, "after\n");

		// Then: the replacement is exact 0600.
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("creates append and exclusive artifacts as exact 0600 despite umask", () => {
		// Given: a restrictive umask that would remove owner bits from open(mode).
		const appendPath = join(root, "new-append.jsonl");
		const exclusivePath = join(root, "new-private.bin");
		const previous = process.umask(0o777);
		try {
			// When: both durable creation paths run.
			appendFileDurablySync(appendPath, Buffer.from("append\n"));
			writeExclusiveFileDurablySync(exclusivePath, Buffer.from("private\n"));
		} finally {
			process.umask(previous);
		}

		// Then: explicit descriptor normalization defeats umask.
		expect(statSync(appendPath).mode & 0o777).toBe(0o600);
		expect(statSync(exclusivePath).mode & 0o777).toBe(0o600);
	});

	it("fails explicitly when the platform refuses exact 0600", () => {
		// Given: a valid existing target and a platform-compatible EPERM failure.
		const path = join(root, "mode-error.jsonl");
		writeFileSync(path, "accepted\n");
		modeFault.enabled = true;
		const previous = process.umask(0o777);
		try {
			// When/Then: rewrite fails before rename with an explicit mode contract error.
			expect(() => atomicRewriteFileSync(path, "replacement\n")).toThrow(/private mode 0600.*EPERM/i);
		} finally {
			process.umask(previous);
		}
		expect(readFileSync(path, "utf8")).toBe("accepted\n");
	});
});

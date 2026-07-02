import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	MemorySessionStorage,
	type SessionStorageWriter,
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { SessionTitleUpdate } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";

interface DetachableWriter extends SessionStorageWriter {
	detach(): void;
}

class DetachingRewriteStorage extends MemorySessionStorage {
	readonly detachedLines: string[] = [];
	readonly rewriteStarted = Promise.withResolvers<void>();
	readonly allowRewrite = Promise.withResolvers<void>();
	pausedRewrites = 0;
	guardRejections = 0;
	readonly #writers = new Set<DetachableWriter>();

	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		const inner = super.openWriter(path, options);
		const writers = this.#writers;
		const detachedLines = this.detachedLines;
		let detached = false;
		const writer: DetachableWriter = {
			async append(line: string): Promise<void> {
				if (detached) {
					detachedLines.push(line);
					return;
				}
				await inner.append(line);
			},
			async flush(): Promise<void> {
				await inner.flush();
			},
			isOpen(): boolean {
				const open = inner.isOpen();
				return open;
			},
			async close(): Promise<void> {
				writers.delete(writer);
				await inner.close();
			},
			getError(): Error | undefined {
				const error = inner.getError();
				return error;
			},
			detach(): void {
				if (detached) return;
				detached = true;
			},
		};
		writers.add(writer);
		return writer;
	}

	override async writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		this.pausedRewrites++;
		this.rewriteStarted.resolve();
		await this.allowRewrite.promise;
		if (options?.commitGuard && !options.commitGuard()) {
			this.guardRejections++;
			return;
		}
		for (const writer of this.#writers) writer.detach();
		this.writeTextSync(path, content);
	}
}

class CloseGatedRewriteStorage extends MemorySessionStorage {
	readonly closeStarted = Promise.withResolvers<void>();
	readonly allowClose = Promise.withResolvers<void>();
	readonly writeStarted = Promise.withResolvers<void>();
	readonly allowWrite = Promise.withResolvers<void>();
	readonly detachedLines: string[] = [];
	writerOpens = 0;
	guardRejections = 0;
	readonly #detachables = new Set<DetachableWriter>();

	override openWriter(
		path: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
	): SessionStorageWriter {
		this.writerOpens++;
		const inner = super.openWriter(path, options);
		const closeStarted = this.closeStarted;
		const allowClose = this.allowClose;
		const detachedLines = this.detachedLines;
		const detachables = this.#detachables;
		let detached = false;
		const writer: DetachableWriter = {
			async append(line: string): Promise<void> {
				if (detached) {
					detachedLines.push(line);
					return;
				}
				await inner.append(line);
			},
			async flush(): Promise<void> {
				await inner.flush();
			},
			isOpen(): boolean {
				return inner.isOpen();
			},
			async close(): Promise<void> {
				closeStarted.resolve();
				await allowClose.promise;
				detachables.delete(writer);
				await inner.close();
			},
			getError(): Error | undefined {
				return inner.getError();
			},
			detach(): void {
				detached = true;
			},
		};
		detachables.add(writer);
		return writer;
	}

	override async writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		this.writeStarted.resolve();
		await this.allowWrite.promise;
		if (options?.commitGuard && !options.commitGuard()) {
			this.guardRejections++;
			return;
		}
		// Emulate the Windows post-EPERM fallback: writers opened against the
		// pre-replacement target end up attached to the moved-aside file after
		// this call returns, so their future appends are detached from `path`.
		for (const w of this.#detachables) w.detach();
		this.writeTextSync(path, content);
	}
}

describe("SessionManager atomic rewrite race", () => {
	it("keeps post-compaction appends on the current JSONL path", async () => {
		const storage = new DetachingRewriteStorage();
		const sessionManager = SessionManager.create("/cwd", "/sessions", storage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model");

		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
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
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await sessionManager.flush();
		sessionManager.appendMessage({ role: "user", content: "before compaction", timestamp: Date.now() });
		await sessionManager.flush();

		const firstKeptEntryId = sessionManager.getBranch()[0]?.id;
		if (!firstKeptEntryId) throw new Error("Expected seeded branch entry");
		sessionManager.appendCompaction("older summary", "older", firstKeptEntryId, 100);
		await sessionManager.flush();
		sessionManager.appendCompaction("newer summary", "newer", firstKeptEntryId, 80);
		await storage.rewriteStarted.promise;

		sessionManager.appendMessage({ role: "user", content: "during rewrite prompt", timestamp: Date.now() });
		sessionManager.appendCustomMessageEntry("during_rewrite_custom", "during rewrite custom", false);
		sessionManager.appendCustomEntry("session_exit", { reason: "dispose", kind: "normal" });
		const titlePersisted = sessionManager.setSessionName("Post rewrite title", "user", "test");

		storage.allowRewrite.resolve();
		await titlePersisted;
		await sessionManager.flush();
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "toolu_after_rewrite",
			toolName: "bash",
			content: [{ type: "text", text: "after rewrite tool" }],
			isError: false,
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "after rewrite assistant" }],
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
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await sessionManager.close();

		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const content = await storage.readText(sessionFile);
		const [titleSlot] = content.split("\n");
		expect(JSON.parse(titleSlot ?? "{}")).toMatchObject({
			type: "title",
			title: "Post rewrite title",
			source: "user",
		});
		expect(content).toContain("newer summary");
		expect(content).toContain("during rewrite prompt");
		expect(content).toContain("during rewrite custom");
		expect(content).toContain('"customType":"session_exit"');
		expect(content).toContain('"type":"title_change"');
		expect(content).toContain("after rewrite tool");
		expect(content).toContain("after rewrite assistant");
		expect(storage.detachedLines).toEqual([]);

		const reloaded = await SessionManager.open(sessionFile, "/sessions", storage, {
			initialCwd: "/cwd",
			suppressBreadcrumb: true,
		});
		const branch = reloaded.getBranch();
		expect(branch.some(entry => entry.type === "compaction" && entry.summary === "newer summary")).toBe(true);
		expect(
			branch.some(
				entry =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					entry.message.content === "during rewrite prompt",
			),
		).toBe(true);
		expect(
			branch.some(
				entry =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.content.some(part => part.type === "text" && part.text === "after rewrite assistant"),
			),
		).toBe(true);
		expect(reloaded.getSessionName()).toBe("Post rewrite title");
	});

	it("flushSync during an in-flight atomic rewrite durably publishes the exit record", async () => {
		const storage = new DetachingRewriteStorage();
		const sessionManager = SessionManager.create("/cwd", "/sessions", storage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model");

		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
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
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await sessionManager.flush();
		sessionManager.appendMessage({ role: "user", content: "before compaction", timestamp: Date.now() });
		await sessionManager.flush();

		const firstKeptEntryId = sessionManager.getBranch()[0]?.id;
		if (!firstKeptEntryId) throw new Error("Expected seeded branch entry");
		sessionManager.appendCompaction("older summary", "older", firstKeptEntryId, 100);
		await sessionManager.flush();
		// Second compaction elides the first, scheduling a full-file rewrite that
		// parks inside the fake storage until we release it.
		sessionManager.appendCompaction("newer summary", "newer", firstKeptEntryId, 80);
		await storage.rewriteStarted.promise;

		// Simulate a Ctrl+C teardown: append a session_exit custom entry (fenced
		// because the atomic rewrite is active) and flushSync it.
		sessionManager.appendCustomEntry("session_exit", { reason: "sigterm", kind: "signal" });
		expect(() => sessionManager.flushSync()).not.toThrow();

		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const afterFlush = await storage.readText(sessionFile);
		expect(afterFlush).toContain('"customType":"session_exit"');
		expect(afterFlush).toContain("newer summary");

		// Release the in-flight atomic rewrite. Its commitGuard MUST reject the
		// stale body serialized before flushSync bumped the disk epoch; otherwise
		// the async publish would overwrite the durable exit record.
		storage.allowRewrite.resolve();
		await Promise.resolve();
		await Promise.resolve();

		const afterRelease = await storage.readText(sessionFile);
		expect(afterRelease).toContain('"customType":"session_exit"');
		expect(afterRelease).toContain("newer summary");
		expect(storage.guardRejections).toBeGreaterThanOrEqual(1);
		expect(storage.detachedLines).toEqual([]);
	});
});

describe("SessionManager atomic rewrite fence spans writer.close()", () => {
	it("blocks a fresh writer from opening while an in-flight rewrite awaits writer.close()", async () => {
		const storage = new CloseGatedRewriteStorage();
		const sessionManager = SessionManager.create("/cwd", "/sessions", storage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model");

		// Seed an assistant message so the session materializes on disk without
		// opening a persistent writer (cold-path #rewriteSynchronously).
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
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
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await sessionManager.flush();
		// Second append takes the hot path and opens a persistent writer that
		// the atomic rewrite task must close before publishing the replacement.
		sessionManager.appendMessage({ role: "user", content: "before rewrite", timestamp: Date.now() });
		await sessionManager.flush();
		const opensBeforeRewrite = storage.writerOpens;
		expect(opensBeforeRewrite).toBeGreaterThan(0);

		// Schedule an atomic rewrite; the task opens by closing the current
		// writer, which parks on the fake's close gate. The fence must be active
		// throughout the entire close-yield window so no fresh writer opens.
		const rewrite = sessionManager.rewriteEntries();
		await storage.closeStarted.promise;

		sessionManager.appendMessage({ role: "user", content: "during close", timestamp: Date.now() });
		sessionManager.appendCustomEntry("during_close_custom", { reason: "guard" });
		// Pre-fix, #appendToSessionFile would take the hot path and call
		// storage.openWriter here; the writer would then be caught by the pending
		// writeTextAtomic detachment. Fence keeps writerOpens flat.
		expect(storage.writerOpens).toBe(opensBeforeRewrite);

		storage.allowClose.resolve();
		storage.allowWrite.resolve();
		await rewrite;
		await sessionManager.flush();

		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const content = await storage.readText(sessionFile);
		expect(content).toContain("during close");
		expect(content).toContain('"customType":"during_close_custom"');
		expect(storage.detachedLines).toEqual([]);
	});
});

class TitleFallbackPausingStorage extends MemorySessionStorage {
	readonly writeStarted = Promise.withResolvers<void>();
	readonly allowWrite = Promise.withResolvers<void>();
	writeTextAtomicCalls = 0;
	failNextUpdateTitle = false;

	override async updateSessionTitle(path: string, update: SessionTitleUpdate): Promise<void> {
		if (this.failNextUpdateTitle) {
			this.failNextUpdateTitle = false;
			throw new Error("updateSessionTitle forced failure");
		}
		return super.updateSessionTitle(path, update);
	}

	override async writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		this.writeTextAtomicCalls += 1;
		this.writeStarted.resolve();
		await this.allowWrite.promise;
		if (options?.commitGuard && !options.commitGuard()) return;
		this.writeTextSync(path, content);
	}
}

describe("SessionManager title-change fallback fenced-append durability", () => {
	it("loops on the dirty flag so fenced appends during the fallback rewrite persist", async () => {
		const storage = new TitleFallbackPausingStorage();
		const sessionManager = SessionManager.create("/cwd", "/sessions", storage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model");

		// Materialize the session on disk with a title slot present so a later
		// setSessionName takes the append-then-updateSessionTitle try branch
		// instead of the up-front #rewriteAtomically fallback.
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
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
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await sessionManager.flush();
		await sessionManager.setSessionName("initial title", "user", "seed");
		await sessionManager.flush();
		expect(storage.writeTextAtomicCalls).toBe(0);

		// Force the try branch to fail so the catch runs the atomic-rewrite loop.
		storage.failNextUpdateTitle = true;
		const rename = sessionManager.setSessionName("second title", "user", "test");
		await storage.writeStarted.promise;

		// Fenced appends during the paused fallback rewrite: pre-fix these
		// would be marked dirty and dropped from the serialized body because
		// the fallback never looped on that flag.
		sessionManager.appendMessage({
			role: "user",
			content: "during title fallback",
			timestamp: Date.now(),
		});
		sessionManager.appendCustomEntry("during_title_fallback_custom", { reason: "test" });

		storage.allowWrite.resolve();
		await rename;
		await sessionManager.flush();

		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const content = await storage.readText(sessionFile);
		expect(content).toContain('"title":"second title"');
		expect(content).toContain("during title fallback");
		expect(content).toContain('"customType":"during_title_fallback_custom"');
		// Loop must have executed at least twice: first pass paused, dirty from
		// the fenced appends triggers a second pass that includes them.
		expect(storage.writeTextAtomicCalls).toBeGreaterThanOrEqual(2);
	});
});

describe("SessionManager fence relaxes when flushSync supersedes the atomic rewrite", () => {
	it("routes post-flushSync appends onto the hot path so they land on disk before close()", async () => {
		const storage = new DetachingRewriteStorage();
		const sessionManager = SessionManager.create("/cwd", "/sessions", storage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model");

		// Materialize a session on disk so subsequent rewrites are meaningful.
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
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
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await sessionManager.flush();
		sessionManager.appendMessage({ role: "user", content: "before rewrite", timestamp: Date.now() });
		await sessionManager.flush();

		// Schedule an atomic rewrite that parks inside writeTextAtomic.
		const rewrite = sessionManager.rewriteEntries();
		await storage.rewriteStarted.promise;

		// (1) Append X1 while the fence epoch is still current: fenced into memory
		// and captured by flushSync's #fileBody() below.
		sessionManager.appendCustomEntry("during_active_atomic", { data: "X1" });

		// (2) flushSync supersedes the pending atomic (bumps #diskEpoch) and
		// publishes a synchronous body containing X1.
		expect(() => sessionManager.flushSync()).not.toThrow();

		// (3) Post-flushSync append MUST take the hot path: pre-fix, the fence
		// stayed active and this entry was only marked dirty, then dropped when
		// the pending atomic returned false and close() published nothing.
		sessionManager.appendMessage({
			role: "user",
			content: "post_flush_sync_prompt",
			timestamp: Date.now(),
		});
		sessionManager.appendCustomEntry("post_flush_sync_custom", { data: "X2" });

		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const midFlight = await storage.readText(sessionFile);
		expect(midFlight).toContain('"customType":"during_active_atomic"');
		expect(midFlight).toContain("post_flush_sync_prompt");
		expect(midFlight).toContain('"customType":"post_flush_sync_custom"');

		// Release the paused atomic rewrite. Its commitGuard MUST reject — a
		// stale publish now would clobber the hot-path appends written above.
		storage.allowRewrite.resolve();
		await rewrite;
		await sessionManager.close();

		const afterClose = await storage.readText(sessionFile);
		expect(afterClose).toContain('"customType":"during_active_atomic"');
		expect(afterClose).toContain("post_flush_sync_prompt");
		expect(afterClose).toContain('"customType":"post_flush_sync_custom"');
		expect(storage.guardRejections).toBeGreaterThanOrEqual(1);
		expect(storage.detachedLines).toEqual([]);
	});
});

interface PauseHandle {
	started: PromiseWithResolvers<void>;
	allow: PromiseWithResolvers<void>;
}

class SequencedRewriteStorage extends MemorySessionStorage {
	readonly detachedLines: string[] = [];
	readonly pauses: PauseHandle[] = [];
	guardRejections = 0;
	writerOpens = 0;
	pauseCount = 0;
	#calls = 0;
	readonly #writers = new Set<DetachableWriter>();

	override openWriter(
		path: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
	): SessionStorageWriter {
		this.writerOpens++;
		const inner = super.openWriter(path, options);
		const writers = this.#writers;
		const detachedLines = this.detachedLines;
		let detached = false;
		const writer: DetachableWriter = {
			async append(line: string): Promise<void> {
				if (detached) {
					detachedLines.push(line);
					return;
				}
				await inner.append(line);
			},
			async flush(): Promise<void> {
				await inner.flush();
			},
			isOpen(): boolean {
				return inner.isOpen();
			},
			async close(): Promise<void> {
				writers.delete(writer);
				await inner.close();
			},
			getError(): Error | undefined {
				return inner.getError();
			},
			detach(): void {
				detached = true;
			},
		};
		writers.add(writer);
		return writer;
	}

	override async writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		const index = this.#calls++;
		if (index < this.pauseCount) {
			const pause: PauseHandle = {
				started: Promise.withResolvers<void>(),
				allow: Promise.withResolvers<void>(),
			};
			this.pauses.push(pause);
			pause.started.resolve();
			await pause.allow.promise;
		}
		if (options?.commitGuard && !options.commitGuard()) {
			this.guardRejections++;
			return;
		}
		for (const w of this.#writers) w.detach();
		this.writeTextSync(path, content);
	}
}

describe("SessionManager fence handoff across superseded rewrites", () => {
	it("preserves the newer fence when a stale rewrite unwinds after flushSync", async () => {
		const storage = new SequencedRewriteStorage();
		storage.pauseCount = 2;
		const sessionManager = SessionManager.create("/cwd", "/sessions", storage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model");

		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
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
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await sessionManager.flush();
		sessionManager.appendMessage({ role: "user", content: "before rewrite", timestamp: Date.now() });
		await sessionManager.flush();
		expect(storage.writerOpens).toBeGreaterThan(0);

		// Stale rewrite parks at pauses[0]. Fence epoch = 0.
		const stale = sessionManager.rewriteEntries();
		while (storage.pauses.length < 1) await Promise.resolve();
		await storage.pauses[0].started.promise;

		// A fenced append flips fileIsCurrent so flushSync actually publishes,
		// bumping the epoch to 1 with the fenced entry captured in the body.
		sessionManager.appendCustomEntry("during_stale", { data: "X1" });
		expect(() => sessionManager.flushSync()).not.toThrow();

		// Newer rewrite scheduled at epoch=1. Parks at pauses[1]. Fence epoch = 1.
		const newer = sessionManager.rewriteEntries();
		while (storage.pauses.length < 2) await Promise.resolve();
		await storage.pauses[1].started.promise;

		const opensBeforeUnwind = storage.writerOpens;

		// Release the stale rewrite. Its `finally` MUST NOT clear the newer
		// fence — pre-fix an unconditional reset stranded the newer rewrite's
		// epoch bookkeeping so subsequent appends took the hot path and were
		// then detached by the newer publish.
		storage.pauses[0].allow.resolve();
		for (let i = 0; i < 20; i++) await Promise.resolve();

		// Sync append during the newer rewrite: MUST still be fenced.
		sessionManager.appendCustomEntry("during_newer", { data: "X2" });
		expect(storage.writerOpens).toBe(opensBeforeUnwind);

		// Release the newer rewrite. Its dirty-loop second iteration is not
		// paused (pauseCount=2) and captures X2 into the published body.
		storage.pauses[1].allow.resolve();

		await stale;
		await newer;
		await sessionManager.close();

		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const content = await storage.readText(sessionFile);
		expect(content).toContain('"customType":"during_stale"');
		expect(content).toContain('"customType":"during_newer"');
		expect(storage.guardRejections).toBeGreaterThanOrEqual(1);
		expect(storage.detachedLines).toEqual([]);
	});
});

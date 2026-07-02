import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	MemorySessionStorage,
	type SessionStorageWriter,
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";

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

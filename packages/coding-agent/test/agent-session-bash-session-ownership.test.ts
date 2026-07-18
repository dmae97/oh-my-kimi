import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as bashExecutor from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const bashResult = {
	output: "old-output",
	exitCode: 0,
	cancelled: false,
	truncated: false,
	totalLines: 1,
	totalBytes: 10,
	outputLines: 1,
	outputBytes: 10,
};

describe("AgentSession bash session ownership", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let additionalManagers: SessionManager[];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-bash-session-owner-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		additionalManagers = [];
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		await Promise.all(additionalManagers.map(manager => manager.close()));
		authStorage.close();
		tempDir.removeSync();
	});

	function createSession(
		sessionManager: SessionManager = SessionManager.inMemory(tempDir.path()),
		extensionRunner?: ExtensionRunner,
		responseContent: () => string[] = () => ["Done"],
	): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const mock = createMockModel({ handler: () => ({ content: responseContent() }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner,
		});
		return session;
	}

	function createGatedBashRunner() {
		const completion = Promise.withResolvers<{ result: typeof bashResult }>();
		const emitUserBash = vi.fn(() => completion.promise);
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "user_bash"),
			emitUserBash,
			emit: vi.fn().mockResolvedValue(undefined),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
		} as unknown as ExtensionRunner;
		return { completion, emitUserBash, extensionRunner };
	}

	async function seedPersistedSession(): Promise<string> {
		await session.prompt("seed prompt");
		await session.waitForIdle();
		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error("Expected persisted session file");
		return sessionFile;
	}

	it("does not flush a pending bash result into a replacement session", async () => {
		createSession();
		let forceStreaming = true;
		Object.defineProperty(session, "isStreaming", {
			configurable: true,
			get: () => forceStreaming,
		});

		const oldSessionId = session.sessionId;
		session.recordBashResult("old-session-command", bashResult);
		expect(session.hasPendingBashMessages).toBe(true);

		forceStreaming = false;
		await session.newSession();
		expect(session.sessionId).not.toBe(oldSessionId);
		expect(session.hasPendingBashMessages).toBe(false);

		await session.prompt("new-session-prompt");
		await session.waitForIdle();

		expect(session.messages.some(message => message.role === "bashExecution")).toBe(false);
	});

	it("keeps a queued bash result on the branch discarded by an empty stop", async () => {
		const sessionManager = SessionManager.inMemory(tempDir.path());
		let returnEmptyStop = true;
		createSession(sessionManager, undefined, () => (returnEmptyStop ? [] : ["Done"]));
		let forceStreaming = false;
		Object.defineProperty(session, "isStreaming", {
			configurable: true,
			get: () => forceStreaming,
		});
		let discardedAssistantTimestamp: number | undefined;
		const unsubscribe = session.agent.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "assistant" && returnEmptyStop) {
				forceStreaming = true;
				discardedAssistantTimestamp = event.message.timestamp;
				session.recordBashResult("discarded-turn-command", bashResult);
			} else if (event.type === "agent_end") {
				forceStreaming = false;
			}
		});

		const started = await session.sendCustomMessage(
			{
				customType: "ownership-test",
				content: "Run an accepted empty turn",
				display: false,
				attribution: "agent",
			},
			{ deliverAs: "nextTurn", triggerTurn: true, acceptTerminalEmptyStop: true },
		);
		unsubscribe();
		expect(started).toBe(true);
		expect(session.hasPendingBashMessages).toBe(true);
		const discardedAssistantEntry = sessionManager
			.getEntries()
			.find(
				entry =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.timestamp === discardedAssistantTimestamp,
			);
		if (!discardedAssistantEntry) throw new Error("Expected discarded assistant entry");

		returnEmptyStop = false;
		await session.prompt("flush queued bash result");
		await session.waitForIdle();

		const bashEntry = sessionManager
			.getEntries()
			.find(
				entry =>
					entry.type === "message" &&
					entry.message.role === "bashExecution" &&
					entry.message.command === "discarded-turn-command",
			);
		expect(bashEntry?.parentId).toBe(discardedAssistantEntry.id);
		expect(
			sessionManager
				.getBranch()
				.some(
					entry =>
						entry.type === "message" &&
						entry.message.role === "bashExecution" &&
						entry.message.command === "discarded-turn-command",
				),
		).toBe(false);
	});

	it("releases the bash owner when session transition preparation fails", async () => {
		const sessionDir = path.join(tempDir.path(), "sessions");
		const { completion, emitUserBash, extensionRunner } = createGatedBashRunner();
		createSession(SessionManager.create(tempDir.path(), sessionDir), extensionRunner);
		await seedPersistedSession();
		const oldSessionId = session.sessionId;
		const bashPromise = session.executeBash("old-session-command");
		expect(emitUserBash).toHaveBeenCalledTimes(1);
		vi.spyOn(session.sessionManager, "flush").mockRejectedValueOnce(new Error("synthetic flush failure"));

		await expect(session.newSession()).rejects.toThrow("synthetic flush failure");
		expect(session.sessionId).toBe(oldSessionId);
		completion.resolve({ result: bashResult });
		const settledResult = await bashPromise;

		expect(settledResult).toEqual(bashResult);
		expect(
			session.messages.some(
				message => message.role === "bashExecution" && message.command === "old-session-command",
			),
		).toBe(true);
	});

	it.each(["new", "switch", "branch"] as const)(
		"records a late bash result in its original session after %s",
		async transition => {
			const sessionDir = path.join(tempDir.path(), "sessions");
			const { completion, emitUserBash, extensionRunner } = createGatedBashRunner();
			createSession(SessionManager.create(tempDir.path(), sessionDir), extensionRunner);
			const oldSessionFile = await seedPersistedSession();
			const oldSessionId = session.sessionId;

			const bashPromise = session.executeBash("old-session-command");
			expect(emitUserBash).toHaveBeenCalledTimes(1);

			switch (transition) {
				case "new":
					await session.newSession();
					break;
				case "switch": {
					const targetManager = SessionManager.create(tempDir.path(), sessionDir);
					targetManager.appendMessage({ role: "user", content: "target", timestamp: Date.now() });
					targetManager.appendMessage(createAssistantMessage("target reply"));
					await targetManager.ensureOnDisk();
					const targetFile = targetManager.getSessionFile();
					if (!targetFile) throw new Error("Expected target session file");
					await targetManager.close();
					await session.switchSession(targetFile);
					break;
				}
				case "branch": {
					const userEntry = session.sessionManager
						.getEntries()
						.find(entry => entry.type === "message" && entry.message.role === "user");
					if (!userEntry) throw new Error("Expected user entry for branch");
					await session.branch(userEntry.id);
					break;
				}
			}

			expect(session.sessionId).not.toBe(oldSessionId);
			completion.resolve({ result: bashResult });
			await bashPromise;

			expect(
				session.messages.some(
					message => message.role === "bashExecution" && message.command === "old-session-command",
				),
			).toBe(false);

			const oldSession = await SessionManager.open(oldSessionFile, sessionDir, undefined, {
				initialCwd: tempDir.path(),
				suppressBreadcrumb: true,
			});
			additionalManagers.push(oldSession);
			const oldMessages = oldSession.getBranch().flatMap(entry => (entry.type === "message" ? [entry.message] : []));
			expect(oldMessages.slice(-3).map(message => message.role)).toEqual(["user", "assistant", "bashExecution"]);
			expect(oldMessages.at(-1)).toMatchObject({
				role: "bashExecution",
				command: "old-session-command",
				output: "old-output",
			});
		},
	);

	it("stores minimized bash output with the originating session", async () => {
		const sessionDir = path.join(tempDir.path(), "sessions");
		createSession(SessionManager.create(tempDir.path(), sessionDir));
		const oldSessionFile = await seedPersistedSession();
		const bashStarted = Promise.withResolvers<void>();
		const finishBash = Promise.withResolvers<void>();
		let artifactId: string | undefined;
		vi.spyOn(bashExecutor, "executeBash").mockImplementation(async (_command, options) => {
			bashStarted.resolve();
			await finishBash.promise;
			artifactId = await options?.onMinimizedSave?.("full old-session output", {
				filter: "test",
				inputBytes: 23,
				outputBytes: 10,
			});
			return { ...bashResult, output: artifactId ? `[raw output: artifact://${artifactId}]` : "missing artifact" };
		});

		const bashPromise = session.executeBash("large old-session command");
		await bashStarted.promise;
		await session.newSession();
		finishBash.resolve();
		await bashPromise;

		expect(artifactId).toBeDefined();
		const oldSession = await SessionManager.open(oldSessionFile, sessionDir, undefined, {
			initialCwd: tempDir.path(),
			suppressBreadcrumb: true,
		});
		additionalManagers.push(oldSession);
		const artifactPath = await oldSession.getArtifactPath(artifactId!);
		expect(artifactPath).not.toBeNull();
		expect(await Bun.file(artifactPath!).text()).toBe("full old-session output");
		expect(await session.sessionManager.getArtifactPath(artifactId!)).toBeNull();
		expect(
			oldSession
				.getBranch()
				.some(
					entry =>
						entry.type === "message" &&
						entry.message.role === "bashExecution" &&
						entry.message.output.includes(`artifact://${artifactId}`),
				),
		).toBe(true);
	});

	it("does not recreate a dropped session for a late bash result or artifact", async () => {
		const sessionDir = path.join(tempDir.path(), "sessions");
		createSession(SessionManager.create(tempDir.path(), sessionDir));
		const oldSessionFile = await seedPersistedSession();
		const oldArtifactsDir = oldSessionFile.slice(0, -6);
		const bashStarted = Promise.withResolvers<void>();
		const finishBash = Promise.withResolvers<void>();
		vi.spyOn(bashExecutor, "executeBash").mockImplementation(async (_command, options) => {
			bashStarted.resolve();
			await finishBash.promise;
			const artifactId = await options?.onMinimizedSave?.("discarded raw output", {
				filter: "test",
				inputBytes: 20,
				outputBytes: 9,
			});
			return { ...bashResult, output: artifactId ? `[raw output: artifact://${artifactId}]` : "discarded" };
		});

		const bashPromise = session.executeBash("dropped-session-command");
		await bashStarted.promise;
		await session.newSession({ drop: true });
		expect(fs.existsSync(oldSessionFile)).toBe(false);
		expect(fs.existsSync(oldArtifactsDir)).toBe(false);

		finishBash.resolve();
		await bashPromise;

		expect(fs.existsSync(oldSessionFile)).toBe(false);
		expect(fs.existsSync(oldArtifactsDir)).toBe(false);
		expect(
			session.messages.some(
				message => message.role === "bashExecution" && message.command === "dropped-session-command",
			),
		).toBe(false);
	});

	it("keeps a late bash result on the branch where it started", async () => {
		const sessionDir = path.join(tempDir.path(), "sessions");
		const { completion, extensionRunner } = createGatedBashRunner();
		createSession(SessionManager.create(tempDir.path(), sessionDir), extensionRunner);
		await session.prompt("first prompt");
		await session.waitForIdle();
		await session.prompt("second prompt");
		await session.waitForIdle();

		const firstUserEntry = session.sessionManager
			.getEntries()
			.find(entry => entry.type === "message" && entry.message.role === "user");
		if (!firstUserEntry) throw new Error("Expected first user entry");
		const originalLeafId = session.sessionManager.getLeafId();
		if (!originalLeafId) throw new Error("Expected original branch leaf");

		const bashPromise = session.executeBash("old-branch-command");
		await session.navigateTree(firstUserEntry.id);
		const navigatedLeafId = firstUserEntry.parentId;
		expect(session.sessionManager.getLeafId()).toBe(navigatedLeafId);

		completion.resolve({ result: bashResult });
		await bashPromise;

		const bashEntry = session.sessionManager
			.getEntries()
			.find(
				entry =>
					entry.type === "message" &&
					entry.message.role === "bashExecution" &&
					entry.message.command === "old-branch-command",
			);
		expect(bashEntry?.parentId).toBe(originalLeafId);
		expect(session.sessionManager.getLeafId()).toBe(navigatedLeafId);
		expect(
			session.messages.some(message => message.role === "bashExecution" && message.command === "old-branch-command"),
		).toBe(false);
	});
});

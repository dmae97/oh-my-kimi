/**
 * Contract tests for the three shared memory tool factories.
 *
 * These exercise the public tool surface (factory gating + execute path) by
 * spying on `HindsightApi.prototype.{retain, recall, reflect}` and stubbing
 * Hindsight state on the fake ToolSession. We deliberately do not boot a real
 * session — these tools only need a populated state accessor and Settings.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import { mnemosyneBackend } from "@oh-my-pi/pi-coding-agent/mnemosyne/backend";
import { loadMnemosyneConfig, type MnemosyneBackendConfig } from "@oh-my-pi/pi-coding-agent/mnemosyne/config";
import {
	getMnemosyneScopedDbPaths,
	getMnemosyneSessionState,
	MnemosyneSessionState,
	setMnemosyneSessionState,
} from "@oh-my-pi/pi-coding-agent/mnemosyne/state";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { MemoryRecallTool } from "@oh-my-pi/pi-coding-agent/tools/memory-recall";
import { MemoryReflectTool } from "@oh-my-pi/pi-coding-agent/tools/memory-reflect";
import { MemoryRetainTool } from "@oh-my-pi/pi-coding-agent/tools/memory-retain";

const TEST_SESSION_ID = "test-session-id";
let registeredState: HindsightSessionState | undefined;
let registeredMnemosyneState: MnemosyneSessionState | undefined;
let tempDbPath: string | undefined;

function makeConfig(overrides: Partial<HindsightConfig> = {}): HindsightConfig {
	return {
		hindsightApiUrl: "http://localhost:8888",
		hindsightApiToken: null,
		bankId: null,
		bankIdPrefix: "",
		scoping: "global",
		bankMission: "",
		retainMission: null,
		autoRecall: true,
		autoRetain: true,
		retainMode: "full-session",
		retainEveryNTurns: 3,
		retainOverlapTurns: 2,
		retainContext: "omp",
		recallBudget: "mid",
		recallMaxTokens: 1024,
		recallTypes: ["world", "experience"],
		recallContextTurns: 1,
		recallMaxQueryChars: 800,
		recallPromptPreamble: "preamble",
		debug: false,
		mentalModelsEnabled: false,
		mentalModelAutoSeed: false,
		mentalModelRefreshIntervalMs: 5 * 60 * 1000,
		mentalModelMaxRenderChars: 16_000,
		...overrides,
	};
}

function makeSession(settings: Settings, sessionId: string | null = TEST_SESSION_ID): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionId: () => sessionId,
		getSessionSpawns: () => null,
		getHindsightSessionState: () => (sessionId === TEST_SESSION_ID ? registeredState : undefined),
		getMnemosyneSessionState: () => (sessionId === TEST_SESSION_ID ? registeredMnemosyneState : undefined),
	} as unknown as ToolSession;
}

interface RegisterStateOptions {
	retainTags?: string[];
	recallTags?: string[];
	recallTagsMatch?: "any" | "all" | "any_strict" | "all_strict";
	sessionOverrides?: Record<string, unknown>;
}

function registerState(client: HindsightApi, settings?: Settings, opts: RegisterStateOptions = {}) {
	registeredState = new HindsightSessionState({
		sessionId: TEST_SESSION_ID,
		client,
		bankId: "test-bank",
		retainTags: opts.retainTags,
		recallTags: opts.recallTags,
		recallTagsMatch: opts.recallTagsMatch,
		config: makeConfig(),
		session: {
			sessionId: TEST_SESSION_ID,
			sessionManager: { getEntries: () => [] } as never,
			emitNotice: () => {},
			getHindsightSessionState: () => registeredState,
			...opts.sessionOverrides,
		} as never,
		missionsSet: new Set(),
		lastRetainedTurn: 0,
		hasRecalledForFirstTurn: false,
	});
	void settings;
}

function makeMnemosyneConfig(
	overrides: (Partial<MnemosyneBackendConfig> & Record<string, unknown>) | undefined = {},
): MnemosyneBackendConfig {
	if (!tempDbPath) {
		const tempDir = path.join(tmpdir(), `mnemosyne-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		tempDbPath = path.join(tempDir, "mnemosyne.db");
	}
	return {
		dbPath: tempDbPath,
		bank: "test-bank",
		autoRecall: true,
		autoRetain: true,
		retainEveryNTurns: 3,
		recallLimit: 10,
		recallContextTurns: 1,
		recallMaxQueryChars: 800,
		injectionTokenLimit: 1024,
		debug: false,
		providerOptions: {
			noEmbeddings: true,
			embeddingModel: undefined,
			embeddingApiUrl: undefined,
			embeddingApiKey: undefined,
			llm: false,
		},
		llmMode: "none",
		llmBaseUrl: undefined,
		llmApiKey: undefined,
		llmModel: undefined,
		...overrides,
	};
}

interface RegisterMnemosyneStateOptions {
	cwd?: string;
	sessionId?: string;
}

function registerMnemosyneState(
	config?: MnemosyneBackendConfig,
	options: RegisterMnemosyneStateOptions = {},
): MnemosyneSessionState {
	const finalConfig = config ?? makeMnemosyneConfig();
	const sessionId = options.sessionId ?? TEST_SESSION_ID;
	registeredMnemosyneState = new MnemosyneSessionState({
		sessionId,
		config: finalConfig,
		session: {
			sessionId,
			sessionManager: {
				getEntries: () => [],
				getCwd: () => options.cwd ?? "/tmp",
			} as never,
			emitNotice: () => {},
			getHindsightSessionState: () => undefined,
		} as never,
	});
	return registeredMnemosyneState;
}

describe("Hindsight tool factories", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredState = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		registeredState = undefined;
	});

	it("retain/recall/reflect factories return null when memory.backend !== hindsight", () => {
		const settings = Settings.isolated({ "memory.backend": "local", "memories.enabled": false });
		const session = makeSession(settings);
		expect(MemoryRetainTool.createIf(session)).toBeNull();
		expect(MemoryRecallTool.createIf(session)).toBeNull();
		expect(MemoryReflectTool.createIf(session)).toBeNull();
	});

	it("retain/recall/reflect factories return tool instances when memory.backend === hindsight", () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const session = makeSession(settings);
		expect(MemoryRetainTool.createIf(session)).toBeInstanceOf(MemoryRetainTool);
		expect(MemoryRecallTool.createIf(session)).toBeInstanceOf(MemoryRecallTool);
		expect(MemoryReflectTool.createIf(session)).toBeInstanceOf(MemoryReflectTool);
	});
});

describe("Mnemosyne tool factories", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredMnemosyneState = undefined;
		tempDbPath = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		registeredMnemosyneState = undefined;
		if (tempDbPath) {
			try {
				const tempDir = path.dirname(tempDbPath);
				rmSync(tempDir, { recursive: true, force: true });
			} catch {}
			tempDbPath = undefined;
		}
	});

	it("retain/recall/reflect factories return null when memory.backend !== mnemosyne", () => {
		const settings = Settings.isolated({ "memory.backend": "local", "memories.enabled": false });
		const session = makeSession(settings);
		expect(MemoryRetainTool.createIf(session)).toBeNull();
		expect(MemoryRecallTool.createIf(session)).toBeNull();
		expect(MemoryReflectTool.createIf(session)).toBeNull();
	});

	it("retain/recall/reflect factories return tool instances when memory.backend === mnemosyne", () => {
		const settings = Settings.isolated({ "memory.backend": "mnemosyne" });
		const session = makeSession(settings);
		expect(MemoryRetainTool.createIf(session)).toBeInstanceOf(MemoryRetainTool);
		expect(MemoryRecallTool.createIf(session)).toBeInstanceOf(MemoryRecallTool);
		expect(MemoryReflectTool.createIf(session)).toBeInstanceOf(MemoryReflectTool);
	});
});

describe("retain.execute", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredState = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		registeredState = undefined;
	});

	it("queues the memory and reports success without calling the API", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const retainBatchSpy = vi.spyOn(HindsightApi.prototype, "retainBatch").mockResolvedValue({} as never);
		const retainSpy = vi.spyOn(HindsightApi.prototype, "retain").mockResolvedValue({} as never);
		registerState(client, settings);

		const tool = MemoryRetainTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-1", { items: [{ content: "user prefers tabs" }] });

		expect(result.content[0]).toEqual({ type: "text", text: "1 memory queued." });
		// Tool returns before any HTTP work happens.
		expect(retainBatchSpy).not.toHaveBeenCalled();
		expect(retainSpy).not.toHaveBeenCalled();
		expect(registeredState?.retainQueue.depth).toBe(1);
	});

	it("flushes a multi-item tool call as a single retainBatch call with per-item context", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const retainBatchSpy = vi.spyOn(HindsightApi.prototype, "retainBatch").mockResolvedValue({} as never);
		registerState(client, settings, { retainTags: ["project:pi"] });

		const tool = MemoryRetainTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-batch", {
			items: [{ content: "fact one" }, { content: "fact two", context: "user override" }],
		});
		expect(result.content[0]).toEqual({ type: "text", text: "2 memories queued." });

		await registeredState?.flushRetainQueue();

		expect(retainBatchSpy).toHaveBeenCalledTimes(1);
		const [bankId, items, options] = retainBatchSpy.mock.calls[0];
		expect(bankId).toBe("test-bank");
		expect(options).toEqual(expect.objectContaining({ async: true }));
		expect(items).toEqual([
			expect.objectContaining({
				content: "fact one",
				metadata: { session_id: TEST_SESSION_ID },
				tags: ["project:pi"],
			}),
			expect.objectContaining({
				content: "fact two",
				context: "user override",
				metadata: { session_id: TEST_SESSION_ID },
				tags: ["project:pi"],
			}),
		]);
		expect(registeredState?.retainQueue.depth).toBe(0);
	});

	it("emits a UI-only warning notice when the batch flush fails", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "retainBatch").mockRejectedValue(new Error("HTTP 503"));
		const noticeSpy = vi.fn();
		registerState(client, settings, { sessionOverrides: { emitNotice: noticeSpy } });

		const tool = MemoryRetainTool.createIf(makeSession(settings))!;
		await tool.execute("call-x", { items: [{ content: "doomed fact" }] });
		await registeredState?.flushRetainQueue();

		expect(noticeSpy).toHaveBeenCalledTimes(1);
		const [level, message, source] = noticeSpy.mock.calls[0];
		expect(level).toBe("warning");
		expect(source).toBe("Hindsight");
		expect(message).toContain("HTTP 503");
		expect(message).toContain("1 memory");
	});

	it("throws when no per-session state is registered", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const tool = MemoryRetainTool.createIf(makeSession(settings))!;
		await expect(tool.execute("call-2", { items: [{ content: "x" }] })).rejects.toThrow(/not initialised/i);
	});
});

describe("retain.execute (Mnemosyne backend)", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredMnemosyneState = undefined;
		tempDbPath = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		registeredMnemosyneState?.dispose();
		registeredMnemosyneState = undefined;
		if (tempDbPath) {
			try {
				const tempDir = path.dirname(tempDbPath);
				rmSync(tempDir, { recursive: true, force: true });
			} catch {}
			tempDbPath = undefined;
		}
	});

	it("writes memories synchronously and returns a stored success message", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemosyne" });
		registerMnemosyneState();

		const tool = MemoryRetainTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-mnemosyne-1", {
			items: [{ content: "user prefers tabs", context: "editor configuration" }],
		});

		expect(result.content[0]).toEqual({ type: "text", text: "1 memory stored." });

		// Verify the memory was actually stored by recalling it
		const recallTool = MemoryRecallTool.createIf(makeSession(settings))!;
		const recallResult = await recallTool.execute("call-mnemosyne-recall", { query: "user preferences" });

		const text = (recallResult.content[0] as { text: string }).text;
		expect(text).toContain("user prefers tabs");
	});

	it("stores multiple memories and returns correct count", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemosyne" });
		registerMnemosyneState();

		const tool = MemoryRetainTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-mnemosyne-multi", {
			items: [
				{ content: "fact one" },
				{ content: "fact two", context: "additional context" },
				{ content: "fact three" },
			],
		});

		expect(result.content[0]).toEqual({ type: "text", text: "3 memories stored." });

		// Verify all memories are recallable
		const recallTool = MemoryRecallTool.createIf(makeSession(settings))!;
		const recallResult = await recallTool.execute("call-mnemosyne-recall-multi", { query: "facts" });

		const text = (recallResult.content[0] as { text: string }).text;
		expect(text).toContain("fact one");
		expect(text).toContain("fact two");
		expect(text).toContain("fact three");
	});

	it("isolates memories between projects when scoping is per-project", async () => {
		const settings = Settings.isolated({
			"memory.backend": "mnemosyne",
			"mnemosyne.scoping": "per-project",
		});
		const alphaConfig = makeMnemosyneConfig({ scoping: "per-project", bank: "project-alpha" });
		const betaConfig = makeMnemosyneConfig({ scoping: "per-project", bank: "project-beta" });
		registerMnemosyneState(alphaConfig, { cwd: "/work/project-alpha" });
		await MemoryRetainTool.createIf(makeSession(settings))!.execute("call-mnemosyne-alpha-store", {
			items: [{ content: "alpha uses tabs" }],
		});
		registeredMnemosyneState?.dispose();
		registerMnemosyneState(betaConfig, { cwd: "/work/project-beta" });
		const betaRecall = await MemoryRecallTool.createIf(makeSession(settings))!.execute("call-mnemosyne-beta-recall", {
			query: "tabs",
		});
		expect(betaRecall.content[0]).toEqual({ type: "text", text: "No relevant memories found." });
		registeredMnemosyneState?.dispose();
		registerMnemosyneState(alphaConfig, { cwd: "/work/project-alpha" });
		const alphaRecall = await MemoryRecallTool.createIf(makeSession(settings))!.execute(
			"call-mnemosyne-alpha-recall",
			{ query: "tabs" },
		);
		expect((alphaRecall.content[0] as { text: string }).text).toContain("alpha uses tabs");
	});
	it("throws when no per-session Mnemosyne state is registered", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemosyne" });
		const tool = MemoryRetainTool.createIf(makeSession(settings))!;
		await expect(tool.execute("call-mnemosyne-no-state", { items: [{ content: "x" }] })).rejects.toThrow(
			/not initialised/i,
		);
	});
});

describe("Mnemosyne backend lifecycle", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredMnemosyneState = undefined;
		tempDbPath = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		registeredMnemosyneState?.dispose();
		registeredMnemosyneState = undefined;
		if (tempDbPath) {
			try {
				rmSync(path.dirname(tempDbPath), { recursive: true, force: true });
			} catch {}
			tempDbPath = undefined;
		}
	});

	it("auto-retain uses the cumulative transcript turn count", async () => {
		const entries = Array.from({ length: 4 }, (_, index) => ({
			type: "message",
			message: { role: "user", content: `turn ${index + 1}` },
		}));
		const state = registerMnemosyneState(makeMnemosyneConfig({ retainEveryNTurns: 4 }), {
			cwd: "/work/project-alpha",
		});
		(state.session.sessionManager as { getEntries: () => unknown[] }).getEntries = () => entries;
		const retainSpy = vi.spyOn(state, "retainMessages").mockResolvedValue();

		await state.maybeRetainOnAgentEnd([{ role: "user", content: [{ type: "text", text: "turn 4" }] }] as never);

		expect(retainSpy).toHaveBeenCalledTimes(1);
		expect(retainSpy.mock.calls[0][0]).toEqual([
			{ role: "user", content: "turn 1" },
			{ role: "user", content: "turn 2" },
			{ role: "user", content: "turn 3" },
			{ role: "user", content: "turn 4" },
		]);
		expect(state.lastRetainedTurn).toBe(4);
	});

	it("registers subagent aliases from parent Mnemosyne state without Hindsight", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemosyne" });
		const parentState = registerMnemosyneState();
		const childSession = {
			sessionId: "child-session-id",
			settings,
			sessionManager: {
				getEntries: () => [],
				getCwd: () => "/tmp",
			},
			emitNotice: () => {},
		} as never;

		await mnemosyneBackend.start({
			session: childSession,
			settings,
			modelRegistry: {} as never,
			agentDir: path.dirname(tempDbPath!),
			taskDepth: 1,
			parentMnemosyneSessionState: parentState,
		});

		const childState = getMnemosyneSessionState(childSession);
		expect(childState?.aliasOf).toBe(parentState);
		expect(childState?.getScopedRetainTarget().bank).toBe(parentState.getScopedRetainTarget().bank);
		childState?.dispose();
	});

	it("clears every scoped Mnemosyne database for per-project-tagged mode", async () => {
		const config = makeMnemosyneConfig({
			scoping: "per-project-tagged",
			bank: "project-alpha",
			globalBank: "default",
			retainBank: "project-alpha",
			recallBanks: ["project-alpha", "default"],
		});
		const state = registerMnemosyneState(config, { cwd: "/work/project-alpha" });
		state.rememberInScope("project clear marker", { scope: "bank", extract: false, source: "test" });
		state.globalMemory?.remember("global clear marker", { scope: "bank", extract: false, source: "test" });
		const dbPaths = getMnemosyneScopedDbPaths(config);
		for (const dbPath of dbPaths) expect(existsSync(dbPath)).toBe(true);
		const session = state.session;
		setMnemosyneSessionState(session, state);

		await mnemosyneBackend.clear(path.dirname(config.dbPath), "/work/project-alpha", session);

		for (const dbPath of dbPaths) {
			expect(existsSync(dbPath)).toBe(false);
			expect(existsSync(`${dbPath}-wal`)).toBe(false);
			expect(existsSync(`${dbPath}-shm`)).toBe(false);
		}
		expect(getMnemosyneSessionState(session)).toBeUndefined();
		registeredMnemosyneState = undefined;
	});

	it("derives valid project banks from the absolute project root", async () => {
		const root = path.join(tmpdir(), `mnemosyne-bank-${Date.now()}`);
		const alphaCwd = path.join(root, "a", "api");
		const betaCwd = path.join(root, "b", "api");
		mkdirSync(alphaCwd, { recursive: true });
		mkdirSync(betaCwd, { recursive: true });
		try {
			const base = Settings.isolated({
				"memory.backend": "mnemosyne",
				"mnemosyne.scoping": "per-project",
				"mnemosyne.bank": "../../bad bank name with spaces and punctuation!",
			});
			const alpha = loadMnemosyneConfig(await base.cloneForCwd(alphaCwd), root);
			const beta = loadMnemosyneConfig(await base.cloneForCwd(betaCwd), root);

			expect(alpha.bank).not.toBe(beta.bank);
			const banks = [alpha.bank, beta.bank, alpha.globalBank, beta.globalBank].filter(
				(bank): bank is string => typeof bank === "string",
			);
			for (const bank of banks) {
				expect(bank).toMatch(/^[A-Za-z0-9_-]+$/);
				expect(bank.length).toBeLessThanOrEqual(64);
			}
			expect(alpha.globalBank).toBe("bad-bank-name-with-spaces-and-punctuation");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
describe("recall.execute", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredState = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		registeredState = undefined;
	});

	it("returns the no-results sentinel when recall yields empty", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({ results: [] } as never);
		registerState(client, settings);

		const tool = MemoryRecallTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-3", { query: "anything" });
		expect(result.content[0]).toEqual({ type: "text", text: "No relevant memories found." });
	});

	it("formats non-empty results with count + UTC timestamp header", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [
				{ text: "fact one", type: "world", id: "1" },
				{ text: "fact two", id: "2" },
			],
		} as never);
		registerState(client, settings);

		const tool = MemoryRecallTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-4", { query: "anything" });
		const block = (result.content[0] as { text: string }).text;
		expect(block).toMatch(/^Found 2 relevant memories \(as of \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\)/);
		expect(block).toContain("- fact one [world]");
		expect(block).toContain("- fact two");
	});

	it("forwards recall tags + tagsMatch from session state when present", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const recallSpy = vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({ results: [] } as never);
		registerState(client, settings, { recallTags: ["project:pi"], recallTagsMatch: "any" });

		const tool = MemoryRecallTool.createIf(makeSession(settings))!;
		await tool.execute("call-tags", { query: "anything" });

		expect(recallSpy).toHaveBeenCalledWith(
			"test-bank",
			"anything",
			expect.objectContaining({ tags: ["project:pi"], tagsMatch: "any" }),
		);
	});

	it("rethrows underlying client errors", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "recall").mockRejectedValue(new Error("HTTP 503"));
		registerState(client, settings);

		const tool = MemoryRecallTool.createIf(makeSession(settings))!;
		await expect(tool.execute("call-5", { query: "anything" })).rejects.toThrow(/HTTP 503/);
	});
});

describe("recall.execute (Mnemosyne backend)", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredMnemosyneState = undefined;
		tempDbPath = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		registeredMnemosyneState?.dispose();
		registeredMnemosyneState = undefined;
		if (tempDbPath) {
			try {
				const tempDir = path.dirname(tempDbPath);
				rmSync(tempDir, { recursive: true, force: true });
			} catch {}
			tempDbPath = undefined;
		}
	});

	it("returns the no-results sentinel when empty", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemosyne" });
		registerMnemosyneState();

		const tool = MemoryRecallTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-mnemosyne-empty", { query: "nonexistent query" });

		expect(result.content[0]).toEqual({ type: "text", text: "No relevant memories found." });
	});

	it("returns a populated text block when a retained memory exists", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemosyne" });
		registerMnemosyneState();

		// First, store a memory
		const retainTool = MemoryRetainTool.createIf(makeSession(settings))!;
		await retainTool.execute("call-mnemosyne-store", {
			items: [{ content: "the user prefers dark mode in their editor" }],
		});

		// Then recall it
		const recallTool = MemoryRecallTool.createIf(makeSession(settings))!;
		const result = await recallTool.execute("call-mnemosyne-query", { query: "editor preferences" });

		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Found 1 relevant memory");
		expect(text).toContain("the user prefers dark mode in their editor");
	});

	it("shares memories across projects when scoping is global", async () => {
		const settings = Settings.isolated({
			"memory.backend": "mnemosyne",
			"mnemosyne.scoping": "global",
		});
		const config = makeMnemosyneConfig({ scoping: "global", bank: "default" });
		registerMnemosyneState(config, { cwd: "/work/project-alpha" });
		await MemoryRetainTool.createIf(makeSession(settings))!.execute("call-mnemosyne-global-store", {
			items: [{ content: "global memory survives project switches" }],
		});
		registeredMnemosyneState?.dispose();
		registerMnemosyneState(config, { cwd: "/work/project-beta" });
		const result = await MemoryRecallTool.createIf(makeSession(settings))!.execute("call-mnemosyne-global-recall", {
			query: "project switches",
		});
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("global memory survives project switches");
	});

	it("merges global and project-local memories on recall when scoping is per-project-tagged", async () => {
		const settings = Settings.isolated({
			"memory.backend": "mnemosyne",
			"mnemosyne.scoping": "per-project-tagged",
		});
		// Store a global memory (uses default/global bank)
		registerMnemosyneState(makeMnemosyneConfig({ scoping: "global", bank: "default", globalBank: "default" }), {
			cwd: "/work/project-alpha",
		});
		await MemoryRetainTool.createIf(makeSession(settings))!.execute("call-mnemosyne-tagged-global", {
			items: [{ content: "the user likes concise CLI output" }],
		});
		// Store project-alpha local memory
		registeredMnemosyneState?.dispose();
		registerMnemosyneState(
			makeMnemosyneConfig({ scoping: "per-project-tagged", bank: "project-alpha", globalBank: "default" }),
			{ cwd: "/work/project-alpha" },
		);
		await MemoryRetainTool.createIf(makeSession(settings))!.execute("call-mnemosyne-tagged-local", {
			items: [{ content: "project alpha uses pnpm workspaces" }],
		});
		// Store project-beta local memory
		registeredMnemosyneState?.dispose();
		registerMnemosyneState(
			makeMnemosyneConfig({ scoping: "per-project-tagged", bank: "project-beta", globalBank: "default" }),
			{ cwd: "/work/project-beta" },
		);
		await MemoryRetainTool.createIf(makeSession(settings))!.execute("call-mnemosyne-tagged-other", {
			items: [{ content: "project beta deploys to staging first" }],
		});
		// Recall from project-alpha should merge global + alpha, exclude beta
		registeredMnemosyneState?.dispose();
		registerMnemosyneState(
			makeMnemosyneConfig({ scoping: "per-project-tagged", bank: "project-alpha", globalBank: "default" }),
			{ cwd: "/work/project-alpha" },
		);
		const result = await MemoryRecallTool.createIf(makeSession(settings))!.execute("call-mnemosyne-tagged-recall", {
			query: "what should I know about this user and project alpha?",
		});
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("the user likes concise CLI output");
		expect(text).toContain("project alpha uses pnpm workspaces");
		expect(text).not.toContain("project beta deploys to staging first");
	});

	it("throws when no per-session Mnemosyne state is registered", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemosyne" });
		const tool = MemoryRecallTool.createIf(makeSession(settings))!;
		await expect(tool.execute("call-mnemosyne-no-state", { query: "anything" })).rejects.toThrow(/not initialised/i);
	});
});

describe("reflect.execute", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredState = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		registeredState = undefined;
	});

	it("returns the reflect text and forwards context", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const reflectSpy = vi
			.spyOn(HindsightApi.prototype, "reflect")
			.mockResolvedValue({ text: "Synthesised answer" } as never);
		registerState(client, settings);

		const tool = MemoryReflectTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-6", { query: "what does the user prefer?", context: "background" });
		expect(reflectSpy).toHaveBeenCalledWith(
			"test-bank",
			"what does the user prefer?",
			expect.objectContaining({ context: "background", budget: "mid" }),
		);
		expect((result.content[0] as { text: string }).text).toBe("Synthesised answer");
	});

	it("falls back to a sentinel when reflect returns blank text", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "reflect").mockResolvedValue({ text: "  " } as never);
		registerState(client, settings);

		const tool = MemoryReflectTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-7", { query: "anything" });
		expect((result.content[0] as { text: string }).text).toBe("No relevant information found to reflect on.");
	});
});

describe("reflect.execute (Mnemosyne backend)", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredMnemosyneState = undefined;
		tempDbPath = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		registeredMnemosyneState?.dispose();
		registeredMnemosyneState = undefined;
		if (tempDbPath) {
			try {
				const tempDir = path.dirname(tempDbPath);
				rmSync(tempDir, { recursive: true, force: true });
			} catch {}
			tempDbPath = undefined;
		}
	});

	it("returns the no-results sentinel when empty", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemosyne" });
		registerMnemosyneState();

		const tool = MemoryReflectTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-mnemosyne-reflect-empty", {
			query: "what does the user prefer?",
		});

		expect(result.content[0]).toEqual({
			type: "text",
			text: "No relevant information found to reflect on.",
		});
	});

	it("returns a synthesized text block based on recalled memories when data exists", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemosyne" });
		registerMnemosyneState();

		// First, store memories
		const retainTool = MemoryRetainTool.createIf(makeSession(settings))!;
		await retainTool.execute("call-mnemosyne-store-reflect", {
			items: [
				{ content: "the user prefers dark mode in their editor" },
				{ content: "the user uses Vim keybindings" },
				{ content: "the user likes tabs over spaces" },
			],
		});

		// Then reflect on them
		const reflectTool = MemoryReflectTool.createIf(makeSession(settings))!;
		const result = await reflectTool.execute("call-mnemosyne-reflect-query", {
			query: "what are the user's editor preferences?",
		});

		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Based on recalled memories");
		expect(text).toContain("dark mode");
		expect(text).toContain("Vim");
		expect(text).toContain("tabs");
	});

	it("includes additional context in the query when provided", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemosyne" });
		registerMnemosyneState();

		// Store a memory
		const retainTool = MemoryRetainTool.createIf(makeSession(settings))!;
		await retainTool.execute("call-mnemosyne-store-context", {
			items: [{ content: "the user works on Python projects" }],
		});

		// Reflect with context
		const reflectTool = MemoryReflectTool.createIf(makeSession(settings))!;
		const result = await reflectTool.execute("call-mnemosyne-reflect-context", {
			query: "what does the user work on?",
			context: "this is for a new project setup",
		});

		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Based on recalled memories");
		expect(text).toContain("Python");
	});

	it("merges global and project-local memories on reflect when scoping is per-project-tagged", async () => {
		const settings = Settings.isolated({
			"memory.backend": "mnemosyne",
			"mnemosyne.scoping": "per-project-tagged",
		});
		// Store a global memory (uses default/global bank)
		registerMnemosyneState(makeMnemosyneConfig({ scoping: "global", bank: "default", globalBank: "default" }), {
			cwd: "/work/project-alpha",
		});
		await MemoryRetainTool.createIf(makeSession(settings))!.execute("call-mnemosyne-reflect-global", {
			items: [{ content: "the user prefers concise summaries" }],
		});
		// Store project-alpha local memory
		registeredMnemosyneState?.dispose();
		registerMnemosyneState(
			makeMnemosyneConfig({ scoping: "per-project-tagged", bank: "project-alpha", globalBank: "default" }),
			{ cwd: "/work/project-alpha" },
		);
		await MemoryRetainTool.createIf(makeSession(settings))!.execute("call-mnemosyne-reflect-local", {
			items: [{ content: "project alpha uses turbo for task orchestration" }],
		});
		const result = await MemoryReflectTool.createIf(makeSession(settings))!.execute("call-mnemosyne-reflect-tagged", {
			query: "what matters for this user working in project alpha?",
		});
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Based on recalled memories");
		expect(text).toContain("the user prefers concise summaries");
		expect(text).toContain("project alpha uses turbo for task orchestration");
	});

	it("throws when no per-session Mnemosyne state is registered", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemosyne" });
		const tool = MemoryReflectTool.createIf(makeSession(settings))!;
		await expect(tool.execute("call-mnemosyne-reflect-no-state", { query: "anything" })).rejects.toThrow(
			/not initialised/i,
		);
	});
});

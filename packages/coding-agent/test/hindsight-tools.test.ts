/**
 * Contract tests for the three Hindsight tool factories.
 *
 * These exercise the public tool surface (factory gating + execute path) by
 * spying on `HindsightClient.prototype.{retain, recall, reflect}` and stubbing
 * a per-session state via `setHindsightSessionStateForTest`. We deliberately
 * do not boot a real session — these tools only need a populated state
 * accessor and a Settings instance.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	clearHindsightSessionStateForTest,
	setHindsightSessionStateForTest,
} from "@oh-my-pi/pi-coding-agent/hindsight/backend";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { HindsightRecallTool } from "@oh-my-pi/pi-coding-agent/tools/hindsight-recall";
import { HindsightReflectTool } from "@oh-my-pi/pi-coding-agent/tools/hindsight-reflect";
import { HindsightRetainTool } from "@oh-my-pi/pi-coding-agent/tools/hindsight-retain";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { HindsightClient } from "@vectorize-io/hindsight-client";

const TEST_SESSION_ID = "test-session-id";

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
	} as unknown as ToolSession;
}

interface RegisterStateOptions {
	retainTags?: string[];
	recallTags?: string[];
	recallTagsMatch?: "any" | "all" | "any_strict" | "all_strict";
}

function registerState(client: HindsightClient, settings?: Settings, opts: RegisterStateOptions = {}) {
	setHindsightSessionStateForTest(TEST_SESSION_ID, {
		client,
		bankId: "test-bank",
		retainTags: opts.retainTags,
		recallTags: opts.recallTags,
		recallTagsMatch: opts.recallTagsMatch,
		config: makeConfig(),
		session: { sessionId: TEST_SESSION_ID, sessionManager: { getEntries: () => [] } as never } as never,
		missionsSet: new Set(),
		lastRetainedTurn: 0,
		hasRecalledForFirstTurn: false,
	});
	void settings;
}

describe("Hindsight tool factories", () => {
	beforeEach(() => {
		_resetSettingsForTest();
		clearHindsightSessionStateForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		clearHindsightSessionStateForTest();
	});

	it("retain/recall/reflect factories return null when memory.backend !== hindsight", () => {
		const settings = Settings.isolated({ "memory.backend": "local", "memories.enabled": false });
		const session = makeSession(settings);
		expect(HindsightRetainTool.createIf(session)).toBeNull();
		expect(HindsightRecallTool.createIf(session)).toBeNull();
		expect(HindsightReflectTool.createIf(session)).toBeNull();
	});

	it("retain/recall/reflect factories return tool instances when memory.backend === hindsight", () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const session = makeSession(settings);
		expect(HindsightRetainTool.createIf(session)).toBeInstanceOf(HindsightRetainTool);
		expect(HindsightRecallTool.createIf(session)).toBeInstanceOf(HindsightRecallTool);
		expect(HindsightReflectTool.createIf(session)).toBeInstanceOf(HindsightReflectTool);
	});
});

describe("retain.execute", () => {
	beforeEach(() => {
		_resetSettingsForTest();
		clearHindsightSessionStateForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		clearHindsightSessionStateForTest();
	});

	it("forwards content + bank id to client.retain and returns success", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightClient({ baseUrl: "http://localhost:8888" });
		const retainSpy = vi.spyOn(HindsightClient.prototype, "retain").mockResolvedValue({} as never);
		registerState(client, settings);

		const tool = HindsightRetainTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-1", { content: "user prefers tabs" });

		expect(retainSpy).toHaveBeenCalledTimes(1);
		expect(retainSpy).toHaveBeenCalledWith(
			"test-bank",
			"user prefers tabs",
			expect.objectContaining({ async: true, metadata: { session_id: TEST_SESSION_ID } }),
		);
		expect(result.content[0]).toEqual({ type: "text", text: "Memory stored." });
	});

	it("forwards retain tags from session state when present", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightClient({ baseUrl: "http://localhost:8888" });
		const retainSpy = vi.spyOn(HindsightClient.prototype, "retain").mockResolvedValue({} as never);
		registerState(client, settings, { retainTags: ["project:pi"] });

		const tool = HindsightRetainTool.createIf(makeSession(settings))!;
		await tool.execute("call-tags", { content: "tagged fact" });

		expect(retainSpy).toHaveBeenCalledWith(
			"test-bank",
			"tagged fact",
			expect.objectContaining({ tags: ["project:pi"] }),
		);
	});

	it("throws when no per-session state is registered", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const tool = HindsightRetainTool.createIf(makeSession(settings))!;
		await expect(tool.execute("call-2", { content: "x" })).rejects.toThrow(/not initialised/i);
	});
});

describe("recall.execute", () => {
	beforeEach(() => {
		_resetSettingsForTest();
		clearHindsightSessionStateForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		clearHindsightSessionStateForTest();
	});

	it("returns the no-results sentinel when recall yields empty", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightClient({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightClient.prototype, "recall").mockResolvedValue({ results: [] } as never);
		registerState(client, settings);

		const tool = HindsightRecallTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-3", { query: "anything" });
		expect(result.content[0]).toEqual({ type: "text", text: "No relevant memories found." });
	});

	it("formats non-empty results with count + UTC timestamp header", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightClient({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightClient.prototype, "recall").mockResolvedValue({
			results: [
				{ text: "fact one", type: "world", id: "1" },
				{ text: "fact two", id: "2" },
			],
		} as never);
		registerState(client, settings);

		const tool = HindsightRecallTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-4", { query: "anything" });
		const block = (result.content[0] as { text: string }).text;
		expect(block).toMatch(/^Found 2 relevant memories \(as of \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\)/);
		expect(block).toContain("- fact one [world]");
		expect(block).toContain("- fact two");
	});

	it("forwards recall tags + tagsMatch from session state when present", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightClient({ baseUrl: "http://localhost:8888" });
		const recallSpy = vi.spyOn(HindsightClient.prototype, "recall").mockResolvedValue({ results: [] } as never);
		registerState(client, settings, { recallTags: ["project:pi"], recallTagsMatch: "any" });

		const tool = HindsightRecallTool.createIf(makeSession(settings))!;
		await tool.execute("call-tags", { query: "anything" });

		expect(recallSpy).toHaveBeenCalledWith(
			"test-bank",
			"anything",
			expect.objectContaining({ tags: ["project:pi"], tagsMatch: "any" }),
		);
	});

	it("rethrows underlying client errors", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightClient({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightClient.prototype, "recall").mockRejectedValue(new Error("HTTP 503"));
		registerState(client, settings);

		const tool = HindsightRecallTool.createIf(makeSession(settings))!;
		await expect(tool.execute("call-5", { query: "anything" })).rejects.toThrow(/HTTP 503/);
	});
});

describe("reflect.execute", () => {
	beforeEach(() => {
		_resetSettingsForTest();
		clearHindsightSessionStateForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		clearHindsightSessionStateForTest();
	});

	it("returns the reflect text and forwards context", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightClient({ baseUrl: "http://localhost:8888" });
		const reflectSpy = vi
			.spyOn(HindsightClient.prototype, "reflect")
			.mockResolvedValue({ text: "Synthesised answer" } as never);
		registerState(client, settings);

		const tool = HindsightReflectTool.createIf(makeSession(settings))!;
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
		const client = new HindsightClient({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightClient.prototype, "reflect").mockResolvedValue({ text: "  " } as never);
		registerState(client, settings);

		const tool = HindsightReflectTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-7", { query: "anything" });
		expect((result.content[0] as { text: string }).text).toBe("No relevant information found to reflect on.");
	});
});

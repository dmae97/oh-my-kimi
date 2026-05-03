/**
 * Backend behavioural contract tests.
 *
 * These exercise hindsightBackend.start / preCompactionContext / clear without
 * a real AgentSession by passing a fake session that exposes a `subscribe`
 * method we can drive manually. The HindsightApi is spied via
 * `vi.spyOn(HindsightApi.prototype, ...)` per AGENTS.md.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { _resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	clearHindsightSessionStateForTest,
	getHindsightSessionState,
	hindsightBackend,
} from "@oh-my-pi/pi-coding-agent/hindsight/backend";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { AgentSessionEventListener } from "@oh-my-pi/pi-coding-agent/session/agent-session";

interface FakeSessionDeps {
	sessionId: string | null;
	cwd?: string;
	entries?: Array<{ role: "user" | "assistant"; text: string }>;
}

function makeFakeSession(deps: FakeSessionDeps) {
	const listeners = new Set<AgentSessionEventListener>();
	const entries = deps.entries ?? [];
	const session = {
		sessionId: deps.sessionId,
		settings: Settings.isolated(),
		sessionManager: {
			getEntries: () =>
				entries.map((e, i) => ({
					id: `e${i}`,
					parentId: i === 0 ? null : `e${i - 1}`,
					timestamp: new Date(0).toISOString(),
					type: "message" as const,
					message:
						e.role === "user"
							? {
									role: "user" as const,
									content: e.text,
									timestamp: 0,
								}
							: {
									role: "assistant" as const,
									content: [{ type: "text" as const, text: e.text }],
									model: "x",
									provider: "x",
									api: "x",
									stopReason: "end_turn" as const,
									timestamp: 0,
								},
				})),
			getCwd: () => deps.cwd ?? "/tmp",
			getSessionFile: () => null,
			getSessionId: () => deps.sessionId ?? "",
		},
		subscribe(listener: AgentSessionEventListener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		refreshBaseSystemPrompt: vi.fn().mockResolvedValue(undefined),
		emit(event: Parameters<AgentSessionEventListener>[0]) {
			for (const l of [...listeners]) l(event);
		},
	};
	return session;
}

describe("hindsightBackend.start", () => {
	beforeEach(() => {
		_resetSettingsForTest();
		clearHindsightSessionStateForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		clearHindsightSessionStateForTest();
	});

	it("does nothing when memory.backend is hindsight but apiUrl is empty", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight", "hindsight.apiUrl": "" });
		const session = makeFakeSession({ sessionId: "s1" });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		expect(getHindsightSessionState("s1")).toBeUndefined();
	});

	it("registers per-session state and subscribes to agent events when configured", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({ sessionId: "s2" });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		expect(getHindsightSessionState("s2")).toBeDefined();
		expect(getHindsightSessionState("s2")?.bankId).toBeTruthy();
	});

	it("retains every Nth user turn on agent_end and skips intermediate turns", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.retainEveryNTurns": 2,
		});
		const retainSpy = vi.spyOn(HindsightApi.prototype, "retain").mockResolvedValue({} as never);
		vi.spyOn(HindsightApi.prototype, "createBank").mockResolvedValue({} as never);

		const entries: Array<{ role: "user" | "assistant"; text: string }> = [];
		const session = makeFakeSession({ sessionId: "s3", entries });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		// Turn 1: not enough turns yet
		entries.push({ role: "user", text: "first user message that is long enough" });
		entries.push({ role: "assistant", text: "first assistant reply that is long enough" });
		session.emit({ type: "agent_end", messages: [] });
		await Bun.sleep(0);
		expect(retainSpy).toHaveBeenCalledTimes(0);

		// Turn 2: hits the threshold
		entries.push({ role: "user", text: "second user message that is long enough" });
		entries.push({ role: "assistant", text: "second reply that is long enough" });
		session.emit({ type: "agent_end", messages: [] });
		await Bun.sleep(0);
		expect(retainSpy).toHaveBeenCalledTimes(1);
	});

	it("does nothing on subagent runs (taskDepth > 0)", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({ sessionId: "s4" });

		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 1,
		});

		expect(getHindsightSessionState("s4")).toBeUndefined();
	});
});

describe("hindsightBackend.preCompactionContext", () => {
	beforeEach(() => {
		_resetSettingsForTest();
		clearHindsightSessionStateForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		clearHindsightSessionStateForTest();
	});

	it("returns undefined when no apiUrl is configured", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight", "hindsight.apiUrl": "" });
		const messages: AgentMessage[] = [{ role: "user", content: "hi", timestamp: 0 } as never];
		const ctx = await hindsightBackend.preCompactionContext?.(messages, settings);
		expect(ctx).toBeUndefined();
	});

	it("returns a <memories> block when recall yields results", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({ sessionId: "s5" });
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [{ id: "1", text: "remembered fact" }],
		} as never);

		const messages: AgentMessage[] = [{ role: "user", content: "What did we decide?", timestamp: 0 } as never];
		const ctx = await hindsightBackend.preCompactionContext?.(messages, settings);
		expect(ctx).toBeDefined();
		expect(ctx).toContain("<memories>");
		expect(ctx).toContain("remembered fact");
	});

	it("returns undefined when recall finds nothing", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({ sessionId: "s6" });
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({ results: [] } as never);
		const messages: AgentMessage[] = [{ role: "user", content: "anything", timestamp: 0 } as never];
		const ctx = await hindsightBackend.preCompactionContext?.(messages, settings);
		expect(ctx).toBeUndefined();
	});
});

describe("hindsightBackend first-turn injection", () => {
	beforeEach(() => {
		_resetSettingsForTest();
		clearHindsightSessionStateForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		clearHindsightSessionStateForTest();
	});

	it("returns a tagged block for the current first turn before agent_start", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({
			sessionId: "s8",
			entries: [{ role: "assistant", text: "previous assistant context" }],
		});
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [{ id: "1", text: "Can prefers concise communication" }],
		} as never);

		const block = await hindsightBackend.beforeAgentStartPrompt?.(
			session as never,
			"What do I know about this user?",
		);
		expect(block).toContain("<memories>");
		expect(block).toContain("Can prefers concise communication");
		expect(getHindsightSessionState("s8")?.hasRecalledForFirstTurn).toBe(true);
		expect(getHindsightSessionState("s8")?.lastRecallSnippet).toBe(block);
	});

	it("keeps the <memories> wrapper in buildDeveloperInstructions", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({ sessionId: "s9" });
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});

		const state = getHindsightSessionState("s9");
		expect(state).toBeDefined();
		state!.lastRecallSnippet = "<memories>\nremembered fact\n</memories>";

		const prompt = await hindsightBackend.buildDeveloperInstructions("/tmp", settings);
		expect(prompt).toContain("<memories>");
		expect(prompt).toContain("</memories>");
		expect(prompt).toContain("remembered fact");
	});
});

describe("hindsightBackend.clear", () => {
	beforeEach(() => {
		_resetSettingsForTest();
		clearHindsightSessionStateForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		clearHindsightSessionStateForTest();
	});

	it("drops every registered session state", async () => {
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
		});
		const session = makeFakeSession({ sessionId: "s7" });
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		expect(getHindsightSessionState("s7")).toBeDefined();

		await hindsightBackend.clear("/tmp", "/tmp");
		expect(getHindsightSessionState("s7")).toBeUndefined();
	});
});

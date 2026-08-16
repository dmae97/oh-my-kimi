import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "omk-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { RunJournalStore } from "../src/core/run-journal-store.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function terminationEvents(events: readonly AgentSessionEvent[]) {
	return events.filter((event) => event.type === "session_termination");
}

function last<T>(values: readonly T[]): T | undefined {
	return values[values.length - 1];
}

describe("AgentSession runtime termination production", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;
	let sessionDir: string;

	beforeEach(() => {
		root = join(tmpdir(), `omk-session-termination-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		sessionDir = join(root, "sessions");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	async function createSession(
		errorMessage?: string,
		withAuth = true,
		stopReason: "stop" | "error" | "aborted" = errorMessage ? "error" : "stop",
	) {
		const faux = registerFauxProvider();
		faux.setResponses([
			stopReason === "stop" ? fauxAssistantMessage("done") : fauxAssistantMessage("", { stopReason, errorMessage }),
		]);
		const authStorage = AuthStorage.inMemory();
		if (withAuth) authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const result = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			model: faux.getModel(),
			sessionManager: SessionManager.create(cwd, sessionDir),
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
		});
		return result.session;
	}

	it("journals typed run_started/run_finished records and exposes an actionable completed termination", async () => {
		const session = await createSession();
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => void events.push(event));

		await session.prompt("finish");

		expect(session.runJournalRecords.map((record) => record.event)).toEqual(["run_started", "run_finished"]);
		expect(terminationEvents(events)).toHaveLength(1);
		expect(session.lastTermination).toMatchObject({
			kind: "completed",
			causeCode: "session.completed",
			retryable: false,
			provider: session.model?.provider,
			model: session.model?.id,
		});
		expect(session.lastTermination?.nextAction).toMatch(/continue|none/i);
		expect(session.lastTermination?.runId).toBe(session.runJournalRecords[0]?.runId);
		session.dispose();
	});

	it.each([
		["429 too many requests", "provider_rate_limit", "provider.rate_limit"],
		["403 You've reached your usage limit for this billing cycle", "provider_rate_limit", "provider.rate_limit"],
		["fetch failed: connection reset", "provider_network", "provider.network"],
		["provider returned an invalid response frame", "provider_protocol", "provider.protocol"],
		["context_length_exceeded", "context_overflow", "provider.context_overflow"],
		["tool execution failed fatally", "tool_fatal", "tool.fatal"],
	])("classifies final provider failure %s", async (message, kind, causeCode) => {
		const session = await createSession(message);
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => void events.push(event));

		await session.prompt("fail");

		const event = last(terminationEvents(events));
		expect(event?.termination).toMatchObject({ kind, causeCode, message, provider: session.model?.provider });
		expect(event?.termination.nextAction.length).toBeGreaterThan(0);
		expect(last(session.runJournalRecords)?.event).toBe("run_finished");
		session.dispose();
	});

	it("fails over quota exhaustion and records the recovered attempt", async () => {
		const primary = registerFauxProvider({ provider: `faux-primary-${Date.now()}` });
		const fallback = registerFauxProvider({
			provider: `faux-fallback-${Date.now()}`,
			models: [{ id: "faux-1", reasoning: false, contextWindow: 1_000_000 }],
		});
		primary.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "403 You've reached your usage limit for this billing cycle",
			}),
		]);
		fallback.setResponses([fauxAssistantMessage("recovered")]);

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(primary.getModel().provider, "primary-key");
		authStorage.setRuntimeApiKey(fallback.getModel().provider, "fallback-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider(fallback.getModel().provider, {
			api: fallback.api,
			apiKey: "fallback-key",
			baseUrl: fallback.getModel().baseUrl,
			models: [...fallback.models],
		});
		const settingsManager = SettingsManager.inMemory({
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
			providerResilience: {
				autoFailoverOnSafetyStop: true,
				failoverCandidates: [{ provider: fallback.getModel().provider, id: fallback.getModel().id }],
			},
		});
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			modelRegistry,
			model: primary.getModel(),
			sessionManager: SessionManager.create(cwd, sessionDir),
			settingsManager,
		});
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => void events.push(event));

		try {
			await session.prompt("recover from quota");

			expect(primary.state.callCount).toBe(1);
			expect(fallback.state.callCount).toBe(1);
			expect(session.model?.provider).toBe(fallback.getModel().provider);
			expect(terminationEvents(events).map((event) => event.termination.kind)).toEqual([
				"provider_rate_limit",
				"completed",
			]);
			expect(session.lastTermination?.kind).toBe("completed");
			expect(events.some((event) => event.type === "auto_retry_start")).toBe(true);
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(fallback.getModel().provider);
			primary.unregister();
			fallback.unregister();
		}
	});

	it("distinguishes provider abort from user abort", async () => {
		const providerAbort = await createSession("Provider aborted the stream.", true, "aborted");
		await providerAbort.prompt("provider abort");
		expect(providerAbort.lastTermination?.kind).toBe("provider_abort");
		providerAbort.dispose();

		const faux = registerFauxProvider({ tokensPerSecond: 10 });
		faux.setResponses([fauxAssistantMessage("a response slow enough to abort")]);
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			model: faux.getModel(),
			sessionManager: SessionManager.create(cwd, sessionDir),
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
		});
		const prompt = session.prompt("abort me");
		while (!session.isStreaming) await new Promise((resolve) => setTimeout(resolve, 1));
		await session.abort();
		await prompt;
		expect(session.lastTermination?.kind).toBe("user_abort");
		session.dispose();
	});

	it("emits exact configuration and internal preflight terminations", async () => {
		const unconfigured = await createSession();
		unconfigured.agent.state.model = undefined as never;
		await expect(unconfigured.prompt("no model")).rejects.toThrow();
		expect(unconfigured.lastTermination?.kind).toBe("configuration");
		unconfigured.dispose();

		const faux = registerFauxProvider({ tokensPerSecond: 10 });
		faux.setResponses([fauxAssistantMessage("a response slow enough for concurrent preflight")]);
		const configuredAuth = AuthStorage.inMemory();
		configuredAuth.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const { session: concurrent } = await createAgentSession({
			cwd,
			agentDir,
			authStorage: configuredAuth,
			model: faux.getModel(),
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory(),
		});
		const events: AgentSessionEvent[] = [];
		concurrent.subscribe((event) => void events.push(event));
		const first = concurrent.prompt("first");
		while (!concurrent.isStreaming) await new Promise((resolve) => setTimeout(resolve, 1));
		await expect(concurrent.prompt("second")).rejects.toThrow("already processing");
		expect(terminationEvents(events).some((event) => event.termination.kind === "internal_error")).toBe(true);
		await concurrent.abort();
		await first;
		concurrent.dispose();
	});

	it("recovers a complete-prefix-valid unclosed prior run as inferred process_crash on startup", async () => {
		const original = await createSession();
		await original.prompt("persist session");
		const sessionPath = original.sessionFile;
		expect(sessionPath).toBeDefined();
		original.dispose();

		const writer = RunJournalStore.open({
			journalPath: `${sessionPath}.runjournal`,
			sessionId: original.sessionId,
		});
		writer.start({
			runId: "run-left-open",
			sessionRevision: 4,
			timestamp: "2026-07-17T02:00:00.000Z",
		});

		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("resumed")]);
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const { session: resumed } = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			model: faux.getModel(),
			sessionManager: SessionManager.open(sessionPath!, sessionDir),
			settingsManager: SettingsManager.inMemory(),
		});
		expect(resumed.lastTermination?.kind).toBe("process_crash");
		const recovered = resumed.runJournalRecords.find(
			(record) => record.event === "run_recovered" && record.runId === "run-left-open",
		);
		expect(recovered?.event).toBe("run_recovered");
		if (recovered?.event === "run_recovered") {
			expect(recovered.termination).toMatchObject({
				kind: "process_crash",
				source: "inferred_on_resume",
				causeCode: "process.crash",
			});
		}
		resumed.dispose();
	});

	it("produces an exact persistence termination when required run-journal append fails", async () => {
		const session = await createSession();
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => void events.push(event));
		mkdirSync(`${session.sessionFile}.runjournal`);

		await expect(session.prompt("cannot journal")).rejects.toThrow();

		expect(session.lastTermination).toMatchObject({
			kind: "persistence",
			causeCode: "persistence.append_failed",
			retryable: true,
		});
		expect(last(terminationEvents(events))?.termination).toEqual(session.lastTermination);
		session.dispose();
	});

	it("produces an exact compaction termination when manual compaction fails", async () => {
		const session = await createSession();
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => void events.push(event));
		session.agent.state.model = undefined as never;

		await expect(session.compact()).rejects.toThrow();

		expect(session.lastTermination).toMatchObject({
			kind: "compaction",
			causeCode: "compaction.failed",
			retryable: true,
		});
		expect(last(terminationEvents(events))?.termination).toEqual(session.lastTermination);
		session.dispose();
	});

	it("emits an exact provider-auth termination for prompt preflight failure", async () => {
		const session = await createSession(undefined, false);
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => void events.push(event));

		await expect(session.prompt("needs auth")).rejects.toThrow();

		const event = last(terminationEvents(events));
		expect(event?.termination).toMatchObject({
			kind: "provider_auth",
			causeCode: "provider.auth",
			retryable: false,
			provider: session.model?.provider,
			model: session.model?.id,
		});
		expect(event?.termination.nextAction).toContain("/login");
		expect(event?.termination.runId).toMatch(/^preflight-/);
		session.dispose();
	});
});

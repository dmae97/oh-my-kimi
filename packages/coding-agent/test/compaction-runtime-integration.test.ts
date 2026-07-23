import { readFileSync, writeFileSync } from "node:fs";
import type { AgentEvent, AgentMessage } from "omk-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
} from "omk-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompactionSettings } from "../src/core/compaction/compaction.ts";
import type { CompactionEnvelope } from "../src/core/compaction/transaction.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

type CompactionDetailsWithEnvelope = {
	readonly compactionEnvelope?: CompactionEnvelope;
};

type ContextInvalidationRuntime = {
	_handleToolAuditEvent(event: AgentEvent): void;
	_resolveCompactionModel(model: Model<any>): Model<any>;
};

type AutoCompactionRuntime = {
	_runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean, emergency?: boolean): Promise<boolean>;
	_compactionHysteresisConfig(
		contextWindow: number,
		settings: CompactionSettings,
	): { readonly triggerRatio: number } | undefined;
	_runtimeCompactionDecision(
		contextTokens: number,
		contextWindow: number,
		settings: CompactionSettings,
	): { readonly compact: boolean; readonly emergency: boolean };
	_recordCompactionCommitForHysteresis(): void;
};

type MutablePendingToolState = {
	messages: AgentMessage[];
	pendingToolCalls: Set<string>;
};

type DurableHeadSessionManager = SessionManager & {
	getDurableHeadToken(): unknown;
};

function usage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function seedClosedTranscript(harness: Harness): string {
	const now = Date.now();
	for (let index = 0; index < 2; index += 1) {
		harness.sessionManager.appendMessage({
			role: "user",
			content: `user-${index}`,
			timestamp: now + index * 2,
		});
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage(`assistant-${index}`),
			usage: usage(100 + index),
			timestamp: now + index * 2 + 1,
		});
	}
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	const leafId = harness.sessionManager.getLeafId();
	if (!leafId) throw new Error("expected seeded leaf");
	return leafId;
}

function appendDuplicateResultCorruption(harness: Harness): void {
	harness.sessionManager.appendMessage(
		fauxAssistantMessage([fauxToolCall("read", { path: "duplicate.ts" }, { id: "duplicate-tool" })], {
			stopReason: "toolUse",
		}),
	);
	const result = {
		role: "toolResult" as const,
		toolCallId: "duplicate-tool",
		toolName: "read",
		content: [{ type: "text" as const, text: "result" }],
		isError: false,
		timestamp: Date.now(),
	};
	harness.sessionManager.appendMessage(result);
	harness.sessionManager.appendMessage({ ...result, timestamp: Date.now() + 1 });
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function injectSummaryStream(harness: Harness, onStart?: () => void, summary = "transactional summary"): () => number {
	let calls = 0;
	let started = false;
	harness.session.agent.streamFn = (model) => {
		calls += 1;
		if (!started) {
			started = true;
			onStart?.();
		}
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				...fauxAssistantMessage(summary),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: usage(10),
			};
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	return () => calls;
}

describe("compaction runtime transaction integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("discards a generated summary when a user entry arrives mid-flight", async () => {
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		seedClosedTranscript(harness);
		injectSummaryStream(harness, () => {
			harness.sessionManager.appendMessage({ role: "user", content: "late steering", timestamp: Date.now() });
		});

		await expect(harness.session.compact()).rejects.toThrow(/stale|changed during compaction/i);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("discards a generated summary when a closed tool turn arrives mid-flight", async () => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		seedClosedTranscript(harness);
		injectSummaryStream(harness, () => {
			harness.sessionManager.appendMessage({ role: "user", content: "late tool turn", timestamp: Date.now() });
			harness.sessionManager.appendMessage(
				fauxAssistantMessage([fauxToolCall("read", { path: "late.ts" }, { id: "late-tool" })], {
					stopReason: "toolUse",
				}),
			);
			harness.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "late-tool",
				toolName: "read",
				content: [{ type: "text", text: "late result" }],
				isError: false,
				timestamp: Date.now(),
			});
		});

		await expect(harness.session.compact()).rejects.toThrow(/stale|changed during compaction/i);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("discards a generated summary after a second SessionManager advances the durable head", async () => {
		// Given: compaction began from a persisted session head.
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		seedClosedTranscript(harness);
		const sessionFile = harness.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("expected persisted session file");
		const manager = harness.sessionManager as DurableHeadSessionManager;
		expect(typeof manager.getDurableHeadToken).toBe("function");
		const durableHeadSpy = vi.spyOn(manager, "getDurableHeadToken");
		let secondManagerEntryId: string | undefined;
		injectSummaryStream(harness, () => {
			const second = SessionManager.open(sessionFile, harness.tempDir);
			secondManagerEntryId = second.appendMessage({
				role: "user",
				content: "second process mutation",
				timestamp: Date.now(),
			});
		});

		// When/Then: commit compares the begin token to the newly read durable token and fails stale.
		await expect(harness.session.compact()).rejects.toThrow(/stale|changed during compaction/i);
		expect(secondManagerEntryId).toBeDefined();
		expect(durableHeadSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(SessionManager.open(sessionFile, harness.tempDir).getEntry(secondManagerEntryId ?? "")).toBeDefined();
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("persists a provenance-bearing envelope after an exact commit", async () => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		seedClosedTranscript(harness);
		injectSummaryStream(harness);

		await harness.session.compact();

		const entry = harness.sessionManager.getEntries().find((candidate) => candidate.type === "compaction");
		expect(entry?.type).toBe("compaction");
		if (!entry || entry.type !== "compaction") throw new Error("expected compaction entry");
		const envelope = (entry.details as CompactionDetailsWithEnvelope | undefined)?.compactionEnvelope;
		expect(envelope).toMatchObject({
			schemaVersion: 2,
			summary: entry.summary,
			source: { activeLeafId: entry.parentId },
		});
		expect(envelope?.summarySha256).toMatch(/^[a-f0-9]{64}$/u);
		expect(envelope?.preserved.latestIntent).toBe("user-1");
	});

	it("redacts credential-shaped generated summaries before committing them", async () => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		seedClosedTranscript(harness);
		const credential = "synthetic-compaction-secret";
		injectSummaryStream(harness, undefined, `api_key = "${credential}"`);

		const result = await harness.session.compact();

		expect(result.summary).toContain('api_key = "[REDACTED]"');
		expect(result.summary).not.toContain(credential);
		const entry = harness.sessionManager.getEntries().find((candidate) => candidate.type === "compaction");
		expect(entry?.type === "compaction" ? entry.summary : undefined).toBe(result.summary);
		expect(JSON.stringify(entry)).not.toContain(credential);
	});

	it("redacts credential-shaped summaries during auto-compaction", async () => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		seedClosedTranscript(harness);
		const credential = "synthetic-auto-compaction-secret";
		injectSummaryStream(harness, undefined, `api_key = "${credential}"`);

		await harness.session["_runAutoCompaction"]("threshold", false);

		const entry = harness.sessionManager.getEntries().find((candidate) => candidate.type === "compaction");
		expect(entry?.type === "compaction" ? entry.summary : undefined).toContain("[REDACTED]");
		expect(JSON.stringify(entry)).not.toContain(credential);
	});

	it("validates a persisted envelope binding when the session reloads", async () => {
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		seedClosedTranscript(harness);
		injectSummaryStream(harness);
		await harness.session.compact();
		const entry = harness.sessionManager.getEntries().find((candidate) => candidate.type === "compaction");
		if (!entry || entry.type !== "compaction") throw new Error("expected compaction entry");
		const envelope = (entry.details as CompactionDetailsWithEnvelope).compactionEnvelope;
		if (!envelope) throw new Error("expected compaction envelope");
		const sessionFile = harness.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("expected persisted session file");
		const serialized = readFileSync(sessionFile, "utf8");

		expect(SessionManager.open(sessionFile, harness.tempDir).getEntries()).toHaveLength(
			harness.sessionManager.getEntries().length,
		);

		writeFileSync(sessionFile, serialized.replace(envelope.summarySha256, "0".repeat(64)));
		expect(() => SessionManager.open(sessionFile, harness.tempDir)).toThrow(/envelope|doctor/i);
	});

	it("repairs a missing-only active tail before emergency overflow compaction", async () => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		seedClosedTranscript(harness);
		harness.sessionManager.appendMessage(
			fauxAssistantMessage([fauxToolCall("read", { path: "dangling.ts" }, { id: "dangling-tool" })], {
				stopReason: "toolUse",
			}),
		);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		injectSummaryStream(harness);

		const result = await (harness.session as unknown as AutoCompactionRuntime)._runAutoCompaction(
			"overflow",
			true,
			true,
		);

		expect(result).toBe(true);
		expect(
			harness.sessionManager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolCallId === "dangling-tool",
				),
		).toBe(true);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(harness.session.contextCacheInvalidationSnapshot.counters.transcriptRepair).toBe(1);
	});

	it("updates invalidation provenance from runtime producer paths", async () => {
		const harness = await createHarness({
			models: [{ id: "main" }, { id: "compact" }],
			settings: { compaction: { model: "faux/compact" } },
		});
		harnesses.push(harness);
		const runtime = harness.session as unknown as ContextInvalidationRuntime;
		const initial = harness.session.contextCacheInvalidationSnapshot;

		runtime._handleToolAuditEvent({
			type: "tool_execution_end",
			toolCallId: "tool-result",
			toolName: "read",
			result: { content: [], details: {} },
			isError: false,
		});
		await harness.session.sendCustomMessage({
			customType: "evidence_receipt",
			content: "receipt",
			display: false,
		});
		await harness.session.steer("new steering");
		await harness.session.reload();
		runtime._handleToolAuditEvent({
			type: "tool_execution_late_settlement",
			toolCallId: "late-write",
			toolName: "write",
			disposition: "timeout",
			outcome: "resolved",
		});
		runtime._resolveCompactionModel(harness.getModel());
		const compactModel = harness.getModel("compact");
		if (!compactModel) throw new Error("expected compact model");
		await harness.session.setModel(compactModel);

		const snapshot = harness.session.contextCacheInvalidationSnapshot;
		expect(snapshot.globalEpoch).toBeGreaterThanOrEqual(initial.globalEpoch + 7);
		expect(snapshot.counters).toMatchObject({
			toolResultDisposition: 1,
			evidenceReceipt: 1,
			userSteering: 1,
			settings: 1,
		});
		expect(snapshot.worktreeFingerprint).not.toBe(initial.worktreeFingerprint);
		expect(snapshot.activeModelId).not.toBe(initial.activeModelId);
		expect(snapshot.compactionModelId).not.toBe(initial.compactionModelId);
	});

	it("fails closed on structural transcript corruption and does not call the summary stream", async () => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		seedClosedTranscript(harness);
		appendDuplicateResultCorruption(harness);
		const streamCalls = injectSummaryStream(harness);

		await expect(harness.session.compact()).rejects.toThrow(/doctor|structural|corrupt/i);
		expect(streamCalls()).toBe(0);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("enforces the same fail-closed barrier for threshold and overflow compaction", async () => {
		for (const reason of ["threshold", "overflow"] as const) {
			const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
			harnesses.push(harness);
			seedClosedTranscript(harness);
			appendDuplicateResultCorruption(harness);
			const streamCalls = injectSummaryStream(harness);

			await expect(
				(harness.session as unknown as AutoCompactionRuntime)._runAutoCompaction(reason, reason === "overflow"),
			).resolves.toBe(false);
			expect(streamCalls(), reason).toBe(0);
			expect(harness.eventsOfType("compaction_end").at(-1)?.errorMessage, reason).toMatch(/doctor|structural/i);
		}
	});

	it("uses all reserve classes for the effective threshold and enforces runtime hysteresis", async () => {
		const harness = await createHarness({
			settings: {
				compaction: {
					maxUsageRatio: 0.99,
					reserveTokens: 100,
					reservedOutputTokens: 100,
					reservedToolResultTokens: 100,
					safetyMarginTokens: 100,
					imageReserveTokens: 100,
					rearmRatio: 0.2,
					emergencyRatio: 0.95,
				},
			},
		});
		harnesses.push(harness);
		const runtime = harness.session as unknown as AutoCompactionRuntime;
		const settings = harness.settingsManager.getCompactionSettings();

		expect(runtime._runtimeCompactionDecision(599, 1000, settings)).toEqual({
			compact: false,
			emergency: false,
		});
		expect(runtime._runtimeCompactionDecision(600, 1000, settings)).toEqual({
			compact: true,
			emergency: false,
		});
		runtime._recordCompactionCommitForHysteresis();
		expect(runtime._runtimeCompactionDecision(700, 1000, settings).compact).toBe(false);
		expect(runtime._runtimeCompactionDecision(950, 1000, settings)).toEqual({
			compact: true,
			emergency: true,
		});
		expect(runtime._runtimeCompactionDecision(200, 1000, settings).compact).toBe(false);
		expect(runtime._runtimeCompactionDecision(700, 1000, settings).compact).toBe(true);
	});

	it("moves the runtime threshold for live text, image, large-output, and unknown pending tool calls", async () => {
		const harness = await createHarness({
			settings: {
				compaction: {
					maxUsageRatio: 0.999,
					reserveTokens: 0,
					reservedOutputTokens: 0,
					reservedToolResultTokens: 500,
					safetyMarginTokens: 0,
					imageReserveTokens: 0,
				},
			},
		});
		harnesses.push(harness);
		const runtime = harness.session as unknown as AutoCompactionRuntime;
		const state = harness.session.agent.state as unknown as MutablePendingToolState;
		const configured = harness.settingsManager.getCompactionSettings();
		const withoutConfiguredReserve = { ...configured, reservedToolResultTokens: 0 };
		const threshold = (name?: string, args: Record<string, unknown> = {}): number => {
			if (name) {
				const id = `pending-${name}`;
				state.messages = [fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" })];
				state.pendingToolCalls = new Set([id]);
			} else {
				state.messages = [];
				state.pendingToolCalls = new Set();
			}
			const config = runtime._compactionHysteresisConfig(100_000, configured);
			if (!config) throw new Error("expected compaction threshold");
			return config.triggerRatio;
		};

		// Configured reserve is additive even with no pending tools.
		const unconfigured = runtime._compactionHysteresisConfig(100_000, withoutConfiguredReserve);
		if (!unconfigured) throw new Error("expected unconfigured compaction threshold");
		const idle = threshold();
		expect(idle).toBeLessThan(unconfigured.triggerRatio);

		// Live class estimates progressively reserve more headroom.
		const text = threshold("grep", { pattern: "needle", path: "." });
		const image = threshold("read", { path: "screenshot.png" });
		const large = threshold("bash", { command: "generate-report" });
		const unknown = threshold("custom-output", {});
		expect(text).toBeLessThan(idle);
		expect(image).toBeLessThan(text);
		expect(large).toBeLessThan(image);
		expect(unknown).toBe(large);
	});

	it("does not recompact an already committed source digest after branching back", async () => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		const sourceLeaf = seedClosedTranscript(harness);
		const streamCalls = injectSummaryStream(harness);
		await harness.session.compact();
		const callsAfterFirstCommit = streamCalls();

		harness.sessionManager.branch(sourceLeaf);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		await expect(harness.session.compact()).rejects.toThrow(/already compacted|duplicate/i);

		expect(streamCalls()).toBe(callsAfterFirstCommit);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});
});

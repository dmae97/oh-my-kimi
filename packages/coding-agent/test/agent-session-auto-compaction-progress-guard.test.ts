import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { resolveThresholdTokens, shouldCompact } from "@oh-my-pi/pi-agent-core/compaction";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { CompactionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";

/**
 * Regression test for the auto-compaction thrash loop.
 *
 * When the most-recent kept turn alone exceeds the compaction threshold,
 * `prepareCompaction` keeps it verbatim (findCutPoint never cuts at tool
 * results), so a "successful" compaction leaves context still above threshold.
 * The snapcompact strategy makes this visible: it projects over budget, falls
 * back to a context-full summary ("could not bring the context under the
 * limit"), and the success tail used to schedule the auto-continue regardless —
 * the next agent_end re-entered #checkCompaction over the same oversized tail and
 * re-fired forever.
 *
 * The fix gates the auto-continue (and the overflow/incomplete retry) on a
 * post-maintenance headroom check; with no headroom it pauses and emits a single
 * warning notice instead of looping.
 */
describe("AgentSession auto-compaction progress guard", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	const NOTICE_SOURCE = "compaction";
	const NO_PROGRESS_FRAGMENT = "Compaction freed too little context to make progress";

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-auto-compaction-progress-");

		// Short-circuit the actual summarization so the test makes no LLM call: the
		// hook supplies the compaction result, then the production tail (events,
		// progress guard, continuation scheduling) runs exactly as in a real pass.
		const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		const extensionPath = path.join(extensionsDir, "compaction-short-circuit.ts");
		fs.writeFileSync(
			extensionPath,
			[
				"export default function(pi) {",
				'\tpi.on("session_before_compact", async (event) => {',
				"\t\treturn {",
				"\t\t\tcompaction: {",
				'\t\t\t\tsummary: "compacted",',
				"\t\t\t\tshortSummary: undefined,",
				"\t\t\t\tfirstKeptEntryId: event.preparation.firstKeptEntryId,",
				"\t\t\t\ttokensBefore: event.preparation.tokensBefore,",
				"\t\t\t\tdetails: {},",
				"\t\t\t},",
				"\t\t};",
				"\t});",
				"}",
			].join("\n"),
		);

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const extensionsResult = await loadExtensions([extensionPath], tempDir.path());
		const extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) {
			throw new Error("Expected built-in anthropic model to exist");
		}
		// Pin the window and output reservation: every usage figure below is tuned
		// to a 200k/64k threshold, so catalog regeneration must not shift the
		// headroom math.
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		// Seed a minimal branch so prepareCompaction() returns a preparation.
		sessionManager.appendMessage({
			role: "user",
			content: "hello",
			timestamp: Date.now(),
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				// Auto-continue ON so the guarded auto-continue path is exercised.
				"compaction.autoContinue": true,
			}),
			modelRegistry,
			extensionRunner,
		});
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
			vi.restoreAllMocks();
		}
	});

	/** Build a threshold-tripping assistant turn (contextWindow 200k, ~80% threshold). */
	function highUsageAssistant() {
		return {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Done." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 190000,
				output: 1000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	/** Build a context-overflow assistant turn (input exceeds the 200k window). */
	function overflowAssistant(content = [{ type: "text" as const, text: "" }]) {
		return {
			role: "assistant" as const,
			content,
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "error" as const,
			errorMessage: "prompt is too long: 250000 tokens > 200000 maximum",
			usage: {
				input: 250000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 250000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	function contentfulOverflowAssistant() {
		return overflowAssistant([{ type: "text" as const, text: "prompt is too long" }]);
	}

	function collectNotices() {
		const notices: { level: string; message: string; source?: string }[] = [];
		session.subscribe(event => {
			if (event.type === "notice") {
				notices.push({ level: event.level, message: event.message, source: event.source });
			}
		});
		return notices;
	}

	function countCompactionStarts() {
		let starts = 0;
		session.subscribe(event => {
			if (event.type === "auto_compaction_start") starts++;
		});
		return () => starts;
	}

	it("pauses (no continuation, single warning) when compaction creates no headroom", async () => {
		session.setTodoPhases([{ name: "Work", tasks: [{ content: "Finish task", status: "in_progress" }] }]);
		const todoReminders: unknown[] = [];
		session.subscribe(event => {
			if (event.type === "todo_reminder") todoReminders.push(event);
		});
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		// Auto-continue runs through agent.prompt (#promptWithMessage), not
		// agent.continue — spy both so "no continuation" is actually proven.
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		// Residual context stays above the recovery band after the rewrite: the most
		// recent turn alone is too large to reduce.
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 190000, contextWindow: 200000, percent: 95 });

		const notices = collectNotices();
		const startCount = countCompactionStarts();

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = highUsageAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		// Compaction ran exactly once and did not schedule a continuation turn
		// (neither the auto-continue prompt nor a queued-message continue).
		expect(startCount()).toBe(1);
		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();
		expect(todoReminders.length).toBe(0);
		expect(session.isStreaming).toBe(false);

		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(1);
		expect(noProgress[0].level).toBe("warning");
	});

	it("clamps a reserve exceeding the window for small-window threshold recovery bands", () => {
		const settings = {
			enabled: true,
			strategy: "context-full" as const,
			thresholdTokens: -1,
			thresholdPercent: -1,
			reserveTokens: 16384,
			keepRecentTokens: 10000,
			autoContinue: true,
		};
		const threshold = resolveThresholdTokens(4096, settings);

		expect(threshold).toBe(3482);
		expect(Math.floor(threshold * 0.8)).toBe(2785);
		expect(shouldCompact(3600, 4096, settings)).toBe(true);
	});

	it("blocks todo continuations after no-headroom compaction when auto-continue is disabled", async () => {
		session.settings.set("compaction.autoContinue", false);
		session.setTodoPhases([{ name: "Work", tasks: [{ content: "Finish task", status: "in_progress" }] }]);
		const todoReminders: unknown[] = [];
		session.subscribe(event => {
			if (event.type === "todo_reminder") todoReminders.push(event);
		});
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 190000, contextWindow: 200000, percent: 95 });

		const notices = collectNotices();

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = highUsageAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();
		expect(todoReminders.length).toBe(0);
		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(1);
	});

	it("drains queued messages when no-headroom compaction pauses auto-continue", async () => {
		session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "Queued while compacting" }],
			display: false,
			timestamp: Date.now(),
		});

		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 190000, contextWindow: 200000, percent: 95 });

		const notices = collectNotices();

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = highUsageAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(1);
	});

	it("blocks automatic maintenance when threshold compaction has nothing to summarize", async () => {
		session.setTodoPhases([{ name: "Work", tasks: [{ content: "Finish task", status: "in_progress" }] }]);
		const todoReminders: unknown[] = [];
		session.subscribe(event => {
			if (event.type === "todo_reminder") todoReminders.push(event);
		});
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(undefined);

		const notices = collectNotices();

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = highUsageAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();
		expect(todoReminders.length).toBe(0);
		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(1);
	});

	it("drains queued messages when no-op threshold compaction pauses automatic maintenance", async () => {
		session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "Queued while compacting" }],
			display: false,
			timestamp: Date.now(),
		});

		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(undefined);

		const notices = collectNotices();

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = highUsageAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(1);
	});

	it("auto-continues (no warning) when compaction creates headroom", async () => {
		// The auto-continue path runs #scheduleAutoContinuePrompt → #promptWithMessage
		// → agent.prompt. Stub both prompt and continue so no real agent loop runs.
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		// Residual context drops well under the threshold: real reduction happened.
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 1000, contextWindow: 200000, percent: 0.5 });

		const notices = collectNotices();

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = highUsageAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		// Headroom was created, so the guard scheduled the agent-authored
		// continuation prompt and stayed silent.
		expect(promptSpy).toHaveBeenCalledTimes(1);
		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(0);
	});

	it("rebases the in-flight prompt snapshot so mid-run compaction is not misread as a dead-end", async () => {
		// Regression: the pending context snapshot is set once per prompt and
		// lives for the whole run. A fresh compaction entry hides every earlier
		// usage anchor from getContextBreakdown, which then fell back to the
		// stale run-start figure until the next provider response — a run
		// submitted above the recovery band (0.8 × 170k = 136k here) tripped the
		// "freed too little context" warning even though compaction had
		// genuinely shrunk the context (observed live: 312k → 86k real tokens,
		// warning still emitted).
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		// Hold the initial prompt in flight so the pending snapshot stays alive
		// through the compaction, exactly like a live tool-loop run. The second
		// agent.prompt call is the scheduled auto-continue — the "headroom was
		// seen" signal the test awaits.
		const gate = Promise.withResolvers<void>();
		const firstPromptCall = Promise.withResolvers<void>();
		const secondPromptCall = Promise.withResolvers<void>();
		let promptCalls = 0;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockImplementation(() => {
			promptCalls++;
			if (promptCalls === 1) firstPromptCall.resolve();
			if (promptCalls === 2) secondPromptCall.resolve();
			return gate.promise as never;
		});

		const notices = collectNotices();
		// The dead-end warning is the "no headroom was seen" signal: the headroom
		// tail runs AFTER auto_compaction_end is emitted, so the test awaits one
		// of the tail's two observable outcomes instead of the end event.
		const noProgressSeen = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "notice" && event.message.includes(NO_PROGRESS_FRAGMENT)) noProgressSeen.resolve();
		});

		// ~150k-token prompt: above the recovery band, below the 170k threshold,
		// so the pre-prompt maintenance pass stays quiet and the snapshot records
		// the run-start size. agent.prompt is mocked, so the text never reaches
		// the branch — it exists only in the in-flight snapshot.
		const inFlightPrompt = session.prompt("x".repeat(600_000));
		// The snapshot is written immediately before agent.prompt; awaiting the
		// first (gated) call guarantees it is in place before the threshold turn
		// lands — emitting earlier would race the submission pipeline and let
		// compaction run against an unset snapshot.
		await firstPromptCall.promise;

		// Mid-run, the billed context crosses the threshold and compaction fires;
		// the rewritten context (summary only) is tiny.
		const assistantMsg = highUsageAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });
		// Wait for the headroom verdict while the prompt is still gated —
		// releasing the gate earlier would clear the snapshot and mask the
		// regression. Fixed behavior schedules the auto-continue (second prompt
		// call); the regression emits the dead-end warning instead.
		await Promise.race([secondPromptCall.promise, noProgressSeen.promise]);

		gate.resolve();
		await inFlightPrompt;
		await session.waitForIdle();

		// The stale 150k run-start snapshot must not be measured as residual
		// context: no dead-end warning, and the auto-continue prompt ran
		// (initial call + continuation).
		expect(promptSpy).toHaveBeenCalledTimes(2);
		expect(continueSpy).not.toHaveBeenCalled();
		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(0);
	});
	/**
	 * Seed several large prior turns into the session branch so `prepareCompaction`
	 * returns a real preparation after the overflow recovery drops the failed
	 * assistant from active context. The drop only touches agent state, and a
	 * branch under `keepRecentTokens` (20k) has nothing to summarize, so each
	 * turn carries enough text (~10k tokens) to push older turns past the cut.
	 */
	function seedPriorTurns() {
		const bigText = "lorem ipsum ".repeat(4000); // ~10k tokens of summarizable text
		for (let i = 0; i < 4; i++) {
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: bigText }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "stop",
				usage: {
					input: 1000,
					output: 50,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1050,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			});
			sessionManager.appendMessage({ role: "user", content: "next", timestamp: Date.now() });
		}
	}

	it("retries an overflow recovery that fits the window but stays inside the recovery band", async () => {
		// Regression for the band-vs-fit conflation (#3412 review): the overflow
		// retry only needs the rebuilt prompt to fit the window, NOT to drop under
		// `COMPACTION_RECOVERY_BAND × threshold`. Residual lands at 150k on a 200k
		// window — above the 0.8×170k≈136k recovery band, but comfortably under the
		// usable budget — so the retry MUST proceed instead of dead-ending.
		seedPriorTurns();
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 150000, contextWindow: 200000, percent: 75 });

		const notices = collectNotices();

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = overflowAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		expect(continueSpy).toHaveBeenCalledTimes(1);
		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(0);
	});

	it("removes the visible overflow error before retrying after compaction", async () => {
		seedPriorTurns();
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 150000, contextWindow: 200000, percent: 75 });

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = overflowAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(sessionManager.getBranch()).not.toContainEqual(
			expect.objectContaining({
				type: "message",
				message: expect.objectContaining({
					role: "assistant",
					stopReason: "error",
					errorMessage: assistantMsg.errorMessage,
				}),
			}),
		);
	});

	it("drops a content-less overflow error when no recovery path is available", async () => {
		// Content-less provider rejection turns are live UI only: persisting them
		// writes an empty assistant turn that replays on reload and re-sends the
		// rejected context.
		session.settings.set("contextPromotion.enabled", false);
		session.settings.set("compaction.enabled", false);

		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		const assistantMsg = overflowAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await session.waitForIdle();

		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();
		expect(sessionManager.getBranch()).not.toContainEqual(
			expect.objectContaining({
				type: "message",
				message: expect.objectContaining({
					role: "assistant",
					stopReason: "error",
					errorMessage: assistantMsg.errorMessage,
				}),
			}),
		);
	});

	it("restores the persisted overflow error when compaction skips without committing", async () => {
		// `#runAutoCompaction` returning COMPACTION_CHECK_NONE without writing a
		// compaction summary (no available model, hook cancel, compaction error)
		// MUST NOT erase the user-visible assistant error: the transcript would
		// otherwise lose the only explanation of why the turn stopped.
		seedPriorTurns();
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([]);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = contentfulOverflowAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();
		expect(sessionManager.getBranch()).toContainEqual(
			expect.objectContaining({
				type: "message",
				message: expect.objectContaining({
					role: "assistant",
					stopReason: "error",
					errorMessage: assistantMsg.errorMessage,
				}),
			}),
		);
	});

	it("does not restore a content-less overflow error when compaction skips without committing", async () => {
		seedPriorTurns();
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([]);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = overflowAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();
		expect(sessionManager.getBranch()).not.toContainEqual(
			expect.objectContaining({
				type: "message",
				message: expect.objectContaining({
					role: "assistant",
					stopReason: "error",
					errorMessage: assistantMsg.errorMessage,
				}),
			}),
		);
	});

	it("restores the persisted overflow error when no-op recovery blocks automatic continuation", async () => {
		// A no-preparation overflow recovery returns the blocked-continuation result
		// to prevent a no-op compaction loop, but it has not written a compaction
		// summary. The failed assistant must be restored so the transcript keeps the
		// error that explains why the turn stopped.
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(undefined);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = contentfulOverflowAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();
		expect(sessionManager.getBranch()).toContainEqual(
			expect.objectContaining({
				type: "message",
				message: expect.objectContaining({
					role: "assistant",
					stopReason: "error",
					errorMessage: assistantMsg.errorMessage,
				}),
			}),
		);
	});

	it("restores the persisted overflow error before draining queued no-op recovery", async () => {
		// A queued user turn still deserves a follow-up, but no-op recovery has not
		// written a compaction summary. Restore the failed assistant before the queue
		// drains so the transcript keeps the reason recovery stopped.
		session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "Queued while recovering" }],
			display: false,
			timestamp: Date.now(),
		});
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(undefined);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			expect(sessionManager.getBranch()).toContainEqual(
				expect.objectContaining({
					type: "message",
					message: expect.objectContaining({
						role: "assistant",
						stopReason: "error",
						errorMessage: assistantMsg.errorMessage,
					}),
				}),
			);
			expect(session.agent.state.messages.at(-1)).toMatchObject({
				role: "assistant",
				stopReason: "error",
				errorMessage: assistantMsg.errorMessage,
			});
			session.agent.clearAllQueues();
		});

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = contentfulOverflowAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(sessionManager.getBranch()).toContainEqual(
			expect.objectContaining({
				type: "message",
				message: expect.objectContaining({
					role: "assistant",
					stopReason: "error",
					errorMessage: assistantMsg.errorMessage,
				}),
			}),
		);
	});

	it("does not restore a length stop after handoff recovery commits", async () => {
		session.settings.set("compaction.strategy", "handoff");
		session.settings.set("contextPromotion.enabled", false);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const handoffSpy = vi.spyOn(session, "handoff").mockResolvedValue({ document: "handoff document" });

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "unfinished" }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "length" as const,
			usage: {
				input: 10_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(handoffSpy).toHaveBeenCalledTimes(1);
		expect(continueSpy).not.toHaveBeenCalled();
		expect(sessionManager.getBranch()).not.toContainEqual(
			expect.objectContaining({
				type: "message",
				message: expect.objectContaining({
					role: "assistant",
					stopReason: "length",
				}),
			}),
		);
	});

	it("retries a small-window overflow when the reserve exceeds the model window", async () => {
		// Bundled 4k/8k models can be smaller than the absolute reserve (16,384,
		// explicit or defaulted). Retry fit must clamp that reserve; otherwise the
		// budget goes negative and a prompt that fits the actual model window dead-ends.
		session.settings.set("compaction.keepRecentTokens", 100);
		const smallText = "lorem ipsum ".repeat(100);
		for (let i = 0; i < 4; i++) {
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: smallText }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "stop",
				usage: {
					input: 100,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 110,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			});
			sessionManager.appendMessage({ role: "user", content: "next", timestamp: Date.now() });
		}
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		const currentModel = session.agent.state.model;
		session.agent.setModel({ ...currentModel, contextWindow: 4096, maxTokens: 1024 });
		session.settings.set("contextPromotion.enabled", false);
		session.settings.set("compaction.reserveTokens", 16384);
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 1000, contextWindow: 4096, percent: 24.4 });

		const notices = collectNotices();

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = overflowAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		expect(continueSpy).toHaveBeenCalledTimes(1);
		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(0);
	});

	it("retries a near-16k-window overflow when the default reserve leaves no usable budget", async () => {
		// GPT-3.5 variants ship with a 16,385-token context window; the default
		// absolute reserve is 16,384. Retry fit must treat that reserve as
		// effectively impossible for the window, otherwise any realistic compacted
		// prompt dead-ends behind a one-token budget.
		session.settings.set("compaction.keepRecentTokens", 100);
		const smallText = "lorem ipsum ".repeat(100);
		for (let i = 0; i < 4; i++) {
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: smallText }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "stop",
				usage: {
					input: 100,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 110,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			});
			sessionManager.appendMessage({ role: "user", content: "next", timestamp: Date.now() });
		}
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		const currentModel = session.agent.state.model;
		session.agent.setModel({ ...currentModel, contextWindow: 16385, maxTokens: 1024 });
		session.settings.set("contextPromotion.enabled", false);
		// compaction.reserveTokens stays unset: the DEFAULTED reserve is the
		// scenario — an explicit 16384 would be honored and leave a 1-token
		// budget on purpose (see "pauses an overflow retry when it only fits
		// after ignoring a configured reserve" below for the explicit contract).
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 10000, contextWindow: 16385, percent: 61 });

		const notices = collectNotices();

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = overflowAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		expect(continueSpy).toHaveBeenCalledTimes(1);
		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(0);
	});

	it("pauses an overflow retry when it only fits after ignoring a configured reserve", async () => {
		// Retry fit may clamp an impossible reserve that exceeds the model window,
		// but must respect a valid user reserve above the 15% default. Otherwise a
		// prompt in the reserved headroom band can retry straight into overflow.
		seedPriorTurns();
		const currentModel = session.agent.state.model;
		session.agent.setModel({ ...currentModel, contextWindow: 20000, maxTokens: 1024 });
		session.settings.set("contextPromotion.enabled", false);
		session.settings.set("compaction.reserveTokens", 5000);
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 16000, contextWindow: 20000, percent: 80 });

		const notices = collectNotices();

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = overflowAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		expect(continueSpy).not.toHaveBeenCalled();
		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(1);
	});

	it("pauses an overflow retry when a large valid configured reserve leaves a small usable budget", async () => {
		// A 90k reserve on a 100k model is valid: the retry prompt must fit inside
		// the remaining ~10k usable budget. The proportional fallback is only for
		// default/impossible reserves, not explicit large reserves.
		seedPriorTurns();
		const currentModel = session.agent.state.model;
		session.agent.setModel({ ...currentModel, contextWindow: 100000, maxTokens: 1024 });
		session.settings.set("contextPromotion.enabled", false);
		session.settings.set("compaction.reserveTokens", 90000);
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 15000, contextWindow: 100000, percent: 15 });

		const notices = collectNotices();

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = overflowAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		expect(continueSpy).not.toHaveBeenCalled();
		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(1);
	});
	/**
	 * Seed a single large `useless` tool result (plus tiny follow-up turns that
	 * keep its suffix inside the cache-warm window) so the per-turn maintenance
	 * passes free ~40k tokens before compaction runs — the same shape as the
	 * #3174 pruning regression. This drives `postMaintenanceContextTokens` (the
	 * trigger handed to the headroom guard) well below the recovery band.
	 */
	function seedPrunableMaintenance(now: number) {
		sessionManager.appendMessage({ role: "user", content: "Investigate everything.", timestamp: now - 200 });
		const bigCallId = "call-big-useless";
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: bigCallId, name: "grep", arguments: { pattern: "TODO" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now - 180,
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: bigCallId,
			toolName: "grep",
			content: [{ type: "text", text: "match line\n".repeat(20000) }], // ~40k+ tokens
			isError: false,
			useless: true,
			timestamp: now - 170,
		});
		for (let i = 0; i < 4; i++) {
			const smallId = `call-small-${i}`;
			const ts = now - 160 + i * 2;
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "toolCall", id: smallId, name: "read", arguments: { path: `note-${i}.md` } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "toolUse",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: ts,
			});
			sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: smallId,
				toolName: "read",
				content: [{ type: "text", text: `tiny note ${i}` }],
				isError: false,
				timestamp: ts + 1,
			});
		}
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
	}

	it("auto-continues when residual sits at the recovery band but the trigger was already sub-band", async () => {
		// Regression for the #3412 review: when stale/tool-output pruning already
		// dropped context under the recovery band BEFORE this pass, the trigger
		// (postMaintenanceContextTokens) is itself sub-band. The old guard returned
		// `residual < trigger`, so a residual that merely held the line at/under the
		// band — not strictly smaller than the already-safe trigger — was reported
		// as no-progress and the auto-continue was suppressed with a false warning,
		// even though the next turn could no longer re-trip threshold compaction.
		const now = Date.now();
		// Pin the threshold so the recovery band is exact: floor(76384 * 0.8) = 61107.
		session.settings.set("compaction.thresholdTokens", 76384);
		session.settings.set("compaction.thresholdPercent", -1);
		session.settings.set("compaction.strategy", "context-full");
		session.settings.set("compaction.dropUseless", true);
		session.settings.set("compaction.supersedeReads", true);
		session.settings.set("compaction.keepRecentTokens", 10000);
		session.settings.set("compaction.reserveTokens", 16384);
		seedPrunableMaintenance(now);

		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		// Residual lands AT the band (61000 <= 61107). Maintenance pruning already
		// drove the trigger below this, so the old strict-less guard would have
		// suppressed; the band check proves headroom and continues.
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 61000, contextWindow: 200000, percent: 30.5 });

		const notices = collectNotices();

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		// Final turn billed above the 76384 threshold so threshold compaction fires.
		const finalAssistant = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "continuing." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 5000,
				output: 1000,
				cacheRead: 85000,
				cacheWrite: 0,
				totalTokens: 91000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now,
		};
		session.agent.emitExternalEvent({ type: "message_end", message: finalAssistant });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [finalAssistant] });

		await compactionDone;
		await session.waitForIdle();

		expect(promptSpy).toHaveBeenCalledTimes(1);
		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(0);
	});

	it("pauses (single warning) when an overflow recovery still does not fit the window", async () => {
		// The genuine dead-end the retry guard must still catch: even after dropping
		// the failed turn the rebuilt prompt is over the window, so retrying would
		// hit the same overflow. Pause once instead of looping.
		seedPriorTurns();
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 205000, contextWindow: 200000, percent: 102.5 });

		const notices = collectNotices();
		const startCount = countCompactionStarts();

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = overflowAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		expect(startCount()).toBe(1);
		expect(continueSpy).not.toHaveBeenCalled();
		expect(session.isStreaming).toBe(false);
		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(1);
		expect(noProgress[0].level).toBe("warning");
	});

	it("auto-continues (no warning) when a shake rescue frees the oversized tail", async () => {
		// The escalation contract: compaction cut at the only turn boundary but the
		// kept tail (e.g. a huge tool result) still sits over the recovery band. The
		// guard now runs an elide shake INSIDE that tail; once it frees enough, the
		// auto-continue proceeds instead of pausing with the no-progress warning.
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		// Residual is over the band until the rescue elides the tail, then drops.
		let shaken = false;
		vi.spyOn(session, "getContextUsage").mockImplementation(() =>
			shaken
				? { tokens: 1000, contextWindow: 200000, percent: 0.5 }
				: { tokens: 190000, contextWindow: 200000, percent: 95 },
		);
		const shakeSpy = vi.spyOn(session, "shake").mockImplementation(async () => {
			shaken = true;
			return { mode: "elide", toolResultsDropped: 1, blocksDropped: 0, tokensFreed: 160000, artifactId: "art-1" };
		});

		const notices = collectNotices();

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = highUsageAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		expect(shakeSpy).toHaveBeenCalledWith("elide", expect.anything());
		expect(promptSpy).toHaveBeenCalledTimes(1);
		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(0);
		const recovery = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("dead-end recovery"));
		expect(recovery.length).toBe(1);
		expect(recovery[0].level).toBe("info");
	});

	it("still warns when a shake rescue cannot free the irreducible tail", async () => {
		// When the oversized tail has nothing elide-eligible (image-only or plain
		// prose), the rescue frees nothing, the residual stays over the band, and
		// the guard MUST still pause with the single no-progress warning.
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 190000, contextWindow: 200000, percent: 95 });
		// Nothing eligible: shake reports zero dropped, so residual is unchanged.
		const shakeSpy = vi
			.spyOn(session, "shake")
			.mockResolvedValue({ mode: "elide", toolResultsDropped: 0, blocksDropped: 0, tokensFreed: 0 });

		const notices = collectNotices();

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = highUsageAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		expect(shakeSpy).toHaveBeenCalledWith("elide", expect.anything());
		expect(promptSpy).not.toHaveBeenCalled();
		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(1);
		expect(noProgress[0].level).toBe("warning");
		const recovery = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("dead-end recovery"));
		expect(recovery.length).toBe(0);
		// The dead-end is also stamped on the compaction entry so the transcript
		// divider badges the pause and carries the warning across rebuilds/resume.
		const compactionEntry = sessionManager
			.getEntries()
			.filter((e): e is CompactionEntry => e.type === "compaction")
			.at(-1);
		expect(compactionEntry?.warning).toContain(NO_PROGRESS_FRAGMENT);
	});

	it("auto-continues (no warning) when the image-drop tier frees an image-only tail", async () => {
		// Elide cannot touch image content (collectShakeRegions skips image-only
		// tool results and user-message images), so the rescue's second tier drops
		// attached images — the automated `/shake images` remedy — and re-tests
		// the recovery band before the guard is allowed to pause.
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		let imagesDropped = false;
		vi.spyOn(session, "getContextUsage").mockImplementation(() =>
			imagesDropped
				? { tokens: 1000, contextWindow: 200000, percent: 0.5 }
				: { tokens: 190000, contextWindow: 200000, percent: 95 },
		);
		// Nothing elide-eligible in the oversized tail.
		vi.spyOn(session, "shake").mockResolvedValue({
			mode: "elide",
			toolResultsDropped: 0,
			blocksDropped: 0,
			tokensFreed: 0,
		});
		const dropSpy = vi.spyOn(session, "dropImages").mockImplementation(async () => {
			imagesDropped = true;
			return { removed: 2 };
		});

		const notices = collectNotices();

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = highUsageAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		expect(dropSpy).toHaveBeenCalledTimes(1);
		expect(promptSpy).toHaveBeenCalledTimes(1);
		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(0);
		const recovery = notices.filter(
			n => n.source === NOTICE_SOURCE && n.message.includes("dropped 2 attached images"),
		);
		expect(recovery.length).toBe(1);
		expect(recovery[0].level).toBe("info");
		// A rescued pass must not stamp the dead-end warning on the entry.
		const compactionEntry = sessionManager
			.getEntries()
			.filter((e): e is CompactionEntry => e.type === "compaction")
			.at(-1);
		expect(compactionEntry?.warning).toBeUndefined();
	});
});

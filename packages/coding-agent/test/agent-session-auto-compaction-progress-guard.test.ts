import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
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

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected built-in anthropic model to exist");
		}

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
		expect(session.isStreaming).toBe(false);

		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(1);
		expect(noProgress[0].level).toBe("warning");
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
});

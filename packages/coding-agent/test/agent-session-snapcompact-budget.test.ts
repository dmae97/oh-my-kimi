/**
 * Regression test for issue #3247.
 *
 * Snapcompact's bundled `MAX_FRAMES_DEFAULT = 80` × `FRAME_TOKEN_ESTIMATE = 5024`
 * ≈ 402k tokens worth of frames. On any sub-1M-token window (e.g. Claude
 * Sonnet 4.5's 200k), passing the default cap to `snapcompact.compact()` made
 * the post-render projection in `AgentSession` always overflow the budget,
 * emit the "snapcompact could not bring the context under the limit" warning
 * on every threshold tick, and downgrade to an LLM summary. The fix sizes the
 * `maxFrames` cap from the live model window (window − reserve − non-message
 * overhead − kept-recent − summary-text reserve) before calling
 * `snapcompact.compact()`.
 *
 * The contract this test defends: for a 200k-window vision model with sane
 * kept-recent traffic, AgentSession MUST pass a budget-sized `maxFrames`
 * (smaller than `MAX_FRAMES_DEFAULT`, and with `maxFrames × FRAME_TOKEN_ESTIMATE`
 * inside the resolved budget) so the projection accepts the snapcompact
 * result instead of falling back to the LLM summarizer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { effectiveReserveTokens } from "@oh-my-pi/pi-agent-core/compaction";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";

describe("AgentSession snapcompact frame-budget sizing", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-snapcompact-budget-");

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled claude-sonnet-4-5 model");
		// Sanity: the contract only holds for vision models with a window
		// genuinely smaller than the snapcompact upper bound. If the bundled
		// catalog ever raises Sonnet's window past 1M, this test no longer
		// covers the failure mode the fix targets.
		expect(model.input).toContain("image");
		expect(model.contextWindow).toBeLessThan(1_000_000);

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});

		// Seed a representative long-running session: many turn-pairs with
		// substantial filler so prepareCompaction() splits the branch into
		// "discard + summarize" (oldest) vs "kept-recent" (newest).
		const filler = "the quick brown fox jumps over the lazy dog. ".repeat(64);
		for (let i = 0; i < 64; i++) {
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `turn ${i}: ${filler}` }],
				timestamp: Date.now() - (64 - i) * 1000,
			});
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `reply ${i}: ${filler}` }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "stop",
				usage: {
					input: 1000,
					output: 1000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now() - (64 - i) * 1000 + 100,
			});
		}

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.strategy": "snapcompact",
				"compaction.autoContinue": false,
				// Force a small kept-recent window so the seeded conversation
				// definitely splits into discard + kept and prepareCompaction()
				// returns a non-empty preparation.
				"compaction.keepRecentTokens": 4000,
			}),
			modelRegistry,
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

	it("passes a window-sized maxFrames to snapcompact.compact() on sub-1M-token models", async () => {
		// Capture the options snapcompact.compact() is invoked with, and short-
		// circuit it so the projection downstream evaluates against a known
		// empty-frame archive (which fits any budget). The contract is about
		// what the caller asks for, not what snapcompact then chooses to emit.
		const model = session.model;
		if (!model) throw new Error("Expected model to be set on session");
		const ctxWindow = model.contextWindow ?? 0;
		expect(ctxWindow).toBeGreaterThan(0);

		const branchEntries = sessionManager.getBranch();
		const firstKeptEntry = branchEntries[branchEntries.length - 1];
		if (!firstKeptEntry?.id) throw new Error("Expected branch entry with id");

		const compactSpy = vi.spyOn(snapcompact, "compact").mockResolvedValue({
			summary: "stubbed snapcompact",
			shortSummary: "stub",
			firstKeptEntryId: firstKeptEntry.id,
			tokensBefore: 100_000,
			details: { readFiles: [], modifiedFiles: [] },
			preserveData: {
				snapcompact: { frames: [], totalChars: 0, truncatedChars: 0 },
			},
		});

		await session.compact(undefined, { mode: "snapcompact" });

		expect(compactSpy).toHaveBeenCalledTimes(1);
		const opts = compactSpy.mock.calls[0]?.[1];
		expect(opts).toBeDefined();
		const maxFrames = opts?.maxFrames;
		expect(maxFrames).toBeDefined();
		expect(maxFrames).toBeLessThan(snapcompact.MAX_FRAMES_DEFAULT);
		expect(maxFrames).toBeGreaterThan(0);

		// The chosen cap MUST keep the projected frame budget inside the
		// resolved (window − reserve) envelope — otherwise the projection
		// guard would reject and loop back to the LLM summary every tick.
		const reserve = effectiveReserveTokens(ctxWindow, {
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 4000,
		});
		const budget = ctxWindow - reserve;
		expect((maxFrames ?? 0) * snapcompact.FRAME_TOKEN_ESTIMATE).toBeLessThan(budget);
	});

	it("skips snapcompact entirely when kept-recent already exceeds the budget", async () => {
		// Append one synthetic message large enough to overflow the model window
		// on its own (kept by findCutPoint since keepRecentTokens=4000 falls
		// well short of it). Snapcompact CANNOT fit even a single frame; the
		// session MUST skip it instead of running and emitting "could not bring
		// the context under the limit" every tick.
		const model = session.model;
		if (!model) throw new Error("Expected model");
		const ctxWindow = model.contextWindow ?? 0;
		const huge = "a".repeat(ctxWindow * 4);
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: huge }],
			timestamp: Date.now(),
		});

		const compactSpy = vi.spyOn(snapcompact, "compact");
		const notices: { level: string; message: string }[] = [];
		session.subscribe(event => {
			if (event.type === "notice") {
				notices.push({ level: event.level, message: event.message });
			}
		});

		await expect(session.compact(undefined, { mode: "snapcompact" })).rejects.toThrow();

		// snapcompact.compact() MUST NOT be invoked when the budget cannot
		// fit even one frame — running it just to reject the result and
		// re-emit the warning is the exact loop issue #3247 reports.
		expect(compactSpy).not.toHaveBeenCalled();
		// The user-facing notice MUST explain the kept-history overflow rather
		// than the misleading "could not bring the context under the limit"
		// (which implied snapcompact had run and produced an oversized result).
		expect(notices.some(n => n.level === "warning" && n.message.includes("kept history"))).toBe(true);
	});
});

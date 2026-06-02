import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { SILENT_ABORT_MARKER } from "@oh-my-pi/pi-coding-agent/session/messages";
import { Text } from "@oh-my-pi/pi-tui";
import { formatNumber, TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import type { HookSelectorSlider } from "../src/modes/components/hook-selector";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

/**
 * Matches the plan-approved synthetic-prompt dispatch. `#approvePlan` calls
 * `session.prompt(rendered, { synthetic: true })` exclusively for that case,
 * so the `synthetic: true` option flag is the unique discriminator.
 */
const isPlanApprovedCall = (args: unknown[]): boolean =>
	args.length >= 2 &&
	typeof args[0] === "string" &&
	typeof args[1] === "object" &&
	args[1] !== null &&
	(args[1] as { synthetic?: boolean }).synthetic === true;

function usageWithInput(input: number): Usage {
	return {
		input,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantWithUsage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: usageWithInput(0),
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

function compactNumber(value: number): string {
	return formatNumber(value).toLowerCase();
}

describe("InteractiveMode plan review rendering", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		Bun.gc(true);
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-plan-review-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		}

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		const currentMode = mode;
		const currentSession = session;
		const currentAuthStorage = authStorage;
		const currentTempDir = tempDir;
		mode = undefined as unknown as InteractiveMode;
		session = undefined as unknown as AgentSession;
		authStorage = undefined as unknown as AuthStorage;
		tempDir = undefined as unknown as TempDir;
		currentMode?.stop();
		await currentSession?.dispose();
		currentAuthStorage?.close();
		currentTempDir?.removeSync();
		resetSettingsForTest();
		Bun.gc(true);
	});

	it("appends each submitted plan review preview to preserve scrollback", async () => {
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# First plan\n\nalpha");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(mode, "showHookSelector").mockResolvedValue("Refine plan");

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
			finalPlanFilePath: "local://PLAN.md",
		});

		const firstPreview = mode.chatContainer.children.at(-1);
		expect(firstPreview).toBeDefined();
		expect(firstPreview!.render(120).join("\n")).toContain("First plan");

		const marker = new Text("MARKER", 0, 0);
		mode.chatContainer.addChild(marker);
		await Bun.write(resolvedPlanPath, "# Second plan\n\nbeta");

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
			finalPlanFilePath: "local://PLAN.md",
		});

		const secondPreview = mode.chatContainer.children.at(-1);
		expect(secondPreview).toBeDefined();
		expect(secondPreview).not.toBe(firstPreview);
		expect(mode.chatContainer.children.at(-2)).toBe(marker);
		expect(mode.chatContainer.children.at(-3)).toBe(firstPreview);
		expect(firstPreview!.render(120).join("\n")).toContain("First plan");
		expect(firstPreview!.render(120).join("\n")).not.toContain("Second plan");
		expect(secondPreview!.render(120).join("\n")).toContain("Second plan");
	});

	it("offers approve-and-keep-context as a distinct plan approval path", async () => {
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nDo the thing.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 7320, contextWindow: 10000, percent: 73.2 });
		const selector = vi.spyOn(mode, "showHookSelector").mockResolvedValue("Refine plan");

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
			finalPlanFilePath: "local://APPROVED.md",
		});

		expect(selector).toHaveBeenCalledWith(
			"Plan mode - next step",
			[
				"Approve and execute",
				"Approve and compact context",
				"Approve and keep context (~7.3k / 10k)",
				"Refine plan",
			],
			expect.any(Object),
			expect.any(Object),
		);
	});

	it("ignores aborted zero-usage assistant messages when estimating context usage", () => {
		session.agent.appendMessage(assistantWithUsage({ usage: usageWithInput(7320), stopReason: "stop" }));
		session.agent.appendMessage(assistantWithUsage({ usage: usageWithInput(0), stopReason: "aborted" }));

		expect(session.getContextUsage({ contextWindow: 10000 })).toMatchObject({
			tokens: 7320,
			contextWindow: 10000,
			percent: 73.2,
		});
	});

	it("measures keep-context approval against the execution model restored after plan mode", async () => {
		mode.stop();
		await session.dispose();

		const modelRegistry = new ModelRegistry(authStorage);
		const executionModel = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		const planModel = modelRegistry.find("anthropic", "claude-opus-4-6");
		if (!executionModel?.contextWindow || !planModel?.contextWindow) {
			throw new Error("Expected test models with context windows");
		}
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: executionModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ modelRoles: { plan: `anthropic/${planModel.id}` } }),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");

		await mode.handlePlanModeCommand();
		expect(session.model?.id).toBe(planModel.id);

		const planFilePath = mode.planModePlanFilePath ?? "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nUse execution context.");

		const tokens = 180000;
		const contextSpy = vi.spyOn(session, "getContextUsage").mockImplementation(options => {
			const contextWindow = options?.contextWindow ?? 0;
			return {
				tokens,
				contextWindow,
				percent: (tokens / contextWindow) * 100,
			};
		});
		const selector = vi.spyOn(mode, "showHookSelector").mockResolvedValue("Refine plan");

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
			finalPlanFilePath: "local://APPROVED.md",
		});

		expect(contextSpy).toHaveBeenCalledWith({ contextWindow: executionModel.contextWindow });
		expect(selector.mock.calls[0]?.[1]).toEqual([
			"Approve and execute",
			"Approve and compact context",
			`Approve and keep context (~${compactNumber(tokens)} / ${compactNumber(executionModel.contextWindow)})`,
			"Refine plan",
		]);
	});

	it("disables keep-context approval when execution context usage is above ninety-five percent", async () => {
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nToo much context.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 9600, contextWindow: 10000, percent: 96 });
		const selector = vi.spyOn(mode, "showHookSelector").mockResolvedValue("Refine plan");

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
			finalPlanFilePath: "local://APPROVED.md",
		});

		expect(selector.mock.calls[0]?.[2]).toEqual(
			expect.objectContaining({
				disabledIndices: [2],
			}),
		);
	});

	it("keeps keep-context approval enabled at exactly ninety-five percent", async () => {
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nAt the threshold.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 9500, contextWindow: 10000, percent: 95 });
		const selector = vi.spyOn(mode, "showHookSelector").mockResolvedValue("Refine plan");

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
			finalPlanFilePath: "local://APPROVED.md",
		});

		expect(selector.mock.calls[0]?.[2]).toEqual(
			expect.objectContaining({
				disabledIndices: undefined,
			}),
		);
	});

	it("keeps the keep-context label plain when context usage is unknown", async () => {
		const planFilePath = "local://PLAN.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nDo the thing.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		// Post-compaction: tokens unknown until the next LLM response.
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: null, contextWindow: 200000, percent: null });
		const selector = vi.spyOn(mode, "showHookSelector").mockResolvedValue("Refine plan");

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
			finalPlanFilePath: "local://APPROVED.md",
		});

		expect(selector).toHaveBeenCalledWith(
			"Plan mode - next step",
			["Approve and execute", "Approve and compact context", "Approve and keep context", "Refine plan"],
			expect.any(Object),
			expect.any(Object),
		);
	});

	it("approves a plan without clearing the session when keeping context", async () => {
		const planFilePath = "local://PLAN.md";
		const finalPlanFilePath = "local://APPROVED.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		const resolvedFinalPlanPath = resolveLocalUrlToPath(finalPlanFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nKeep context.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: null, contextWindow: 200000, percent: null });
		vi.spyOn(mode, "showHookSelector").mockResolvedValue("Approve and keep context");
		const clear = vi.spyOn(mode, "handleClearCommand").mockResolvedValue();
		const prompt = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
			finalPlanFilePath,
		});

		expect(clear).not.toHaveBeenCalled();
		expect(await Bun.file(resolvedFinalPlanPath).text()).toBe("# Plan\n\nKeep context.");
		expect(prompt).toHaveBeenCalledWith(expect.any(String), {
			synthetic: true,
		});
	});

	it("keeps the existing approve-and-execute path clearing the session", async () => {
		const planFilePath = "local://PLAN.md";
		const finalPlanFilePath = "local://APPROVED.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nClear context.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(mode, "showHookSelector").mockResolvedValue("Approve and execute");
		const clear = vi.spyOn(mode, "handleClearCommand").mockResolvedValue();
		const prompt = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
			finalPlanFilePath,
		});

		expect(clear).toHaveBeenCalledTimes(1);
		expect(prompt).toHaveBeenCalledWith(expect.any(String), {
			synthetic: true,
		});
	});

	it("executes on the slider-selected tier, surviving #exitPlanMode's model restore", async () => {
		// Regression: the model-tier slider's choice used to be applied BEFORE
		// #approvePlan ran. #approvePlan → #exitPlanMode restores the model that
		// was active before plan mode (#planModePreviousModelState), which silently
		// reverted the operator's pick — sliding to "slow" still executed on the
		// default model. The fix defers application until after the plan-mode exit.
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const slow = session.modelRegistry.find("anthropic", "claude-opus-4-5");
		const def = session.modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!slow || !def) throw new Error("Expected sonnet + opus to exist in registry");

		// plan === default === the session model: this is what makes plan-mode entry
		// record a previous-model state for #exitPlanMode to restore. slow differs,
		// so an early application would be clobbered by that restore.
		session.settings.setModelRole("default", "anthropic/claude-sonnet-4-5");
		session.settings.setModelRole("slow", "anthropic/claude-opus-4-5");
		session.settings.setModelRole("plan", "anthropic/claude-sonnet-4-5");

		const planFilePath = "local://PLAN.md";
		const finalPlanFilePath = "local://APPROVED.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nRun this on the slow tier.");

		await mode.handlePlanModeCommand();
		expect(session.getPlanModeState()?.enabled).toBe(true);
		expect(session.model?.id).toBe(def.id);

		// Keep-context path avoids newSession() so the assertion isolates the
		// exit-plan-mode restore from session-clear effects.
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: null, contextWindow: 200000, percent: null });
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		let observedSegments: string[] = [];
		vi.spyOn(mode, "showHookSelector").mockImplementation(
			async (_title, _options, _dialogOptions, extra?: { slider?: HookSelectorSlider }) => {
				const slider = extra?.slider;
				expect(slider).toBeDefined();
				observedSegments = slider!.segments.map(segment => segment.label);
				const slowIndex = slider!.segments.findIndex(segment => segment.label === "slow");
				expect(slowIndex).toBeGreaterThanOrEqual(0);
				// Simulate the operator sliding the tier to "slow" before approving.
				slider!.onChange?.(slowIndex);
				return "Approve and keep context";
			},
		);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
			finalPlanFilePath,
		});

		expect(observedSegments).toEqual(["default", "slow"]);
		// The load-bearing assertion: the approved plan executes on the operator's
		// selected tier, not the restored default.
		expect(session.model?.id).toBe(slow.id);
	});

	it("re-enters plan mode on the approved titled artifact after approve-and-execute", async () => {
		const planFilePath = "local://PLAN.md";
		const finalPlanFilePath = "local://APPROVED.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nExecute then edit.");

		await mode.handlePlanModeCommand();

		vi.spyOn(mode, "showHookSelector").mockResolvedValue("Approve and execute");
		vi.spyOn(mode, "handleClearCommand").mockResolvedValue();
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "APPROVED",
			finalPlanFilePath,
		});

		expect(mode.planModeEnabled).toBe(false);
		expect(session.getPlanReferencePath()).toBe(finalPlanFilePath);

		await mode.handlePlanModeCommand();
		expect(session.getPlanModeState()).toMatchObject({
			enabled: true,
			planFilePath: finalPlanFilePath,
			reentry: true,
		});
	});

	it("Approve and compact context: ok outcome dispatches plan-approved after compaction", async () => {
		const planFilePath = "local://PLAN.md";
		const finalPlanFilePath = "local://APPROVED.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nCompact and execute.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(mode, "showHookSelector").mockResolvedValue("Approve and compact context");
		const compactSpy = vi.spyOn(mode, "handleCompactCommand").mockResolvedValue("ok");
		const markSentSpy = vi.spyOn(session, "markPlanReferenceSent");
		const promptSpy = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
			finalPlanFilePath,
		});

		// Compaction was run with the rendered planning-specific custom instruction.
		expect(compactSpy).toHaveBeenCalledTimes(1);
		const [compactInstruction] = compactSpy.mock.calls[0]!;
		expect(typeof compactInstruction).toBe("string");
		expect(compactInstruction as string).toContain("Preparing to execute the approved plan");
		expect(compactInstruction as string).toContain(finalPlanFilePath);

		// Plan-approved synthetic prompt was dispatched.
		const planApprovedIdx = promptSpy.mock.calls.findIndex(isPlanApprovedCall);
		expect(planApprovedIdx).toBeGreaterThanOrEqual(0);

		// markPlanReferenceSent fires on the dispatch path so the executor's first
		// turn doesn't double-inject the plan reference (it was just dispatched
		// inside the synthetic prompt).
		expect(markSentSpy).toHaveBeenCalledTimes(1);
	});

	it("Approve and compact context: cancelled outcome skips plan-approved dispatch", async () => {
		// Mock `handleCompactCommand` to surface the "cancelled" outcome directly.
		// (Testing the consumer — `#approvePlan`'s outcome handling — at the
		// CompactionOutcome boundary; the underlying executeCompaction → sentinel
		// classification path is producer-layer and not under T3's contract.)
		const planFilePath = "local://PLAN.md";
		const finalPlanFilePath = "local://APPROVED.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nCancel mid-compact.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(mode, "showHookSelector").mockResolvedValue("Approve and compact context");
		vi.spyOn(mode, "handleCompactCommand").mockResolvedValue("cancelled");
		const showWarningSpy = vi.spyOn(mode, "showWarning");
		const setPlanRefSpy = vi.spyOn(session, "setPlanReferencePath");
		const markSentSpy = vi.spyOn(session, "markPlanReferenceSent");
		const promptSpy = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
			finalPlanFilePath,
		});

		// Operator was told the dispatch was deferred.
		expect(showWarningSpy).toHaveBeenCalledWith(
			expect.stringContaining("Plan approved, but compaction was cancelled"),
		);
		// Plan reference path was recorded so the session knows about the approved
		// plan at its final destination …
		expect(setPlanRefSpy).toHaveBeenCalledWith(finalPlanFilePath);
		// … but markPlanReferenceSent was NOT called, so the next operator turn
		// will inject the reference fresh via #buildPlanReferenceMessage. This is
		// the load-bearing assertion that the cancel path leaves the executor
		// with the plan in its first turn.
		expect(markSentSpy).not.toHaveBeenCalled();
		// And — the contract — the plan-approved synthetic prompt was NOT dispatched.
		expect(promptSpy.mock.calls.some(isPlanApprovedCall)).toBe(false);
	});

	it("Approve and compact context: failed outcome still dispatches plan-approved (best-effort)", async () => {
		// Mock `handleCompactCommand` to surface the "failed" outcome directly.
		// Failure → approval intent stands → synthetic dispatch fires.
		const planFilePath = "local://PLAN.md";
		const finalPlanFilePath = "local://APPROVED.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nFail mid-compact.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(mode, "showHookSelector").mockResolvedValue("Approve and compact context");
		vi.spyOn(mode, "handleCompactCommand").mockResolvedValue("failed");
		const markSentSpy = vi.spyOn(session, "markPlanReferenceSent");
		const promptSpy = vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
			finalPlanFilePath,
		});

		// Plan-approved synthetic prompt WAS dispatched despite the failure.
		expect(promptSpy.mock.calls.some(isPlanApprovedCall)).toBe(true);
		// markPlanReferenceSent fires on this dispatch path.
		expect(markSentSpy).toHaveBeenCalledTimes(1);
	});
	it("Approve and compact context: setPlanReferencePath is pinned BEFORE compaction flushes the queue", async () => {
		// Regression: handleCompactCommand internally awaits flushCompactionQueue,
		// which can deliver a user-queued message back to the session. If
		// setPlanReferencePath had not been called yet, that queued turn would
		// hit #buildPlanReferenceMessage with the stale plan-mode path. Pin it
		// before the compaction await.
		const planFilePath = "local://PLAN.md";
		const finalPlanFilePath = "local://APPROVED.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nQueue race.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(mode, "showHookSelector").mockResolvedValue("Approve and compact context");
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		const setPlanRefSpy = vi.spyOn(session, "setPlanReferencePath");
		let planRefSetWhenCompactionRan = false;
		vi.spyOn(mode, "handleCompactCommand").mockImplementation(async () => {
			planRefSetWhenCompactionRan = setPlanRefSpy.mock.calls.some(call => call[0] === finalPlanFilePath);
			return "ok";
		});

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
			finalPlanFilePath,
		});

		// The contract: by the time handleCompactCommand runs (and flushes the
		// compaction queue inside), setPlanReferencePath has already pinned the
		// approved plan path, so any user message queued during compaction is
		// dispatched against the approved plan, not the plan-mode draft.
		expect(planRefSetWhenCompactionRan).toBe(true);
	});

	// ==========================================================================
	// Phase 6 — B layer: #approvePlan flag lifecycle via try/finally.
	//
	// Drives `handlePlanApproval` with each CompactionOutcome variant and
	// asserts `session.isPlanCompactAbortPending === false` after `#approvePlan`
	// resolves/rejects. The flag is the only state that can leak into later
	// unrelated aborts; the `try/finally` in `#approvePlan` is what protects it.
	// ==========================================================================

	/**
	 * Drives `handlePlanApproval` with the "Approve and compact context"
	 * picker outcome and the given compaction-outcome mock. Returns the promise
	 * the harness produces so the caller decides between `await` (B1-B3 happy
	 * paths) and `expect(...).rejects` (B4 throw path). Does NOT swallow errors.
	 */
	async function approveWithCompact(
		compactOutcome: "ok" | "cancelled" | "failed" | "throw",
		throwError?: Error,
	): Promise<void> {
		const planFilePath = "local://PLAN.md";
		const finalPlanFilePath = "local://APPROVED.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nBody.");

		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(mode, "showHookSelector").mockResolvedValue("Approve and compact context");
		if (compactOutcome === "throw") {
			vi.spyOn(mode, "handleCompactCommand").mockRejectedValue(throwError ?? new Error("compact boom"));
		} else {
			vi.spyOn(mode, "handleCompactCommand").mockResolvedValue(compactOutcome);
		}
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
			finalPlanFilePath,
		});
	}

	it("B1: Approve and compact context + ok outcome → flag cleared by finally", async () => {
		await approveWithCompact("ok");
		expect(session.isPlanCompactAbortPending).toBe(false);
	});

	it("B2: Approve and compact context + cancelled outcome → flag cleared by finally even without aborted message_end", async () => {
		await approveWithCompact("cancelled");
		// The leak-guard contract: no aborted message_end consumed the flag,
		// but `finally` still cleared it so the next real abort cannot be
		// silenced.
		expect(session.isPlanCompactAbortPending).toBe(false);
	});

	it("B3: Approve and compact context + failed outcome → flag cleared by finally", async () => {
		await approveWithCompact("failed");
		expect(session.isPlanCompactAbortPending).toBe(false);
	});

	it("B4: Approve and compact context + handleCompactCommand throws → showError surfaces the failure AND flag cleared by finally before the outer catch", async () => {
		// `handlePlanApproval` wraps `#approvePlan` in a try/catch
		// in `InteractiveMode` that consumes the throw and reports via
		// `showError`. The contract under test is:
		//   1. `#approvePlan`'s own `try/finally` clears the flag BEFORE the
		//      throw bubbles up to that outer catch.
		//   2. The outer catch surfaces the failure via `showError` (not
		//      silenced).
		const showErrorSpy = vi.spyOn(mode, "showError");
		await approveWithCompact("throw", new Error("synthetic compaction failure"));
		expect(session.isPlanCompactAbortPending).toBe(false);
		expect(showErrorSpy).toHaveBeenCalledWith(expect.stringContaining("synthetic compaction failure"));
	});

	it("B5: Approve and execute (no compact) → markPlanCompactAbortPending never called; flag stays false", async () => {
		const planFilePath = "local://PLAN.md";
		const finalPlanFilePath = "local://APPROVED.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nBody.");
		mode.planModeEnabled = true;
		mode.planModePlanFilePath = planFilePath;
		vi.spyOn(mode, "showHookSelector").mockResolvedValue("Approve and execute");
		const markSpy = vi.spyOn(session, "markPlanCompactAbortPending");
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "PLAN",
			finalPlanFilePath,
		});

		expect(markSpy).not.toHaveBeenCalled();
		expect(session.isPlanCompactAbortPending).toBe(false);
	});

	it("re-enters plan mode on the approved titled artifact after approval", async () => {
		const planFilePath = "local://PLAN.md";
		const finalPlanFilePath = "local://APPROVED.md";
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		await Bun.write(resolvedPlanPath, "# Plan\n\nKeep editing this artifact.");

		await mode.handlePlanModeCommand();
		expect(session.getPlanModeState()?.planFilePath).toBe(planFilePath);

		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: null, contextWindow: 200000, percent: null });
		const selector = vi.spyOn(mode, "showHookSelector").mockResolvedValue("Approve and keep context");
		const showError = vi.spyOn(mode, "showError");
		vi.spyOn(session, "prompt").mockResolvedValue(undefined as never);

		await mode.handlePlanApproval({
			planFilePath,
			planExists: true,
			title: "APPROVED",
			finalPlanFilePath,
		});

		expect(mode.planModeEnabled).toBe(false);
		expect(session.getPlanReferencePath()).toBe(finalPlanFilePath);

		await mode.handlePlanModeCommand();
		expect(session.getPlanModeState()).toMatchObject({
			enabled: true,
			planFilePath: finalPlanFilePath,
			reentry: true,
		});

		await mode.handlePlanApproval({
			planFilePath: finalPlanFilePath,
			planExists: true,
			title: "APPROVED",
			finalPlanFilePath,
		});

		expect(selector).toHaveBeenCalledTimes(2);
		expect(showError).not.toHaveBeenCalled();
	});

	// ==========================================================================
	// Phase 6 — D layer: replay-side render branches in AssistantMessageComponent.
	//
	// D1 asserts that the persisted `SILENT_ABORT_MARKER` suppresses the red
	// "Operation aborted" line. D2 is the over-suppression regression guard —
	// an aborted message with NO marker must still render the line.
	// ==========================================================================

	function renderAssistant(message: AssistantMessage, width = 120): string {
		const component = new AssistantMessageComponent(message);
		return Bun.stripANSI(component.render(width).join("\n"));
	}

	/** Build an aborted assistant message with the minimum required fields. */
	function buildAbortedAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "Approved plan; transitioning to compaction." }],
			api: "openai-completions",
			provider: "github-copilot",
			model: "gpt-4o",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			timestamp: Date.now(),
			...overrides,
		};
	}

	it("D1: Replay of an assistant message with SILENT_ABORT_MARKER + aborted: rendered component contains no /Operation aborted/", () => {
		const message = buildAbortedAssistantMessage({ errorMessage: SILENT_ABORT_MARKER });
		const rendered = renderAssistant(message);
		expect(rendered).not.toMatch(/Operation aborted/);
		// The marker itself MUST NOT leak into rendered output either.
		expect(rendered).not.toContain(SILENT_ABORT_MARKER);
	});

	it("D2: Replay of an aborted message with no marker + empty content: rendered component DOES contain 'Operation aborted'", () => {
		// Over-suppression regression guard: silent path is opt-in via the
		// persisted marker. A user-cancel abort with no marker and no content
		// still surfaces the standard label.
		const message = buildAbortedAssistantMessage({ content: [], errorMessage: undefined });
		const rendered = renderAssistant(message);
		expect(rendered).toContain("Operation aborted");
	});
});

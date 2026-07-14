import { afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import * as path from "node:path";
import * as core from "@oh-my-pi/pi-agent-core";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runGuidedGoalTurn } from "@oh-my-pi/pi-coding-agent/goals/guided-setup";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentSession as RealAgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

const planModel = { provider: "test", id: "plan" } as unknown as Model<Api>;
const slowModel = { provider: "test", id: "slow" } as unknown as Model<Api>;
const currentModel = { provider: "test", id: "current" } as unknown as Model<Api>;

function createSession(options?: {
	plan?: boolean;
	slow?: boolean;
	current?: boolean;
	thinkingLevel?: ThinkingLevel;
}): AgentSession {
	const plan = options?.plan ?? true;
	const slow = options?.slow ?? true;
	const current = options?.current ?? false;
	return {
		resolveRoleModelWithThinking(role: string) {
			if (role === "plan" && plan) return { model: planModel, explicitThinkingLevel: false };
			if (role === "slow" && slow) return { model: slowModel, explicitThinkingLevel: false };
			return { model: undefined, explicitThinkingLevel: false };
		},
		modelRegistry: {
			getAvailable: () => [currentModel],
			getApiKey: async () => "test-key",
			resolver: (model: typeof planModel) => `${model.provider}/${model.id}:key`,
		},
		settings: {
			getModelRole: () => undefined,
		},
		model: current ? currentModel : undefined,
		thinkingLevel: options?.thinkingLevel,
		sessionId: "session-1",
		preferWebsockets: true,
		providerSessionState: new Map(),
		agent: { telemetry: undefined },
	} as unknown as AgentSession;
}

function mockResponse(args: unknown) {
	return {
		stopReason: "tool_use",
		content: [{ type: "toolCall", name: "respond", arguments: args }],
	};
}

function createToolSession(cwd: string, settings: Settings): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
	};
}

async function createInteractiveGoalHarness(): Promise<{
	mode: InteractiveMode;
	session: RealAgentSession;
	modelRegistry: ModelRegistry;
	authStorage: AuthStorage;
	tempDir: TempDir;
	cleanup: () => Promise<void>;
}> {
	resetSettingsForTest();
	const tempDir = TempDir.createSync("@pi-guided-goal-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"goal.enabled": true,
		"plan.enabled": true,
	});
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Expected claude-sonnet-4-5 to exist in registry");
	}
	const initialTools = await createTools(createToolSession(tempDir.path(), settings), ["read"]);
	const toolRegistry = new Map<string, Tool>(initialTools.map(tool => [tool.name, tool] as const));
	const session = new RealAgentSession({
		agent: new core.Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: initialTools,
				messages: [],
			},
		}),
		sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
		settings,
		modelRegistry,
		toolRegistry,
		rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
	});
	const mode = new InteractiveMode(session, "test");
	vi.spyOn(mode, "addMessageToChat").mockReturnValue([]);
	vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
	mode.ui.requestRender = vi.fn();
	return {
		mode,
		session,
		modelRegistry,
		authStorage,
		tempDir,
		cleanup: async () => {
			mode.stop();
			await session.dispose();
			authStorage.close();
			await tempDir.remove();
			resetSettingsForTest();
		},
	};
}

describe("guided goal setup", () => {
	beforeAll(() => {
		initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		(core.instrumentedCompleteSimple as { mockRestore?: () => void }).mockRestore?.();
	});

	it("prefers the plan model", async () => {
		const complete = spyOn(core, "instrumentedCompleteSimple").mockResolvedValue(
			mockResponse({ kind: "question", question: "What is done?" }) as never,
		);

		const result = await runGuidedGoalTurn(createSession(), { messages: [{ role: "user", content: "Ship it" }] });

		expect(result).toEqual({ kind: "question", question: "What is done?" });
		expect(complete.mock.calls[0]?.[0]).toBe(planModel);
	});

	it("routes the guided-goal request through the session provider transport", async () => {
		const complete = spyOn(core, "instrumentedCompleteSimple").mockResolvedValue(
			mockResponse({ kind: "question", question: "What is done?" }) as never,
		);
		const session = createSession();

		await runGuidedGoalTurn(session, { messages: [{ role: "user", content: "Ship it" }] });

		// Regression (#5304): without a websocket-capable provider session, Codex
		// falls back to SSE and rejects websocket-only models (gpt-5.6-luna) with
		// "Model not found". The oneshot must inherit the session transport and use
		// an isolated session id so it never pollutes the main conversation state.
		const requestOptions = complete.mock.calls[0]?.[2];
		expect(requestOptions?.preferWebsockets).toBe(true);
		expect(requestOptions?.providerSessionState).toBe(session.providerSessionState);
		expect(requestOptions?.promptCacheKey).toBe("session-1");
		expect(requestOptions?.sessionId).toStartWith("session-1:guided-goal:");
		expect(requestOptions?.sessionId).not.toBe("session-1");
	});

	it("reuses a supplied side session id across interview turns", async () => {
		const complete = spyOn(core, "instrumentedCompleteSimple").mockResolvedValue(
			mockResponse({ kind: "question", question: "What is done?" }) as never,
		);
		const session = createSession();
		const sideSessionId = "session-1:guided-goal:fixed";

		// Regression (#5471 review): a multi-question interview must share one Codex
		// side session so it does not leak a websocket-only socket per turn and trip
		// websocket_connection_limit_reached (which drops back to the rejected SSE path).
		await runGuidedGoalTurn(session, { messages: [{ role: "user", content: "Ship it" }], sideSessionId });
		await runGuidedGoalTurn(session, { messages: [{ role: "user", content: "More" }], sideSessionId });

		expect(complete.mock.calls[0]?.[2]?.sessionId).toBe(sideSessionId);
		expect(complete.mock.calls[1]?.[2]?.sessionId).toBe(sideSessionId);
	});

	it("falls back to slow when plan is unavailable", async () => {
		const complete = spyOn(core, "instrumentedCompleteSimple").mockResolvedValue(
			mockResponse({ kind: "ready", objective: "Deliver the confirmed feature." }) as never,
		);

		const result = await runGuidedGoalTurn(createSession({ plan: false, slow: true }), {
			messages: [{ role: "user", content: "Ship it" }],
		});

		expect(result).toEqual({ kind: "ready", objective: "Deliver the confirmed feature." });
		expect(complete.mock.calls[0]?.[0]).toBe(slowModel);
	});

	it("throws when no guided-goal fallback model resolves", async () => {
		await expect(
			runGuidedGoalTurn(createSession({ plan: false, slow: false }), {
				messages: [{ role: "user", content: "Ship it" }],
			}),
		).rejects.toThrow("No plan, slow, or current session model is available for /guided-goal.");
	});

	it("falls back to the current session model when plan and slow roles are unresolved", async () => {
		const complete = spyOn(core, "instrumentedCompleteSimple").mockResolvedValue(
			mockResponse({ kind: "ready", objective: "Deliver with the active model." }) as never,
		);

		const result = await runGuidedGoalTurn(
			createSession({ plan: false, slow: false, current: true, thinkingLevel: ThinkingLevel.High }),
			{ messages: [{ role: "user", content: "Ship it" }] },
		);

		expect(result).toEqual({ kind: "ready", objective: "Deliver with the active model." });
		expect(complete.mock.calls[0]?.[0]).toBe(currentModel);
		expect((complete.mock.calls[0]?.[2] as { reasoning?: ThinkingLevel } | undefined)?.reasoning).toBe(
			ThinkingLevel.High,
		);
	});

	it("preserves disabled reasoning when falling back to the current session model", async () => {
		const complete = spyOn(core, "instrumentedCompleteSimple").mockResolvedValue(
			mockResponse({ kind: "ready", objective: "Deliver without reasoning." }) as never,
		);

		await runGuidedGoalTurn(
			createSession({ plan: false, slow: false, current: true, thinkingLevel: ThinkingLevel.Off }),
			{ messages: [{ role: "user", content: "Ship it" }] },
		);

		expect((complete.mock.calls[0]?.[2] as { disableReasoning?: boolean } | undefined)?.disableReasoning).toBe(true);
	});

	it("rejects malformed structured responses", async () => {
		spyOn(core, "instrumentedCompleteSimple").mockResolvedValue(mockResponse({ kind: "ready" }) as never);

		await expect(
			runGuidedGoalTurn(createSession(), { messages: [{ role: "user", content: "Ship it" }] }),
		).rejects.toThrow("guided goal returned an invalid response");
	});

	it("captures a draft objective alongside a question", async () => {
		spyOn(core, "instrumentedCompleteSimple").mockResolvedValue(
			mockResponse({ kind: "question", question: "What is done?", objective: "Ship the feature." }) as never,
		);

		const result = await runGuidedGoalTurn(createSession(), { messages: [{ role: "user", content: "Ship it" }] });

		expect(result).toEqual({ kind: "question", question: "What is done?", objective: "Ship the feature." });
	});

	it("obfuscates secrets in the transcript before the request and deobfuscates the echoed objective", async () => {
		const obfuscator = {
			hasSecrets: () => true,
			obfuscate: (text: string) => text.replaceAll("SECRET123", "#S0#"),
			deobfuscate: (text: string) => text.replaceAll("#S0#", "SECRET123"),
		};
		const session = { ...createSession(), obfuscator } as unknown as AgentSession;
		const complete = spyOn(core, "instrumentedCompleteSimple").mockResolvedValue(
			// The model echoes the obfuscated placeholder back inside its objective.
			mockResponse({ kind: "ready", objective: "Rotate the key #S0# and redeploy." }) as never,
		);

		const result = await runGuidedGoalTurn(session, {
			messages: [{ role: "user", content: "my api key is SECRET123, automate rotation" }],
		});

		// The provider never sees the raw secret — only the placeholder.
		const sentContext = complete.mock.calls[0]?.[1] as { messages: Array<{ content: Array<{ text: string }> }> };
		const sentText = sentContext.messages[0]!.content[0]!.text;
		expect(sentText).not.toContain("SECRET123");
		expect(sentText).toContain("#S0#");

		// The objective is restored to the real secret before the goal starts.
		expect(result).toEqual({ kind: "ready", objective: "Rotate the key SECRET123 and redeploy." });
	});

	it("salvages the latest guided objective when the turn cap ends on a question without one", async () => {
		const harness = await createInteractiveGoalHarness();
		try {
			const model = harness.session.model;
			if (!model) throw new Error("expected session model");
			spyOn(harness.session, "resolveRoleModelWithThinking").mockReturnValue({
				model,
				explicitThinkingLevel: false,
			} as never);
			spyOn(harness.modelRegistry, "getApiKey").mockResolvedValue("test-key");
			const complete = spyOn(core, "instrumentedCompleteSimple");
			complete
				.mockResolvedValueOnce(
					mockResponse({
						kind: "question",
						question: "Who is the user?",
						objective: "Draft one.",
					}) as never,
				)
				.mockResolvedValueOnce(
					mockResponse({
						kind: "question",
						question: "What is success?",
						objective: "Draft two is the latest usable objective.",
					}) as never,
				)
				.mockResolvedValueOnce(mockResponse({ kind: "question", question: "Constraint?" }) as never)
				.mockResolvedValueOnce(mockResponse({ kind: "question", question: "Timeline?" }) as never)
				.mockResolvedValueOnce(mockResponse({ kind: "question", question: "Risk?" }) as never)
				.mockResolvedValueOnce(mockResponse({ kind: "question", question: "Anything else?" }) as never);
			const editor = vi
				.spyOn(harness.mode, "showHookEditor")
				.mockResolvedValueOnce("answer 1")
				.mockResolvedValueOnce("answer 2")
				.mockResolvedValueOnce("answer 3")
				.mockResolvedValueOnce("answer 4")
				.mockResolvedValueOnce("answer 5")
				.mockResolvedValueOnce("answer 6")
				.mockResolvedValueOnce("Confirmed objective.");
			const warning = vi.spyOn(harness.mode, "showWarning");

			await harness.mode.handleGuidedGoalCommand("Initial goal");

			expect(editor).toHaveBeenLastCalledWith(
				"Review guided goal",
				"Draft two is the latest usable objective.",
				undefined,
				{
					promptStyle: true,
				},
			);
			expect(harness.session.getGoalModeState()?.goal.objective).toBe("Confirmed objective.");
			expect(warning).not.toHaveBeenCalledWith(
				"Guided goal setup needs more detail. Run /guided-goal again with a narrower objective.",
			);
		} finally {
			await harness.cleanup();
		}
	});
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

// Regression for https://github.com/can1357/oh-my-pi/issues/4579.
//
// When the advisor role resolves to a reasoning model without a controllable
// effort surface (Devin `devin-agent`: `reasoning: true`, `thinking: undefined`
// — Cascade routes by sibling model id, not a wire param), the advisor
// descriptor MUST NOT hand the Agent a concrete `Effort.Medium` default. That
// would trip `requireSupportedEffort` inside `stream.ts` on the first prompt
// and disable the advisor session-wide with an empty
// `Supported efforts:` warning list.
//
// This mirrors the `auto`-path fix already covered by
// `auto-thinking-classifier.test.ts:145` for `clampAutoThinkingEffort`, at the
// advisor descriptor boundary.
describe("AgentSession advisor descriptor thinking level", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let anthropicModel: Model;
	let devinModel: Model;

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-advisor-devin-thinking-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		// Seeding a runtime API key exposes the bundled Devin catalog for
		// `resolveAdvisorRoleSelection` / `getAvailable()` without any live
		// network discovery.
		authStorage.setRuntimeApiKey("devin", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const anthropic = getBundledModel("anthropic", "claude-sonnet-4-5");
		const devin = getBundledModel("devin", "glm-5-2");
		if (!anthropic) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");
		if (!devin) throw new Error("Expected bundled devin/glm-5-2 to exist");
		anthropicModel = anthropic;
		devinModel = devin;
	});

	afterAll(async () => {
		authStorage.close();
		try {
			await sharedDir.remove();
		} catch {}
	});

	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-advisor-devin-thinking-");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const agent = new Agent({
			initialState: {
				model: anthropicModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			advisorTools: [],
		});
	});

	afterEach(async () => {
		await session.dispose();
		try {
			await tempDir.remove();
		} catch {}
	});

	it("Devin advisor with no configured thinking suffix boots without an unsupported-effort throw", () => {
		// Confirm the catalog shape that triggered the bug: `reasoning: true` with
		// no controllable `thinking.efforts`. If this drifts upstream the
		// regression's assumptions no longer hold.
		expect(devinModel.reasoning).toBe(true);
		expect(devinModel.thinking).toBeUndefined();

		session.settings.setModelRole("advisor", `${devinModel.provider}/${devinModel.id}`);

		expect(session.setAdvisorEnabled(true)).toBe(true);
		expect(session.isAdvisorActive()).toBe(true);

		// Before the fix, the descriptor hardcoded `ThinkingLevel.Medium` which
		// flowed to `Agent#state.thinkingLevel` and then tripped
		// `requireSupportedEffort` inside `mapOptionsForApi`'s `devin-agent`
		// branch on the first stream. The clamp now forwards no explicit effort
		// (mirroring `clampAutoThinkingEffort`), so the Agent stores `undefined`
		// and the provider's default routing applies.
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor Agent to be live");
		expect(advisor.state.model.provider).toBe(devinModel.provider);
		expect(advisor.state.model.id).toBe(devinModel.id);
		expect(advisor.state.thinkingLevel).toBeUndefined();
		// `Off` is reserved for the explicit "disable reasoning" selector; the
		// Devin path forwards no effort while keeping reasoning enabled.
		expect(advisor.state.disableReasoning).toBe(false);
	});

	it("Anthropic advisor with no configured thinking suffix still gets the medium default", () => {
		// Guard against over-clamping: models that support `medium` MUST keep
		// receiving it so the historical advisor thinking budget is preserved.
		session.settings.setModelRole("advisor", `${anthropicModel.provider}/${anthropicModel.id}`);
		expect(session.setAdvisorEnabled(true)).toBe(true);

		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor Agent to be live");
		expect(advisor.state.model.provider).toBe(anthropicModel.provider);
		expect(advisor.state.thinkingLevel).toBe(Effort.Medium);
	});

	it("Devin advisor with an explicit :off suffix disables reasoning without clamping to inherit", () => {
		// `off` is an explicit user opt-out and MUST reach the Agent as
		// `disableReasoning: true` regardless of the model's effort surface. The
		// clamp helper preserves `off`; verifying that here so a future change
		// to the descriptor doesn't route `off` through the Devin
		// no-controllable-effort fallback and silently re-enable reasoning.
		session.settings.setModelRole("advisor", `${devinModel.provider}/${devinModel.id}:off`);
		expect(session.setAdvisorEnabled(true)).toBe(true);

		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor Agent to be live");
		expect(advisor.state.thinkingLevel).toBeUndefined();
		expect(advisor.state.disableReasoning).toBe(true);
	});
});

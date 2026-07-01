/**
 * Contract: when the SDK supplies provider-shaping options to AgentSession,
 * the advisor `Agent` constructed by `#buildAdvisorRuntime` inherits them so
 * its OpenRouter/OpenAI requests cache and route like the main turn.
 *
 * Regression for can1357/oh-my-pi#3639: before the fix, the advisor was built
 * with only `sessionId`/`getApiKey`/telemetry — it dropped the session's
 * `streamFn` wrapper (so `providers.openrouterVariant` and `loopGuard` never
 * landed on advisor requests), its `promptCacheKey` (so OpenAI Responses
 * fell back to a different cache shard), its shared `providerSessionState`,
 * and its explicit websocket preference.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession advisor provider-options parity", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-advisor-parity-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		model = bundled;
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
	const settings = () =>
		Settings.isolated({
			"compaction.enabled": false,
			"providers.openrouterVariant": "floor",
			"model.loopGuard.enabled": true,
		});

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-advisor-parity-");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
	});

	afterEach(async () => {
		await session.dispose();
		try {
			await tempDir.remove();
		} catch {}
	});

	it("inherits streamFn, promptCacheKey, and providerSessionState from the session", () => {
		const advisorStreamFn: StreamFn = (m, ctx, opts) => streamSimple(m, ctx, opts);
		const mainAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent: mainAgent,
			sessionManager,
			settings: settings(),
			modelRegistry,
			advisorTools: [],
			advisorStreamFn,
			preferWebsockets: true,
		});
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);

		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");

		// Stream wrapper from the SDK reaches the advisor — without it,
		// `providers.openrouterVariant` would never be applied to advisor
		// requests (issue #3639) and the Agent would fall back to bare
		// `streamSimple`.
		expect(advisor.streamFn).toBe(advisorStreamFn);
		expect(advisor.streamFn).not.toBe(streamSimple);

		// Shared transport / fast-mode state map keeps Codex websockets and
		// Anthropic fast-mode fallbacks consistent across the two agents.
		expect(advisor.providerSessionState).toBe(session.providerSessionState);

		// Stable advisor-scoped cache key keeps consecutive advisor turns on the
		// same OpenAI Responses shard. With no parent `providerPromptCacheKey`
		// the main agent's effective key is just its `sessionId`, so the
		// advisor's derived key matches its own `${sessionId}-advisor`.
		expect(advisor.sessionId).toMatch(/-advisor$/);
		expect(advisor.promptCacheKey).toBe(`${mainAgent.sessionId}-advisor`);
		expect(advisor.promptCacheKey).toBe(advisor.sessionId);
	});

	it("captures the SDK-provided onPayload, onResponse, onSseEvent, and transformProviderContext on the advisor's stream call", async () => {
		const capturedStreamOptions: Array<SimpleStreamOptions | undefined> = [];
		const captureStreamFn: StreamFn = (_m, _ctx, opts) => {
			capturedStreamOptions.push(opts);
			// Return a stream that immediately fails — we only need to observe
			// the options the advisor handed us before the call.
			throw new Error("capture-stop");
		};
		const onPayload = async (payload: unknown) => payload;
		const onResponse = async (_response: unknown, _model: unknown) => undefined;
		const onSseEvent = (_event: { data: string }, _model: unknown) => {};
		const transformProviderContext = async <T>(context: T): Promise<T> => context;

		const mainAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent: mainAgent,
			sessionManager,
			settings: settings(),
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: captureStreamFn,
			onPayload,
			onResponse,
			onSseEvent,
			transformProviderContext,
			preferWebsockets: true,
		});
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);

		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");

		await advisor.prompt("ping").catch(() => {});

		expect(capturedStreamOptions.length).toBeGreaterThan(0);
		const opts = capturedStreamOptions[0];
		if (!opts) throw new Error("Expected captured advisor stream options");

		// Provider hooks forwarded by the Agent loop carry the session's wrappers
		// (the session wraps `onResponse`/`onSseEvent` to also drive its
		// `RawSseDebugBuffer` — what matters here is that *something* is wired,
		// not the exact closure identity for those two).
		expect(typeof opts.onPayload).toBe("function");
		expect(typeof opts.onResponse).toBe("function");
		expect(typeof opts.onSseEvent).toBe("function");

		// Bare `onPayload` has no session-side wrapping so it reaches the stream
		// call unchanged — proof the SDK-provided hook was installed.
		expect(opts.onPayload).toBe(onPayload);

		// Cache routing identity threaded through into the actual stream call.
		// Without a parent `providerPromptCacheKey`, advisor's effective key
		// collapses to `${main.sessionId}-advisor` which equals its sessionId.
		expect(opts.sessionId).toBe(advisor.sessionId);
		expect(opts.promptCacheKey).toBe(advisor.sessionId);
		expect(opts.providerSessionState).toBe(session.providerSessionState);
		expect(opts.preferWebsockets).toBe(true);
	});

	it("reuses the main agent's providerPromptCacheKey unchanged so tan/shared sessions stay on the parent shard", () => {
		// Regression for codex-connector review on #3640: when the SDK pins
		// `agent.promptCacheKey` (tan/shared-session callers do this to share
		// the parent provider cache while keeping a distinct providerSessionId),
		// the advisor MUST pass that key through unchanged or it cannot read the
		// exact shard populated by the parent turn.
		const parentPromptCacheKey = "tan-parent-cache-key";
		const mainAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			promptCacheKey: parentPromptCacheKey,
		});
		session = new AgentSession({
			agent: mainAgent,
			sessionManager,
			settings: settings(),
			modelRegistry,
			advisorTools: [],
		});
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);

		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");

		// Explicit provider cache keys are shared byte-for-byte with the parent
		// live turn; only the provider session id stays advisor-scoped.
		expect(advisor.promptCacheKey).toBe(parentPromptCacheKey);
		// Session id is still advisor-scoped so credential stickiness and the
		// advisor's session-keyed telemetry stay distinct from the parent.
		expect(advisor.sessionId).toMatch(/-advisor$/);
		expect(advisor.sessionId).not.toBe(advisor.promptCacheKey);
	});
});

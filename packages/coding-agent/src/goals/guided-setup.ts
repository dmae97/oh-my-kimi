import { instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import type { Tool } from "@oh-my-pi/pi-ai";
import { prompt, Snowflake } from "@oh-my-pi/pi-utils";
import { extractTextContent, extractToolCall, parseJsonPayload } from "../commit/utils";
import guidedGoalInterviewPrompt from "../prompts/goals/guided-goal-interview.md" with { type: "text" };
import guidedGoalSystemPrompt from "../prompts/goals/guided-goal-system.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import { concreteThinkingLevel, shouldDisableReasoning, toReasoningEffort } from "../thinking";

const RESPOND_TOOL_NAME = "respond";

const RESPOND_TOOL: Tool = {
	name: RESPOND_TOOL_NAME,
	description: "Return the next guided-goal interview step.",
	parameters: {
		type: "object",
		properties: {
			kind: { type: "string", enum: ["question", "ready"] },
			question: { type: "string" },
			objective: { type: "string" },
		},
		required: ["kind"],
		additionalProperties: false,
	},
	strict: false,
};

export interface GuidedGoalMessage {
	role: "user" | "assistant";
	content: string;
}

export type GuidedGoalTurnResult =
	| { kind: "question"; question: string; objective?: string }
	| { kind: "ready"; objective: string };

export interface GuidedGoalTurnOptions {
	messages: readonly GuidedGoalMessage[];
	signal?: AbortSignal;
	/**
	 * Stable Codex transport session id reused across every turn of one
	 * interview. `handleGuidedGoalCommand` runs up to six turns; minting a fresh
	 * id per turn opens a new websocket-only Codex socket each time (kept in
	 * `providerSessionState` until session dispose), which can trip
	 * `websocket_connection_limit_reached` and drop back to the SSE path this
	 * fix avoids. Callers pass one id for the whole interview; omitted for
	 * one-shot callers, which mint a unique id per call.
	 */
	sideSessionId?: string;
}

/** Mint a guided-goal Codex side-session id keyed off the main session id. */
export function newGuidedGoalSessionId(session: AgentSession): string {
	return `${session.sessionId}:guided-goal:${Snowflake.next()}`;
}

function parseGuidedGoalPayload(value: unknown): GuidedGoalTurnResult {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("guided goal returned an invalid response");
	}
	const payload = value as Record<string, unknown>;
	if (payload.kind === "question" && typeof payload.question === "string" && payload.question.trim()) {
		const question = payload.question.trim();
		if (typeof payload.objective === "string" && payload.objective.trim()) {
			return { kind: "question", question, objective: payload.objective.trim() };
		}
		return { kind: "question", question };
	}
	if (payload.kind === "ready" && typeof payload.objective === "string" && payload.objective.trim()) {
		return { kind: "ready", objective: payload.objective.trim() };
	}
	throw new Error("guided goal returned an invalid response");
}

function parseToolArguments(value: unknown): unknown {
	return typeof value === "string" ? parseJsonPayload(value) : value;
}

export async function runGuidedGoalTurn(
	session: AgentSession,
	options: GuidedGoalTurnOptions,
): Promise<GuidedGoalTurnResult> {
	const plan = session.resolveRoleModelWithThinking("plan");
	const slow = plan.model ? plan : session.resolveRoleModelWithThinking("slow");
	const resolved = slow.model
		? slow
		: {
				model: session.model,
				thinkingLevel: session.thinkingLevel,
				explicitThinkingLevel: false,
				warning: undefined,
			};
	if (!resolved.model) {
		throw new Error("No plan, slow, or current session model is available for /guided-goal.");
	}

	const apiKey = await session.modelRegistry.getApiKey(resolved.model, session.sessionId);
	if (!apiKey) {
		throw new Error(`No API key for ${resolved.model.provider}/${resolved.model.id}`);
	}

	const userPrompt = prompt.render(guidedGoalInterviewPrompt, {
		messages: options.messages.map(message => ({ label: message.role.toUpperCase(), content: message.content })),
	});
	// Secret obfuscation: route the user-authored transcript through the session obfuscator the
	// same way normal turns do, so an API key / secret typed into the rough goal or an answer is
	// never sent verbatim to the plan/slow provider. Deobfuscated again below before display/use.
	const obfuscator = session.obfuscator;
	const promptText = obfuscator?.hasSecrets() ? obfuscator.obfuscate(userPrompt) : userPrompt;
	const thinkingLevel = concreteThinkingLevel(resolved.thinkingLevel);
	const response = await instrumentedCompleteSimple(
		resolved.model,
		{
			systemPrompt: [prompt.render(guidedGoalSystemPrompt)],
			messages: [{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() }],
			tools: [RESPOND_TOOL],
		},
		{
			apiKey: session.modelRegistry.resolver(resolved.model, session.sessionId),
			signal: options.signal,
			reasoning: toReasoningEffort(thinkingLevel),
			disableReasoning: shouldDisableReasoning(thinkingLevel),
			toolChoice: { type: "tool", name: RESPOND_TOOL_NAME },
			// Route through the session's provider transport so websocket-only Codex
			// models (gpt-5.6-luna/sol/terra) get a websocket session instead of
			// falling back to SSE — the Codex SSE /responses endpoint does not serve
			// those ids and rejects the turn with "Model not found" (#5304, same class
			// as the /btw regression in #5213). The side session id is minted once per
			// interview and reused across turns so a multi-question interview shares one
			// Codex socket instead of opening a fresh one each turn; it stays distinct
			// from the main session id so the oneshot's append-only turn state never
			// pollutes the main conversation.
			sessionId: options.sideSessionId ?? newGuidedGoalSessionId(session),
			promptCacheKey: session.sessionId,
			preferWebsockets: session.preferWebsockets,
			providerSessionState: session.providerSessionState,
		},
		{ telemetry: resolveTelemetry(session.agent.telemetry, session.sessionId), oneshotKind: "guided_goal_setup" },
	);

	if (response.stopReason === "error") {
		throw new Error(response.errorMessage ?? "guided goal request failed");
	}
	if (response.stopReason === "aborted") {
		throw new Error("guided goal request aborted");
	}

	const call = extractToolCall(response, RESPOND_TOOL_NAME);
	let result: GuidedGoalTurnResult;
	if (call) {
		result = parseGuidedGoalPayload(parseToolArguments(call.arguments));
	} else {
		const text = extractTextContent(response);
		if (!text) {
			throw new Error("guided goal returned an invalid response");
		}
		result = parseGuidedGoalPayload(parseJsonPayload(text));
	}

	// Reverse the obfuscation: restore any secret placeholders the model echoed back before the
	// question/objective is shown or the goal is started.
	if (!obfuscator?.hasSecrets()) return result;
	if (result.kind === "question") {
		return {
			kind: "question",
			question: obfuscator.deobfuscate(result.question),
			objective: result.objective !== undefined ? obfuscator.deobfuscate(result.objective) : undefined,
		};
	}
	return { kind: "ready", objective: obfuscator.deobfuscate(result.objective) };
}

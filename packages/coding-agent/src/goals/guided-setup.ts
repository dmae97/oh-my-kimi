import { instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import type { Tool } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
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

import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { completeSimple, validateToolCall } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { Type } from "@sinclair/typebox";
import reduceSystemPrompt from "../../commit/prompts/reduce-system.md" with { type: "text" };
import reduceUserPrompt from "../../commit/prompts/reduce-user.md" with { type: "text" };
import type { ChangelogCategory, ConventionalAnalysis, FileObservation } from "../../commit/types";
import { toReasoningEffort } from "../../thinking";
import { extractTextContent, extractToolCall, normalizeAnalysis, parseJsonPayload } from "../utils";

const ReduceTool = {
	name: "create_conventional_analysis",
	description: "Synthesize file observations into a conventional commit analysis.",
	parameters: Type.Object({
		type: Type.Union([
			Type.Literal("feat"),
			Type.Literal("fix"),
			Type.Literal("refactor"),
			Type.Literal("docs"),
			Type.Literal("test"),
			Type.Literal("chore"),
			Type.Literal("style"),
			Type.Literal("perf"),
			Type.Literal("build"),
			Type.Literal("ci"),
			Type.Literal("revert"),
		]),
		scope: Type.Union([Type.String(), Type.Null()]),
		details: Type.Array(
			Type.Object({
				text: Type.String(),
				changelog_category: Type.Optional(
					Type.Union([
						Type.Literal("Added"),
						Type.Literal("Changed"),
						Type.Literal("Fixed"),
						Type.Literal("Deprecated"),
						Type.Literal("Removed"),
						Type.Literal("Security"),
						Type.Literal("Breaking Changes"),
					]),
				),
				user_visible: Type.Optional(Type.Boolean()),
			}),
		),
		issue_refs: Type.Array(Type.String()),
	}),
};

export interface ReducePhaseInput {
	model: Model<Api>;
	apiKey: string;
	thinkingLevel?: ThinkingLevel;
	observations: FileObservation[];
	stat: string;
	scopeCandidates: string;
	typesDescription?: string;
}

export async function runReducePhase({
	model,
	apiKey,
	thinkingLevel,
	observations,
	stat,
	scopeCandidates,
	typesDescription,
}: ReducePhaseInput): Promise<ConventionalAnalysis> {
	const userContent = prompt.render(reduceUserPrompt, {
		types_description: typesDescription,
		observations: observations.flatMap(obs => obs.observations.map(line => `- ${obs.file}: ${line}`)).join("\n"),
		stat,
		scope_candidates: scopeCandidates,
	});
	const response = await completeSimple(
		model,
		{
			systemPrompt: prompt.render(reduceSystemPrompt),
			messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
			tools: [ReduceTool],
		},
		{ apiKey, maxTokens: 2400, reasoning: toReasoningEffort(thinkingLevel) },
	);

	return parseAnalysisResponse(response);
}

function parseAnalysisResponse(message: AssistantMessage): ConventionalAnalysis {
	const toolCall = extractToolCall(message, "create_conventional_analysis");
	if (toolCall) {
		const parsed = validateToolCall([ReduceTool], toolCall) as {
			type: ConventionalAnalysis["type"];
			scope: string | null;
			details: Array<{ text: string; changelog_category?: ChangelogCategory; user_visible?: boolean }>;
			issue_refs: string[];
		};
		return normalizeAnalysis(parsed);
	}
	const text = extractTextContent(message);
	const parsed = parseJsonPayload(text) as {
		type: ConventionalAnalysis["type"];
		scope: string | null;
		details: Array<{ text: string; changelog_category?: ChangelogCategory; user_visible?: boolean }>;
		issue_refs: string[];
	};
	return normalizeAnalysis(parsed);
}

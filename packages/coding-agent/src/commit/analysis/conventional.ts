import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { completeSimple, validateToolCall } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { Type } from "@sinclair/typebox";
import analysisSystemPrompt from "../../commit/prompts/analysis-system.md" with { type: "text" };
import analysisUserPrompt from "../../commit/prompts/analysis-user.md" with { type: "text" };
import type { ChangelogCategory, ConventionalAnalysis } from "../../commit/types";
import { toReasoningEffort } from "../../thinking";
import { extractTextContent, extractToolCall, normalizeAnalysis, parseJsonPayload } from "../utils";

const ConventionalAnalysisTool = {
	name: "create_conventional_analysis",
	description: "Analyze a diff and return conventional commit classification.",
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

export interface ConventionalAnalysisInput {
	model: Model<Api>;
	apiKey: string;
	thinkingLevel?: ThinkingLevel;
	contextFiles?: Array<{ path: string; content: string }>;
	userContext?: string;
	typesDescription?: string;
	recentCommits?: string[];
	scopeCandidates: string;
	stat: string;
	diff: string;
}

/**
 * Generate conventional analysis data from a diff and metadata.
 */
export async function generateConventionalAnalysis({
	model,
	apiKey,
	thinkingLevel,
	contextFiles,
	userContext,
	typesDescription,
	recentCommits,
	scopeCandidates,
	stat,
	diff,
}: ConventionalAnalysisInput): Promise<ConventionalAnalysis> {
	const userContent = prompt.render(analysisUserPrompt, {
		context_files: contextFiles && contextFiles.length > 0 ? contextFiles : undefined,
		user_context: userContext,
		types_description: typesDescription,
		recent_commits: recentCommits?.join("\n"),
		scope_candidates: scopeCandidates,
		stat,
		diff,
	});

	const response = await completeSimple(
		model,
		{
			systemPrompt: prompt.render(analysisSystemPrompt),
			messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
			tools: [ConventionalAnalysisTool],
		},
		{ apiKey, maxTokens: 2400, reasoning: toReasoningEffort(thinkingLevel) },
	);

	return parseAnalysisFromResponse(response);
}

function parseAnalysisFromResponse(message: AssistantMessage): ConventionalAnalysis {
	const toolCall = extractToolCall(message, "create_conventional_analysis");
	if (toolCall) {
		const parsed = validateToolCall([ConventionalAnalysisTool], toolCall) as {
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

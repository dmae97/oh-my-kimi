import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { validateToolCall } from "@oh-my-pi/pi-ai";
import { Type } from "@sinclair/typebox";
import type { ChangelogCategory, ConventionalAnalysis } from "./types";
import { extractTextContent, extractToolCall, normalizeAnalysis, parseJsonPayload } from "./utils";

/**
 * Shared TypeBox schema for the `create_conventional_analysis` tool used by
 * both the single-pass analysis call and the map-reduce reduce phase. Schemas
 * are identical across phases — only the surrounding tool `description`
 * differs to reflect the input the phase is summarizing.
 */
export const conventionalAnalysisParameters = Type.Object({
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
});

export interface ConventionalAnalysisTool {
	name: "create_conventional_analysis";
	description: string;
	parameters: typeof conventionalAnalysisParameters;
}

/**
 * Build a `create_conventional_analysis` tool descriptor. Phase-specific
 * `description` text is the only thing that varies between callers.
 */
export function createConventionalAnalysisTool(description: string): ConventionalAnalysisTool {
	return {
		name: "create_conventional_analysis",
		description,
		parameters: conventionalAnalysisParameters,
	};
}

interface ParsedConventionalAnalysis {
	type: ConventionalAnalysis["type"];
	scope: string | null;
	details: Array<{ text: string; changelog_category?: ChangelogCategory; user_visible?: boolean }>;
	issue_refs: string[];
}

/**
 * Extract a {@link ConventionalAnalysis} from an assistant response, preferring
 * a structured tool call and falling back to JSON embedded in text content.
 */
export function parseConventionalAnalysisResponse(
	message: AssistantMessage,
	tool: ConventionalAnalysisTool,
): ConventionalAnalysis {
	const toolCall = extractToolCall(message, tool.name);
	if (toolCall) {
		const parsed = validateToolCall([tool], toolCall) as ParsedConventionalAnalysis;
		return normalizeAnalysis(parsed);
	}
	const text = extractTextContent(message);
	const parsed = parseJsonPayload(text) as ParsedConventionalAnalysis;
	return normalizeAnalysis(parsed);
}

import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import { getHindsightSessionState } from "../hindsight/backend";
import { formatCurrentTime, formatMemories } from "../hindsight/content";
import type { ToolSession } from ".";

const hindsightRecallSchema = Type.Object({
	query: Type.String({
		description: "Natural language search query. Be specific about what you need to know.",
	}),
});

export type HindsightRecallParams = Static<typeof hindsightRecallSchema>;

const DESCRIPTION = [
	"Search long-term memory (Hindsight) for relevant information. Use proactively before answering",
	"questions about past conversations, user preferences, project history, or any topic where prior",
	"context would help. When in doubt, recall first.",
].join(" ");

export class HindsightRecallTool implements AgentTool<typeof hindsightRecallSchema> {
	readonly name = "recall";
	readonly label = "Recall";
	readonly description = DESCRIPTION;
	readonly parameters = hindsightRecallSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): HindsightRecallTool | null {
		if (session.settings.get("memory.backend") !== "hindsight") return null;
		return new HindsightRecallTool(session);
	}

	async execute(_id: string, params: HindsightRecallParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const sessionId = this.session.getSessionId?.();
			const state = sessionId ? getHindsightSessionState(sessionId) : undefined;
			if (!state) {
				throw new Error("Hindsight backend is not initialised for this session.");
			}

			try {
				const response = await state.client.recall(state.bankId, params.query, {
					budget: state.config.recallBudget,
					maxTokens: state.config.recallMaxTokens,
					types: state.config.recallTypes.length > 0 ? state.config.recallTypes : undefined,
					tags: state.recallTags,
					tagsMatch: state.recallTagsMatch,
				});
				const results = response.results ?? [];
				if (results.length === 0) {
					return {
						content: [{ type: "text", text: "No relevant memories found." }],
						details: {},
					};
				}
				const formatted = formatMemories(results);
				return {
					content: [
						{
							type: "text",
							text: `Found ${results.length} relevant memories (as of ${formatCurrentTime()} UTC):\n\n${formatted}`,
						},
					],
					details: {},
				};
			} catch (err) {
				logger.warn("recall failed", { bankId: state.bankId, error: String(err) });
				throw err instanceof Error ? err : new Error(String(err));
			}
		});
	}
}

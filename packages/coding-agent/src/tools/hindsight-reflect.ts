import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import { getHindsightSessionState } from "../hindsight/backend";
import { ensureBankMission } from "../hindsight/bank";
import type { ToolSession } from ".";

const hindsightReflectSchema = Type.Object({
	query: Type.String({ description: "The question to answer using long-term memory." }),
	context: Type.Optional(Type.String({ description: "Optional additional context to guide the reflection." })),
});

export type HindsightReflectParams = Static<typeof hindsightReflectSchema>;

const DESCRIPTION = [
	"Generate a synthesised answer using long-term memory. Unlike recall (which returns raw memories),",
	'reflect blends memories into a coherent answer. Use for questions like "What do you know about',
	'this user?" or "Summarize project decisions."',
].join(" ");

export class HindsightReflectTool implements AgentTool<typeof hindsightReflectSchema> {
	readonly name = "reflect";
	readonly label = "Reflect";
	readonly description = DESCRIPTION;
	readonly parameters = hindsightReflectSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): HindsightReflectTool | null {
		if (session.settings.get("memory.backend") !== "hindsight") return null;
		return new HindsightReflectTool(session);
	}

	async execute(_id: string, params: HindsightReflectParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const sessionId = this.session.getSessionId?.();
			const state = sessionId ? getHindsightSessionState(sessionId) : undefined;
			if (!state) {
				throw new Error("Hindsight backend is not initialised for this session.");
			}

			try {
				await ensureBankMission(state.client, state.bankId, state.config, state.missionsSet);
				const response = await state.client.reflect(state.bankId, params.query, {
					context: params.context,
					budget: state.config.recallBudget,
					tags: state.recallTags,
					tagsMatch: state.recallTagsMatch,
				});
				const text = response.text?.trim() || "No relevant information found to reflect on.";
				return {
					content: [{ type: "text", text }],
					details: {},
				};
			} catch (err) {
				logger.warn("reflect failed", { bankId: state.bankId, error: String(err) });
				throw err instanceof Error ? err : new Error(String(err));
			}
		});
	}
}

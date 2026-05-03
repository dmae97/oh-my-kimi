import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import { getHindsightSessionState } from "../hindsight/backend";
import { ensureBankMission } from "../hindsight/bank";
import type { ToolSession } from ".";

const hindsightRetainSchema = Type.Object({
	content: Type.String({
		description: "The information to remember. Be specific and self-contained — include who, what, when, why.",
	}),
	context: Type.Optional(
		Type.String({ description: "Optional context describing where this information came from." }),
	),
});

export type HindsightRetainParams = Static<typeof hindsightRetainSchema>;

const DESCRIPTION = [
	"Store information in long-term memory (Hindsight). Use this to remember durable facts:",
	"user preferences, project context, decisions, and anything worth recalling in future sessions.",
	"Be specific — include who, what, when, and why.",
].join(" ");

export class HindsightRetainTool implements AgentTool<typeof hindsightRetainSchema> {
	readonly name = "retain";
	readonly label = "Retain";
	readonly description = DESCRIPTION;
	readonly parameters = hindsightRetainSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): HindsightRetainTool | null {
		if (session.settings.get("memory.backend") !== "hindsight") return null;
		return new HindsightRetainTool(session);
	}

	async execute(_id: string, params: HindsightRetainParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const sessionId = this.session.getSessionId?.();
			const state = sessionId ? getHindsightSessionState(sessionId) : undefined;
			if (!state) {
				throw new Error("Hindsight backend is not initialised for this session.");
			}

			try {
				await ensureBankMission(state.client, state.bankId, state.config, state.missionsSet);
				await state.client.retain(state.bankId, params.content, {
					context: params.context ?? state.config.retainContext,
					metadata: { session_id: sessionId ?? "" },
					async: true,
				});
				return {
					content: [{ type: "text", text: "Memory stored." }],
					details: {},
				};
			} catch (err) {
				logger.warn("retain failed", { bankId: state.bankId, error: String(err) });
				throw err instanceof Error ? err : new Error(String(err));
			}
		});
	}
}

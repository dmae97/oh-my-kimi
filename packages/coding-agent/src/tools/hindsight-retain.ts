import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { getHindsightSessionState } from "../hindsight/backend";
import { enqueueRetain } from "../hindsight/retain-queue";
import retainDescription from "../prompts/tools/retain.md" with { type: "text" };
import type { ToolSession } from ".";

const hindsightRetainSchema = Type.Object({
	items: Type.Array(
		Type.Object({
			content: Type.String({
				description: "The information to remember. Be specific and self-contained — include who, what, when, why.",
			}),
			context: Type.Optional(
				Type.String({ description: "Optional context describing where this information came from." }),
			),
		}),
		{
			minItems: 1,
			description:
				"One or more memories to retain. Batch related facts in a single call rather than calling retain repeatedly — they are deduplicated and consolidated together.",
		},
	),
});

export type HindsightRetainParams = Static<typeof hindsightRetainSchema>;
export class HindsightRetainTool implements AgentTool<typeof hindsightRetainSchema> {
	readonly name = "retain";
	readonly label = "Retain";
	readonly description = retainDescription;
	readonly parameters = hindsightRetainSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): HindsightRetainTool | null {
		if (session.settings.get("memory.backend") !== "hindsight") return null;
		return new HindsightRetainTool(session);
	}

	async execute(_id: string, params: HindsightRetainParams): Promise<AgentToolResult> {
		const sessionId = this.session.getSessionId?.();
		const state = sessionId ? getHindsightSessionState(sessionId) : undefined;
		if (!state || !sessionId) {
			throw new Error("Hindsight backend is not initialised for this session.");
		}

		// Push every item onto the global queue and return immediately. The
		// queue flushes either when it reaches its batch threshold or when its
		// debounce timer fires. If the eventual batch fails, the queue
		// surfaces a UI-only warning notice — the LLM is not informed.
		for (const item of params.items) {
			enqueueRetain(sessionId, item.content, item.context);
		}

		const count = params.items.length;
		const noun = count === 1 ? "memory" : "memories";
		return {
			content: [{ type: "text", text: `${count} ${noun} queued.` }],
			details: { count },
		};
	}
}

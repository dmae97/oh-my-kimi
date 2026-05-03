import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { getHindsightSessionState } from "../hindsight/backend";
import { enqueueRetain } from "../hindsight/retain-queue";
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

	async execute(_id: string, params: HindsightRetainParams): Promise<AgentToolResult> {
		const sessionId = this.session.getSessionId?.();
		const state = sessionId ? getHindsightSessionState(sessionId) : undefined;
		if (!state || !sessionId) {
			throw new Error("Hindsight backend is not initialised for this session.");
		}

		// Push onto the global queue and return immediately. The queue flushes
		// either when it reaches its batch threshold or when its debounce timer
		// fires. If the eventual batch fails, the queue surfaces the failure
		// via session.queueDeferredMessage — the agent learns about it on the
		// next turn rather than blocking the current tool call.
		enqueueRetain(sessionId, params.content, params.context);

		return {
			content: [{ type: "text", text: "Memory queued." }],
			details: {},
		};
	}
}

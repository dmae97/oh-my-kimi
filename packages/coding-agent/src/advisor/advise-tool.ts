import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { z } from "zod/v4";
import adviseDescription from "../prompts/advisor/advise-tool.md" with { type: "text" };

const adviseSchema = z.object({
	note: z
		.string()
		.describe("One concrete piece of advice for the agent you are watching. Terse, specific, actionable."),
	severity: z
		.enum(["nit", "concern", "blocker"])
		.optional()
		.describe("How strongly to weigh this. Omit for a plain nit."),
});

export type AdviseParams = z.infer<typeof adviseSchema>;

export type AdvisorSeverity = "nit" | "concern" | "blocker";

export interface AdviseDetails {
	note: string;
	severity?: AdvisorSeverity;
}

/** One queued advice note. */
export interface AdvisorNote {
	note: string;
	severity?: AdvisorSeverity;
}

/** Details payload on the batched `advisor` custom message rendered in the transcript. */
export interface AdvisorMessageDetails {
	notes: AdvisorNote[];
}

/**
 * Prose framing prepended to every batched advisor message. Kept here so the
 * non-interrupting YieldQueue dispatcher and the interrupting steer path build
 * byte-identical content.
 */
const ADVISOR_BATCH_PREFIX = "Advisor (a senior reviewer watching your work — weigh it, don't blindly obey):";

/** Render one advisor card body from a batch of notes (prefix + one bullet per note). */
export function formatAdvisorBatchContent(notes: readonly AdvisorNote[]): string {
	return `${ADVISOR_BATCH_PREFIX}\n${notes.map(n => `- ${n.severity ? `[${n.severity}] ` : ""}${n.note}`).join("\n")}`;
}

/**
 * Whether advice at this severity should interrupt the running agent (delivered
 * via the steering channel, aborting in-flight tools) rather than ride the
 * non-interrupting aside queue that lands at the next step boundary. `concern`
 * and `blocker` interrupt; a plain `nit` queues.
 */
export function isInterruptingSeverity(severity: AdvisorSeverity | undefined): boolean {
	return severity === "concern" || severity === "blocker";
}

/**
 * Side-effect-free investigation tools handed to the advisor agent so it can
 * inspect the workspace before weighing in. Names match the primary session's
 * tool instances, which the advisor reuses.
 */
export const ADVISOR_READONLY_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "search", "find"]);

export class AdviseTool implements AgentTool<typeof adviseSchema, AdviseDetails> {
	readonly name = "advise";
	readonly label = "Advise";
	readonly description = adviseDescription;
	readonly parameters = adviseSchema;
	readonly intent = "omit" as const;

	constructor(private readonly onAdvice: (note: string, severity?: AdviseDetails["severity"]) => void) {}

	async execute(
		_toolCallId: string,
		args: AdviseParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AdviseDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<AdviseDetails>> {
		this.onAdvice(args.note, args.severity);
		return {
			content: [{ type: "text", text: "Recorded." }],
			details: { note: args.note, severity: args.severity },
			useless: true,
		};
	}
}

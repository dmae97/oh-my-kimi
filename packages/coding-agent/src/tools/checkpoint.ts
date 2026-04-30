import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import checkpointDescription from "../prompts/tools/checkpoint.md" with { type: "text" };
import rewindDescription from "../prompts/tools/rewind.md" with { type: "text" };
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

export interface CheckpointState {
	/** Number of in-memory messages at checkpoint (AFTER checkpoint tool result is appended) */
	checkpointMessageCount: number;
	/** Session entry ID at checkpoint (for session tree branching) */
	checkpointEntryId: string | null;
	/** Timestamp */
	startedAt: string;
}

const checkpointSchema = Type.Object({
	goal: Type.String({ description: "investigation goal", examples: ["investigate retry logic"] }),
});

type CheckpointParams = Static<typeof checkpointSchema>;

const rewindSchema = Type.Object({
	report: Type.String({ description: "investigation findings" }),
});

type RewindParams = Static<typeof rewindSchema>;

export interface CheckpointToolDetails {
	goal: string;
	startedAt: string;
	meta?: OutputMeta;
}

export interface RewindToolDetails {
	report: string;
	rewound: boolean;
	meta?: OutputMeta;
}

function isTopLevelSession(session: ToolSession): boolean {
	const depth = session.taskDepth;
	return depth === undefined || depth === 0;
}

export class CheckpointTool implements AgentTool<typeof checkpointSchema, CheckpointToolDetails> {
	readonly name = "checkpoint";
	readonly label = "Checkpoint";
	readonly description: string;
	readonly parameters = checkpointSchema;
	readonly strict = true;
	readonly intent = (args: Partial<CheckpointParams>) => args.goal;

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(checkpointDescription);
	}

	static createIf(session: ToolSession): CheckpointTool | null {
		if (!isTopLevelSession(session)) return null;
		return new CheckpointTool(session);
	}

	async execute(
		_toolCallId: string,
		params: CheckpointParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<CheckpointToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<CheckpointToolDetails>> {
		if (!isTopLevelSession(this.session)) {
			throw new ToolError("Checkpoint not available in subagents.");
		}
		if (this.session.getCheckpointState?.()) {
			throw new ToolError("Checkpoint already active.");
		}
		const startedAt = new Date().toISOString();
		return toolResult<CheckpointToolDetails>({ goal: params.goal, startedAt })
			.text(
				[
					"Checkpoint created.",
					`Goal: ${params.goal}`,
					"Run your investigation, then call rewind with a concise report.",
				].join("\n"),
			)
			.done();
	}
}

export class RewindTool implements AgentTool<typeof rewindSchema, RewindToolDetails> {
	readonly name = "rewind";
	readonly label = "Rewind";
	readonly description: string;
	readonly parameters = rewindSchema;
	readonly strict = true;
	readonly intent = (): string => "Rewinding to checkpoint";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(rewindDescription);
	}

	static createIf(session: ToolSession): RewindTool | null {
		if (!isTopLevelSession(session)) return null;
		return new RewindTool(session);
	}

	async execute(
		_toolCallId: string,
		params: RewindParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<RewindToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<RewindToolDetails>> {
		if (!isTopLevelSession(this.session)) {
			throw new ToolError("Checkpoint not available in subagents.");
		}
		if (!this.session.getCheckpointState?.()) {
			throw new ToolError("No active checkpoint.");
		}
		const report = params.report.trim();
		if (report.length === 0) {
			throw new ToolError("Report cannot be empty.");
		}
		return toolResult<RewindToolDetails>({ report, rewound: true })
			.text(["Rewind requested.", "Report captured for context replacement."].join("\n"))
			.done();
	}
}

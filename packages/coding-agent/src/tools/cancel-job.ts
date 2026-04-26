import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import { isBackgroundJobSupportEnabled } from "../async";
import cancelJobDescription from "../prompts/tools/cancel-job.md" with { type: "text" };
import type { ToolSession } from "./index";

const cancelJobSchema = Type.Object({
	job_id: Type.String({ description: "background job id", examples: ["job-1234"] }),
});

type CancelJobParams = Static<typeof cancelJobSchema>;

export interface CancelJobToolDetails {
	status: "cancelled" | "not_found" | "already_completed";
	jobId: string;
}

export class CancelJobTool implements AgentTool<typeof cancelJobSchema, CancelJobToolDetails> {
	readonly name = "cancel_job";
	readonly label = "CancelJob";
	readonly description: string;
	readonly parameters = cancelJobSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(cancelJobDescription);
	}

	static createIf(session: ToolSession): CancelJobTool | null {
		if (!isBackgroundJobSupportEnabled(session.settings)) return null;
		return new CancelJobTool(session);
	}

	async execute(
		_toolCallId: string,
		params: CancelJobParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<CancelJobToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<CancelJobToolDetails>> {
		const manager = this.session.asyncJobManager;
		if (!manager) {
			return {
				content: [
					{ type: "text", text: "Async execution is disabled; no background jobs are available to cancel." },
				],
				details: {
					status: "not_found",
					jobId: params.job_id,
				},
			};
		}

		const existing = manager.getJob(params.job_id);
		if (!existing) {
			return {
				content: [{ type: "text", text: `Background job not found: ${params.job_id}` }],
				details: {
					status: "not_found",
					jobId: params.job_id,
				},
			};
		}

		if (existing.status !== "running") {
			return {
				content: [{ type: "text", text: `Background job ${params.job_id} is already ${existing.status}.` }],
				details: {
					status: "already_completed",
					jobId: params.job_id,
				},
			};
		}

		const cancelled = manager.cancel(params.job_id);
		if (!cancelled) {
			return {
				content: [{ type: "text", text: `Background job ${params.job_id} is already completed.` }],
				details: {
					status: "already_completed",
					jobId: params.job_id,
				},
			};
		}

		return {
			content: [{ type: "text", text: `Cancelled background job ${params.job_id}.` }],
			details: {
				status: "cancelled",
				jobId: params.job_id,
			},
		};
	}
}

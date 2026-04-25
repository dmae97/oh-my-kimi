import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import { isBackgroundJobSupportEnabled } from "../async";
import pollDescription from "../prompts/tools/poll.md" with { type: "text" };
import type { ToolSession } from "./index";

const pollSchema = Type.Object({
	jobs: Type.Optional(
		Type.Array(Type.String(), {
			description: "job ids to wait for",
			examples: [["job-1234"]],
		}),
	),
});

type PollParams = Static<typeof pollSchema>;

interface PollResult {
	id: string;
	type: "bash" | "task";
	status: "running" | "completed" | "failed" | "cancelled";
	label: string;
	durationMs: number;
	resultText?: string;
	errorText?: string;
}

export interface PollToolDetails {
	jobs: PollResult[];
}

export class PollTool implements AgentTool<typeof pollSchema, PollToolDetails> {
	readonly name = "poll";
	readonly label = "Poll";
	readonly description: string;
	readonly parameters = pollSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(pollDescription);
	}

	static createIf(session: ToolSession): PollTool | null {
		if (!isBackgroundJobSupportEnabled(session.settings)) return null;
		return new PollTool(session);
	}

	async execute(
		_toolCallId: string,
		params: PollParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<PollToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<PollToolDetails>> {
		const manager = this.session.asyncJobManager;
		if (!manager) {
			return {
				content: [{ type: "text", text: "Async execution is disabled; no background jobs to poll." }],
				details: { jobs: [] },
			};
		}

		const requestedIds = params.jobs;

		// Resolve which jobs to watch
		const jobsToWatch = requestedIds?.length
			? requestedIds.map(id => manager.getJob(id)).filter(j => j != null)
			: manager.getRunningJobs();

		if (jobsToWatch.length === 0) {
			const message = requestedIds?.length
				? `No matching jobs found for IDs: ${requestedIds.join(", ")}`
				: "No running background jobs to wait for.";
			return {
				content: [{ type: "text", text: message }],
				details: { jobs: [] },
			};
		}

		// If all watched jobs are already done, return immediately
		const runningJobs = jobsToWatch.filter(j => j.status === "running");
		if (runningJobs.length === 0) {
			return this.#buildResult(manager, jobsToWatch);
		}

		// Block until at least one running job finishes or the call is aborted
		const racePromises: Promise<unknown>[] = runningJobs.map(j => j.promise);
		const watchedJobIds = runningJobs.map(job => job.id);
		manager.watchJobs(watchedJobIds);

		try {
			if (signal) {
				const { promise: abortPromise, resolve: abortResolve } = Promise.withResolvers<void>();
				const onAbort = () => abortResolve();
				signal.addEventListener("abort", onAbort, { once: true });
				racePromises.push(abortPromise);
				try {
					await Promise.race(racePromises);
				} finally {
					signal.removeEventListener("abort", onAbort);
				}
			} else {
				await Promise.race(racePromises);
			}
		} finally {
			manager.unwatchJobs(watchedJobIds);
		}

		if (signal?.aborted) {
			return this.#buildResult(manager, jobsToWatch);
		}

		return this.#buildResult(manager, jobsToWatch);
	}

	#buildResult(
		manager: NonNullable<ToolSession["asyncJobManager"]>,
		jobs: {
			id: string;
			type: "bash" | "task";
			status: string;
			label: string;
			startTime: number;
			resultText?: string;
			errorText?: string;
		}[],
	): AgentToolResult<PollToolDetails> {
		const now = Date.now();
		const jobResults: PollResult[] = jobs.map(j => ({
			id: j.id,
			type: j.type,
			status: j.status as PollResult["status"],
			label: j.label,
			durationMs: Math.max(0, now - j.startTime),
			...(j.resultText ? { resultText: j.resultText } : {}),
			...(j.errorText ? { errorText: j.errorText } : {}),
		}));

		manager.acknowledgeDeliveries(jobResults.filter(j => j.status !== "running").map(j => j.id));

		const completed = jobResults.filter(j => j.status !== "running");
		const running = jobResults.filter(j => j.status === "running");

		const lines: string[] = [];
		if (completed.length > 0) {
			lines.push(`## Completed (${completed.length})\n`);
			for (const j of completed) {
				lines.push(`### ${j.id} [${j.type}] — ${j.status}`);
				lines.push(`Label: ${j.label}`);
				if (j.resultText) {
					lines.push("```", j.resultText, "```");
				}
				if (j.errorText) {
					lines.push(`Error: ${j.errorText}`);
				}
				lines.push("");
			}
		}

		if (running.length > 0) {
			lines.push(`## Still Running (${running.length})\n`);
			for (const j of running) {
				lines.push(`- \`${j.id}\` [${j.type}] — ${j.label}`);
			}
		}

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { jobs: jobResults },
		};
	}
}

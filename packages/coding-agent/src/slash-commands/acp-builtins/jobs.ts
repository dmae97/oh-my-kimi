import { formatDuration } from "./format";
import { commandConsumed } from "./shared";
import type { AcpBuiltinCommandSpec } from "./types";

export const jobsCommand: AcpBuiltinCommandSpec = {
	name: "jobs",
	description: "Show background jobs",
	handle: async (_command, runtime) => {
		const snapshot = runtime.session.getAsyncJobSnapshot({ recentLimit: 5 });
		if (!snapshot || (snapshot.running.length === 0 && snapshot.recent.length === 0)) {
			await runtime.output(
				"No background jobs running. (Background jobs run async tools — e.g. long-running bash, debug, or task subagents that would otherwise tie up a turn. They appear here while alive and for ~5 minutes after.)",
			);
			return commandConsumed();
		}
		const now = Date.now();
		const lines: string[] = ["Background Jobs", `Running: ${snapshot.running.length}`];
		if (snapshot.running.length > 0) {
			lines.push("", "Running Jobs");
			for (const job of snapshot.running) {
				lines.push(`  [${job.id}] ${job.type} (${job.status}) — ${formatDuration(now - job.startTime)}`);
				lines.push(`    ${job.label}`);
			}
		}
		if (snapshot.recent.length > 0) {
			lines.push("", "Recent Jobs");
			for (const job of snapshot.recent) {
				lines.push(`  [${job.id}] ${job.type} (${job.status}) — ${formatDuration(now - job.startTime)}`);
				lines.push(`    ${job.label}`);
			}
		}
		await runtime.output(lines.join("\n"));
		return commandConsumed();
	},
};

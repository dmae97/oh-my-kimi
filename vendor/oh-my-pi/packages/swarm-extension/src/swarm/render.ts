/**
 * TUI progress rendering for swarm pipeline status.
 */
import { formatDuration, truncate } from "@oh-my-pi/pi-utils";
import type { AgentState, SwarmState } from "./state";

const STATUS_LABELS: Record<string, string> = {
	completed: "[done]",
	running: "[....]",
	failed: "[FAIL]",
	pending: "[    ]",
	waiting: "[wait]",
	idle: "[idle]",
	aborted: "[stop]",
};

export function renderSwarmProgress(state: SwarmState): string[] {
	const lines: string[] = [];

	const statusLabel = state.status.toUpperCase();
	lines.push(`Swarm: ${state.name} [${statusLabel}]`);
	lines.push(`Mode: ${state.mode} | Iteration: ${state.iteration + 1}/${state.targetCount}`);
	lines.push("");

	const agents: AgentState[] = Object.values(state.agents);
	if (agents.length === 0) {
		lines.push("  (no agents)");
		return lines;
	}

	for (const agent of agents) {
		const icon = STATUS_LABELS[agent.status] ?? "[????]";
		const duration = formatAgentDuration(agent);
		const errorSuffix = agent.error ? ` - ${truncate(agent.error, 60)}` : "";
		lines.push(`  ${icon} ${agent.name}: ${agent.status}${duration}${errorSuffix}`);
	}

	// Summary line
	const completed = agents.filter(a => a.status === "completed").length;
	const failed = agents.filter(a => a.status === "failed").length;
	const running = agents.filter(a => a.status === "running").length;

	lines.push("");
	const parts = [`${completed}/${agents.length} done`];
	if (running > 0) parts.push(`${running} running`);
	if (failed > 0) parts.push(`${failed} failed`);
	if (state.startedAt) {
		parts.push(`elapsed: ${formatDuration(Date.now() - state.startedAt)}`);
	}
	lines.push(`  ${parts.join(" | ")}`);

	return lines;
}

function formatAgentDuration(agent: { startedAt?: number; completedAt?: number; status: string }): string {
	if (agent.startedAt && agent.completedAt) {
		return ` (${formatDuration(agent.completedAt - agent.startedAt)})`;
	}
	if (agent.startedAt && (agent.status === "running" || agent.status === "waiting")) {
		return ` (${formatDuration(Date.now() - agent.startedAt)}...)`;
	}
	return "";
}

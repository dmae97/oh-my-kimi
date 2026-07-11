/**
 * Vibe mode tools — the director's entire non-read surface.
 *
 * Five thin tools over {@link VibeSessionRegistry}: spawn/send/wait/kill/list
 * persistent worker sessions ("fast"/"good" CLIs). Spawns and sends return
 * immediately; turn results self-deliver through the async job manager.
 */
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import vibeKillDescription from "../prompts/tools/vibe-kill.md" with { type: "text" };
import vibeListDescription from "../prompts/tools/vibe-list.md" with { type: "text" };
import vibeSendDescription from "../prompts/tools/vibe-send.md" with { type: "text" };
import vibeSpawnDescription from "../prompts/tools/vibe-spawn.md" with { type: "text" };
import vibeWaitDescription from "../prompts/tools/vibe-wait.md" with { type: "text" };
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import { oneLineLabel } from "../task/types";
import { renderStatusLine } from "../tui";
import {
	type VibeCli,
	type VibeKillOutcome,
	type VibeRosterEntry,
	type VibeSendOutcome,
	VibeSessionRegistry,
	type VibeSessionState,
} from "../vibe/runtime";
import type { ToolSession } from "./index";
import {
	Ellipsis,
	formatBadge,
	formatStatusIcon,
	replaceTabs,
	type ToolUIColor,
	type ToolUIStatus,
	truncateToWidth,
} from "./render-utils";

export const VIBE_TOOL_NAMES = ["vibe_spawn", "vibe_send", "vibe_wait", "vibe_kill", "vibe_list"] as const;

const vibeSpawnSchema = type({
	cli: type("'fast' | 'good'").describe(
		"worker flavor: fast = low-latency model for mechanical work; good = strong model for hard work",
	),
	"name?": type("string <= 48").describe("optional session name; generated when omitted"),
	prompt: type("string > 0").describe("first instruction; the worker starts with no other context"),
});

const vibeSendSchema = type({
	session: type("string > 0").describe("session id from vibe_spawn / vibe_list"),
	message: type("string > 0").describe("message for the session; steers mid-turn, else runs as its next turn"),
});

const vibeWaitSchema = type({
	"sessions?": type("string[]").describe("session ids to watch; omit to watch every session with a turn in flight"),
	"timeout?": type("number > 0").describe("max seconds to wait (default 30)"),
});

const vibeKillSchema = type({
	session: type("string > 0").describe("session id to terminate"),
});

const vibeListSchema = type({});

type VibeOp = "spawn" | "send" | "wait" | "kill" | "list";

/** Details payload shared by every vibe tool for TUI rendering. */
export interface VibeToolDetails {
	op: VibeOp;
	roster: VibeRosterEntry[];
	spawned?: { id: string; cli: VibeCli; jobId: string };
	send?: VibeSendOutcome;
	wait?: {
		settled: Array<{ id: string; jobId: string; status: "completed" | "failed" | "cancelled" }>;
		stillRunning: string[];
		timedOut: boolean;
	};
	killed?: VibeKillOutcome;
}

function rosterOf(session: ToolSession): VibeRosterEntry[] {
	return VibeSessionRegistry.global().list(session.getAgentId?.() ?? MAIN_AGENT_ID);
}

function textResult(text: string, details: VibeToolDetails): AgentToolResult<VibeToolDetails> {
	return { content: [{ type: "text", text }], details };
}

export class VibeSpawnTool implements AgentTool<typeof vibeSpawnSchema, VibeToolDetails> {
	readonly name = "vibe_spawn";
	readonly approval = "exec" as const;
	readonly label = "Vibe Spawn";
	readonly summary = "Start a persistent fast/good worker session";
	readonly description: string;
	readonly parameters = vibeSpawnSchema;
	readonly strict = true;
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(vibeSpawnDescription);
	}

	async execute(_toolCallId: string, params: typeof vibeSpawnSchema.infer): Promise<AgentToolResult<VibeToolDetails>> {
		const { id, jobId } = await VibeSessionRegistry.global().spawn(this.session, params);
		return textResult(
			`Spawned ${params.cli} session \`${id}\` (turn job \`${jobId}\`). The turn result will be delivered when it finishes — keep directing other sessions meanwhile. Continue this one with vibe_send \`${id}\`.`,
			{ op: "spawn", roster: rosterOf(this.session), spawned: { id, cli: params.cli, jobId } },
		);
	}
}

export class VibeSendTool implements AgentTool<typeof vibeSendSchema, VibeToolDetails> {
	readonly name = "vibe_send";
	readonly approval = "exec" as const;
	readonly label = "Vibe Send";
	readonly summary = "Message a worker session (steer or next turn)";
	readonly description: string;
	readonly parameters = vibeSendSchema;
	readonly strict = true;
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(vibeSendDescription);
	}

	async execute(_toolCallId: string, params: typeof vibeSendSchema.infer): Promise<AgentToolResult<VibeToolDetails>> {
		const outcome = await VibeSessionRegistry.global().send(this.session, params);
		const ack =
			outcome.mode === "turn"
				? `Started a new turn on \`${outcome.id}\` (job \`${outcome.jobId}\`). Its result will be delivered when the turn finishes.`
				: outcome.mode === "steered"
					? `Steered \`${outcome.id}\` mid-turn — the running turn sees your message at its next step.`
					: `\`${outcome.id}\` is mid-turn; your message is queued and runs automatically as the next turn.`;
		return textResult(ack, { op: "send", roster: rosterOf(this.session), send: outcome });
	}
}

export class VibeWaitTool implements AgentTool<typeof vibeWaitSchema, VibeToolDetails> {
	readonly name = "vibe_wait";
	readonly approval = "read" as const;
	readonly label = "Vibe Wait";
	readonly summary = "Block until a worker session finishes its turn";
	readonly description: string;
	readonly parameters = vibeWaitSchema;
	readonly strict = true;
	readonly interruptible = true;
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(vibeWaitDescription);
	}

	async execute(
		_toolCallId: string,
		params: typeof vibeWaitSchema.infer,
		signal?: AbortSignal,
	): Promise<AgentToolResult<VibeToolDetails>> {
		const outcome = await VibeSessionRegistry.global().wait(this.session, {
			sessions: params.sessions,
			timeoutMs: params.timeout !== undefined ? params.timeout * 1000 : undefined,
			signal,
		});
		const details: VibeToolDetails = {
			op: "wait",
			roster: rosterOf(this.session),
			wait: {
				settled: outcome.settled.map(({ id, jobId, status }) => ({ id, jobId, status })),
				stillRunning: outcome.stillRunning,
				timedOut: outcome.timedOut,
			},
		};
		if (outcome.settled.length === 0 && outcome.stillRunning.length === 0) {
			return { ...textResult("No turns in flight to wait for.", details), useless: true };
		}
		const lines: string[] = [];
		for (const entry of outcome.settled) {
			lines.push(`## \`${entry.id}\` — ${entry.status}`, entry.resultText, "");
		}
		if (outcome.stillRunning.length > 0) {
			lines.push(`Still running: ${outcome.stillRunning.map(id => `\`${id}\``).join(", ")}.`);
		}
		if (outcome.timedOut) {
			lines.push("Wait window elapsed before any turn settled — re-issue vibe_wait to keep waiting.");
		}
		const result = textResult(lines.join("\n").trimEnd(), details);
		// A pure "still waiting" frame is noise once a newer wait exists.
		return outcome.settled.length === 0 ? { ...result, useless: true } : result;
	}
}

export class VibeKillTool implements AgentTool<typeof vibeKillSchema, VibeToolDetails> {
	readonly name = "vibe_kill";
	readonly approval = "read" as const;
	readonly label = "Vibe Kill";
	readonly summary = "Terminate a worker session";
	readonly description: string;
	readonly parameters = vibeKillSchema;
	readonly strict = true;
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(vibeKillDescription);
	}

	async execute(_toolCallId: string, params: typeof vibeKillSchema.infer): Promise<AgentToolResult<VibeToolDetails>> {
		const outcome = await VibeSessionRegistry.global().kill(this.session, params.session);
		const cancelNote = outcome.cancelledTurn ? " Its in-flight turn was cancelled." : "";
		return textResult(
			`Killed session \`${outcome.id}\`.${cancelNote} Transcript remains at history://${outcome.id}.`,
			{ op: "kill", roster: rosterOf(this.session), killed: outcome },
		);
	}
}

export class VibeListTool implements AgentTool<typeof vibeListSchema, VibeToolDetails> {
	readonly name = "vibe_list";
	readonly approval = "read" as const;
	readonly label = "Vibe List";
	readonly summary = "List worker sessions and their states";
	readonly description: string;
	readonly parameters = vibeListSchema;
	readonly strict = true;
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(vibeListDescription);
	}

	async execute(): Promise<AgentToolResult<VibeToolDetails>> {
		const roster = rosterOf(this.session);
		const details: VibeToolDetails = { op: "list", roster };
		if (roster.length === 0) {
			return textResult("No vibe sessions. Spawn one with vibe_spawn.", details);
		}
		const lines = roster.map(entry => {
			const parts = [
				`- \`${entry.id}\` [${entry.cli}] ${entry.state}`,
				`${entry.turns} turn${entry.turns === 1 ? "" : "s"}`,
			];
			if (entry.queued > 0) parts.push(`${entry.queued} queued`);
			if (entry.model) parts.push(entry.model);
			if (entry.lastActivity) parts.push(`last: ${entry.lastActivity}`);
			return parts.join(" · ");
		});
		return textResult(lines.join("\n"), details);
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

const ROSTER_LINE_WIDTH = 100;
const ROSTER_LIMIT_COLLAPSED = 4;

function stateToIcon(state: VibeSessionState): ToolUIStatus {
	switch (state) {
		case "running":
			return "running";
		case "starting":
			return "pending";
		case "idle":
			return "done";
		case "dead":
			return "aborted";
	}
}

function stateToColor(state: VibeSessionState): ToolUIColor {
	switch (state) {
		case "running":
			return "accent";
		case "starting":
			return "accent";
		case "idle":
			return "success";
		case "dead":
			return "muted";
	}
}

function rosterLine(entry: VibeRosterEntry, uiTheme: Theme, spinnerFrame: number | undefined): string {
	const icon = formatStatusIcon(
		stateToIcon(entry.state),
		uiTheme,
		entry.state === "running" ? spinnerFrame : undefined,
	);
	const badge = formatBadge(entry.cli, stateToColor(entry.state), uiTheme);
	const gist = entry.lastActivity ? ` ${uiTheme.fg("dim", oneLineLabel(replaceTabs(entry.lastActivity), 60))}` : "";
	const turns = uiTheme.fg("muted", `${entry.turns}t${entry.queued > 0 ? `+${entry.queued}q` : ""}`);
	return truncateToWidth(
		`${icon} ${badge} ${uiTheme.fg("toolOutput", entry.id)} ${uiTheme.fg("dim", entry.state)} ${turns}${gist}`,
		ROSTER_LINE_WIDTH,
		Ellipsis.Unicode,
	);
}

interface VibeRenderArgs {
	cli?: VibeCli;
	prompt?: string;
	session?: string;
	message?: string;
	sessions?: string[];
}

function describeCall(op: VibeOp, args: VibeRenderArgs | undefined): string {
	switch (op) {
		case "spawn":
			return `spawn ${args?.cli ?? "?"}${args?.prompt ? `: ${oneLineLabel(args.prompt, 60)}` : ""}`;
		case "send":
			return `send → ${args?.session ?? "?"}${args?.message ? `: ${oneLineLabel(args.message, 60)}` : ""}`;
		case "wait":
			return args?.sessions?.length ? `wait on ${args.sessions.join(", ")}` : "wait on running sessions";
		case "kill":
			return `kill ${args?.session ?? "?"}`;
		case "list":
			return "sessions";
	}
}

/** Build the shared vibe renderer for one tool name. */
export function createVibeToolRenderer(op: VibeOp) {
	return {
		inline: true,
		mergeCallAndResult: true,

		renderCall(args: VibeRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
			return new Text(renderStatusLine({ icon: "pending", title: `vibe ${describeCall(op, args)}` }, uiTheme), 0, 0);
		},

		renderResult(
			result: { content: Array<{ type: string; text?: string }>; details?: VibeToolDetails; isError?: boolean },
			options: RenderResultOptions,
			uiTheme: Theme,
			args?: VibeRenderArgs,
		): Component {
			const details = result.details;
			const title = `vibe ${describeCall(op, args)}`;
			if (!details || result.isError) {
				const fallback = result.content.find(part => part.type === "text")?.text ?? "";
				const header = renderStatusLine({ icon: result.isError ? "error" : "done", title }, uiTheme);
				const body = fallback
					? `\n  ${uiTheme.fg(result.isError ? "error" : "dim", oneLineLabel(replaceTabs(fallback), ROSTER_LINE_WIDTH))}`
					: "";
				return new Text(`${header}${body}`, 0, 0);
			}

			const running = details.roster.filter(entry => entry.state === "running" || entry.state === "starting").length;
			const meta: string[] = [];
			if (running > 0) meta.push(uiTheme.fg("accent", `${running} running`));
			if (details.wait?.timedOut) meta.push(uiTheme.fg("warning", "timed out"));
			if (details.wait?.settled.length) meta.push(uiTheme.fg("success", `${details.wait.settled.length} settled`));
			const header = renderStatusLine(
				{
					icon: details.wait?.timedOut ? "warning" : "done",
					spinnerFrame: running > 0 ? options.spinnerFrame : undefined,
					title,
					meta,
				},
				uiTheme,
			);

			const roster = options.expanded ? details.roster : details.roster.slice(0, ROSTER_LIMIT_COLLAPSED);
			const lines = roster.map(entry => `  ${rosterLine(entry, uiTheme, options.spinnerFrame)}`);
			if (!options.expanded && details.roster.length > roster.length) {
				lines.push(`  ${uiTheme.fg("dim", `… ${details.roster.length - roster.length} more`)}`);
			}
			return new Text([header, ...lines].join("\n"), 0, 0);
		},
	};
}

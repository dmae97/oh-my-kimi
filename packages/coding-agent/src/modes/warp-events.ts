import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isInsideTmux, wrapTmuxPassthrough } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import type { ExtensionContext, ExtensionFactory } from "../extensibility/extensions/types";

const WARP_CLI_AGENT_PROTOCOL_VERSION = 1;
const WARP_CLI_AGENT_SENTINEL = "warp://cli-agent";

export type WarpEventValue =
	| string
	| number
	| boolean
	| null
	| readonly WarpEventValue[]
	| { readonly [key: string]: WarpEventValue | undefined };

/** Fields added to the Warp CLI-agent event envelope by the event bridge. */
export type WarpEvent = Readonly<Record<string, WarpEventValue | undefined>>;

export interface WarpEventEmitterOptions {
	sessionId: string;
}

export interface WarpEventEmitter {
	emit(event: WarpEvent): void;
}

/**
 * Creates the Warp event transport for a top-level interactive TUI session.
 * The caller MUST enforce that install-site invariant; the sole production
 * caller is gated by `isInteractive`, so ACP, RPC, print, headless, and
 * subagent sessions never construct an emitter.
 */
export function createWarpEventEmitter(options: WarpEventEmitterOptions): WarpEventEmitter | undefined {
	if (!(Number(process.env.WARP_CLI_AGENT_PROTOCOL_VERSION) >= WARP_CLI_AGENT_PROTOCOL_VERSION)) {
		return undefined;
	}

	return {
		emit(event): void {
			const cwd = process.cwd();
			const body = {
				...event,
				v: WARP_CLI_AGENT_PROTOCOL_VERSION,
				agent: "omp",
				session_id: options.sessionId,
				cwd,
				project: path.basename(cwd),
				plugin_version: VERSION,
			};
			const osc = `\x1b]777;notify;${WARP_CLI_AGENT_SENTINEL};${JSON.stringify(body)}\x07`;
			process.stdout.write(isInsideTmux() ? wrapTmuxPassthrough(osc) : osc);
		},
	};
}

function lastAssistantText(messages: readonly AgentMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		return message.content
			.filter(content => content.type === "text")
			.map(content => content.text)
			.join("");
	}
	return "";
}

function truncateEventText(text: string): string {
	let end = 0;
	let count = 0;
	for (const codePoint of text) {
		if (count === 200) break;
		end += codePoint.length;
		count++;
	}
	return text.slice(0, end);
}

function userMessageText(message: Extract<AgentMessage, { role: "user" }>): string {
	if (typeof message.content === "string") {
		return message.content;
	}
	return message.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("");
}

/** Internal event bridge installed only by the top-level interactive TUI runner. */
export function createWarpEventBridgeExtension(): ExtensionFactory {
	return api => {
		let emitter: WarpEventEmitter | undefined;
		let activePrompt: string | undefined;

		const rebuildEmitter = (_event: unknown, ctx: ExtensionContext): void => {
			activePrompt = undefined;
			emitter = createWarpEventEmitter({ sessionId: ctx.sessionManager.getSessionId() });
			emitter?.emit({ event: "session_start" });
		};

		api.on("session_start", rebuildEmitter);
		api.on("session_switch", rebuildEmitter);
		api.on("session_branch", rebuildEmitter);

		api.on("message_start", event => {
			const message = event.message;
			if (message.role !== "user" || message.synthetic || message.attribution === "agent") {
				return;
			}
			activePrompt = truncateEventText(userMessageText(message));
			emitter?.emit({ event: "prompt_submit", query: activePrompt });
		});

		api.on("tool_approval_requested", event => {
			emitter?.emit({
				event: "permission_request",
				tool_name: event.toolName,
				summary: `omp wants to run ${event.toolName}`,
			});
		});

		api.on("tool_approval_resolved", () => {
			emitter?.emit({ event: "permission_replied" });
		});

		api.on("tool_execution_start", event => {
			if (event.toolName === "ask") {
				emitter?.emit({ event: "question_asked", summary: "Waiting for your answer" });
			}
		});

		api.on("tool_result", event => {
			emitter?.emit({ event: "tool_complete", tool_name: event.toolName });
		});

		api.on("agent_end", event => {
			emitter?.emit({
				event: "stop",
				query: activePrompt,
				response: truncateEventText(lastAssistantText(event.messages)),
			});
		});
	};
}

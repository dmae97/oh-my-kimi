import { isInsideTmux, TERMINAL, wrapTmuxPassthrough } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";

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
	isSubagent: boolean;
}

export interface WarpEventEmitter {
	emit(event: WarpEvent): void;
}

/**
 * Creates the Warp event transport for an interactive top-level TUI session.
 * TUI startup owns construction, so ACP, RPC, print, and other headless modes
 * never create an emitter.
 */
export function createWarpEventEmitter(options: WarpEventEmitterOptions): WarpEventEmitter | undefined {
	if (
		options.isSubagent ||
		TERMINAL.id !== "warp" ||
		!(Number(process.env.WARP_CLI_AGENT_PROTOCOL_VERSION) >= WARP_CLI_AGENT_PROTOCOL_VERSION)
	) {
		return undefined;
	}

	return {
		emit(event): void {
			const body = {
				...event,
				v: WARP_CLI_AGENT_PROTOCOL_VERSION,
				agent: "omp",
				session_id: options.sessionId,
				cwd: process.cwd(),
				plugin_version: VERSION,
			};
			const osc = `\x1b]777;notify;${WARP_CLI_AGENT_SENTINEL};${JSON.stringify(body)}\x07`;
			process.stdout.write(isInsideTmux() ? wrapTmuxPassthrough(osc) : osc);
		},
	};
}

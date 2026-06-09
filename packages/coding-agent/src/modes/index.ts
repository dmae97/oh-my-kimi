import { emergencyTerminalRestore } from "@oh-my-pi/pi-tui";
import { postmortem } from "@oh-my-pi/pi-utils";

/**
 * Interactive mode and embeddable RPC client exports for the coding agent.
 *
 * Branch-specific runners live in their concrete modules so importing this
 * barrel does not pull print, RPC server, or ACP server mode into the normal
 * TUI graph.
 */
export { InteractiveMode, type InteractiveModeOptions } from "./interactive-mode";
export {
	defineRpcClientTool,
	type ModelInfo,
	RpcClient,
	type RpcClientCustomTool,
	type RpcClientOptions,
	type RpcClientToolContext,
	type RpcClientToolResult,
	type RpcEventListener,
	type RpcSessionEventListener,
	type RpcSubagentEventListener,
	type RpcSubagentLifecycleListener,
	type RpcSubagentProgressListener,
} from "./rpc/rpc-client";
export type {
	RpcCommand,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcResponse,
	RpcSessionEventFrame,
	RpcSessionState,
	RpcSubagentEventFrame,
	RpcSubagentFrame,
	RpcSubagentLifecycleFrame,
	RpcSubagentMessagesResult,
	RpcSubagentProgressFrame,
	RpcSubagentSnapshot,
	RpcSubagentSubscriptionLevel,
} from "./rpc/rpc-types";

postmortem.register("terminal-restore", () => {
	emergencyTerminalRestore();
});

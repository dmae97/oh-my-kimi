/**
 * MCP client surface for the OMK harness.
 *
 * Before this module, `mcp-inventory.ts` could read MCP configuration and the
 * doctor could report on it, but the runtime had no way to speak the protocol:
 * configured servers contributed zero tools to a session. This package closes
 * that gap with a dependency-free stdio client.
 */

export {
	DEFAULT_HANDSHAKE_TIMEOUT_MS,
	DEFAULT_REQUEST_TIMEOUT_MS,
	MCP_PROTOCOL_VERSION,
	McpClient,
	type McpClientOptions,
	type McpContentBlock,
	type McpServerInfo,
	type McpToolCallResult,
	type McpToolSchema,
} from "./client.ts";
export { loadMcpServerConfigs, mcpConfigPaths } from "./config.ts";
export {
	McpManager,
	type McpManagerOptions,
	type McpServerConfig,
	type McpServerState,
	type McpServerStatus,
} from "./manager.ts";
export {
	createLineDecoder,
	encodeMessage,
	formatJsonRpcError,
	isJsonRpcNotification,
	isJsonRpcRequest,
	isJsonRpcResponse,
	type JsonRpcMessage,
	MAX_MESSAGE_LINE_BYTES,
} from "./protocol.ts";
export {
	DEFAULT_KILL_GRACE_MS,
	MAX_STDERR_TAIL_CHARS,
	McpStdioTransport,
	type StdioTransportOptions,
} from "./stdio-transport.ts";
export {
	buildMcpToolName,
	createMcpToolDefinition,
	MAX_TOOL_NAME_LENGTH,
	MCP_TOOL_NAME_SEPARATOR,
	type McpToolDetails,
	mapMcpContent,
	sanitizeToolNameSegment,
} from "./tools.ts";

export const MCP_CONNECTING_EVENT_CHANNEL = "mcp:connecting";

export type McpConnectingEvent = { serverNames: string[] };

export function formatMCPConnectingMessage(serverNames: string[]): string {
	return `Connecting to MCP servers: ${serverNames.join(", ")}…`;
}

/**
 * Runtime validator for the cross-module event payload. The event bus is
 * untyped at runtime, so the subscriber verifies the shape before formatting
 * rather than trusting a cast — a malformed emit is ignored instead of throwing.
 */
export function isMcpConnectingEvent(data: unknown): data is McpConnectingEvent {
	return (
		typeof data === "object" &&
		data !== null &&
		Array.isArray((data as { serverNames?: unknown }).serverNames) &&
		(data as { serverNames: unknown[] }).serverNames.every(name => typeof name === "string")
	);
}

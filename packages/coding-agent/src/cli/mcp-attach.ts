// Structural shapes on purpose: importing the core types here would put cli/ in an import cycle.
export interface McpAttachStatus {
	readonly name: string;
	readonly state: string;
	readonly error?: string;
}

/**
 * Startup diagnostics for `AgentSession.attachMcpServers()` results. A ready
 * server is silent; anything else becomes a warning so one broken server is
 * visible without taking the session down. Error text never carries env values.
 */
export function mcpAttachDiagnostics(
	statuses: readonly McpAttachStatus[],
): Array<{ type: "warning"; message: string }> {
	return statuses.flatMap((status) => {
		if (status.state === "ready") return [];
		const reason = status.error ? `: ${status.error}` : "";
		return [{ type: "warning", message: `MCP server "${status.name}" ${status.state}${reason}` }];
	});
}

/**
 * Adapt an MCP tool into a harness `ToolDefinition`.
 *
 * Two things make this small:
 * - `validateToolArguments` already accepts a plain JSON Schema, so an MCP
 *   `inputSchema` is passed straight through instead of being re-modelled in
 *   TypeBox.
 * - MCP content blocks are already text/image, which is exactly what the
 *   harness renders.
 *
 * Naming: tools are exposed as `<server>__<tool>` so two servers can ship a
 * `search` without colliding, and so a model can tell where a tool came from.
 */

import type { ImageContent, TextContent } from "omk-ai";
import type { TSchema } from "typebox";
import type { AgentToolResult, ToolDefinition } from "../extensions/types.ts";
import type { McpClient, McpContentBlock, McpToolSchema } from "./client.ts";

/** Tool-name separator between the server label and the server's own tool name. */
export const MCP_TOOL_NAME_SEPARATOR = "__";
/** Providers reject long tool names; this is the common ceiling. */
export const MAX_TOOL_NAME_LENGTH = 64;

/** Empty-object schema used when a server omits `inputSchema`. */
const EMPTY_OBJECT_SCHEMA = { type: "object", properties: {} } as const;

export interface McpToolDetails {
	readonly server: string;
	readonly tool: string;
	readonly isError: boolean;
	readonly structuredContent?: unknown;
}

/** Reduce an arbitrary label to the character set providers accept for tool names. */
export function sanitizeToolNameSegment(segment: string): string {
	return segment.replace(/[^a-zA-Z0-9_-]/gu, "_").replace(/_{2,}/gu, "_");
}

/**
 * Build the exposed tool name. Over-long names keep the server prefix and
 * truncate the tool segment, because the prefix is what disambiguates.
 */
export function buildMcpToolName(serverName: string, toolName: string): string {
	const server = sanitizeToolNameSegment(serverName);
	const tool = sanitizeToolNameSegment(toolName);
	const full = `${server}${MCP_TOOL_NAME_SEPARATOR}${tool}`;
	if (full.length <= MAX_TOOL_NAME_LENGTH) return full;
	const room = MAX_TOOL_NAME_LENGTH - server.length - MCP_TOOL_NAME_SEPARATOR.length;
	if (room <= 0) return full.slice(0, MAX_TOOL_NAME_LENGTH);
	return `${server}${MCP_TOOL_NAME_SEPARATOR}${tool.slice(0, room)}`;
}

/** Map MCP content blocks onto the harness content union, dropping unrenderable kinds. */
export function mapMcpContent(blocks: readonly McpContentBlock[]): (TextContent | ImageContent)[] {
	const out: (TextContent | ImageContent)[] = [];
	for (const block of blocks) {
		if (block.type === "text" && typeof block.text === "string") {
			out.push({ type: "text", text: block.text });
			continue;
		}
		if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
			out.push({ type: "image", data: block.data, mimeType: block.mimeType });
			continue;
		}
		if (block.type === "resource" && typeof block.resource === "object" && block.resource !== null) {
			const resource = block.resource as Record<string, unknown>;
			if (typeof resource.text === "string") {
				out.push({ type: "text", text: resource.text });
				continue;
			}
		}
		// Unknown block kinds are summarized rather than dropped silently.
		out.push({ type: "text", text: `[unsupported MCP content block: ${String(block.type)}]` });
	}
	return out;
}

export interface CreateMcpToolDefinitionOptions {
	/** Per-call deadline. Falls back to the client's default. */
	readonly callTimeoutMs?: number;
}

/**
 * Wrap one MCP tool. The returned definition executes in `parallel` mode: MCP
 * tools declare no filesystem claims, so the DAG scheduler cannot prove a
 * conflict and must not serialize them by default.
 */
export function createMcpToolDefinition(
	serverName: string,
	client: McpClient,
	tool: McpToolSchema,
	options: CreateMcpToolDefinitionOptions = {},
): ToolDefinition<TSchema, McpToolDetails> {
	const exposedName = buildMcpToolName(serverName, tool.name);
	const parameters = (tool.inputSchema ?? EMPTY_OBJECT_SCHEMA) as unknown as TSchema;

	return {
		name: exposedName,
		label: tool.title ?? tool.name,
		description: tool.description ?? `MCP tool "${tool.name}" from server "${serverName}".`,
		parameters,
		executionMode: "parallel",
		async execute(_toolCallId, params): Promise<AgentToolResult<McpToolDetails>> {
			try {
				const result = await client.callTool(tool.name, params, options.callTimeoutMs);
				const content = mapMcpContent(result.content);
				return {
					content: content.length > 0 ? content : [{ type: "text", text: "(no content)" }],
					details: {
						server: serverName,
						tool: tool.name,
						isError: result.isError,
						structuredContent: result.structuredContent,
					},
				};
			} catch (error) {
				// A dead or hung server degrades this one tool call, not the turn.
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: message }],
					details: { server: serverName, tool: tool.name, isError: true },
				};
			}
		},
	};
}

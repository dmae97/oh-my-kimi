import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolSession } from "../../tools";
import { ToolError } from "../../tools/tool-errors";
import type { JsStatusEvent } from "./shared/types";

export type { JsStatusEvent } from "./shared/types";

interface ToolBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

type ToolValue =
	| string
	| {
			text: string;
			details?: unknown;
			images?: Array<{ mimeType: string; data: string }>;
	  };

function getTool(session: ToolSession, name: string): AgentTool {
	const tool = session.getToolByName?.(name);
	if (!tool) {
		throw new ToolError(`Unknown tool from js runtime: ${name}`);
	}
	return tool;
}

function normalizeArgs(args: unknown): unknown {
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		return args;
	}
	const record = { ...(args as Record<string, unknown>) };
	if (record._i === undefined) {
		record._i = "js prelude";
	}
	return record;
}

function summarizeToolResult(name: string, args: unknown, result: AgentToolResult, text: string): JsStatusEvent {
	const record = (args && typeof args === "object" ? (args as Record<string, unknown>) : {}) as Record<
		string,
		unknown
	>;
	const details = (
		result.details && typeof result.details === "object" ? (result.details as Record<string, unknown>) : {}
	) as Record<string, unknown>;

	switch (name) {
		case "read":
			return { op: "read", path: record.path, chars: text.length, preview: text.slice(0, 500) };
		case "write":
			return {
				op: "write",
				path: record.path,
				chars: typeof record.content === "string" ? record.content.length : 0,
			};
		case "grep":
			return {
				op: "grep",
				pattern: record.pattern,
				path: record.path,
				count: details.matchCount ?? undefined,
			};
		case "find":
			return {
				op: "find",
				pattern: record.pattern,
				count: details.fileCount ?? undefined,
				matches: Array.isArray(details.files) ? details.files.slice(0, 20) : undefined,
			};
		case "bash":
			return {
				op: "run",
				cmd: record.command,
				code: typeof details.exitCode === "number" ? details.exitCode : undefined,
				output: text.slice(0, 500),
			};
		default:
			return { op: name, chars: text.length };
	}
}

export async function callSessionTool(name: string, args: unknown, options: ToolBridgeOptions): Promise<ToolValue> {
	const tool = getTool(options.session, name);
	const normalizedArgs = normalizeArgs(args);
	const toolCallId = `js-${name}-${crypto.randomUUID()}`;
	try {
		const result = await tool.execute(toolCallId, normalizedArgs, options.signal);
		const textBlocks = result.content.filter(
			(content): content is { type: "text"; text: string } =>
				content.type === "text" && typeof content.text === "string",
		);
		const imageBlocks = result.content.filter(
			(content): content is { type: "image"; mimeType: string; data: string } =>
				content.type === "image" && typeof content.mimeType === "string" && typeof content.data === "string",
		);
		const text = textBlocks.map(block => block.text).join("");
		options.emitStatus?.(summarizeToolResult(name, normalizedArgs, result, text));
		if (result.details === undefined && imageBlocks.length === 0) {
			return text;
		}
		return {
			text,
			details: result.details,
			images:
				imageBlocks.length > 0
					? imageBlocks.map(block => ({
							mimeType: block.mimeType,
							data: block.data,
						}))
					: undefined,
		};
	} catch (error) {
		options.emitStatus?.({
			op: name,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}

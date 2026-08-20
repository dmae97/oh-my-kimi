import type { AgentTool } from "omk-agent-core";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";

const MAX_TOOL_TIMEOUT_MS = 2_147_483_647;

function validateExtensionToolTimeout(timeoutMs: number | undefined, toolName: string): number | undefined {
	if (timeoutMs === undefined) return undefined;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TOOL_TIMEOUT_MS) {
		throw new Error(`Invalid timeout for extension tool "${toolName}"`);
	}
	return timeoutMs;
}

/** Wrap a ToolDefinition into an AgentTool for the core runtime. */
export function wrapToolDefinition<TDetails = unknown>(
	definition: ToolDefinition<any, TDetails>,
	ctxFactory?: () => ExtensionContext,
): AgentTool<any, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		resourceClaims: definition.resourceClaims,
		get timeoutMs() {
			const ctx = ctxFactory?.();
			const timeoutMs = (ctx ? definition.resolveTimeoutMs?.(ctx) : undefined) ?? definition.timeoutMs;
			return validateExtensionToolTimeout(timeoutMs, definition.name);
		},
		execute: (toolCallId, params, signal, onUpdate) =>
			definition.execute(toolCallId, params, signal, onUpdate, ctxFactory?.() as ExtensionContext),
	};
}

/** Wrap multiple ToolDefinitions into AgentTools for the core runtime. */
export function wrapToolDefinitions(
	definitions: ToolDefinition<any, any>[],
	ctxFactory?: () => ExtensionContext,
): AgentTool<any>[] {
	return definitions.map((definition) => wrapToolDefinition(definition, ctxFactory));
}

/**
 * Synthesize a minimal ToolDefinition from an AgentTool.
 *
 * This keeps AgentSession's internal registry definition-first even when a caller
 * provides plain AgentTool overrides that do not include prompt metadata or renderers.
 */
export function createToolDefinitionFromAgentTool(tool: AgentTool<any>): ToolDefinition<any, unknown> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters as any,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		resourceClaims: tool.resourceClaims,
		timeoutMs: tool.timeoutMs,
		execute: async (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),
	};
}

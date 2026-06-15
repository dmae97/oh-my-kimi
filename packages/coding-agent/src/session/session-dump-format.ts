/**
 * Plain-text / markdown session formatting (same shape as /dump clipboard export).
 */
import type { AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model, ToolExample, TSchema } from "@oh-my-pi/pi-ai";
import { getDialectDefinition, renderToolInventory } from "@oh-my-pi/pi-ai/dialect";
import { preferredDialect } from "@oh-my-pi/pi-catalog/identity";
import { convertToLlm } from "./messages";

/** Minimal tool shape for dump output (matches AgentTool fields used by formatSessionDumpText). */
export interface SessionDumpToolInfo {
	name: string;
	description: string;
	parameters: unknown;
	examples?: readonly ToolExample[];
}

export interface FormatSessionDumpTextOptions {
	messages: readonly AgentMessage[];
	systemPrompt?: readonly string[] | null;
	model?: Model | null;
	thinkingLevel?: ThinkingLevel | string | null;
	tools?: readonly SessionDumpToolInfo[];
}

/**
 * Format messages and session metadata as markdown/plain text (same as AgentSession.formatSessionAsText / /dump).
 */
export function formatSessionDumpText(options: FormatSessionDumpTextOptions): string {
	const lines: string[] = [];
	const definition = getDialectDefinition(preferredDialect(options.model?.id ?? ""));

	const systemPrompt = options.systemPrompt?.filter(prompt => prompt.length > 0) ?? [];
	if (systemPrompt.length > 0) {
		lines.push("## System Prompt\n");
		for (let index = 0; index < systemPrompt.length; index++) {
			if (systemPrompt.length > 1) {
				lines.push(`### System Prompt ${index + 1}\n`);
			}
			lines.push(systemPrompt[index]);
			lines.push("\n");
		}
	}

	const model = options.model;
	const thinkingLevel = options.thinkingLevel;
	lines.push("## Configuration\n");
	lines.push(`Model: ${model ? `${model.provider}/${model.id}` : "(not selected)"}`);
	lines.push(`Thinking Level: ${thinkingLevel ?? ""}`);
	lines.push("\n");

	const tools = options.tools ?? [];
	const inventoryTools = tools.map(tool => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters as TSchema,
		examples: tool.examples,
	}));
	if (inventoryTools.length > 0) {
		lines.push("## Available Tools\n");
		lines.push(renderToolInventory(inventoryTools, options.model?.id ?? ""));
		lines.push("\n");
	}

	lines.push("## Transcript\n");
	lines.push(definition.renderTranscript(convertToLlm([...options.messages]), { tools: inventoryTools }));
	lines.push("\n");

	return lines.join("\n").trim();
}

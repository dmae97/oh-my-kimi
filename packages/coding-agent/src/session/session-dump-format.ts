/**
 * Plain-text / markdown session formatting (same shape as /dump clipboard export).
 */
import type { AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { INTENT_FIELD } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, ToolExample, TSchema } from "@oh-my-pi/pi-ai";
import { getInbandGrammar, renderToolInventory } from "@oh-my-pi/pi-ai/grammar";
import { preferredToolSyntax } from "@oh-my-pi/pi-catalog/identity";
import { canonicalizeMessage } from "../utils/thinking-display";
import {
	type BashExecutionMessage,
	type BranchSummaryMessage,
	bashExecutionToText,
	type CompactionSummaryMessage,
	type CustomMessage,
	type FileMentionMessage,
	type HookMessage,
	type PythonExecutionMessage,
	pythonExecutionToText,
} from "./messages";

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
	const grammar = getInbandGrammar(preferredToolSyntax(options.model?.id ?? ""));

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
	if (tools.length > 0) {
		lines.push("## Available Tools\n");
		const inventoryTools = tools.map(tool => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters as TSchema,
			examples: tool.examples,
		}));
		lines.push(renderToolInventory(inventoryTools, options.model?.id ?? ""));
		lines.push("\n");
	}

	for (const msg of options.messages) {
		if (msg.role === "user" || msg.role === "developer") {
			lines.push(msg.role === "developer" ? "## Developer\n" : "## User\n");
			if (typeof msg.content === "string") {
				lines.push(msg.content);
			} else {
				for (const c of msg.content) {
					if (c.type === "text") {
						lines.push(c.text);
					} else if (c.type === "image") {
						lines.push("[Image]");
					}
				}
			}
			lines.push("\n");
		} else if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			lines.push("## Assistant\n");

			for (const c of assistantMsg.content) {
				if (c.type === "text") {
					lines.push(c.text);
				} else if (c.type === "thinking") {
					const thinking = canonicalizeMessage(c.thinking);
					if (thinking.length === 0) continue;
					lines.push("<thinking>");
					lines.push(thinking);
					lines.push("</thinking>\n");
				} else if (c.type === "toolCall") {
					const args = { ...(c.arguments as Record<string, unknown>) };
					delete args[INTENT_FIELD];
					lines.push(grammar.renderToolCall({ ...c, arguments: args }));
				}
			}
			lines.push("");
		} else if (msg.role === "toolResult") {
			lines.push(`### Tool Result: ${msg.toolName}`);
			if (msg.isError) {
				lines.push("(error)");
			}
			for (const c of msg.content) {
				if (c.type === "text") {
					lines.push("```");
					lines.push(c.text);
					lines.push("```");
				} else if (c.type === "image") {
					lines.push("[Image output]");
				}
			}
			lines.push("");
		} else if (msg.role === "bashExecution") {
			const bashMsg = msg as BashExecutionMessage;
			if (!bashMsg.excludeFromContext) {
				lines.push("## Bash Execution\n");
				lines.push(bashExecutionToText(bashMsg));
				lines.push("\n");
			}
		} else if (msg.role === "pythonExecution") {
			const pythonMsg = msg as PythonExecutionMessage;
			if (!pythonMsg.excludeFromContext) {
				lines.push("## Python Execution\n");
				lines.push(pythonExecutionToText(pythonMsg));
				lines.push("\n");
			}
		} else if (msg.role === "custom" || msg.role === "hookMessage") {
			const customMsg = msg as CustomMessage | HookMessage;
			lines.push(`## ${customMsg.customType}\n`);
			if (typeof customMsg.content === "string") {
				lines.push(customMsg.content);
			} else {
				for (const c of customMsg.content) {
					if (c.type === "text") {
						lines.push(c.text);
					} else if (c.type === "image") {
						lines.push("[Image]");
					}
				}
			}
			lines.push("\n");
		} else if (msg.role === "branchSummary") {
			const branchMsg = msg as BranchSummaryMessage;
			lines.push("## Branch Summary\n");
			lines.push(`(from branch: ${branchMsg.fromId})\n`);
			lines.push(branchMsg.summary);
			lines.push("\n");
		} else if (msg.role === "compactionSummary") {
			const compactMsg = msg as CompactionSummaryMessage;
			lines.push("## Compaction Summary\n");
			lines.push(`(${compactMsg.tokensBefore} tokens before compaction)\n`);
			lines.push(compactMsg.summary);
			lines.push("\n");
		} else if (msg.role === "fileMention") {
			const fileMsg = msg as FileMentionMessage;
			lines.push("## File Mention\n");
			for (const file of fileMsg.files) {
				lines.push(`<file path="${file.path}">`);
				if (file.content) {
					lines.push(file.content);
				}
				if (file.image) {
					lines.push("[Image attached]");
				}
				lines.push("</file>\n");
			}
			lines.push("\n");
		}
	}

	return lines.join("\n").trim();
}

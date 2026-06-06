import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolCall } from "@oh-my-pi/pi-ai";

/** A fenced code block extracted from assistant markdown. */
export interface CodeBlock {
	/** Info string after the opening fence (language id), trimmed. */
	lang: string;
	/** Block body with the trailing newline stripped. */
	code: string;
}

/** The most recent runnable command found in the transcript. */
export interface LastCommand {
	kind: "bash" | "eval";
	code: string;
	/** Highlight language: "bash" for bash, "python"/"javascript" for eval. */
	language: string;
}

/**
 * A node in the `/copy` picker tree. Leaves carry `content` (placed on the
 * clipboard) plus `copyMessage` (the status shown afterwards); groups carry
 * `children` to drill into.
 */
export interface CopyTarget {
	/** Stable identifier (e.g. "msg:1", "msg:1:code:0", "msg:1:all", "cmd"). */
	id: string;
	label: string;
	/** Dim annotation: line/block counts, language, or tool name. */
	hint?: string;
	/** Full text rendered in the preview pane. */
	preview: string;
	/** Highlight language for code/command previews (undefined = plain/markdown). */
	language?: string;
	/** Leaf: text copied to the clipboard. */
	content?: string;
	/** Leaf: status message shown after copying. */
	copyMessage?: string;
	/** Group: nested targets to drill into. */
	children?: CopyTarget[];
}

/** Minimal session surface needed to assemble copy targets (eases testing). */
export interface CopySource {
	readonly messages: readonly AgentMessage[];
	getLastVisibleHandoffText(): string | undefined;
}

/** Cap on how many recent assistant messages the picker lists. */
const MAX_MESSAGES = 50;

const CODE_BLOCK_RE = /^```([^\n]*)\n([\s\S]*?)^```/gm;

/** Extract fenced code blocks from assistant markdown, in document order. */
export function extractCodeBlocks(text: string): CodeBlock[] {
	const blocks: CodeBlock[] = [];
	for (const match of text.matchAll(CODE_BLOCK_RE)) {
		blocks.push({ lang: match[1].trim(), code: match[2].replace(/\n$/, "") });
	}
	return blocks;
}

function extractEvalCode(args: unknown): { code: string; language: string } | undefined {
	if (!args || typeof args !== "object") return undefined;
	const cells = (args as { cells?: unknown }).cells;
	if (!Array.isArray(cells)) return undefined;

	const codeBlocks: string[] = [];
	let language = "python";
	let languageResolved = false;
	for (const cell of cells) {
		if (!cell || typeof cell !== "object") continue;
		const code = (cell as { code?: unknown }).code;
		if (typeof code !== "string" || code.length === 0) continue;
		codeBlocks.push(code);
		if (!languageResolved) {
			language = (cell as { language?: unknown }).language === "js" ? "javascript" : "python";
			languageResolved = true;
		}
	}

	return codeBlocks.length > 0 ? { code: codeBlocks.join("\n\n"), language } : undefined;
}

/** Walk the transcript backwards for the most recent bash command or eval code. */
export function extractLastCommand(messages: readonly AgentMessage[]): LastCommand | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const toolCalls = msg.content.filter((c): c is ToolCall => c.type === "toolCall");
		for (let j = toolCalls.length - 1; j >= 0; j--) {
			const tc = toolCalls[j];
			if (tc.name === "bash" && typeof tc.arguments.command === "string") {
				return { kind: "bash", code: tc.arguments.command, language: "bash" };
			}
			if (tc.name === "eval") {
				const evalResult = extractEvalCode(tc.arguments);
				if (evalResult) return { kind: "eval", code: evalResult.code, language: evalResult.language };
			}
		}
	}
	return undefined;
}

/** Concatenated visible text of an assistant message, or undefined when empty. */
function assistantText(msg: AgentMessage): string | undefined {
	if (msg.role !== "assistant") return undefined;
	let text = "";
	for (const content of msg.content) {
		if (content.type === "text") text += content.text;
	}
	return text.trim() || undefined;
}

function pluralLines(text: string): string {
	const count = text.length === 0 ? 0 : text.split("\n").length;
	return `${count} line${count === 1 ? "" : "s"}`;
}

function blockHint(block: CodeBlock): string {
	const lines = pluralLines(block.code);
	return block.lang ? `${block.lang} · ${lines}` : lines;
}

/** First non-empty line, whitespace-collapsed, used as a message label. */
function firstLine(text: string): string {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed) return trimmed.replace(/\s+/g, " ");
	}
	return text.trim().replace(/\s+/g, " ");
}

/** Build the target node for one assistant message: a leaf when it has no code
 * blocks, otherwise a group exposing the full message, each block, and "all". */
function messageTarget(text: string, rank: number): CopyTarget {
	const id = `msg:${rank}`;
	const label = firstLine(text);
	const blocks = extractCodeBlocks(text);
	const hint = blocks.length > 0 ? `${pluralLines(text)} · ${blocks.length} code` : pluralLines(text);
	const messageCopy = rank === 1 ? "Copied last message to clipboard" : "Copied message to clipboard";

	if (blocks.length === 0) {
		return { id, label, hint, preview: text, content: text, copyMessage: messageCopy };
	}

	// The message node itself copies the full message; its code blocks are
	// child copy targets you can expand into.
	const children: CopyTarget[] = blocks.map((block, j) => ({
		id: `${id}:code:${j}`,
		label: `Block ${j + 1}`,
		hint: blockHint(block),
		preview: block.code,
		language: block.lang || undefined,
		content: block.code,
		copyMessage: `Copied code block ${j + 1} to clipboard`,
	}));
	if (blocks.length > 1) {
		const combined = blocks.map(b => b.code).join("\n\n");
		children.push({
			id: `${id}:all`,
			label: `All ${blocks.length} blocks`,
			hint: pluralLines(combined),
			preview: combined,
			content: combined,
			copyMessage: `Copied ${blocks.length} code blocks to clipboard`,
		});
	}

	return { id, label, hint, preview: text, content: text, copyMessage: messageCopy, children };
}

/**
 * Assemble the unified `/copy` target tree: the recent assistant messages
 * (most recent first, each drillable into its code blocks), a fresh-handoff
 * fallback when no assistant message exists yet, and the most recent command.
 */
export function buildCopyTargets(source: CopySource): CopyTarget[] {
	const targets: CopyTarget[] = [];

	let rank = 0;
	for (let i = source.messages.length - 1; i >= 0 && rank < MAX_MESSAGES; i--) {
		const text = assistantText(source.messages[i]);
		if (!text) continue;
		rank += 1;
		targets.push(messageTarget(text, rank));
	}

	if (targets.length === 0) {
		const handoff = source.getLastVisibleHandoffText();
		if (handoff) {
			targets.push({
				id: "handoff",
				label: "Handoff context",
				hint: pluralLines(handoff),
				preview: handoff,
				content: handoff,
				copyMessage: "Copied handoff context to clipboard",
			});
		}
	}

	const command = extractLastCommand(source.messages);
	if (command) {
		targets.push({
			id: "cmd",
			label: command.kind === "bash" ? "Last bash command" : "Last eval code",
			hint: command.kind,
			preview: command.code,
			language: command.language,
			content: command.code,
			copyMessage:
				command.kind === "bash" ? "Copied last bash command to clipboard" : "Copied last eval code to clipboard",
		});
	}

	return targets;
}

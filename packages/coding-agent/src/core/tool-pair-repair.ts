export interface ToolContentBlock {
	readonly type: string;
	readonly id?: string;
}

export interface ToolPairMessage {
	readonly role: string;
	readonly content?: readonly ToolContentBlock[] | string;
	readonly toolCallId?: string;
}

function asBlocks(content: ToolPairMessage["content"]): readonly ToolContentBlock[] {
	return Array.isArray(content) ? content : [];
}

export function applyToolPairRepair<T extends ToolPairMessage>(messages: readonly T[]): T[] {
	const resultIds = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			resultIds.add(message.toolCallId);
		}
	}

	const keptIds = new Set<string>();
	const repaired: T[] = [];
	for (const message of messages) {
		if (message.role === "assistant") {
			const original = asBlocks(message.content);
			const content = original.filter((block) => {
				if (block.type !== "toolCall") return true;
				if (typeof block.id !== "string" || !resultIds.has(block.id)) return false;
				keptIds.add(block.id);
				return true;
			});
			if (content.length === 0) continue;
			repaired.push(content.length === original.length ? message : { ...message, content });
			continue;
		}
		if (message.role === "toolResult") {
			if (typeof message.toolCallId === "string" && keptIds.has(message.toolCallId)) repaired.push(message);
			continue;
		}
		repaired.push(message);
	}
	return repaired;
}

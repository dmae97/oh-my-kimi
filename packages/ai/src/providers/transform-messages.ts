import turnAbortedGuidance from "../prompts/turn-aborted-guidance.md" with { type: "text" };
import type {
	Api,
	AssistantMessage,
	DeveloperMessage,
	Message,
	Model,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "../types";

const enum ToolCallStatus {
	/** A tool result has already been emitted for this tool call; later duplicates must be skipped. */
	Resolved = 1,
	/** A synthetic aborted result was emitted; later real results must be skipped. */
	Aborted = 2,
}

function shouldDropTruncatedThinkingOnlyAssistant(msg: AssistantMessage): boolean {
	const isTruncatedStop = msg.stopReason === "length" || msg.stopReason === "error" || msg.stopReason === "aborted";
	return isTruncatedStop && !msg.content.some(block => block.type === "toolCall" || block.type === "text");
}

function getLatestSurvivingAssistantIndex(messages: readonly Message[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const msg = messages[index]!;
		if (msg.role === "assistant" && !shouldDropTruncatedThinkingOnlyAssistant(msg)) {
			return index;
		}
	}
	return -1;
}

/**
 * Normalize tool call ID for cross-provider compatibility.
 * OpenAI Responses API generates IDs that are 450+ chars with special characters like `|`.
 * Anthropic APIs require IDs matching ^[a-zA-Z0-9_-]+$ (max 64 chars).
 *
 * For aborted/errored turns, this function:
 * - Preserves tool call structure (unlike converting to text summaries)
 * - Injects synthetic "aborted" tool results
 * - Adds a <turn-aborted> guidance marker for the model
 */
export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
	// Build a map of original tool call IDs to normalized IDs
	const toolCallIdMap = new Map<string, string>();

	const latestSurvivingAssistantIndex = getLatestSurvivingAssistantIndex(messages);
	// First pass: transform messages (thinking blocks, tool call ID normalization)
	const transformed = messages.map((msg, index) => {
		// User and developer messages pass through unchanged
		if (msg.role === "user" || msg.role === "developer") {
			return msg;
		}

		// Handle toolResult messages - normalize toolCallId if we have a mapping
		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			if (normalizedId && normalizedId !== msg.toolCallId) {
				return { ...msg, toolCallId: normalizedId };
			}
			return msg;
		}

		// Assistant messages need transformation check
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const isSameModel =
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api &&
				assistantMsg.model === model.id;

			const mustPreserveLatestAnthropicThinking =
				index === latestSurvivingAssistantIndex &&
				model.api === "anthropic-messages" &&
				assistantMsg.api === "anthropic-messages";
			// Aborted/errored messages may have partially-streamed thinking signatures.
			// A partial signature is invalid and will be rejected by the API, so we must
			// strip signatures from thinking blocks in these messages.
			//
			// Abandoned tool-use turns get the same treatment once they are no longer
			// the latest assistant message. When a turn carries toolCall blocks but did
			// NOT request tool execution (stopReason !== "toolUse" — e.g.
			// adaptive-thinking Opus emitting tool calls and then ending the turn on
			// `end_turn`/`stop`), the agent loop pairs those calls with placeholder
			// tool_results to keep the tool_use/tool_result contract valid. Historical
			// abandoned turns cannot safely replay their end_turn-bound signatures in
			// that continuation, so stripping downgrades them to plain text downstream.
			// Latest abandoned turns are exempt because Anthropic requires thinking
			// blocks from its most recent response to remain byte-for-byte unmodified.
			const invalidStopReason = assistantMsg.stopReason === "aborted" || assistantMsg.stopReason === "error";
			const abandonedToolUse =
				!invalidStopReason &&
				assistantMsg.stopReason !== "toolUse" &&
				assistantMsg.content.some(b => b.type === "toolCall");
			const hasInvalidSignatures = invalidStopReason || abandonedToolUse;

			const transformedContent = assistantMsg.content.flatMap(block => {
				if (block.type === "thinking") {
					// Strip untrustworthy signatures so the encoder can downgrade to text.
					const sanitized =
						hasInvalidSignatures && block.thinkingSignature ? { ...block, thinkingSignature: undefined } : block;
					if (mustPreserveLatestAnthropicThinking) return abandonedToolUse ? block : sanitized;
					// For same model: keep thinking blocks with signatures (needed for replay)
					// even if the thinking text is empty (OpenAI encrypted reasoning)
					if (isSameModel && sanitized.thinkingSignature) return sanitized;
					// Skip empty thinking blocks, convert others to plain text
					if (!sanitized.thinking || sanitized.thinking.trim() === "") return [];
					if (isSameModel) return sanitized;
					return {
						type: "text" as const,
						text: sanitized.thinking,
					};
				}

				if (block.type === "redactedThinking") {
					if (mustPreserveLatestAnthropicThinking) return block;
					if (isSameModel) return block;
					return [];
				}

				if (block.type === "text") {
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.text,
					};
				}

				if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					let normalizedToolCall: ToolCall = toolCall;

					if (!isSameModel && toolCall.thoughtSignature) {
						normalizedToolCall = { ...toolCall };
						delete (normalizedToolCall as { thoughtSignature?: string }).thoughtSignature;
					}

					if (!isSameModel && normalizeToolCallId) {
						const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
						if (normalizedId !== toolCall.id) {
							toolCallIdMap.set(toolCall.id, normalizedId);
							normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
						}
					}

					return normalizedToolCall;
				}

				return block;
			});

			return {
				...assistantMsg,
				content: transformedContent,
			};
		}
		return msg;
	});
	const realToolResultsById = new Map<string, ToolResultMessage>();
	for (const msg of transformed) {
		if (msg.role === "toolResult" && !realToolResultsById.has(msg.toolCallId)) {
			realToolResultsById.set(msg.toolCallId, msg);
		}
	}

	// Anthropic rejects `tool_result` blocks whose `tool_use_id` does not appear in a prior
	// `tool_use` block. After handoff/compaction folds an assistant turn into a summary
	// string, the user-side `toolResult` for that turn can survive while the originating
	// `tool_use` disappears — leaving an orphan that triggers HTTP 400. Track the set of
	// `tool_use` ids that survive transformation so the second pass can drop orphans cleanly.
	const validToolUseIds = new Set<string>();
	for (const msg of transformed) {
		if (msg.role !== "assistant") continue;
		for (const block of msg.content) {
			if (block.type === "toolCall") validToolUseIds.add(block.id);
		}
	}

	// Second pass: ensure each surviving assistant tool call is immediately
	// followed by exactly one corresponding tool result.
	const result: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let pendingAbortedToolCalls = new Map<string, ToolCall>();
	let pendingAbortedTimestamp: number | undefined;
	// Track which tool calls already have an emitted result so delayed/duplicate
	// toolResult messages cannot create a second provider-visible result.
	const toolCallStatus = new Map<string, ToolCallStatus>();

	const flushPendingToolCalls = (timestamp: number): void => {
		if (pendingToolCalls.length === 0) return;
		for (const tc of pendingToolCalls) {
			if (toolCallStatus.has(tc.id)) continue;
			const realToolResult = realToolResultsById.get(tc.id);
			if (realToolResult) {
				result.push(realToolResult);
				toolCallStatus.set(tc.id, ToolCallStatus.Resolved);
				continue;
			}
			result.push({
				role: "toolResult",
				toolCallId: tc.id,
				toolName: tc.name,
				content: [{ type: "text", text: "No result provided" }],
				isError: true,
				timestamp,
			} as ToolResultMessage);
			toolCallStatus.set(tc.id, ToolCallStatus.Resolved);
		}
		pendingToolCalls = [];
	};

	const flushPendingAbortedToolCalls = (): void => {
		if (pendingAbortedTimestamp === undefined) return;
		for (const tc of pendingAbortedToolCalls.values()) {
			if (toolCallStatus.has(tc.id)) continue;
			const realToolResult = realToolResultsById.get(tc.id);
			if (realToolResult) {
				result.push(realToolResult);
				toolCallStatus.set(tc.id, ToolCallStatus.Resolved);
				continue;
			}
			result.push({
				role: "toolResult",
				toolCallId: tc.id,
				toolName: tc.name,
				content: [{ type: "text", text: "aborted" }],
				isError: true,
				timestamp: pendingAbortedTimestamp,
			} as ToolResultMessage);
			toolCallStatus.set(tc.id, ToolCallStatus.Aborted);
		}
		result.push({
			role: "developer",
			content: turnAbortedGuidance,
			timestamp: pendingAbortedTimestamp + 1,
		} as DeveloperMessage);
		pendingAbortedToolCalls = new Map();
		pendingAbortedTimestamp = undefined;
	};

	for (let i = 0; i < transformed.length; i++) {
		const msg = transformed[i];
		const messageTimestamp = "timestamp" in msg && typeof msg.timestamp === "number" ? msg.timestamp : Date.now();

		if (msg.role === "assistant") {
			flushPendingToolCalls(messageTimestamp);
			flushPendingAbortedToolCalls();

			const assistantMsg = msg as AssistantMessage;

			// Drop assistant turns that carry no actionable content (no `text`, no `toolCall`)
			// AND were terminated by a truncating stop reason (`length` / `error` / `aborted`).
			// These are produced when the provider returns `stop_reason: "max_tokens"` (or a
			// stream error) mid-thinking, leaving a `[thinking]`-only message with a valid
			// signature but nothing for the next turn to anchor on. Keeping it creates
			// back-to-back assistant turns once the next response lands, which Anthropic
			// rejects with "messages.X.content.Y: `thinking` blocks in the latest assistant
			// message cannot be modified".
			//
			// `stopReason: "stop"` thinking-only messages are intentionally preserved: they
			// represent reasoning-only assistant turns used for replay round-trips
			// (OpenAI completions `reasoning_text`, Google signed thought parts).
			const originalMsg = messages[i]!;
			if (originalMsg.role === "assistant" && shouldDropTruncatedThinkingOnlyAssistant(originalMsg)) {
				if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
					// Still arm the aborted-turn note so downstream guidance fires.
					pendingAbortedToolCalls = new Map();
					pendingAbortedTimestamp = assistantMsg.timestamp;
				}
				continue;
			}

			const toolCalls = assistantMsg.content.filter(b => b.type === "toolCall") as ToolCall[];

			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				// Keep the assistant message with tool calls intact. Real tool results are
				// emitted immediately if available; otherwise synthesize aborted results
				// before the next turn boundary.
				result.push(msg);
				pendingAbortedToolCalls = new Map(toolCalls.map(toolCall => [toolCall.id, toolCall] as const));
				pendingAbortedTimestamp = assistantMsg.timestamp;
				continue;
			}

			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
			}

			result.push(msg);
		} else if (msg.role === "toolResult") {
			if (toolCallStatus.has(msg.toolCallId)) continue;

			if (pendingAbortedToolCalls.has(msg.toolCallId)) {
				pendingAbortedToolCalls.delete(msg.toolCallId);
				toolCallStatus.set(msg.toolCallId, ToolCallStatus.Resolved);
				result.push(msg);
				continue;
			}

			if (pendingToolCalls.some(tc => tc.id === msg.toolCallId)) {
				toolCallStatus.set(msg.toolCallId, ToolCallStatus.Resolved);
				result.push(msg);
				continue;
			}

			if (!validToolUseIds.has(msg.toolCallId)) {
				// Orphan `tool_result`: the originating `tool_use` is not present in the
				// transformed history (typically because handoff/compaction folded the
				// assistant message into a summary string while the user-side result
				// survived). Sending the block as-is would 400 the request, so it must
				// be dropped.
				//
				// If a pending tool-call window is still open (either normal or
				// aborted), the orphan cannot be replaced with a developer note here:
				//
				// * Anthropic requires the next message after an assistant `tool_use`
				//   to be the matching `tool_result`. Inserting a developer message
				//   would break that contiguity.
				// * Flushing pending aborted calls here would wedge synthetic results
				//   between the assistant turn and a real result that may still arrive
				//   inside the current contiguous result window.
				//
				// Drop the orphan silently in that case; the pending calls will be
				// resolved in their own contiguous result window or at the next boundary.
				if (pendingToolCalls.some(tc => !toolCallStatus.has(tc.id)) || pendingAbortedToolCalls.size > 0) {
					continue;
				}
				// No pending tool-call window: safe to preserve the text payload so the
				// model still sees what the tool returned.
				//
				// The note is emitted with `role: "user"` rather than `role: "developer"`
				// because the developer role is elevated by some providers:
				//
				// * Ollama maps `developer` -> `system` (highest instruction priority).
				// * OpenAI chat-completions reasoning models forward `developer` as
				//   `developer` (above-user instruction priority).
				//
				// Stale, model-untrusted tool output must not gain instruction priority
				// above user/developer messages it lived alongside before compaction.
				// `user` role is mapped to plain user content by every provider, so the
				// content survives without ever being treated as an instruction the
				// model should obey.
				const textParts: string[] = [];
				for (const part of msg.content) {
					if (part.type === "text" && part.text.trim() !== "") textParts.push(part.text);
				}
				if (textParts.length > 0) {
					const errorAttr = msg.isError ? ' is-error="true"' : "";
					result.push({
						role: "user",
						content: `<stale-tool-result tool="${msg.toolName}" id="${msg.toolCallId}"${errorAttr}>\n${textParts.join("\n")}\n</stale-tool-result>`,
						timestamp: messageTimestamp,
					} as UserMessage);
				}
			}

			// The matching tool_use exists elsewhere, but this result is not in
			// the currently open result window. Emitting it here would break the
			// provider invariant; the first real result is pulled into the correct
			// slot by the pending-call flush instead.
		} else if (msg.role === "user" || msg.role === "developer") {
			flushPendingToolCalls(messageTimestamp);
			flushPendingAbortedToolCalls();
			result.push(msg);
		} else {
			flushPendingToolCalls(messageTimestamp);
			flushPendingAbortedToolCalls();
			result.push(msg);
		}
	}

	flushPendingToolCalls(Date.now());
	flushPendingAbortedToolCalls();

	return result;
}

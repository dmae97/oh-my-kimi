/**
 * Pure, browser-safe transcript integrity inspector and repair for the tool-call
 * transcripts produced by the agent loop.
 *
 * The inspector detects five classes of structural corruption:
 * - `missing_result`: a tool call with no matching tool result
 * - `duplicate_result`: two or more tool results for the same call id
 * - `orphan_result`: a tool result whose call id was never emitted
 * - `duplicate_call_id`: two or more tool calls sharing an id
 * - `interleaved_non_result`: a non-result message breaks the contiguous run of
 *   results that must follow an assistant message's tool calls (including a
 *   result that arrives before its call, after a user/custom boundary, or at the
 *   start of the transcript)
 *
 * IDs are accounted globally, so an orphan or duplicate is caught regardless of
 * where it appears. Repair is intentionally conservative: it only appends
 * synthetic results for unambiguous missing tail calls. Any duplicate, orphan,
 * interleaving, or mid-transcript gap fails closed.
 *
 * This module uses no platform APIs (no `process`, fs, or timers) so it is safe
 * to run in a browser.
 */

import type { AssistantMessage, ToolCall, ToolResultMessage } from "omk-ai";
import { createImmutableSnapshot } from "./plain-data.ts";
import { type AgentMessage, createToolResultEnvelope } from "./types.ts";

export type TranscriptIntegrityIssueKind =
	| "missing_result"
	| "duplicate_result"
	| "orphan_result"
	| "duplicate_call_id"
	| "interleaved_non_result";

export interface TranscriptIntegrityIssue {
	readonly kind: TranscriptIntegrityIssueKind;
	readonly toolCallId: string;
	readonly toolName?: string;
}

export interface TranscriptIntegrityReport {
	readonly ok: boolean;
	readonly issues: readonly TranscriptIntegrityIssue[];
}

/** Thrown by {@link repairTranscriptIntegrity} when a transcript cannot be safely repaired. */
export class TranscriptIntegrityError extends Error {
	readonly report: TranscriptIntegrityReport;
	constructor(message: string, report: TranscriptIntegrityReport) {
		super(message);
		this.name = "TranscriptIntegrityError";
		this.report = report;
	}
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant";
}

function isToolResultMessage(message: AgentMessage): message is ToolResultMessage {
	return message.role === "toolResult";
}

function isToolCallBlock(block: unknown): block is ToolCall {
	return (block as { type?: string } | null)?.type === "toolCall";
}

/**
 * Inspect a transcript and report every detected integrity issue. Pure: does not
 * mutate the input and uses no platform APIs.
 *
 * IDs are accounted globally first (catching duplicates, orphans, and missing
 * results anywhere in the transcript), then a single left-to-right pass checks
 * the ordering invariant that an assistant message's tool calls must be followed
 * by a contiguous run of their results with no intervening non-result message.
 */
export function inspectTranscriptIntegrity(messages: readonly AgentMessage[]): TranscriptIntegrityReport {
	const issues: TranscriptIntegrityIssue[] = [];

	const callIdCount = new Map<string, number>();
	const resultIdCount = new Map<string, number>();
	const callToolName = new Map<string, string>();

	for (const message of messages) {
		if (isAssistantMessage(message)) {
			for (const block of message.content) {
				if (isToolCallBlock(block)) {
					callIdCount.set(block.id, (callIdCount.get(block.id) ?? 0) + 1);
					if (!callToolName.has(block.id)) {
						callToolName.set(block.id, block.name);
					}
				}
			}
		} else if (isToolResultMessage(message)) {
			resultIdCount.set(message.toolCallId, (resultIdCount.get(message.toolCallId) ?? 0) + 1);
		}
	}

	for (const [id, count] of callIdCount) {
		if (count > 1) {
			issues.push({ kind: "duplicate_call_id", toolCallId: id, toolName: callToolName.get(id) });
		}
	}
	for (const [id, count] of resultIdCount) {
		if (count > 1) {
			issues.push({ kind: "duplicate_result", toolCallId: id });
		}
	}
	for (const [id] of resultIdCount) {
		if (!callIdCount.has(id)) {
			issues.push({ kind: "orphan_result", toolCallId: id });
		}
	}
	for (const [id] of callIdCount) {
		if (!resultIdCount.has(id)) {
			issues.push({ kind: "missing_result", toolCallId: id, toolName: callToolName.get(id) });
		}
	}

	const pending = new Map<string, string>();
	let resultsRegion = false;

	for (const message of messages) {
		if (isAssistantMessage(message)) {
			const calls = message.content.filter(isToolCallBlock);
			if (calls.length > 0) {
				// A new assistant message with tool calls while previous calls are
				// still unresolved means a non-result interrupted the prior region.
				if (pending.size > 0) {
					for (const [id, name] of pending) {
						issues.push({ kind: "interleaved_non_result", toolCallId: id, toolName: name });
					}
					break;
				}
				for (const call of calls) {
					pending.set(call.id, call.name);
				}
				resultsRegion = true;
			} else if (resultsRegion && pending.size > 0) {
				for (const [id, name] of pending) {
					issues.push({ kind: "interleaved_non_result", toolCallId: id, toolName: name });
				}
				break;
			}
		} else if (isToolResultMessage(message)) {
			if (resultsRegion && pending.has(message.toolCallId)) {
				pending.delete(message.toolCallId);
				if (pending.size === 0) {
					resultsRegion = false;
				}
			} else if (callIdCount.has(message.toolCallId)) {
				// Known call id arriving outside its contiguous results region:
				// orphan-at-start, after-user, or assistant -> non-result -> result.
				issues.push({ kind: "interleaved_non_result", toolCallId: message.toolCallId });
				break;
			}
			// Unknown-id orphans are already reported above; do not double report.
		} else {
			// user or custom non-result message: breaks an open results region.
			if (resultsRegion && pending.size > 0) {
				for (const [id, name] of pending) {
					issues.push({ kind: "interleaved_non_result", toolCallId: id, toolName: name });
				}
				break;
			}
		}
	}

	const frozenIssues = Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
	return Object.freeze({ ok: frozenIssues.length === 0, issues: frozenIssues });
}

/**
 * Create a synthetic terminal tool result. Shared by transcript repair and the
 * agent-loop abort closure so the disposition of an unresolved call is encoded
 * identically everywhere. The `details.omk` envelope marks the artifact as
 * synthetic (`executionStarted: false`): it closes the provider transcript and
 * never claims the tool actually ran.
 */
export function createSyntheticToolResult(
	toolCallId: string,
	toolName: string,
	reason: string,
	timestamp: number = Date.now(),
	disposition: "aborted" | "skipped" = "aborted",
): ToolResultMessage {
	const envelope = createToolResultEnvelope({
		synthetic: true,
		disposition,
		reason,
		executionStarted: false,
	});
	return createImmutableSnapshot({
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: reason }],
		details: { omk: envelope },
		isError: true,
		timestamp,
	});
}

/**
 * Repair a transcript by appending synthetic results for unambiguous missing
 * tail calls. Fails closed (throws {@link TranscriptIntegrityError}) for any
 * duplicate, orphan, interleaving, or mid-transcript gap. Idempotent: a second
 * call on already-repaired input returns an equal copy with no new messages.
 */
export function repairTranscriptIntegrity(messages: readonly AgentMessage[], reason?: string): AgentMessage[] {
	const report = inspectTranscriptIntegrity(messages);

	for (const issue of report.issues) {
		if (issue.kind !== "missing_result") {
			throw new TranscriptIntegrityError(
				`Cannot repair transcript: detected ${issue.kind} for tool call ${issue.toolCallId}`,
				report,
			);
		}
	}

	const missingIds = new Set(report.issues.map((issue) => issue.toolCallId));
	if (missingIds.size === 0) {
		return messages.slice();
	}

	let lastAssistantIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isAssistantMessage(messages[i])) {
			lastAssistantIndex = i;
			break;
		}
	}
	if (lastAssistantIndex === -1) {
		throw new TranscriptIntegrityError(
			"Cannot repair transcript: missing results without an assistant message",
			report,
		);
	}

	const lastAssistant = messages[lastAssistantIndex];
	if (!isAssistantMessage(lastAssistant)) {
		throw new TranscriptIntegrityError("Cannot repair transcript: trailing message is not assistant", report);
	}
	const tailCalls = lastAssistant.content.filter(isToolCallBlock);
	const tailCallIds = new Set(tailCalls.map((call) => call.id));
	for (const id of missingIds) {
		if (!tailCallIds.has(id)) {
			throw new TranscriptIntegrityError(
				`Cannot repair transcript: missing result for ${id} is not in the trailing assistant message`,
				report,
			);
		}
	}

	for (let i = lastAssistantIndex + 1; i < messages.length; i++) {
		const message = messages[i];
		if (!isToolResultMessage(message) || !tailCallIds.has(message.toolCallId)) {
			throw new TranscriptIntegrityError(
				"Cannot repair transcript: non-result message after the trailing assistant message",
				report,
			);
		}
	}

	const text = reason ?? "Tool result missing; synthesized by transcript repair";
	const repaired = messages.slice();
	for (const call of tailCalls) {
		if (missingIds.has(call.id)) {
			repaired.push(createSyntheticToolResult(call.id, call.name, text));
		}
	}
	return repaired;
}

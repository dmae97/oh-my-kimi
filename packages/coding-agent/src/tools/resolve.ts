import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	CustomMessage,
} from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import resolveDescription from "../prompts/tools/resolve.md" with { type: "text" };
import { Ellipsis, padToWidth, renderStatusLine, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import { replaceTabs } from "./render-utils";
import { ToolError } from "./tool-errors";

const resolveSchema = type({
	action: "'apply' | 'discard'",
	reason: type("string").describe("reason for action"),
	"extra?": type("Record<string, unknown>").describe("free-form metadata"),
});

type ResolveParams = typeof resolveSchema.infer;

export interface ResolveToolDetails {
	action: "apply" | "discard";
	reason: string;
	extra?: Record<string, unknown>;
	sourceToolName?: string;
	label?: string;
	sourceResultDetails?: unknown;
}

/** Monotonic suffix making each staged preview's pending-invoker id UNIQUE, so
 *  stacked previews never clobber one another by label. */
let pendingPreviewSeq = 0;

/**
 * Register a non-forcing resolve-protocol handler for a staged preview. Wraps the
 * caller's apply/reject into an onInvoked closure (matching the resolve schema) and
 * stores it on the tool-choice queue's pending-invoker registry under a UNIQUE id.
 * The `resolve` tool dispatches to it; the agent-loop's SoftToolRequirement
 * lifecycle injects the preview reminder and escalates to a forced `resolve` only
 * if the model declines — so a compliant turn pays ZERO tool_choice change (no
 * prompt-cache messages-cache invalidation).
 *
 * This is the canonical entry point for any tool that wants preview/apply
 * semantics. No session-level abstraction is needed: callers pass their
 * apply/reject functions directly.
 */
export function queueResolveHandler(
	session: ToolSession,
	options: {
		label: string;
		sourceToolName: string;
		apply(reason: string, extra?: Record<string, unknown>): Promise<AgentToolResult<unknown>>;
		reject?(reason: string, extra?: Record<string, unknown>): Promise<AgentToolResult<unknown> | undefined>;
	},
): void {
	const queue = session.getToolChoiceQueue?.();
	if (!queue) return;

	// Unique per preview: stacked/sequential previews each get their own entry.
	const id = `pending-action:${options.sourceToolName}:${pendingPreviewSeq++}`;

	const onInvoked = async (input: unknown): Promise<AgentToolResult<unknown>> => {
		const result = await runResolveInvocation(input as ResolveParams, {
			sourceToolName: options.sourceToolName,
			label: options.label,
			apply: options.apply,
			reject: options.reject,
			onApplyError: () => {
				// Apply threw (e.g. ast_edit overlapping replacements). Keep the preview
				// pending under the SAME id so the model can `discard` or fix-and-retry;
				// runResolveInvocation rethrows, so the success-path removal below is skipped.
				queue.registerPendingInvoker(id, options.sourceToolName, onInvoked);
			},
		});
		// Resolved (apply succeeded, or discard): consume the staged action exactly once.
		queue.removePendingInvoker(id);
		return result;
	};

	// NON-FORCING: register so `resolve` can dispatch here WITHOUT changing
	// tool_choice. The agent-loop injects the reminder (from the SoftToolRequirement
	// the session builds) and forces a resolve turn only on non-compliance.
	queue.registerPendingInvoker(id, options.sourceToolName, onInvoked);
}

/**
 * The canonical preview reminder. The resolve mechanism owns the wording; the
 * agent-loop delivers it via the session's `SoftToolRequirement.reminder` (injected
 * once per pending-preview head) instead of a host-side steer, so it lands as a
 * stable mid-history append and never churns the cached prefix.
 */
export function buildResolveReminderMessage(sourceToolName: string): CustomMessage {
	return {
		role: "custom",
		customType: "resolve-reminder",
		content: [
			"<system-reminder>",
			"This is a preview. Call the `resolve` tool to apply or discard these changes.",
			"</system-reminder>",
		].join("\n"),
		display: false,
		details: { toolName: sourceToolName },
		attribution: "agent",
		timestamp: Date.now(),
	};
}

/**
 * Shared invocation runner used by both queued (in-flight) handlers and
 * standing handlers (e.g. plan-mode approval). Discriminates on action,
 * routes through the caller's apply/reject, and wraps the resulting tool
 * payload with `ResolveToolDetails` so the renderer and event-controller
 * see a consistent shape.
 */
export async function runResolveInvocation(
	params: ResolveParams,
	options: {
		sourceToolName: string;
		label: string;
		apply(reason: string, extra?: Record<string, unknown>): Promise<AgentToolResult<unknown>>;
		reject?(reason: string, extra?: Record<string, unknown>): Promise<AgentToolResult<unknown> | undefined>;
		/** Invoked synchronously when `apply()` throws, before the error is rethrown.
		 *  The queued caller uses this to re-push the resolve directive so the
		 *  pending preview survives a failed apply (e.g. overlapping ast_edit
		 *  replacements) and the model can `discard` or fix-and-retry. */
		onApplyError?(error: unknown): void;
	},
): Promise<AgentToolResult<ResolveToolDetails>> {
	const baseDetails: ResolveToolDetails = {
		action: params.action,
		reason: params.reason,
		sourceToolName: options.sourceToolName,
		label: options.label,
		...(params.extra != null ? { extra: params.extra } : {}),
	};
	if (params.action === "apply") {
		let result: AgentToolResult<unknown>;
		try {
			result = await options.apply(params.reason, params.extra);
		} catch (error) {
			try {
				options.onApplyError?.(error);
			} catch {
				// Requeue hook must not mask the original apply failure.
			}
			if (error instanceof ToolError) throw error;
			const message = error instanceof Error ? error.message : String(error);
			throw new ToolError(`Apply failed: ${message}`);
		}
		return {
			...result,
			details: {
				...baseDetails,
				...(result.details != null ? { sourceResultDetails: result.details } : {}),
			},
		};
	}
	if (params.action === "discard" && options.reject != null) {
		const result = await options.reject(params.reason, params.extra);
		if (result != null) {
			return {
				...result,
				details: {
					...baseDetails,
					...(result.details != null ? { sourceResultDetails: result.details } : {}),
				},
			};
		}
	}
	return {
		content: [{ type: "text" as const, text: `Discarded: ${options.label}. Reason: ${params.reason}` }],
		details: baseDetails,
	};
}

export class ResolveTool implements AgentTool<typeof resolveSchema, ResolveToolDetails> {
	readonly name = "resolve";
	readonly approval = "read" as const;
	readonly label = "Resolve";
	readonly hidden = true;
	readonly description: string;
	readonly parameters = resolveSchema;
	readonly strict = true;
	readonly intent = (args: Partial<ResolveParams>) => {
		if (args.action === "discard") {
			return args.reason ? `discarding: ${args.reason}` : "discarding changes";
		}
		return args.reason ? `accepting: ${args.reason}` : "accepting changes";
	};

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(resolveDescription);
	}

	async execute(
		_toolCallId: string,
		params: ResolveParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ResolveToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ResolveToolDetails>> {
		return untilAborted(signal, async () => {
			const invoker =
				this.session.peekQueueInvoker?.() ??
				this.session.peekPendingInvoker?.() ??
				this.session.peekStandingResolveHandler?.();
			if (!invoker) {
				// `discard` is a request to cancel/abort a staged action. When nothing is
				// pending, the desired end-state (no staged change) already holds, so honor
				// it as a successful cancellation instead of surfacing a hard error to the
				// model. `apply` still errors — there is nothing to apply.
				if (params.action === "discard") {
					return {
						content: [{ type: "text" as const, text: "Nothing to discard; no pending action remains." }],
						details: {
							action: "discard",
							reason: params.reason,
							...(params.extra != null ? { extra: params.extra } : {}),
						},
					};
				}
				throw new ToolError("No pending action to resolve. Nothing to apply or discard.");
			}
			const result = (await invoker(params)) as AgentToolResult<ResolveToolDetails>;
			return result;
		});
	}
}

export const resolveToolRenderer = {
	renderCall(args: ResolveParams, _options: RenderResultOptions, uiTheme: Theme): Component {
		const reasonTrimmed = args.reason?.trim();
		const reason = reasonTrimmed ? truncateToWidth(reasonTrimmed, 72, Ellipsis.Omit) : undefined;
		const text = renderStatusLine(
			{
				icon: "pending",
				title: "Resolve",
				description: args.action,
				badge: {
					label: args.action === "apply" ? "proposed -> resolved" : "proposed -> rejected",
					color: args.action === "apply" ? "success" : "warning",
				},
				meta: reason ? [uiTheme.fg("muted", reason)] : undefined,
			},
			uiTheme,
		);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: ResolveToolDetails; isError?: boolean },
		_options: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		const details = result.details;
		const label = replaceTabs(details?.label ?? "pending action");
		const reason = replaceTabs(details?.reason?.trim() || "No reason provided");
		const action = details?.action ?? "apply";
		const isApply = action === "apply" && !result.isError;
		const isFailedApply = action === "apply" && result.isError;
		const bgColor = result.isError ? "error" : isApply ? "success" : "warning";
		// Bare symbol: the line is wrapped in inverse(fg(...)), so any embedded fg
		// reset (styledSymbol/status glyphs carry their own \x1b[39m) would drop the
		// inverse block back to the default background mid-line.
		const icon = uiTheme.symbol(isApply ? "tool.resolve" : "status.error");
		const verb = isApply ? "Accept" : isFailedApply ? "Failed" : "Discard";
		const separator = ": ";
		const separatorIndex = label.indexOf(separator);
		const sourceLabel = separatorIndex > 0 ? label.slice(0, separatorIndex).trim() : undefined;
		const summaryLabel = separatorIndex > 0 ? label.slice(separatorIndex + separator.length).trim() : label;
		const sourceBadge = sourceLabel
			? uiTheme.bold(`${uiTheme.format.bracketLeft}${sourceLabel}${uiTheme.format.bracketRight}`)
			: undefined;
		const headerLine = `${icon} ${uiTheme.bold(`${verb}:`)} ${summaryLabel}${sourceBadge ? ` ${sourceBadge}` : ""}`;
		const lines = ["", headerLine, "", uiTheme.italic(reason), ""];

		return {
			render(width: number): readonly string[] {
				const lineWidth = Math.max(3, width);
				const innerWidth = Math.max(1, lineWidth - 2);
				return lines.map(line => {
					const truncated = truncateToWidth(line, innerWidth, Ellipsis.Omit);
					const framed = ` ${padToWidth(truncated, innerWidth)} `;
					const padded = padToWidth(framed, lineWidth);
					return uiTheme.inverse(uiTheme.fg(bgColor, padded));
				});
			},
			invalidate() {},
		};
	},

	inline: true,
	mergeCallAndResult: true,
};

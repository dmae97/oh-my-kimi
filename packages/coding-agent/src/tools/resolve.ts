import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import resolveDescription from "../prompts/tools/resolve.md" with { type: "text" };
import { Ellipsis, padToWidth, renderStatusLine, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import { replaceTabs } from "./render-utils";
import { ToolError } from "./tool-errors";

const resolveSchema = z.object({
	action: z.enum(["apply", "discard"]),
	reason: z.string().describe("reason for action"),
	extra: z.record(z.string(), z.unknown()).optional().describe("free-form metadata"),
});

type ResolveParams = z.infer<typeof resolveSchema>;

export interface ResolveToolDetails {
	action: "apply" | "discard";
	reason: string;
	extra?: Record<string, unknown>;
	sourceToolName?: string;
	label?: string;
	sourceResultDetails?: unknown;
}

/**
 * Queue a resolve-protocol handler on the tool-choice queue. Forces the next
 * LLM call to invoke the hidden `resolve` tool, wraps the caller's apply/reject
 * callbacks into an onInvoked closure that matches the resolve schema, and
 * steers a preview reminder so the model understands why.
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
	const forced = session.buildToolChoice?.("resolve");
	if (!queue || !forced || typeof forced === "string") return;

	const steerReminder = (): void => {
		session.steer?.({
			customType: "resolve-reminder",
			content: [
				"<system-reminder>",
				"This is a preview. Call the `resolve` tool to apply or discard these changes.",
				"</system-reminder>",
			].join("\n"),
			details: { toolName: options.sourceToolName },
		});
	};

	const pushDirective = (): void => {
		queue.pushOnce(forced, {
			label: `pending-action:${options.sourceToolName}`,
			now: true,
			onRejected: () => "requeue",
			onInvoked: async (input: unknown) =>
				runResolveInvocation(input as ResolveParams, {
					sourceToolName: options.sourceToolName,
					label: options.label,
					apply: options.apply,
					reject: options.reject,
					onApplyError: () => {
						// Apply threw (e.g. ast_edit overlapping replacements). Re-push the
						// same directive so the preview remains pending and the model can
						// `discard` or fix-and-retry on the next turn instead of being
						// stranded with no pending action to address.
						pushDirective();
						steerReminder();
					},
				}),
		});
	};

	pushDirective();
	steerReminder();
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
			const invoker = this.session.peekQueueInvoker?.() ?? this.session.peekStandingResolveHandler?.();
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

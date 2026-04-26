import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import resolveDescription from "../prompts/tools/resolve.md" with { type: "text" };
import { Ellipsis, padToWidth, renderStatusLine, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import { replaceTabs } from "./render-utils";
import { ToolError } from "./tool-errors";

const resolveSchema = Type.Object({
	action: Type.Union([Type.Literal("apply"), Type.Literal("discard")]),
	reason: Type.String({ description: "reason for action", examples: ["approved by user"] }),
});

type ResolveParams = Static<typeof resolveSchema>;

export interface ResolveToolDetails {
	action: "apply" | "discard";
	reason: string;
	sourceToolName?: string;
	label?: string;
	sourceResultDetails?: unknown;
}

function resolveReasonPreview(reason?: string): string | undefined {
	const trimmed = reason?.trim();
	if (!trimmed) return undefined;
	return truncateToWidth(trimmed, 72, Ellipsis.Omit);
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
		apply(reason: string): Promise<AgentToolResult<unknown>>;
		reject?(reason: string): Promise<AgentToolResult<unknown> | undefined>;
	},
): void {
	const queue = session.getToolChoiceQueue?.();
	const forced = session.buildToolChoice?.("resolve");
	if (!queue || !forced || typeof forced === "string") return;

	const detailsFor = (params: ResolveParams): ResolveToolDetails => ({
		action: params.action,
		reason: params.reason,
		sourceToolName: options.sourceToolName,
		label: options.label,
	});

	queue.pushOnce(forced, {
		label: `pending-action:${options.sourceToolName}`,
		now: true,
		onRejected: () => "requeue",
		onInvoked: async (input: unknown) => {
			const params = input as ResolveParams;
			const withResolveDetails = (result: AgentToolResult<unknown>): AgentToolResult<ResolveToolDetails> => ({
				...result,
				details: {
					...detailsFor(params),
					...(result.details != null ? { sourceResultDetails: result.details } : {}),
				},
			});
			if (params.action === "apply") {
				const result = await options.apply(params.reason);
				return withResolveDetails(result);
			}
			if (params.action === "discard" && options.reject != null) {
				const result = await options.reject(params.reason);
				if (result != null) {
					return withResolveDetails(result);
				}
			}
			return {
				content: [{ type: "text" as const, text: `Discarded: ${options.label}. Reason: ${params.reason}` }],
				details: detailsFor(params),
			};
		},
	});

	session.steer?.({
		customType: "resolve-reminder",
		content: [
			"<system-reminder>",
			"This is a preview. Call the `resolve` tool to apply or discard these changes.",
			"</system-reminder>",
		].join("\n"),
		details: { toolName: options.sourceToolName },
	});
}

export class ResolveTool implements AgentTool<typeof resolveSchema, ResolveToolDetails> {
	readonly name = "resolve";
	readonly label = "Resolve";
	readonly hidden = true;
	readonly description: string;
	readonly parameters = resolveSchema;
	readonly strict = true;
	readonly intent = (args: Partial<ResolveParams>) =>
		args.action === "discard" ? "Discarding pending action" : "Applying pending action";

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
			const invoker = this.session.peekQueueInvoker?.();
			if (!invoker) {
				throw new ToolError("No pending action to resolve. Nothing to apply or discard.");
			}
			const result = (await invoker(params)) as AgentToolResult<ResolveToolDetails>;
			return result;
		});
	}
}

export const resolveToolRenderer = {
	renderCall(args: ResolveParams, _options: RenderResultOptions, uiTheme: Theme): Component {
		const reason = resolveReasonPreview(args.reason);
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
		const icon = isApply ? uiTheme.status.success : uiTheme.status.error;
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
			render(width: number) {
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

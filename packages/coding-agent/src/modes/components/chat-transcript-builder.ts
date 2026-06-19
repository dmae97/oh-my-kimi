/**
 * Builds transcript components from persisted session message entries — the
 * file/remote-backed counterpart to {@link UiHelpers.addMessageToChat} (which is
 * bound to the live InteractiveModeContext). Used by the fullscreen transcript
 * viewer ({@link AgentTranscriptViewer}) to render a parked subagent / advisor /
 * collab-guest transcript that has no live session.
 *
 * Unlike the old incremental hub sync, {@link ChatTranscriptBuilder.rebuild}
 * always discards prior components and rebuilds the whole transcript from the
 * supplied entries. Re-rendering a growing transcript is therefore O(n) in the
 * entry count, but it cannot duplicate or misorder rows the way incremental
 * component reuse could.
 */
import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import { Text, type TUI } from "@oh-my-pi/pi-tui";
import { formatBytes, formatDuration } from "@oh-my-pi/pi-utils";
import type { AdvisorMessageDetails } from "../../advisor";
import { COLLAB_PROMPT_MESSAGE_TYPE, type CollabPromptDetails } from "../../collab/protocol";
import { settings } from "../../config/settings";
import type { MessageRenderer } from "../../extensibility/extensions/types";
import {
	BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
	type CustomMessage,
	isSilentAbort,
	LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
	resolveAbortLabel,
	SKILL_PROMPT_MESSAGE_TYPE,
	type SkillPromptDetails,
} from "../../session/messages";
import type { SessionMessageEntry } from "../../session/session-entries";
import { createIrcMessageCard } from "../../tools/irc";
import { canonicalizeMessage } from "../../utils/thinking-display";
import { theme } from "../theme/theme";
import { createAdvisorMessageCard } from "./advisor-message";
import { AssistantMessageComponent } from "./assistant-message";
import { createBackgroundTanDispatchBlock } from "./background-tan-message";
import { BashExecutionComponent } from "./bash-execution";
import { detectCacheInvalidation } from "./cache-invalidation-marker";
import { CollabPromptMessageComponent } from "./collab-prompt-message";
import {
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	createHandoffSummaryMessageComponent,
} from "./compaction-summary-message";
import { CustomMessageComponent } from "./custom-message";
import { EvalExecutionComponent } from "./eval-execution";
import { type LateDiagnosticsFile, LateDiagnosticsMessageComponent } from "./late-diagnostics-message";
import { ReadToolGroupComponent, readArgsHaveTarget, readArgsTargetInternalUrl } from "./read-tool-group";
import { SkillMessageComponent } from "./skill-message";
import { ToolExecutionComponent } from "./tool-execution";
import { TranscriptBlock, TranscriptContainer } from "./transcript-container";
import { createUsageRowBlock } from "./usage-row";
import { UserMessageComponent } from "./user-message";

export interface ChatTranscriptBuilderDeps {
	ui: TUI;
	getTool?: (name: string) => AgentTool | undefined;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	cwd: string;
	hideThinkingBlock?: () => boolean;
	requestRender: () => void;
}

/** Extracts the plain-text content of a user message (string or text blocks). */
function userMessageText(message: Extract<AgentMessage, { role: "user" }>): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("");
}

export class ChatTranscriptBuilder {
	readonly container = new TranscriptContainer();
	#pendingTools = new Map<string, ToolExecutionComponent | ReadToolGroupComponent>();
	#readArgs = new Map<string, Record<string, unknown>>();
	#readGroup: ReadToolGroupComponent | null = null;
	#pendingUsage: Usage | undefined;
	#lastAssistantUsage: Usage | undefined;
	#waitingPoll: ToolExecutionComponent | null = null;
	#expandables: Array<{ setExpanded(expanded: boolean): void }> = [];
	#expanded = false;

	constructor(private readonly deps: ChatTranscriptBuilderDeps) {}

	/** Whether the transcript currently holds any rendered rows. */
	get isEmpty(): boolean {
		return this.container.children.length === 0;
	}

	/** Discard all components and rebuild the whole transcript from `entries`. */
	rebuild(entries: SessionMessageEntry[]): void {
		this.reset();
		for (const entry of entries) this.#appendChatMessage(entry.message);
		// Flush the trailing turn's usage row only once its tools are materialized
		// (a read whose result has not arrived stays pending); otherwise the row
		// would sit above its tools. The drain happens here at the end of the pass.
		if (this.#readArgs.size === 0 && this.#pendingTools.size === 0) this.#flushPendingUsage();
	}

	/** Toggle tool-output expansion across every expandable component. */
	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		for (const component of this.#expandables) component.setExpanded(expanded);
	}

	get expanded(): boolean {
		return this.#expanded;
	}

	/** Tear down components (sealing pending spinners) and clear build state. */
	reset(): void {
		for (const pending of this.#pendingTools.values()) pending.seal();
		this.#pendingTools.clear();
		this.#readArgs.clear();
		this.#readGroup = null;
		this.#pendingUsage = undefined;
		this.#lastAssistantUsage = undefined;
		this.#waitingPoll = null;
		this.#expandables = [];
		this.container.dispose();
		this.container.clear();
	}

	dispose(): void {
		this.reset();
	}

	#trackExpandable(component: { setExpanded(expanded: boolean): void }): void {
		component.setExpanded(this.#expanded);
		this.#expandables.push(component);
	}

	/** A `job` poll showing all-running is displaced by the next `job` call. */
	#resolveWaitingPoll(nextToolName?: string): void {
		const previous = this.#waitingPoll;
		if (!previous) return;
		this.#waitingPoll = null;
		if (nextToolName === "job" && previous.isDisplaceableBlock()) {
			this.container.removeChild(previous);
		}
		previous.seal();
	}

	#ensureReadGroup(): ReadToolGroupComponent {
		if (!this.#readGroup) {
			this.#readGroup = new ReadToolGroupComponent({
				showContentPreview: settings.get("read.toolResultPreview"),
			});
			this.#trackExpandable(this.#readGroup);
			this.container.addChild(this.#readGroup);
		}
		return this.#readGroup;
	}

	// The per-turn token-usage row must land below the turn's tool blocks, but
	// normal `read` calls only materialize their group in #appendToolResult. Defer
	// the row: stash it on the assistant message and flush once the turn's tools
	// are placed, sealing the read run so the row sits under it.
	#flushPendingUsage(): void {
		if (!this.#pendingUsage) return;
		this.#readGroup?.seal();
		this.#readGroup = null;
		this.container.addChild(createUsageRowBlock(this.#pendingUsage));
		this.#pendingUsage = undefined;
	}

	#appendChatMessage(message: AgentMessage): void {
		if (message.role !== "toolResult") this.#flushPendingUsage();
		switch (message.role) {
			case "assistant":
				this.#appendAssistantMessage(message);
				break;
			case "toolResult":
				this.#appendToolResult(message);
				break;
			case "user":
			case "developer": {
				// A user prompt closes the poll-displacement window, same as the live path.
				if (message.role === "user") this.#resolveWaitingPoll();
				const textContent = message.role === "user" ? userMessageText(message) : "";
				if (textContent) {
					const isSynthetic = message.role === "developer" ? true : (message.synthetic ?? false);
					this.container.addChild(new UserMessageComponent(textContent, isSynthetic));
				}
				break;
			}
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.deps.ui, message.excludeFromContext);
				if (message.output) component.appendOutput(message.output);
				component.setComplete(message.exitCode, message.cancelled, { truncation: message.meta?.truncation });
				this.container.addChild(component);
				break;
			}
			case "pythonExecution": {
				const component = new EvalExecutionComponent(message.code, this.deps.ui, message.excludeFromContext);
				if (message.output) component.appendOutput(message.output);
				component.setComplete(message.exitCode, message.cancelled, { truncation: message.meta?.truncation });
				this.container.addChild(component);
				break;
			}
			case "hookMessage":
			case "custom":
				this.#appendCustomMessage(message);
				break;
			case "compactionSummary": {
				const component = new CompactionSummaryMessageComponent(message);
				this.#trackExpandable(component);
				this.container.addChild(component);
				break;
			}
			case "branchSummary": {
				const component = new BranchSummaryMessageComponent(message);
				this.#trackExpandable(component);
				this.container.addChild(component);
				break;
			}
			case "fileMention": {
				const block = new TranscriptBlock();
				for (const file of message.files) {
					let suffix: string;
					if (file.skippedReason === "tooLarge") {
						const size = typeof file.byteSize === "number" ? formatBytes(file.byteSize) : "unknown size";
						suffix = `(skipped: ${size})`;
					} else {
						suffix = file.image
							? "(image)"
							: file.lineCount === undefined
								? "(unknown lines)"
								: `(${file.lineCount} lines)`;
					}
					const text = `${theme.fg("dim", `${theme.tree.last} `)}${theme.fg("muted", "Read")} ${theme.fg(
						"accent",
						file.path,
					)} ${theme.fg("dim", suffix)}`;
					// Indent one column to match the transcript's other rows (the viewer renders
					// body rows without an outer gutter; rows own their left pad).
					block.addChild(new Text(text, 1, 0));
				}
				if (block.children.length > 0) this.container.addChild(block);
				break;
			}
			default:
				message satisfies never;
		}
	}

	#appendAssistantMessage(message: Extract<AgentMessage, { role: "assistant" }>): void {
		const assistantComponent = new AssistantMessageComponent(message, this.deps.hideThinkingBlock?.() ?? false, () =>
			this.deps.requestRender(),
		);
		this.container.addChild(assistantComponent);

		if (settings.get("display.cacheMissMarker")) {
			const invalidation = detectCacheInvalidation(this.#lastAssistantUsage, message.usage);
			if (invalidation) assistantComponent.setCacheInvalidation(invalidation);
		}
		if (message.usage.cacheRead + message.usage.cacheWrite + message.usage.input > 0) {
			this.#lastAssistantUsage = message.usage;
		}

		const hasVisibleAssistantContent = message.content.some(
			content =>
				(content.type === "text" && canonicalizeMessage(content.text)) ||
				(content.type === "thinking" && canonicalizeMessage(content.thinking)),
		);
		if (hasVisibleAssistantContent) {
			// New visible turn content closes the current read run (mirrors rebuild).
			this.#readGroup?.seal();
			this.#readGroup = null;
		}

		const isAbortedSilently = message.stopReason === "aborted" && isSilentAbort(message.errorMessage);
		const hasErrorStop = !isAbortedSilently && (message.stopReason === "aborted" || message.stopReason === "error");
		const errorMessage = hasErrorStop
			? message.stopReason === "aborted"
				? resolveAbortLabel(message.errorMessage)
				: message.errorMessage || "Error"
			: null;

		for (const content of message.content) {
			if (content.type !== "toolCall") continue;
			this.#resolveWaitingPoll(content.name);

			if (
				content.name === "read" &&
				readArgsHaveTarget(content.arguments) &&
				!readArgsTargetInternalUrl(content.arguments)
			) {
				if (hasErrorStop && errorMessage) {
					const group = this.#ensureReadGroup();
					group.updateArgs(content.arguments, content.id);
					group.updateResult(
						{ content: [{ type: "text", text: errorMessage }], isError: true },
						false,
						content.id,
					);
				} else {
					const normalizedArgs =
						content.arguments && typeof content.arguments === "object" && !Array.isArray(content.arguments)
							? (content.arguments as Record<string, unknown>)
							: {};
					this.#readArgs.set(content.id, normalizedArgs);
				}
				continue;
			}

			this.#readGroup?.seal();
			this.#readGroup = null;
			const component = new ToolExecutionComponent(
				content.name,
				content.arguments,
				{
					// Images can't be sliced through the scroll viewport; keep them off.
					showImages: false,
					editFuzzyThreshold: settings.get("edit.fuzzyThreshold"),
					editAllowFuzzy: settings.get("edit.fuzzyMatch"),
					liveRegion: this.container,
				},
				this.deps.getTool?.(content.name),
				this.deps.ui,
				this.deps.cwd,
				content.id,
			);
			this.#trackExpandable(component);
			this.container.addChild(component);

			if (hasErrorStop && errorMessage) {
				component.updateResult(
					{ content: [{ type: "text", text: errorMessage }], isError: true },
					false,
					content.id,
				);
			} else {
				this.#pendingTools.set(content.id, component);
			}
		}

		this.#pendingUsage = settings.get("display.showTokenUsage") ? message.usage : undefined;
	}

	#appendToolResult(message: Extract<AgentMessage, { role: "toolResult" }>): void {
		const pending = this.#pendingTools.get(message.toolCallId);
		const isReadGroupResult = message.toolName === "read" && (!pending || pending instanceof ReadToolGroupComponent);
		if (isReadGroupResult) {
			let component = pending;
			if (!component) {
				const group = this.#ensureReadGroup();
				const args = this.#readArgs.get(message.toolCallId);
				if (args) group.updateArgs(args, message.toolCallId);
				component = group;
			}
			component.updateResult(message, false, message.toolCallId);
			this.#pendingTools.delete(message.toolCallId);
			this.#readArgs.delete(message.toolCallId);
			return;
		}
		if (!pending) return;
		pending.updateResult(message, false, message.toolCallId);
		this.#pendingTools.delete(message.toolCallId);
		if (message.toolName === "job" && pending instanceof ToolExecutionComponent && pending.isDisplaceableBlock()) {
			this.#waitingPoll = pending;
		}
	}

	#appendCustomMessage(message: Extract<AgentMessage, { role: "custom" | "hookMessage" }>): void {
		if (!message.display) return;
		if (message.customType === "async-result") {
			const details = (
				message as CustomMessage<{
					jobId?: string;
					type?: "bash" | "task";
					label?: string;
					durationMs?: number;
					jobs?: Array<{ jobId?: string; type?: "bash" | "task"; label?: string; durationMs?: number }>;
				}>
			).details;
			const jobs =
				details?.jobs && details.jobs.length > 0
					? details.jobs
					: [
							{
								jobId: details?.jobId,
								type: details?.type,
								label: details?.label,
								durationMs: details?.durationMs,
							},
						];
			const block = new TranscriptBlock();
			for (const job of jobs) {
				const jobId = job.jobId ?? "unknown";
				const typeLabel = job.type ? `[${job.type}]` : "[job]";
				const duration = typeof job.durationMs === "number" ? formatDuration(job.durationMs) : undefined;
				const line = [
					theme.fg("success", `${theme.status.done} Background job completed`),
					theme.fg("dim", typeLabel),
					theme.fg("accent", jobId),
					duration ? theme.fg("dim", `(${duration})`) : undefined,
				]
					.filter(Boolean)
					.join(" ");
				block.addChild(new Text(line, 1, 0));
			}
			this.container.addChild(block);
			return;
		}
		if (message.customType === LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE) {
			const details = (message as CustomMessage<{ files?: LateDiagnosticsFile[] }>).details;
			const component = new LateDiagnosticsMessageComponent(details?.files ?? []);
			this.#trackExpandable(component);
			this.container.addChild(component);
			return;
		}
		if (message.customType === COLLAB_PROMPT_MESSAGE_TYPE) {
			this.container.addChild(new CollabPromptMessageComponent(message as CustomMessage<CollabPromptDetails>));
			return;
		}
		if (message.customType === SKILL_PROMPT_MESSAGE_TYPE) {
			const component = new SkillMessageComponent(message as CustomMessage<SkillPromptDetails>);
			this.#trackExpandable(component);
			this.container.addChild(component);
			return;
		}
		if (
			message.customType === "irc:incoming" ||
			message.customType === "irc:autoreply" ||
			message.customType === "irc:relay"
		) {
			const details = (
				message as CustomMessage<{ from?: string; to?: string; message?: string; body?: string; replyTo?: string }>
			).details;
			const kind =
				message.customType === "irc:incoming"
					? ("incoming" as const)
					: message.customType === "irc:autoreply"
						? ("autoreply" as const)
						: ("relay" as const);
			const card = createIrcMessageCard(
				{
					kind,
					from: details?.from,
					to: details?.to,
					body: kind === "incoming" ? details?.message : details?.body,
					replyTo: details?.replyTo,
					timestamp: message.timestamp,
				},
				() => this.#expanded,
				theme,
			);
			this.container.addChild(card);
			return;
		}
		if (message.customType === "advisor") {
			const details = (message as CustomMessage<AdvisorMessageDetails>).details;
			this.container.addChild(createAdvisorMessageCard(details, () => this.#expanded, theme));
			return;
		}
		if (message.customType === BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE) {
			this.container.addChild(createBackgroundTanDispatchBlock(message as CustomMessage<unknown>));
			return;
		}
		const handoffComponent = createHandoffSummaryMessageComponent(message as CustomMessage<unknown>, this.#expanded);
		if (handoffComponent) {
			this.#trackExpandable(handoffComponent);
			this.container.addChild(handoffComponent);
			return;
		}
		const component = new CustomMessageComponent(
			message as CustomMessage<unknown>,
			this.deps.getMessageRenderer?.(message.customType),
		);
		this.#trackExpandable(component);
		this.container.addChild(component);
	}
}

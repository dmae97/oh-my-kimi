import { INTENT_FIELD } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import { Loader, TERMINAL, Text } from "@oh-my-pi/pi-tui";
import { settings } from "../../config/settings";
import { AssistantMessageComponent } from "../../modes/components/assistant-message";
import { ReadToolGroupComponent } from "../../modes/components/read-tool-group";
import { TodoReminderComponent } from "../../modes/components/todo-reminder";
import { ToolExecutionComponent } from "../../modes/components/tool-execution";
import { TtsrNotificationComponent } from "../../modes/components/ttsr-notification";
import { getSymbolTheme, theme } from "../../modes/theme/theme";
import type { InteractiveModeContext, TodoPhase } from "../../modes/types";
import type { AgentSessionEvent } from "../../session/agent-session";
import { calculatePromptTokens } from "../../session/compaction/compaction";
import type { ExitPlanModeDetails } from "../../tools";

type AgentSessionEventKind = AgentSessionEvent["type"];

type AgentSessionEventHandlers = {
	[E in AgentSessionEventKind]: (event: Extract<AgentSessionEvent, { type: E }>) => Promise<void>;
};

export class EventController {
	#lastReadGroup: ReadToolGroupComponent | undefined = undefined;
	#lastThinkingCount = 0;
	#renderedCustomMessages = new Set<string>();
	#lastIntent: string | undefined = undefined;
	#backgroundToolCallIds = new Set<string>();
	#readToolCallArgs = new Map<string, Record<string, unknown>>();
	#readToolCallAssistantComponents = new Map<string, AssistantMessageComponent>();
	#lastAssistantComponent: AssistantMessageComponent | undefined = undefined;
	#idleCompactionTimer?: NodeJS.Timeout;
	#handlers: AgentSessionEventHandlers;

	constructor(private ctx: InteractiveModeContext) {
		this.#handlers = {
			agent_start: e => this.#handleAgentStart(e),
			agent_end: e => this.#handleAgentEnd(e),
			turn_start: async () => {},
			turn_end: async () => {},
			message_start: e => this.#handleMessageStart(e),
			message_update: e => this.#handleMessageUpdate(e),
			message_end: e => this.#handleMessageEnd(e),
			tool_execution_start: e => this.#handleToolExecutionStart(e),
			tool_execution_update: e => this.#handleToolExecutionUpdate(e),
			tool_execution_end: e => this.#handleToolExecutionEnd(e),
			auto_compaction_start: e => this.#handleAutoCompactionStart(e),
			auto_compaction_end: e => this.#handleAutoCompactionEnd(e),
			auto_retry_start: e => this.#handleAutoRetryStart(e),
			auto_retry_end: e => this.#handleAutoRetryEnd(e),
			retry_fallback_applied: e => this.#handleRetryFallbackApplied(e),
			retry_fallback_succeeded: e => this.#handleRetryFallbackSucceeded(e),
			ttsr_triggered: e => this.#handleTtsrTriggered(e),
			todo_reminder: e => this.#handleTodoReminder(e),
			todo_auto_clear: e => this.#handleTodoAutoClear(e),
			irc_message: e => this.#handleIrcMessage(e),
		} satisfies AgentSessionEventHandlers;
	}

	dispose(): void {
		this.#cancelIdleCompaction();
	}

	#resetReadGroup(): void {
		this.#lastReadGroup = undefined;
	}

	#getReadGroup(): ReadToolGroupComponent {
		if (!this.#lastReadGroup) {
			this.ctx.chatContainer.addChild(new Text("", 0, 0));
			const group = new ReadToolGroupComponent({
				showContentPreview: this.ctx.settings.get("read.toolResultPreview"),
			});
			group.setExpanded(this.ctx.toolOutputExpanded);
			this.ctx.chatContainer.addChild(group);
			this.#lastReadGroup = group;
		}
		return this.#lastReadGroup;
	}

	#trackReadToolCall(toolCallId: string, args: unknown): void {
		if (!toolCallId) return;
		const normalizedArgs =
			args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
		this.#readToolCallArgs.set(toolCallId, normalizedArgs);
		const assistantComponent = this.ctx.streamingComponent ?? this.#lastAssistantComponent;
		if (assistantComponent) {
			this.#readToolCallAssistantComponents.set(toolCallId, assistantComponent);
		}
	}

	#clearReadToolCall(toolCallId: string): void {
		this.#readToolCallArgs.delete(toolCallId);
		this.#readToolCallAssistantComponents.delete(toolCallId);
	}

	#inlineReadToolImages(
		toolCallId: string,
		result: { content: Array<{ type: string; data?: string; mimeType?: string }> },
	): boolean {
		if (!settings.get("terminal.showImages")) return false;
		const assistantComponent = this.#readToolCallAssistantComponents.get(toolCallId);
		if (!assistantComponent) return false;
		const images: ImageContent[] = result.content
			.filter(
				(content): content is ImageContent =>
					content.type === "image" && typeof content.data === "string" && typeof content.mimeType === "string",
			)
			.map(content => ({ type: "image", data: content.data, mimeType: content.mimeType }));
		if (images.length === 0) return false;
		assistantComponent.setToolResultImages(toolCallId, images);
		return true;
	}
	#updateWorkingMessageFromIntent(intent: string | undefined): void {
		const trimmed = intent?.trim();
		if (!trimmed || trimmed === this.#lastIntent) return;
		this.#lastIntent = trimmed;
		this.ctx.setWorkingMessage(`${trimmed} (esc to interrupt)`);
	}

	subscribeToAgent(): void {
		this.ctx.unsubscribe = this.ctx.session.subscribe(async (event: AgentSessionEvent) => {
			await this.handleEvent(event);
		});
	}

	async handleEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.ctx.isInitialized) {
			await this.ctx.init();
		}

		this.ctx.statusLine.invalidate();
		this.ctx.updateEditorTopBorder();

		const run = this.#handlers[event.type] as (e: AgentSessionEvent) => Promise<void>;
		await run(event);
	}

	async #handleAgentStart(_event: Extract<AgentSessionEvent, { type: "agent_start" }>): Promise<void> {
		this.#lastIntent = undefined;
		this.#readToolCallArgs.clear();
		this.#readToolCallAssistantComponents.clear();
		this.#lastAssistantComponent = undefined;
		if (this.ctx.retryEscapeHandler) {
			this.ctx.editor.onEscape = this.ctx.retryEscapeHandler;
			this.ctx.retryEscapeHandler = undefined;
		}
		if (this.ctx.retryLoader) {
			this.ctx.retryLoader.stop();
			this.ctx.retryLoader = undefined;
			this.ctx.statusContainer.clear();
		}
		this.#cancelIdleCompaction();
		this.ctx.ensureLoadingAnimation();
		this.ctx.ui.requestRender();
	}

	async #handleMessageStart(event: Extract<AgentSessionEvent, { type: "message_start" }>): Promise<void> {
		if (event.message.role === "hookMessage" || event.message.role === "custom") {
			const signature = `${event.message.role}:${event.message.customType}:${event.message.timestamp}`;
			if (this.#renderedCustomMessages.has(signature)) {
				return;
			}
			this.#renderedCustomMessages.add(signature);
			this.#resetReadGroup();
			this.ctx.addMessageToChat(event.message);
			this.ctx.ui.requestRender();
		} else if (event.message.role === "user") {
			const textContent = this.ctx.getUserMessageText(event.message);
			const imageCount =
				typeof event.message.content === "string"
					? 0
					: event.message.content.filter(content => content.type === "image").length;
			const signature = `${textContent}\u0000${imageCount}`;

			this.#resetReadGroup();
			const wasOptimistic = this.ctx.optimisticUserMessageSignature === signature;
			if (!wasOptimistic) {
				this.ctx.addMessageToChat(event.message);
			}
			this.ctx.optimisticUserMessageSignature = undefined;

			// Clear the editor only when the submission did not originate from this
			// session's optimistic flow (which already cleared the editor at submit
			// time). Clearing here on the optimistic path would race with the user
			// typing the next prompt while the previous large redraw lands and erase
			// their in-progress draft (#783).
			if (!event.message.synthetic && !wasOptimistic) {
				this.ctx.editor.setText("");
				this.ctx.updatePendingMessagesDisplay();
			}
			this.ctx.ui.requestRender();
		} else if (event.message.role === "fileMention") {
			this.#resetReadGroup();
			this.ctx.addMessageToChat(event.message);
			this.ctx.ui.requestRender();
		} else if (event.message.role === "assistant") {
			this.#lastThinkingCount = 0;
			this.#resetReadGroup();
			this.ctx.streamingComponent = new AssistantMessageComponent(undefined, this.ctx.hideThinkingBlock);
			this.ctx.streamingMessage = event.message;
			this.ctx.chatContainer.addChild(this.ctx.streamingComponent);
			this.ctx.streamingComponent.updateContent(this.ctx.streamingMessage);
			this.ctx.ui.requestRender();
		}
	}

	async #handleIrcMessage(event: Extract<AgentSessionEvent, { type: "irc_message" }>): Promise<void> {
		const signature = `${event.message.role}:${event.message.customType}:${event.message.timestamp}`;
		if (this.#renderedCustomMessages.has(signature)) {
			return;
		}
		this.#renderedCustomMessages.add(signature);
		this.#resetReadGroup();
		this.ctx.addMessageToChat(event.message);
		this.ctx.ui.requestRender();
	}

	async #handleMessageUpdate(event: Extract<AgentSessionEvent, { type: "message_update" }>): Promise<void> {
		if (this.ctx.streamingComponent && event.message.role === "assistant") {
			this.ctx.streamingMessage = event.message;
			this.ctx.streamingComponent.updateContent(this.ctx.streamingMessage);

			const thinkingCount = this.ctx.streamingMessage.content.filter(
				content => content.type === "thinking" && content.thinking.trim(),
			).length;
			if (thinkingCount > this.#lastThinkingCount) {
				this.#resetReadGroup();
				this.#lastThinkingCount = thinkingCount;
			}

			for (const content of this.ctx.streamingMessage.content) {
				if (content.type !== "toolCall") continue;
				if (content.name === "read") {
					this.#trackReadToolCall(content.id, content.arguments);
					const component = this.ctx.pendingTools.get(content.id);
					if (component) {
						component.updateArgs(content.arguments, content.id);
					} else {
						const group = this.#getReadGroup();
						group.updateArgs(content.arguments, content.id);
						this.ctx.pendingTools.set(content.id, group);
					}
					continue;
				}

				// Preserve the raw partial JSON for renderers that need to surface fields before the JSON object closes.
				// Bash uses this to show inline env assignments during streaming instead of popping them in at completion.
				const renderArgs =
					"partialJson" in content
						? { ...content.arguments, __partialJson: content.partialJson }
						: content.arguments;
				if (!this.ctx.pendingTools.has(content.id)) {
					this.#resetReadGroup();
					this.ctx.chatContainer.addChild(new Text("", 0, 0));
					const tool = this.ctx.session.getToolByName(content.name);
					const component = new ToolExecutionComponent(
						content.name,
						renderArgs,
						{
							showImages: settings.get("terminal.showImages"),
							editFuzzyThreshold: settings.get("edit.fuzzyThreshold"),
							editAllowFuzzy: settings.get("edit.fuzzyMatch"),
						},
						tool,
						this.ctx.ui,
						this.ctx.sessionManager.getCwd(),
						content.id,
					);
					component.setExpanded(this.ctx.toolOutputExpanded);
					this.ctx.chatContainer.addChild(component);
					this.ctx.pendingTools.set(content.id, component);
				} else {
					const component = this.ctx.pendingTools.get(content.id);
					if (component) {
						component.updateArgs(renderArgs, content.id);
					}
				}
			}

			// Update working message with intent from streamed tool arguments
			for (const content of this.ctx.streamingMessage.content) {
				if (content.type !== "toolCall") continue;
				const args = content.arguments;
				if (!args || typeof args !== "object") continue;
				if (INTENT_FIELD in args) {
					this.#updateWorkingMessageFromIntent(args[INTENT_FIELD] as string | undefined);
					continue;
				}
				const tool = this.ctx.session.getToolByName(content.name);
				if (typeof tool?.intent !== "function") continue;
				try {
					const derived = tool.intent(args as never)?.trim();
					if (derived) {
						this.#updateWorkingMessageFromIntent(derived);
					}
				} catch {
					// intent function must never break the UI
				}
			}

			this.ctx.ui.requestRender();
		}
	}

	async #handleMessageEnd(event: Extract<AgentSessionEvent, { type: "message_end" }>): Promise<void> {
		if (event.message.role === "user") return;
		if (this.ctx.streamingComponent && event.message.role === "assistant") {
			this.ctx.streamingMessage = event.message;
			let errorMessage: string | undefined;
			if (this.ctx.streamingMessage.stopReason === "aborted" && !this.ctx.session.isTtsrAbortPending) {
				const retryAttempt = this.ctx.session.retryAttempt;
				errorMessage =
					retryAttempt > 0
						? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
						: "Operation aborted";
				this.ctx.streamingMessage.errorMessage = errorMessage;
			}
			if (this.ctx.session.isTtsrAbortPending && this.ctx.streamingMessage.stopReason === "aborted") {
				const msgWithoutAbort = { ...this.ctx.streamingMessage, stopReason: "stop" as const };
				this.ctx.streamingComponent.updateContent(msgWithoutAbort);
			} else {
				this.ctx.streamingComponent.updateContent(this.ctx.streamingMessage);
			}

			if (this.ctx.streamingMessage.stopReason !== "aborted" && this.ctx.streamingMessage.stopReason !== "error") {
				for (const [toolCallId, component] of this.ctx.pendingTools.entries()) {
					component.setArgsComplete(toolCallId);
				}
			}
			this.#lastAssistantComponent = this.ctx.streamingComponent;
			this.#lastAssistantComponent.setUsageInfo(event.message.usage);
			this.ctx.streamingComponent = undefined;
			this.ctx.streamingMessage = undefined;
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorTopBorder();
		}
		this.ctx.ui.requestRender();
	}

	async #handleToolExecutionStart(event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>): Promise<void> {
		this.#updateWorkingMessageFromIntent(event.intent);
		if (!this.ctx.pendingTools.has(event.toolCallId)) {
			if (event.toolName === "read") {
				this.#trackReadToolCall(event.toolCallId, event.args);
				const component = this.ctx.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateArgs(event.args, event.toolCallId);
				} else {
					const group = this.#getReadGroup();
					group.updateArgs(event.args, event.toolCallId);
					this.ctx.pendingTools.set(event.toolCallId, group);
				}
				this.ctx.ui.requestRender();
				return;
			}

			this.#resetReadGroup();
			const tool = this.ctx.session.getToolByName(event.toolName);
			const component = new ToolExecutionComponent(
				event.toolName,
				event.args,
				{
					showImages: settings.get("terminal.showImages"),
					editFuzzyThreshold: settings.get("edit.fuzzyThreshold"),
					editAllowFuzzy: settings.get("edit.fuzzyMatch"),
				},
				tool,
				this.ctx.ui,
				this.ctx.sessionManager.getCwd(),
				event.toolCallId,
			);
			component.setExpanded(this.ctx.toolOutputExpanded);
			this.ctx.chatContainer.addChild(component);
			this.ctx.pendingTools.set(event.toolCallId, component);
			this.ctx.ui.requestRender();
		}
	}

	async #handleToolExecutionUpdate(
		event: Extract<AgentSessionEvent, { type: "tool_execution_update" }>,
	): Promise<void> {
		const component = this.ctx.pendingTools.get(event.toolCallId);
		if (component) {
			const asyncState = (event.partialResult.details as { async?: { state?: string } } | undefined)?.async?.state;
			const isFinalAsyncState = asyncState === "completed" || asyncState === "failed";
			component.updateResult(
				{ ...event.partialResult, isError: asyncState === "failed" },
				!isFinalAsyncState,
				event.toolCallId,
			);
			if (isFinalAsyncState) {
				this.ctx.pendingTools.delete(event.toolCallId);
				this.#backgroundToolCallIds.delete(event.toolCallId);
			}
			this.ctx.ui.requestRender();
		}
	}

	async #handleToolExecutionEnd(event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): Promise<void> {
		if (event.toolName === "read") {
			if (this.#inlineReadToolImages(event.toolCallId, event.result)) {
				const component = this.ctx.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError }, false, event.toolCallId);
					this.ctx.pendingTools.delete(event.toolCallId);
				}
				const asyncState = (event.result.details as { async?: { state?: string } } | undefined)?.async?.state;
				if (asyncState === "running") {
					this.#backgroundToolCallIds.add(event.toolCallId);
				} else {
					this.#backgroundToolCallIds.delete(event.toolCallId);
					this.#clearReadToolCall(event.toolCallId);
				}
				this.ctx.ui.requestRender();
			} else {
				let component = this.ctx.pendingTools.get(event.toolCallId);
				if (!component) {
					const group = this.#getReadGroup();
					const args = this.#readToolCallArgs.get(event.toolCallId);
					if (args) {
						group.updateArgs(args, event.toolCallId);
					}
					component = group;
					this.ctx.pendingTools.set(event.toolCallId, group);
				}
				const asyncState = (event.result.details as { async?: { state?: string } } | undefined)?.async?.state;
				const isBackgroundRunning = asyncState === "running";
				component.updateResult({ ...event.result, isError: event.isError }, isBackgroundRunning, event.toolCallId);
				if (isBackgroundRunning) {
					this.#backgroundToolCallIds.add(event.toolCallId);
				} else {
					this.ctx.pendingTools.delete(event.toolCallId);
					this.#backgroundToolCallIds.delete(event.toolCallId);
					this.#clearReadToolCall(event.toolCallId);
				}
				this.ctx.ui.requestRender();
			}
		} else {
			const component = this.ctx.pendingTools.get(event.toolCallId);
			if (component) {
				const asyncState = (event.result.details as { async?: { state?: string } } | undefined)?.async?.state;
				const isBackgroundRunning = asyncState === "running";
				component.updateResult({ ...event.result, isError: event.isError }, isBackgroundRunning, event.toolCallId);
				if (isBackgroundRunning) {
					this.#backgroundToolCallIds.add(event.toolCallId);
				} else {
					this.ctx.pendingTools.delete(event.toolCallId);
					this.#backgroundToolCallIds.delete(event.toolCallId);
				}
				this.ctx.ui.requestRender();
			}
		}
		// Update todo display when todo_write tool completes
		if (event.toolName === "todo_write" && !event.isError) {
			const details = event.result.details as { phases?: TodoPhase[] } | undefined;
			if (details?.phases) {
				this.ctx.setTodos(details.phases);
			}
		} else if (event.toolName === "todo_write" && event.isError) {
			const textContent = event.result.content.find(
				(content: { type: string; text?: string }) => content.type === "text",
			)?.text;
			this.ctx.showWarning(
				`Todo update failed${textContent ? `: ${textContent}` : ". Progress may be stale until todo_write succeeds."}`,
			);
		}
		if (event.toolName === "exit_plan_mode" && !event.isError) {
			const details = event.result.details as ExitPlanModeDetails | undefined;
			if (details) {
				await this.ctx.handleExitPlanModeTool(details);
			}
		}
	}

	async #handleAgentEnd(_event: Extract<AgentSessionEvent, { type: "agent_end" }>): Promise<void> {
		if (this.ctx.loadingAnimation) {
			this.ctx.loadingAnimation.stop();
			this.ctx.loadingAnimation = undefined;
			this.ctx.statusContainer.clear();
		}
		if (this.ctx.streamingComponent) {
			this.ctx.chatContainer.removeChild(this.ctx.streamingComponent);
			this.ctx.streamingComponent = undefined;
			this.ctx.streamingMessage = undefined;
		}
		await this.ctx.flushPendingModelSwitch();
		for (const toolCallId of Array.from(this.ctx.pendingTools.keys())) {
			if (!this.#backgroundToolCallIds.has(toolCallId)) {
				this.ctx.pendingTools.delete(toolCallId);
			}
		}
		this.#backgroundToolCallIds = new Set(
			Array.from(this.#backgroundToolCallIds).filter(toolCallId => this.ctx.pendingTools.has(toolCallId)),
		);
		this.#readToolCallArgs.clear();
		this.#readToolCallAssistantComponents.clear();
		this.#lastAssistantComponent = undefined;
		this.ctx.ui.requestRender();
		this.#scheduleIdleCompaction();
		this.sendCompletionNotification();
	}

	async #handleAutoCompactionStart(
		event: Extract<AgentSessionEvent, { type: "auto_compaction_start" }>,
	): Promise<void> {
		this.#cancelIdleCompaction();
		this.ctx.autoCompactionEscapeHandler = this.ctx.editor.onEscape;
		this.ctx.editor.onEscape = () => {
			this.ctx.session.abortCompaction();
		};
		this.ctx.statusContainer.clear();
		const reasonText =
			event.reason === "overflow" ? "Context overflow detected, " : event.reason === "idle" ? "Idle " : "";
		const actionLabel = event.action === "handoff" ? "Auto-handoff" : "Auto context-full maintenance";
		this.ctx.autoCompactionLoader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("accent", spinner),
			text => theme.fg("muted", text),
			`${reasonText}${actionLabel}… (esc to cancel)`,
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(this.ctx.autoCompactionLoader);
		this.ctx.ui.requestRender();
	}

	async #handleAutoCompactionEnd(event: Extract<AgentSessionEvent, { type: "auto_compaction_end" }>): Promise<void> {
		this.#cancelIdleCompaction();
		if (this.ctx.autoCompactionEscapeHandler) {
			this.ctx.editor.onEscape = this.ctx.autoCompactionEscapeHandler;
			this.ctx.autoCompactionEscapeHandler = undefined;
		}
		if (this.ctx.autoCompactionLoader) {
			this.ctx.autoCompactionLoader.stop();
			this.ctx.autoCompactionLoader = undefined;
			this.ctx.statusContainer.clear();
		}
		const isHandoffAction = event.action === "handoff";
		if (event.aborted) {
			this.ctx.showStatus(isHandoffAction ? "Auto-handoff cancelled" : "Auto context-full maintenance cancelled");
		} else if (event.result) {
			this.ctx.rebuildChatFromMessages();
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorTopBorder();
		} else if (event.errorMessage) {
			this.ctx.showWarning(event.errorMessage);
		} else if (isHandoffAction) {
			this.ctx.chatContainer.clear();
			this.ctx.rebuildChatFromMessages();
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorTopBorder();
			await this.ctx.reloadTodos();
			this.ctx.showStatus("Auto-handoff completed");
		} else if (event.skipped) {
			// Benign skip: no model selected, no candidate models available, or nothing
			// to compact yet. Not a failure — suppress the warning.
		} else {
			this.ctx.showWarning("Auto context-full maintenance failed; continuing without maintenance");
		}
		await this.ctx.flushCompactionQueue({ willRetry: event.willRetry });
		this.ctx.ui.requestRender();
	}

	async #handleAutoRetryStart(event: Extract<AgentSessionEvent, { type: "auto_retry_start" }>): Promise<void> {
		this.ctx.retryEscapeHandler = this.ctx.editor.onEscape;
		this.ctx.editor.onEscape = () => {
			this.ctx.session.abortRetry();
		};
		this.ctx.statusContainer.clear();
		const delaySeconds = Math.round(event.delayMs / 1000);
		this.ctx.retryLoader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("warning", spinner),
			text => theme.fg("muted", text),
			`Retrying (${event.attempt}/${event.maxAttempts}) in ${delaySeconds}s… (esc to cancel)`,
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(this.ctx.retryLoader);
		this.ctx.ui.requestRender();
	}

	async #handleAutoRetryEnd(event: Extract<AgentSessionEvent, { type: "auto_retry_end" }>): Promise<void> {
		if (this.ctx.retryEscapeHandler) {
			this.ctx.editor.onEscape = this.ctx.retryEscapeHandler;
			this.ctx.retryEscapeHandler = undefined;
		}
		if (this.ctx.retryLoader) {
			this.ctx.retryLoader.stop();
			this.ctx.retryLoader = undefined;
			this.ctx.statusContainer.clear();
		}
		if (!event.success) {
			this.ctx.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
		}
		this.ctx.ui.requestRender();
	}

	async #handleRetryFallbackApplied(
		event: Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>,
	): Promise<void> {
		this.ctx.showWarning(`Fallback: ${event.from} -> ${event.to}`);
	}

	async #handleRetryFallbackSucceeded(
		event: Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>,
	): Promise<void> {
		this.ctx.showStatus(`Fallback succeeded on ${event.model}`);
	}

	async #handleTtsrTriggered(event: Extract<AgentSessionEvent, { type: "ttsr_triggered" }>): Promise<void> {
		const component = new TtsrNotificationComponent(event.rules);
		component.setExpanded(this.ctx.toolOutputExpanded);
		this.ctx.chatContainer.addChild(component);
		this.ctx.ui.requestRender();
	}

	async #handleTodoReminder(event: Extract<AgentSessionEvent, { type: "todo_reminder" }>): Promise<void> {
		const component = new TodoReminderComponent(event.todos, event.attempt, event.maxAttempts);
		this.ctx.chatContainer.addChild(component);
		this.ctx.ui.requestRender();
	}

	async #handleTodoAutoClear(_event: Extract<AgentSessionEvent, { type: "todo_auto_clear" }>): Promise<void> {
		await this.ctx.reloadTodos();
	}

	#cancelIdleCompaction(): void {
		if (this.#idleCompactionTimer) {
			clearTimeout(this.#idleCompactionTimer);
			this.#idleCompactionTimer = undefined;
		}
	}

	#scheduleIdleCompaction(): void {
		this.#cancelIdleCompaction();
		// Don't schedule while compaction/handoff is already running — the agent_end from a
		// handoff agent turn still has the old session's bloated token counts, and scheduling
		// here would fire after the session resets, trying to handoff an empty session.
		if (this.ctx.session.isCompacting) return;

		const idleSettings = settings.getGroup("compaction");
		if (!idleSettings.idleEnabled) return;

		// Only if input is empty
		if (this.ctx.editor.getText().trim()) return;

		const threshold = idleSettings.idleThresholdTokens;
		if (threshold <= 0) return;
		if (this.#currentContextTokens() < threshold) return;

		const timeoutMs = Math.max(60, Math.min(3600, idleSettings.idleTimeoutSeconds)) * 1000;
		this.#idleCompactionTimer = setTimeout(() => {
			this.#idleCompactionTimer = undefined;
			// Re-check conditions before firing. Pruning may have run between arming
			// the timer and now, dropping usage back below the idle threshold.
			if (this.ctx.session.isStreaming) return;
			if (this.ctx.session.isCompacting) return;
			if (this.ctx.editor.getText().trim()) return;
			if (this.#currentContextTokens() < threshold) return;
			void this.ctx.session.runIdleCompaction();
		}, timeoutMs);
		this.#idleCompactionTimer.unref?.();
	}

	#currentContextTokens(): number {
		const lastAssistant = this.ctx.session.agent.state.messages
			.slice()
			.reverse()
			.find((m): m is AssistantMessage => m.role === "assistant" && m.stopReason !== "aborted");
		return lastAssistant?.usage ? calculatePromptTokens(lastAssistant.usage) : 0;
	}

	sendCompletionNotification(): void {
		if (this.ctx.isBackgrounded === false) return;
		const notify = settings.get("completion.notify");
		if (notify === "off") return;
		const title =
			this.ctx.sessionManager.titleSource === "auto" ? undefined : this.ctx.sessionManager.getSessionName();
		const message = title ? `${title}: Complete` : "Complete";
		TERMINAL.sendNotification(message);
	}

	async handleBackgroundEvent(event: AgentSessionEvent): Promise<void> {
		if (event.type !== "agent_end") {
			return;
		}
		if (this.ctx.session.queuedMessageCount > 0 || this.ctx.session.isStreaming) {
			return;
		}
		this.sendCompletionNotification();
		await this.ctx.shutdown();
	}
}

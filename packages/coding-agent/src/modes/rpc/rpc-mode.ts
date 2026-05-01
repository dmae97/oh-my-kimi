/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */
import { $env, readJsonl, Snowflake } from "@oh-my-pi/pi-utils";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
} from "../../extensibility/extensions";
import { runExtensionCompact, runExtensionSetModel } from "../../extensibility/extensions/compact-handler";
import { type Theme, theme } from "../../modes/theme/theme";
import type { AgentSession } from "../../session/agent-session";
import { isRpcHostToolResult, isRpcHostToolUpdate, RpcHostToolBridge } from "./host-tools";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcResponse,
	RpcSessionState,
} from "./rpc-types";

// Re-export types for consumers
export type * from "./rpc-types";

export type PendingExtensionRequest = {
	resolve: (response: RpcExtensionUIResponse) => void;
	reject: (error: Error) => void;
};

type RpcOutput = (
	obj: RpcResponse | RpcExtensionUIRequest | RpcHostToolCallRequest | RpcHostToolCancelRequest | object,
) => void;

function normalizeHostToolDefinitions(tools: RpcHostToolDefinition[]): RpcHostToolDefinition[] {
	return tools.map((tool, index) => {
		const name = typeof tool.name === "string" ? tool.name.trim() : "";
		if (!name) {
			throw new Error(`Host tool at index ${index} must provide a non-empty name`);
		}
		const description = typeof tool.description === "string" ? tool.description.trim() : "";
		if (!description) {
			throw new Error(`Host tool "${name}" must provide a non-empty description`);
		}
		if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
			throw new Error(`Host tool "${name}" must provide a JSON Schema object`);
		}
		const label = typeof tool.label === "string" && tool.label.trim() ? tool.label.trim() : name;
		return {
			name,
			label,
			description,
			parameters: tool.parameters,
			hidden: tool.hidden === true,
		};
	});
}

function parseValueDialogResponse(
	response: RpcExtensionUIResponse,
	dialogOptions: ExtensionUIDialogOptions | undefined,
): string | undefined {
	if ("cancelled" in response && response.cancelled) {
		if (response.timedOut) dialogOptions?.onTimeout?.();
		return undefined;
	}
	if ("value" in response) return response.value;
	return undefined;
}

function shouldEmitRpcTitles(): boolean {
	const raw = $env.PI_RPC_EMIT_TITLE;
	if (!raw) return false;
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function requestRpcEditor(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	title: string,
	prefill?: string,
	dialogOptions?: ExtensionUIDialogOptions,
	editorOptions?: { promptStyle?: boolean },
): Promise<string | undefined> {
	if (dialogOptions?.signal?.aborted) return Promise.resolve(undefined);

	const id = Snowflake.next() as string;
	const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
	let settled = false;

	const cleanup = () => {
		dialogOptions?.signal?.removeEventListener("abort", onAbort);
		pendingRequests.delete(id);
	};
	const finish = (value: string | undefined) => {
		if (settled) return;
		settled = true;
		cleanup();
		resolve(value);
	};
	const fail = (error: Error) => {
		if (settled) return;
		settled = true;
		cleanup();
		reject(error);
	};
	const onAbort = () => {
		output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "cancel",
			targetId: id,
		} as RpcExtensionUIRequest);
		finish(undefined);
	};

	dialogOptions?.signal?.addEventListener("abort", onAbort, { once: true });
	pendingRequests.set(id, {
		resolve: response => {
			if ("cancelled" in response && response.cancelled) {
				finish(undefined);
			} else if ("value" in response) {
				finish(response.value);
			} else {
				finish(undefined);
			}
		},
		reject: fail,
	});
	output({
		type: "extension_ui_request",
		id,
		method: "editor",
		title,
		prefill,
		promptStyle: editorOptions?.promptStyle,
	} as RpcExtensionUIRequest);
	return promise;
}

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(session: AgentSession): Promise<never> {
	// Signal to RPC clients that the server is ready to accept commands
	process.stdout.write(`${JSON.stringify({ type: "ready" })}\n`);
	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		process.stdout.write(`${JSON.stringify(obj)}\n`);
	};
	const emitRpcTitles = shouldEmitRpcTitles();

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message };
	};

	const pendingExtensionRequests = new Map<string, PendingExtensionRequest>();
	const hostToolBridge = new RpcHostToolBridge(output);

	// Shutdown request flag (wrapped in object to allow mutation with const)
	const shutdownState = { requested: false };

	/**
	 * Extension UI context that uses the RPC protocol.
	 */
	class RpcExtensionUIContext implements ExtensionUIContext {
		constructor(
			private pendingRequests: Map<string, PendingExtensionRequest>,
			private output: (obj: RpcResponse | RpcExtensionUIRequest | object) => void,
		) {}

		/** Helper for dialog methods with signal/timeout support */
		#createDialogPromise<T>(
			opts: ExtensionUIDialogOptions | undefined,
			defaultValue: T,
			request: Record<string, unknown>,
			parseResponse: (response: RpcExtensionUIResponse) => T,
		): Promise<T> {
			if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

			const id = Snowflake.next() as string;
			const { promise, resolve, reject } = Promise.withResolvers<T>();
			let timeoutId: NodeJS.Timeout | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				this.pendingRequests.delete(id);
			};

			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout !== undefined) {
				timeoutId = setTimeout(() => {
					opts.onTimeout?.();
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}

			this.pendingRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
			});
			this.output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
			return promise;
		}

		select(title: string, options: string[], dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined> {
			return this.#createDialogPromise(
				dialogOptions,
				undefined,
				{ method: "select", title, options, timeout: dialogOptions?.timeout },
				response => parseValueDialogResponse(response, dialogOptions),
			);
		}

		confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean> {
			return this.#createDialogPromise(
				dialogOptions,
				false,
				{ method: "confirm", title, message, timeout: dialogOptions?.timeout },
				response => {
					if ("cancelled" in response && response.cancelled) {
						if (response.timedOut) dialogOptions?.onTimeout?.();
						return false;
					}
					if ("confirmed" in response) return response.confirmed;
					return false;
				},
			);
		}

		input(
			title: string,
			placeholder?: string,
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> {
			return this.#createDialogPromise(
				dialogOptions,
				undefined,
				{ method: "input", title, placeholder, timeout: dialogOptions?.timeout },
				response => parseValueDialogResponse(response, dialogOptions),
			);
		}

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		}

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		}

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		}

		setWorkingMessage(_message?: string): void {
			// Not supported in RPC mode
		}

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only support string arrays in RPC mode - factory functions are ignored
			if (content === undefined || Array.isArray(content)) {
				this.output({
					type: "extension_ui_request",
					id: Snowflake.next() as string,
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
		}

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		}

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		}

		setTitle(title: string): void {
			// Title updates are low-value noise for most RPC hosts; opt in via PI_RPC_EMIT_TITLE=1.
			if (!emitRpcTitles) return;
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		}

		async custom(): Promise<never> {
			// Custom UI not supported in RPC mode
			return undefined as never;
		}

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		}

		setEditorText(text: string): void {
			// Fire and forget - host can implement editor control
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		}

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		}

		async editor(
			title: string,
			prefill?: string,
			dialogOptions?: ExtensionUIDialogOptions,
			editorOptions?: { promptStyle?: boolean },
		): Promise<string | undefined> {
			return requestRpcEditor(this.pendingRequests, this.output, title, prefill, dialogOptions, editorOptions);
		}

		get theme(): Theme {
			return theme;
		}

		getAllThemes(): Promise<{ name: string; path: string | undefined }[]> {
			return Promise.resolve([]);
		}

		getTheme(_name: string): Promise<Theme | undefined> {
			return Promise.resolve(undefined);
		}

		setTheme(_theme: string | Theme): Promise<{ success: boolean; error?: string }> {
			// Theme switching not supported in RPC mode
			return Promise.resolve({ success: false, error: "Theme switching not supported in RPC mode" });
		}

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		}

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		}

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		}
	}

	// Set up extensions with RPC-based UI context
	const extensionRunner = session.extensionRunner;
	if (extensionRunner) {
		extensionRunner.initialize(
			// ExtensionActions
			{
				sendMessage: (message, options) => {
					session.sendCustomMessage(message, options).catch(e => {
						output(error(undefined, "extension_send", e.message));
					});
				},
				sendUserMessage: (content, options) => {
					session.sendUserMessage(content, options).catch(e => {
						output(error(undefined, "extension_send_user", e.message));
					});
				},
				appendEntry: (customType, data) => {
					session.sessionManager.appendCustomEntry(customType, data);
				},
				setLabel: (targetId, label) => {
					session.sessionManager.appendLabelChange(targetId, label);
				},
				getActiveTools: () => session.getActiveToolNames(),
				getAllTools: () => session.getAllToolNames(),
				setActiveTools: (toolNames: string[]) => session.setActiveToolsByName(toolNames),
				getCommands: () => [],
				setModel: model => runExtensionSetModel(session, model),
				getThinkingLevel: () => session.thinkingLevel,
				setThinkingLevel: level => session.setThinkingLevel(level),
				getSessionName: () => session.sessionManager.getSessionName(),
				setSessionName: async name => {
					await session.sessionManager.setSessionName(name, "user");
				},
			},
			// ExtensionContextActions
			{
				getModel: () => session.agent.state.model,
				isIdle: () => !session.isStreaming,
				abort: () => session.abort(),
				hasPendingMessages: () => session.queuedMessageCount > 0,
				shutdown: () => {
					shutdownState.requested = true;
				},
				getContextUsage: () => session.getContextUsage(),
				getSystemPrompt: () => session.systemPrompt,
				compact: instructionsOrOptions => runExtensionCompact(session, instructionsOrOptions),
			},
			// ExtensionCommandContextActions - commands invokable via prompt("/command")
			{
				getContextUsage: () => session.getContextUsage(),
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: async options => {
					const success = await session.newSession({ parentSession: options?.parentSession });
					// Note: setup callback runs but no UI feedback in RPC mode
					if (success && options?.setup) {
						await options.setup(session.sessionManager);
					}
					return { cancelled: !success };
				},
				branch: async entryId => {
					const result = await session.branch(entryId);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, { summarize: options?.summarize });
					return { cancelled: result.cancelled };
				},
				switchSession: async sessionPath => {
					const success = await session.switchSession(sessionPath);
					return { cancelled: !success };
				},
				reload: async () => {
					await session.reload();
				},
				compact: instructionsOrOptions => runExtensionCompact(session, instructionsOrOptions),
			},
			new RpcExtensionUIContext(pendingExtensionRequests, output),
		);
		extensionRunner.onError(err => {
			output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
		});
		// Emit session_start event
		await extensionRunner.emit({
			type: "session_start",
		});
	}

	// Output all agent events as JSON
	session.subscribe(event => {
		output(event);
	});

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
		const id = command.id;

		switch (command.type) {
			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				// Don't await - events will stream
				// Extension commands are executed immediately, file prompt templates are expanded
				// If streaming and streamingBehavior specified, queues via steer/followUp
				session
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
					})
					.catch(e => output(error(id, "prompt", e.message)));
				return success(id, "prompt");
			}

			case "steer": {
				await session.steer(command.message, command.images);
				return success(id, "steer");
			}

			case "follow_up": {
				await session.followUp(command.message, command.images);
				return success(id, "follow_up");
			}

			case "abort": {
				await session.abort();
				return success(id, "abort");
			}

			case "abort_and_prompt": {
				await session.abort();
				session
					.prompt(command.message, { images: command.images })
					.catch(e => output(error(id, "abort_and_prompt", e.message)));
				return success(id, "abort_and_prompt");
			}

			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const cancelled = !(await session.newSession(options));
				return success(id, "new_session", { cancelled });
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				const state: RpcSessionState = {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					interruptMode: session.interruptMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					queuedMessageCount: session.queuedMessageCount,
					todoPhases: session.getTodoPhases(),
					systemPrompt: session.systemPrompt,
					dumpTools: session.agent.state.tools.map(tool => ({
						name: tool.name,
						description: tool.description,
						parameters: tool.parameters,
					})),
				};
				return success(id, "get_state", state);
			}

			case "set_todos": {
				session.setTodoPhases(command.phases);
				return success(id, "set_todos", { todoPhases: session.getTodoPhases() });
			}

			case "set_host_tools": {
				const tools = normalizeHostToolDefinitions(command.tools);
				const rpcTools = hostToolBridge.setTools(tools);
				await session.refreshRpcHostTools(rpcTools);
				return success(id, "set_host_tools", { toolNames: tools.map(tool => tool.name) });
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				const models = session.getAvailableModels();
				const model = models.find(m => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				const models = session.getAvailableModels();
				return success(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			case "set_interrupt_mode": {
				session.setInterruptMode(command.mode);
				return success(id, "set_interrupt_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const result = await session.executeBash(command.command);
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "switch_session": {
				const cancelled = !(await session.switchSession(command.sessionPath));
				return success(id, "switch_session", { cancelled });
			}

			case "branch": {
				const result = await session.branch(command.entryId);
				return success(id, "branch", { text: result.selectedText, cancelled: result.cancelled });
			}

			case "get_branch_messages": {
				const messages = session.getUserMessagesForBranching();
				return success(id, "get_branch_messages", { messages });
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				const applied = await session.setSessionName(name, "user");
				if (!applied) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				return success(id, "set_session_name");
			}

			case "handoff": {
				const result = await session.handoff(command.customInstructions);
				return success(id, "handoff", result ? { savedPath: result.savedPath } : null);
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}

			default: {
				const unknownCommand = command as { type: string };
				return error(undefined, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 * Called after handling each command when waiting for the next command.
	 */
	async function checkShutdownRequested(): Promise<void> {
		if (!shutdownState.requested) return;

		if (extensionRunner?.hasHandlers("session_shutdown")) {
			await extensionRunner.emit({ type: "session_shutdown" });
		}

		process.exit(0);
	}

	// Listen for JSON input using Bun's stdin
	for await (const parsed of readJsonl(Bun.stdin.stream())) {
		try {
			// Handle extension UI responses
			if ((parsed as RpcExtensionUIResponse).type === "extension_ui_response") {
				const response = parsed as RpcExtensionUIResponse;
				const pending = pendingExtensionRequests.get(response.id);
				if (pending) {
					pending.resolve(response);
				}
				continue;
			}

			if (isRpcHostToolResult(parsed)) {
				hostToolBridge.handleResult(parsed);
				continue;
			}

			if (isRpcHostToolUpdate(parsed)) {
				hostToolBridge.handleUpdate(parsed);
				continue;
			}

			// Handle regular commands
			const command = parsed as RpcCommand;
			const response = await handleCommand(command);
			output(response);

			// Check for deferred shutdown request (idle between commands)
			await checkShutdownRequested();
		} catch (e: any) {
			output(error(undefined, "parse", `Failed to parse command: ${e.message}`));
		}
	}

	// stdin closed — RPC client is gone, exit cleanly
	hostToolBridge.rejectAllPending("RPC client disconnected before host tool execution completed");
	process.exit(0);
}

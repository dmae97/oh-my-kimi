import * as fs from "node:fs/promises";
import { type AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { sanitizeText } from "@oh-my-pi/pi-natives";
import type { AutocompleteProvider, SlashCommand } from "@oh-my-pi/pi-tui";
import { $env } from "@oh-my-pi/pi-utils";
import { settings } from "../../config/settings";
import { createPromptActionAutocompleteProvider } from "../../modes/prompt-action-autocomplete";
import { theme } from "../../modes/theme/theme";
import type { InteractiveModeContext } from "../../modes/types";
import type { AgentSessionEvent } from "../../session/agent-session";
import { SKILL_PROMPT_MESSAGE_TYPE, type SkillPromptDetails } from "../../session/messages";
import { executeBuiltinSlashCommand } from "../../slash-commands/builtin-registry";
import { copyToClipboard, readImageFromClipboard } from "../../utils/clipboard";
import { getEditorCommand, openInEditor } from "../../utils/external-editor";
import { ensureSupportedImageInput } from "../../utils/image-loading";
import { resizeImage } from "../../utils/image-resize";
import { generateSessionTitle, setSessionTerminalTitle } from "../../utils/title-generator";

interface Expandable {
	setExpanded(expanded: boolean): void;
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

export class InputController {
	constructor(private ctx: InteractiveModeContext) {}

	setupKeyHandlers(): void {
		this.ctx.editor.setActionKeys("app.interrupt", this.ctx.keybindings.getKeys("app.interrupt"));
		this.ctx.editor.shouldBypassAutocompleteOnEscape = () =>
			Boolean(
				this.ctx.loadingAnimation ||
					this.ctx.hasActiveBtw() ||
					this.ctx.session.isStreaming ||
					this.ctx.session.isCompacting ||
					this.ctx.session.isGeneratingHandoff ||
					this.ctx.session.isBashRunning ||
					this.ctx.session.isPythonRunning ||
					this.ctx.autoCompactionLoader ||
					this.ctx.retryLoader ||
					this.ctx.autoCompactionEscapeHandler ||
					this.ctx.retryEscapeHandler,
			);
		this.ctx.editor.onEscape = () => {
			if (this.ctx.loopModeEnabled) {
				this.ctx.disableLoopMode();
				if (this.ctx.session.isStreaming) {
					void this.ctx.session.abort();
				} else {
					this.ctx.cancelPendingSubmission();
				}
				return;
			}
			if (this.ctx.hasActiveBtw() && this.ctx.handleBtwEscape()) {
				return;
			}
			if (this.ctx.loadingAnimation) {
				if (this.ctx.cancelPendingSubmission()) {
					return;
				}
				this.restoreQueuedMessagesToEditor({ abort: true });
			} else if (this.ctx.session.isBashRunning) {
				this.ctx.session.abortBash();
			} else if (this.ctx.isBashMode) {
				this.ctx.editor.setText("");
				this.ctx.isBashMode = false;
				this.ctx.updateEditorBorderColor();
			} else if (this.ctx.session.isPythonRunning) {
				this.ctx.session.abortPython();
			} else if (this.ctx.isPythonMode) {
				this.ctx.editor.setText("");
				this.ctx.isPythonMode = false;
				this.ctx.updateEditorBorderColor();
			} else if (this.ctx.session.isStreaming) {
				void this.ctx.session.abort();
			} else if (!this.ctx.editor.getText().trim()) {
				// Double-interrupt with empty editor triggers /tree, /branch, or nothing based on setting
				const action = settings.get("doubleEscapeAction");
				if (action !== "none") {
					const now = Date.now();
					if (now - this.ctx.lastEscapeTime < 500) {
						if (action === "tree") {
							this.ctx.showTreeSelector();
						} else {
							this.ctx.showUserMessageSelector();
						}
						this.ctx.lastEscapeTime = 0;
					} else {
						this.ctx.lastEscapeTime = now;
					}
				}
			}
		};

		this.ctx.editor.setActionKeys("app.clear", this.ctx.keybindings.getKeys("app.clear"));
		this.ctx.editor.onClear = () => this.handleCtrlC();
		this.ctx.editor.setActionKeys("app.exit", this.ctx.keybindings.getKeys("app.exit"));
		this.ctx.editor.onExit = () => this.handleCtrlD();
		this.ctx.editor.setActionKeys("app.suspend", this.ctx.keybindings.getKeys("app.suspend"));
		this.ctx.editor.onSuspend = () => this.handleCtrlZ();
		this.ctx.editor.setActionKeys("app.thinking.cycle", this.ctx.keybindings.getKeys("app.thinking.cycle"));
		this.ctx.editor.onCycleThinkingLevel = () => this.cycleThinkingLevel();
		this.ctx.editor.setActionKeys("app.model.cycleForward", this.ctx.keybindings.getKeys("app.model.cycleForward"));
		this.ctx.editor.onCycleModelForward = () => this.cycleRoleModel();
		this.ctx.editor.setActionKeys("app.model.cycleBackward", this.ctx.keybindings.getKeys("app.model.cycleBackward"));
		this.ctx.editor.onCycleModelBackward = () => this.cycleRoleModel({ temporary: true });
		this.ctx.editor.setActionKeys(
			"app.model.selectTemporary",
			this.ctx.keybindings.getKeys("app.model.selectTemporary"),
		);
		this.ctx.editor.onSelectModelTemporary = () => this.ctx.showModelSelector({ temporaryOnly: true });

		// Global debug handler on TUI (works regardless of focus)
		this.ctx.ui.onDebug = () => this.ctx.showDebugSelector();
		this.ctx.editor.setActionKeys("app.model.select", this.ctx.keybindings.getKeys("app.model.select"));
		this.ctx.editor.onSelectModel = () => this.ctx.showModelSelector();
		this.ctx.editor.setActionKeys("app.history.search", this.ctx.keybindings.getKeys("app.history.search"));
		this.ctx.editor.onHistorySearch = () => this.ctx.showHistorySearch();
		this.ctx.editor.setActionKeys("app.thinking.toggle", this.ctx.keybindings.getKeys("app.thinking.toggle"));
		this.ctx.editor.onToggleThinking = () => this.ctx.toggleThinkingBlockVisibility();
		this.ctx.editor.setActionKeys("app.editor.external", this.ctx.keybindings.getKeys("app.editor.external"));
		this.ctx.editor.onExternalEditor = () => void this.openExternalEditor();
		this.ctx.editor.onShowHotkeys = () => this.ctx.handleHotkeysCommand();
		this.ctx.editor.setActionKeys(
			"app.clipboard.pasteImage",
			this.ctx.keybindings.getKeys("app.clipboard.pasteImage"),
		);
		this.ctx.editor.onPasteImage = () => this.handleImagePaste();
		this.ctx.editor.setActionKeys(
			"app.clipboard.copyPrompt",
			this.ctx.keybindings.getKeys("app.clipboard.copyPrompt"),
		);
		this.ctx.editor.onCopyPrompt = () => this.handleCopyPrompt();
		this.ctx.editor.setActionKeys("app.tools.expand", this.ctx.keybindings.getKeys("app.tools.expand"));
		this.ctx.editor.onExpandTools = () => this.toggleToolOutputExpansion();
		this.ctx.editor.setActionKeys("app.message.dequeue", this.ctx.keybindings.getKeys("app.message.dequeue"));
		this.ctx.editor.onDequeue = () => this.handleDequeue();

		this.ctx.editor.clearCustomKeyHandlers();
		// Wire up extension shortcuts
		this.registerExtensionShortcuts();

		const planModeKeys = this.ctx.keybindings.getKeys("app.plan.toggle");
		for (const key of planModeKeys) {
			this.ctx.editor.setCustomKeyHandler(key, () => void this.ctx.handlePlanModeCommand());
		}

		for (const key of this.ctx.keybindings.getKeys("app.session.new")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.handleClearCommand());
		}
		for (const key of this.ctx.keybindings.getKeys("app.session.tree")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.showTreeSelector());
		}
		for (const key of this.ctx.keybindings.getKeys("app.session.fork")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.showUserMessageSelector());
		}
		for (const key of this.ctx.keybindings.getKeys("app.session.resume")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.showSessionSelector());
		}
		for (const key of this.ctx.keybindings.getKeys("app.message.followUp")) {
			this.ctx.editor.setCustomKeyHandler(key, () => void this.handleFollowUp());
		}
		for (const key of this.ctx.keybindings.getKeys("app.stt.toggle")) {
			this.ctx.editor.setCustomKeyHandler(key, () => void this.ctx.handleSTTToggle());
		}
		for (const key of this.ctx.keybindings.getKeys("app.clipboard.copyLine")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.handleCopyCurrentLine());
		}
		for (const key of this.ctx.keybindings.getKeys("app.session.observe")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.showSessionObserver());
		}

		this.ctx.editor.onChange = (text: string) => {
			const wasBashMode = this.ctx.isBashMode;
			const wasPythonMode = this.ctx.isPythonMode;
			const trimmed = text.trimStart();
			this.ctx.isBashMode = text.trimStart().startsWith("!");
			this.ctx.isPythonMode = trimmed.startsWith("$") && !trimmed.startsWith("${");
			if (wasBashMode !== this.ctx.isBashMode || wasPythonMode !== this.ctx.isPythonMode) {
				this.ctx.updateEditorBorderColor();
			}
		};
	}

	setupEditorSubmitHandler(): void {
		this.ctx.editor.onSubmit = async (text: string) => {
			text = text.trim();

			// Empty submit while streaming with queued messages: flush queues immediately
			if (!text && this.ctx.session.isStreaming && this.ctx.session.queuedMessageCount > 0) {
				// Abort current stream and let queued messages be processed
				await this.ctx.session.abort();
				return;
			}

			if (!text) return;

			// Continue shortcuts: "." or "c" sends empty message (agent continues, no visible message)
			if (text === "." || text === "c") {
				if (this.ctx.onInputCallback) {
					this.ctx.editor.setText("");
					this.ctx.pendingImages = [];
					this.ctx.onInputCallback({ text: "", cancelled: false, started: true });
				}
				return;
			}

			const runner = this.ctx.session.extensionRunner;
			let inputImages = this.ctx.pendingImages.length > 0 ? [...this.ctx.pendingImages] : undefined;

			if (runner?.hasHandlers("input")) {
				const result = await runner.emitInput(text, inputImages, "interactive");
				if (result?.handled) {
					this.ctx.editor.setText("");
					this.ctx.pendingImages = [];
					return;
				}
				if (result?.text !== undefined) {
					text = result.text.trim();
				}
				if (result?.images !== undefined) {
					inputImages = result.images;
				}
			}

			if (!text) return;

			// Handle built-in slash commands
			const slashResult = await executeBuiltinSlashCommand(text, {
				ctx: this.ctx,
				handleBackgroundCommand: () => this.handleBackgroundCommand(),
			});
			if (slashResult === true) {
				return;
			}
			if (typeof slashResult === "string") {
				// Command handled but returned remaining text to use as prompt
				text = slashResult;
			}

			// Handle skill commands (/skill:name [args])
			if (text.startsWith("/skill:")) {
				const spaceIndex = text.indexOf(" ");
				const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
				const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
				const skillPath = this.ctx.skillCommands?.get(commandName);
				if (skillPath) {
					this.ctx.editor.addToHistory(text);
					this.ctx.editor.setText("");
					try {
						const content = await Bun.file(skillPath).text();
						const body = content.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
						const metaLines = [`Skill: ${skillPath}`];
						if (args) {
							metaLines.push(`User: ${args}`);
						}
						const message = `${body}\n\n---\n\n${metaLines.join("\n")}`;
						const skillName = commandName.slice("skill:".length);
						const details: SkillPromptDetails = {
							name: skillName || commandName,
							path: skillPath,
							args: args || undefined,
							lineCount: body ? body.split("\n").length : 0,
						};
						await this.ctx.session.promptCustomMessage(
							{
								customType: SKILL_PROMPT_MESSAGE_TYPE,
								content: message,
								display: true,
								details,
								attribution: "user",
							},
							{ streamingBehavior: "followUp" },
						);
					} catch (err) {
						this.ctx.showError(`Failed to load skill: ${err instanceof Error ? err.message : String(err)}`);
					}
					return;
				}
			}

			// Handle bash command (! for normal, !! for excluded from context)
			if (text.startsWith("!")) {
				const isExcluded = text.startsWith("!!");
				const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
				if (command) {
					if (this.ctx.session.isBashRunning) {
						this.ctx.showWarning("A bash command is already running. Press Esc to cancel it first.");
						this.ctx.editor.setText(text);
						return;
					}
					this.ctx.editor.addToHistory(text);
					await this.ctx.handleBashCommand(command, isExcluded);
					this.ctx.isBashMode = false;
					this.ctx.updateEditorBorderColor();
					return;
				}
			}

			// Handle python command ($ for normal, $$ for excluded from context)
			if (text.startsWith("$")) {
				const isExcluded = text.startsWith("$$");
				const code = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
				if (code) {
					if (this.ctx.session.isPythonRunning) {
						this.ctx.showWarning("A Python execution is already running. Press Esc to cancel it first.");
						this.ctx.editor.setText(text);
						return;
					}
					this.ctx.editor.addToHistory(text);
					await this.ctx.handlePythonCommand(code, isExcluded);
					this.ctx.isPythonMode = false;
					this.ctx.updateEditorBorderColor();
					return;
				}
			}

			// Queue input during compaction
			if (this.ctx.session.isCompacting) {
				if (this.ctx.pendingImages.length > 0) {
					this.ctx.showStatus("Compaction in progress. Retry after it completes to send images.");
					return;
				}
				this.ctx.queueCompactionMessage(text, "steer");
				return;
			}

			// If streaming, use prompt() with steer behavior
			// This handles extension commands (execute immediately), prompt template expansion, and queueing
			if (this.ctx.session.isStreaming) {
				this.ctx.editor.addToHistory(text);
				this.ctx.editor.setText("");
				const images = inputImages && inputImages.length > 0 ? [...inputImages] : undefined;
				this.ctx.pendingImages = [];
				await this.ctx.session.prompt(text, { streamingBehavior: "steer", images });
				this.ctx.updatePendingMessagesDisplay();
				this.ctx.ui.requestRender();
				return;
			}

			// Normal message submission
			// First, move any pending bash components to chat
			this.ctx.flushPendingBashComponents();

			// Generate session title on first message
			const hasUserMessages = this.ctx.session.messages.some((m: AgentMessage) => m.role === "user");
			if (!hasUserMessages && !this.ctx.sessionManager.getSessionName() && !$env.PI_NO_TITLE) {
				const registry = this.ctx.session.modelRegistry;
				generateSessionTitle(text, registry, this.ctx.settings, this.ctx.session.sessionId, this.ctx.session.model)
					.then(async title => {
						if (title) {
							const applied = await this.ctx.sessionManager.setSessionName(title, "auto");
							if (applied) {
								setSessionTerminalTitle(
									this.ctx.sessionManager.getSessionName()!,
									this.ctx.sessionManager.getCwd(),
									this.ctx.sessionManager.titleSource,
								);
								this.ctx.updateEditorBorderColor();
							}
						}
					})
					.catch(() => {});
			}

			if (this.ctx.onInputCallback) {
				// Include any pending images from clipboard paste
				const images = inputImages && inputImages.length > 0 ? [...inputImages] : undefined;
				this.ctx.pendingImages = [];

				// Render user message immediately, then let session events catch up
				const submission = this.ctx.startPendingSubmission({ text, images });

				this.ctx.onInputCallback(submission);
			}
			this.ctx.editor.addToHistory(text);
		};
	}

	handleCtrlC(): void {
		const now = Date.now();
		if (now - this.ctx.lastSigintTime < 500) {
			void this.ctx.shutdown();
		} else {
			this.ctx.clearEditor();
			this.ctx.lastSigintTime = now;
		}
	}

	handleCtrlD(): void {
		// Only called when editor is empty (enforced by CustomEditor)
		void this.ctx.shutdown();
	}

	handleCtrlZ(): void {
		// Set up handler to restore TUI when resumed
		process.once("SIGCONT", () => {
			this.ctx.ui.start();
			this.ctx.ui.requestRender(true);
		});

		// Stop the TUI (restore terminal to normal mode)
		this.ctx.ui.stop();

		// Send SIGTSTP to process group (pid=0 means all processes in group)
		process.kill(0, "SIGTSTP");
	}

	handleDequeue(): void {
		const restored = this.restoreQueuedMessagesToEditor();
		if (restored === 0) {
			this.ctx.showStatus("No queued messages to restore");
		} else {
			this.ctx.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
		}
	}

	/** Send editor text as a follow-up message (queued behind current stream). */
	async handleFollowUp(): Promise<void> {
		const text = this.ctx.editor.getText().trim();
		if (!text) return;

		if (this.ctx.session.isCompacting) {
			this.ctx.queueCompactionMessage(text, "followUp");
			return;
		}

		if (this.ctx.session.isStreaming) {
			this.ctx.editor.addToHistory(text);
			this.ctx.editor.setText("");
			await this.ctx.session.prompt(text, { streamingBehavior: "followUp" });
			this.ctx.updatePendingMessagesDisplay();
			this.ctx.ui.requestRender();
			return;
		}

		// Not streaming — just submit normally
		this.ctx.editor.addToHistory(text);
		this.ctx.editor.setText("");
		await this.ctx.session.prompt(text);
	}

	restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		const { steering, followUp } = this.ctx.session.clearQueue();
		const allQueued = [...steering, ...followUp];
		if (allQueued.length === 0) {
			this.ctx.updatePendingMessagesDisplay();
			if (options?.abort) {
				this.ctx.session.abort();
			}
			return 0;
		}
		const queuedText = allQueued.join("\n\n");
		const currentText = options?.currentText ?? this.ctx.editor.getText();
		const combinedText = [queuedText, currentText].filter(t => t.trim()).join("\n\n");
		this.ctx.editor.setText(combinedText);
		this.ctx.updatePendingMessagesDisplay();
		if (options?.abort) {
			this.ctx.session.abort();
		}
		return allQueued.length;
	}

	handleBackgroundCommand(): void {
		if (this.ctx.isBackgrounded) {
			this.ctx.showStatus("Background mode already enabled");
			return;
		}
		if (!this.ctx.session.isStreaming && this.ctx.session.queuedMessageCount === 0) {
			this.ctx.showWarning("Agent is idle; nothing to background");
			return;
		}
		if (this.ctx.hasActiveBtw()) {
			this.ctx.handleBtwEscape();
		}

		this.ctx.isBackgrounded = true;
		const backgroundUiContext = this.ctx.createBackgroundUiContext();

		// Background mode disables interactive UI so tools like ask fail fast.
		this.ctx.setToolUIContext(backgroundUiContext, false);
		this.ctx.initializeHookRunner(backgroundUiContext, false);

		if (this.ctx.loadingAnimation) {
			this.ctx.loadingAnimation.stop();
			this.ctx.loadingAnimation = undefined;
		}
		if (this.ctx.autoCompactionLoader) {
			this.ctx.autoCompactionLoader.stop();
			this.ctx.autoCompactionLoader = undefined;
		}
		if (this.ctx.retryLoader) {
			this.ctx.retryLoader.stop();
			this.ctx.retryLoader = undefined;
		}
		this.ctx.statusContainer.clear();
		this.ctx.statusLine.dispose();

		if (this.ctx.unsubscribe) {
			this.ctx.unsubscribe();
		}
		this.ctx.unsubscribe = this.ctx.session.subscribe(async (event: AgentSessionEvent) => {
			await this.ctx.handleBackgroundEvent(event);
		});

		// Backgrounding keeps the current process to preserve in-flight agent state.
		if (this.ctx.isInitialized) {
			this.ctx.ui.stop();
			this.ctx.isInitialized = false;
		}

		process.stdout.write("Background mode enabled. Run `bg` to continue in background.\n");

		if (process.platform === "win32" || !process.stdout.isTTY) {
			process.stdout.write("Backgrounding requires POSIX job control; continuing in foreground.\n");
			return;
		}

		process.kill(0, "SIGTSTP");
	}

	async handleImagePaste(): Promise<boolean> {
		try {
			const image = await readImageFromClipboard();
			if (image) {
				const base64Data = image.data.toBase64();
				let imageData = await ensureSupportedImageInput({
					type: "image",
					data: base64Data,
					mimeType: image.mimeType,
				});
				if (!imageData) {
					this.ctx.showStatus(`Unsupported clipboard image format: ${image.mimeType}`);
					return false;
				}
				if (settings.get("images.autoResize")) {
					try {
						const resized = await resizeImage({
							type: "image",
							data: imageData.data,
							mimeType: imageData.mimeType,
						});
						imageData = { type: "image", data: resized.data, mimeType: resized.mimeType };
					} catch {
						// Keep the normalized image when resize fails.
					}
				}

				this.ctx.pendingImages.push({
					type: "image",
					data: imageData.data,
					mimeType: imageData.mimeType,
				});
				// Insert placeholder at cursor like Claude does
				const imageNum = this.ctx.pendingImages.length;
				const placeholder = `[Image #${imageNum}]`;
				this.ctx.editor.insertText(`${placeholder} `);
				this.ctx.ui.requestRender();
				return true;
			}
			// No image in clipboard - show hint
			this.ctx.showStatus("No image in clipboard (use terminal paste for text)");
			return false;
		} catch {
			this.ctx.showStatus("Failed to read clipboard");
			return false;
		}
	}

	createAutocompleteProvider(commands: SlashCommand[], basePath: string): AutocompleteProvider {
		return createPromptActionAutocompleteProvider({
			commands,
			basePath,
			keybindings: this.ctx.keybindings,
			copyCurrentLine: () => this.handleCopyCurrentLine(),
			copyPrompt: () => this.handleCopyPrompt(),
			undo: prefix => this.ctx.editor.undoPastTransientText(prefix),
			moveCursorToMessageEnd: () => this.ctx.editor.moveToMessageEnd(),
			moveCursorToMessageStart: () => this.ctx.editor.moveToMessageStart(),
			moveCursorToLineStart: () => this.ctx.editor.moveToLineStart(),
			moveCursorToLineEnd: () => this.ctx.editor.moveToLineEnd(),
		});
	}

	/** Copy the current editor line to the system clipboard. */
	handleCopyCurrentLine(): void {
		const { line } = this.ctx.editor.getCursor();
		const text = this.ctx.editor.getLines()[line] || "";
		if (!text) {
			this.ctx.showStatus("Nothing to copy");
			return;
		}
		try {
			copyToClipboard(text);
			const sanitized = sanitizeText(text);
			const preview = sanitized.length > 30 ? `${sanitized.slice(0, 30)}...` : sanitized;
			this.ctx.showStatus(`Copied line: ${preview}`);
		} catch {
			this.ctx.showWarning("Failed to copy to clipboard");
		}
	}

	/** Copy current prompt text to system clipboard. */
	handleCopyPrompt(): void {
		const text = this.ctx.editor.getText();
		if (!text) {
			this.ctx.showStatus("Nothing to copy");
			return;
		}
		try {
			copyToClipboard(text);
			const sanitized = sanitizeText(text);
			const preview = sanitized.length > 30 ? `${sanitized.slice(0, 30)}...` : sanitized;
			this.ctx.showStatus(`Copied: ${preview}`);
		} catch {
			this.ctx.showWarning("Failed to copy to clipboard");
		}
	}

	cycleThinkingLevel(): void {
		const newLevel = this.ctx.session.cycleThinkingLevel();
		if (newLevel === undefined) {
			this.ctx.showStatus("Current model does not support thinking");
		} else {
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
		}
	}

	async cycleRoleModel(options?: { temporary?: boolean }): Promise<void> {
		try {
			const cycleOrder = settings.get("cycleOrder");
			const result = await this.ctx.session.cycleRoleModels(cycleOrder, options);
			if (!result) {
				this.ctx.showStatus("Only one role model available");
				return;
			}

			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
			const roleLabel = result.role === "default" ? "default" : result.role;
			const roleLabelStyled = theme.bold(theme.fg("accent", roleLabel));
			const thinkingStr =
				result.model.thinking && result.thinkingLevel !== ThinkingLevel.Off
					? ` (thinking: ${result.thinkingLevel})`
					: "";
			const tempLabel = options?.temporary ? " (temporary)" : "";
			const cycleSeparator = theme.fg("dim", " > ");
			const cycleLabel = cycleOrder
				.map(role => {
					if (role === result.role) {
						return theme.bold(theme.fg("accent", role));
					}
					return theme.fg("muted", role);
				})
				.join(cycleSeparator);
			const orderLabel = ` (cycle: ${cycleLabel})`;
			this.ctx.showStatus(
				`Switched to ${roleLabelStyled}: ${result.model.name || result.model.id}${thinkingStr}${tempLabel}${orderLabel}`,
				{ dim: false },
			);
		} catch (error) {
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		}
	}

	toggleToolOutputExpansion(): void {
		this.setToolsExpanded(!this.ctx.toolOutputExpanded);
	}

	setToolsExpanded(expanded: boolean): void {
		this.ctx.toolOutputExpanded = expanded;
		for (const child of this.ctx.chatContainer.children) {
			if (isExpandable(child)) {
				child.setExpanded(expanded);
			}
		}
		this.ctx.ui.requestRender();
	}

	toggleThinkingBlockVisibility(): void {
		this.ctx.hideThinkingBlock = !this.ctx.hideThinkingBlock;
		settings.set("hideThinkingBlock", this.ctx.hideThinkingBlock);

		// Rebuild chat from session messages
		this.ctx.chatContainer.clear();
		this.ctx.rebuildChatFromMessages();

		// If streaming, re-add the streaming component with updated visibility and re-render
		if (this.ctx.streamingComponent && this.ctx.streamingMessage) {
			this.ctx.streamingComponent.setHideThinkingBlock(this.ctx.hideThinkingBlock);
			this.ctx.streamingComponent.updateContent(this.ctx.streamingMessage);
			this.ctx.chatContainer.addChild(this.ctx.streamingComponent);
		}

		this.ctx.showStatus(`Thinking blocks: ${this.ctx.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	#getEditorTerminalPath(): string | null {
		if (process.platform === "win32") {
			return null;
		}
		return "/dev/tty";
	}

	async #openEditorTerminalHandle(): Promise<fs.FileHandle | null> {
		const terminalPath = this.#getEditorTerminalPath();
		if (!terminalPath) {
			return null;
		}
		try {
			return await fs.open(terminalPath, "r+");
		} catch {
			return null;
		}
	}

	async openExternalEditor(): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) {
			this.ctx.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const currentText = this.ctx.editor.getExpandedText?.() ?? this.ctx.editor.getText();

		let ttyHandle: fs.FileHandle | null = null;
		try {
			ttyHandle = await this.#openEditorTerminalHandle();
			this.ctx.ui.stop();

			const stdio: [number | "inherit", number | "inherit", number | "inherit"] = ttyHandle
				? [ttyHandle.fd, ttyHandle.fd, ttyHandle.fd]
				: ["inherit", "inherit", "inherit"];

			const result = await openInEditor(editorCmd, currentText, { extension: ".omp.md", stdio });
			if (result !== null) {
				this.ctx.editor.setText(result);
			}
		} catch (error) {
			this.ctx.showWarning(
				`Failed to open external editor: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			if (ttyHandle) {
				await ttyHandle.close();
			}

			this.ctx.ui.start();
			this.ctx.ui.requestRender();
		}
	}

	registerExtensionShortcuts(): void {
		const runner = this.ctx.session.extensionRunner;
		if (!runner) return;

		const shortcuts = runner.getShortcuts();
		for (const [keyId, shortcut] of shortcuts) {
			this.ctx.editor.setCustomKeyHandler(keyId, () => {
				const ctx = runner.createCommandContext();
				try {
					shortcut.handler(ctx);
				} catch (err) {
					runner.emitError({
						extensionPath: shortcut.extensionPath,
						event: "shortcut",
						error: err instanceof Error ? err.message : String(err),
						stack: err instanceof Error ? err.stack : undefined,
					});
				}
			});
		}
	}
}

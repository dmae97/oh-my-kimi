import * as fs from "node:fs/promises";
import type { AutocompleteProvider, SlashCommand } from "@oh-my-pi/pi-tui";
import { $env, logger, sanitizeText } from "@oh-my-pi/pi-utils";
import { getRoleInfo } from "../../config/model-registry";
import { isSettingsInitialized, settings } from "../../config/settings";
import { renderSegmentTrack } from "../../modes/components/segment-track";
import { TinyTitleDownloadProgressComponent } from "../../modes/components/tiny-title-download-progress";
import { expandEmoticons } from "../../modes/emoji-autocomplete";
import { materializeImageReferenceLinks } from "../../modes/image-references";
import { createPromptActionAutocompleteProvider } from "../../modes/prompt-action-autocomplete";
import type { InteractiveModeContext } from "../../modes/types";
import { SKILL_PROMPT_MESSAGE_TYPE, type SkillPromptDetails, USER_INTERRUPT_LABEL } from "../../session/messages";
import { executeBuiltinSlashCommand } from "../../slash-commands/builtin-registry";
import { isTinyTitleLocalModelKey } from "../../tiny/models";
import { isLowSignalTitleInput } from "../../tiny/text";
import { tinyTitleClient } from "../../tiny/title-client";
import type { TinyTitleProgressEvent } from "../../tiny/title-protocol";
import { copyToClipboard, readImageFromClipboard, readTextFromClipboard } from "../../utils/clipboard";
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

const TINY_TITLE_PROGRESS_DONE_TTL_MS = 3_000;
// A cached model fires its file-load events in a short burst and then goes silent
// while onnxruntime builds the session; a genuine download keeps streaming progress
// events for seconds. Only reveal the bar once a still-incomplete event arrives after
// this grace window, so an already-downloaded model never flashes the bar.
const TINY_TITLE_PROGRESS_REVEAL_DELAY_MS = 1_000;

export class InputController {
	constructor(private ctx: InteractiveModeContext) {}

	#showTinyTitleDownloadProgress(modelKey: string): void {
		if (!isTinyTitleLocalModelKey(modelKey)) return;
		const component = new TinyTitleDownloadProgressComponent(modelKey);
		let added = false;
		let disposed = false;
		let removeTimer: NodeJS.Timeout | undefined;
		const remove = (): void => {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			if (removeTimer) {
				clearTimeout(removeTimer);
				removeTimer = undefined;
			}
			if (added) {
				this.ctx.chatContainer.removeChild(component);
				this.ctx.ui.requestRender();
			}
		};
		const scheduleRemove = (): void => {
			if (removeTimer) clearTimeout(removeTimer);
			removeTimer = setTimeout(remove, TINY_TITLE_PROGRESS_DONE_TTL_MS);
			removeTimer.unref?.();
		};
		let revealAt = 0;
		const update = (event: TinyTitleProgressEvent): void => {
			if (disposed || event.modelKey !== modelKey) return;
			component.update(event);
			if (revealAt === 0) revealAt = performance.now() + TINY_TITLE_PROGRESS_REVEAL_DELAY_MS;
			const complete = component.isComplete();
			// Reveal only for a download still in flight past the grace window. Cache hits
			// either complete or fall silent (onnx init emits no events) before this fires.
			if (!added && !complete && performance.now() >= revealAt) {
				this.ctx.chatContainer.addChild(component);
				added = true;
			}
			if (added) this.ctx.ui.requestRender();
			if (complete) {
				if (added) scheduleRemove();
				else remove();
			}
		};
		const unsubscribe = tinyTitleClient.onProgress(update);
	}

	setupKeyHandlers(): void {
		this.ctx.editor.setActionKeys("app.interrupt", this.ctx.keybindings.getKeys("app.interrupt"));
		this.ctx.editor.onEscape = () => {
			if (this.ctx.loopModeEnabled) {
				this.ctx.pauseLoop();
				if (this.ctx.session.isStreaming) {
					void this.ctx.session.abort({ reason: USER_INTERRUPT_LABEL });
				} else {
					this.ctx.cancelPendingSubmission();
				}
				return;
			}
			if (this.ctx.hasActiveBtw() && this.ctx.handleBtwEscape()) {
				return;
			}
			if (this.ctx.hasActiveOmfg() && this.ctx.handleOmfgEscape()) {
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
			} else if (this.ctx.session.isEvalRunning) {
				this.ctx.session.abortEval();
			} else if (this.ctx.isPythonMode) {
				this.ctx.editor.setText("");
				this.ctx.isPythonMode = false;
				this.ctx.updateEditorBorderColor();
			} else if (this.ctx.session.isStreaming) {
				void this.ctx.session.abort({ reason: USER_INTERRUPT_LABEL });
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
		this.ctx.editor.setActionKeys("app.display.reset", this.ctx.keybindings.getKeys("app.display.reset"));
		this.ctx.editor.onDisplayReset = () => this.ctx.ui.resetDisplay();
		this.ctx.editor.onExit = () => this.handleCtrlD();
		this.ctx.editor.setActionKeys("app.suspend", this.ctx.keybindings.getKeys("app.suspend"));
		this.ctx.editor.onSuspend = () => this.handleCtrlZ();
		this.ctx.editor.setActionKeys("app.thinking.cycle", this.ctx.keybindings.getKeys("app.thinking.cycle"));
		this.ctx.editor.onCycleThinkingLevel = () => this.cycleThinkingLevel();
		this.ctx.editor.setActionKeys("app.model.cycleForward", this.ctx.keybindings.getKeys("app.model.cycleForward"));
		this.ctx.editor.onCycleModelForward = () => this.cycleRoleModel("forward");
		this.ctx.editor.setActionKeys("app.model.cycleBackward", this.ctx.keybindings.getKeys("app.model.cycleBackward"));
		this.ctx.editor.onCycleModelBackward = () => this.cycleRoleModel("backward");
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
		this.ctx.editor.setActionKeys(
			"app.clipboard.pasteImage",
			this.ctx.keybindings.getKeys("app.clipboard.pasteImage"),
		);
		this.ctx.editor.onPasteImage = () => this.handleImagePaste();
		this.ctx.editor.setActionKeys(
			"app.clipboard.pasteTextRaw",
			this.ctx.keybindings.getKeys("app.clipboard.pasteTextRaw"),
		);
		this.ctx.editor.onPasteTextRaw = () => void this.handleClipboardTextRawPaste();
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
			if ((!isSettingsInitialized() || settings.get("emojiAutocomplete")) && text) text = expandEmoticons(text);

			// Empty submit while streaming with queued messages: flush queues immediately
			if (!text && this.ctx.session.isStreaming && this.ctx.session.queuedMessageCount > 0) {
				// Abort current stream and let queued messages be processed
				await this.ctx.session.abort({ reason: USER_INTERRUPT_LABEL });
				return;
			}

			if (!text) return;

			// Continue shortcuts: "." or "c" sends empty message (agent continues, no visible message)
			if (text === "." || text === "c") {
				if (this.ctx.onInputCallback) {
					this.ctx.editor.setText("");
					this.ctx.pendingImages = [];
					this.ctx.pendingImageLinks = [];
					this.ctx.editor.imageLinks = undefined;
					this.ctx.onInputCallback({ text: "", cancelled: false, started: true });
				}
				return;
			}

			const runner = this.ctx.session.extensionRunner;
			let inputImages = this.ctx.pendingImages.length > 0 ? [...this.ctx.pendingImages] : undefined;
			let inputImageLinks = this.ctx.pendingImageLinks.length > 0 ? [...this.ctx.pendingImageLinks] : undefined;

			if (runner?.hasHandlers("input")) {
				const result = await runner.emitInput(text, inputImages, "interactive");
				if (result?.handled) {
					this.ctx.editor.setText("");
					this.ctx.pendingImages = [];
					this.ctx.pendingImageLinks = [];
					this.ctx.editor.imageLinks = undefined;
					return;
				}
				if (result?.text !== undefined) {
					text = result.text.trim();
				}
				if (result?.images !== undefined) {
					inputImages = result.images;
					inputImageLinks = await materializeImageReferenceLinks(
						inputImages,
						this.ctx.sessionManager.putBlob.bind(this.ctx.sessionManager),
					);
				}
			}

			if (!text) return;

			// Handle built-in slash commands
			const slashResult = await executeBuiltinSlashCommand(text, {
				ctx: this.ctx,
			});
			if (slashResult === true) {
				return;
			}
			if (typeof slashResult === "string") {
				// Command handled but returned remaining text to use as prompt
				text = slashResult;
			}

			// Handle skill commands (/skill:name [args]). Enter ⇒ steer (matches the
			// free-text Enter semantics applied a few lines below at the streaming
			// branch). Ctrl+Enter routes through `handleFollowUp` and dispatches the
			// same helper with `"followUp"`.
			if (await this.#invokeSkillCommand(text, "steer")) {
				return;
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
					if (this.ctx.session.isEvalRunning) {
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

			// While loop mode is on, every user-typed prompt becomes the new loop
			// prompt that auto-resubmits after each yield.
			if (this.ctx.loopModeEnabled) {
				this.ctx.loopPrompt = text;
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
				this.ctx.editor.imageLinks = undefined;
				const images = inputImages && inputImages.length > 0 ? [...inputImages] : undefined;
				this.ctx.pendingImages = [];
				this.ctx.pendingImageLinks = [];
				// Record the signature so the queued message's eventual delivery
				// (a user-role `message_start` event) leaves any draft the user has
				// typed since queuing intact. Same protection as #783, applied to
				// the streaming/queue path.
				await this.ctx.withLocalSubmission(
					text,
					() => this.ctx.session.prompt(text, { streamingBehavior: "steer", images }),
					{ imageCount: images?.length ?? 0 },
				);
				this.ctx.updatePendingMessagesDisplay();
				this.ctx.ui.requestRender();
				return;
			}

			// Normal message submission
			// First, move any pending bash components to chat
			this.ctx.flushPendingBashComponents();

			// Auto-generate a session title while the session is still unnamed.
			// Greetings / acknowledgements / empty input carry no task, so they are
			// skipped deterministically (no model invoked, no download-progress UI)
			// and the session stays unnamed — the next user message gets a fresh
			// chance, so titling defers past "hi" instead of latching onto it.
			if (!this.ctx.sessionManager.getSessionName() && !$env.PI_NO_TITLE && !isLowSignalTitleInput(text)) {
				this.#showTinyTitleDownloadProgress(this.ctx.settings.get("providers.tinyModel"));
				const registry = this.ctx.session.modelRegistry;
				generateSessionTitle(
					text,
					registry,
					this.ctx.settings,
					this.ctx.session.sessionId,
					this.ctx.session.model,
					provider => this.ctx.session.agent.metadataForProvider(provider),
				)
					.then(async title => {
						// Re-check: a concurrent attempt for an earlier message may have
						// already named the session. Don't clobber it.
						if (title && !this.ctx.sessionManager.getSessionName()) {
							const applied = await this.ctx.sessionManager.setSessionName(title, "auto");
							if (applied) {
								setSessionTerminalTitle(
									this.ctx.sessionManager.getSessionName()!,
									this.ctx.sessionManager.getCwd(),
								);
								this.ctx.updateEditorBorderColor();
							}
						}
					})
					.catch(err => {
						logger.warn("title-generator: uncaught auto-title error", {
							sessionId: this.ctx.session.sessionId,
							reason: "uncaught-auto-title-error",
							error: err instanceof Error ? err.message : String(err),
						});
					});
			}

			if (this.ctx.onInputCallback) {
				// Include any pending images from clipboard paste
				this.ctx.editor.imageLinks = undefined;
				const images = inputImages && inputImages.length > 0 ? [...inputImages] : undefined;
				this.ctx.pendingImages = [];
				this.ctx.pendingImageLinks = [];

				// Render user message immediately, then let session events catch up
				const submission = this.ctx.startPendingSubmission({
					text,
					images,
					imageLinks: inputImageLinks,
				});

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
		// Editor text (if any) is snapshotted at the start of shutdown() and
		// persisted as a draft for the next resume. Empty text is also fine —
		// shutdown clears any stale sidecar in that case.
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

	/**
	 * Dispatch a `/skill:<name> [args]` invocation through `promptCustomMessage`
	 * using the supplied `streamingBehavior`. Returns true if the text was a
	 * recognised skill command and was dispatched. A failure to load the skill
	 * file is surfaced via `showError` but still returns true — the editor was
	 * already cleared on the success path, so falling through to plain-text
	 * handling at that point would double-submit. Returns false when the text
	 * isn't a `/skill:` prefix or the command name isn't a registered skill,
	 * so the caller can fall through to plain-text handling (this branch
	 * leaves the editor state untouched). `streamingBehavior` is only consulted
	 * while the agent is streaming; the idle path of `promptCustomMessage`
	 * ignores it.
	 */
	async #invokeSkillCommand(text: string, streamingBehavior: "steer" | "followUp"): Promise<boolean> {
		if (!text.startsWith("/skill:")) return false;
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
		const skillPath = this.ctx.skillCommands?.get(commandName);
		if (!skillPath) return false;
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
			// When the agent is streaming, register the compact slash-form text as
			// the pending-display twin BEFORE dispatching the CustomMessage. The
			// returned tag is embedded in details so AgentSession.#handleAgentEvent
			// can remove the matching display entry when the agent consumes this
			// message (mirrors the user-message dequeue path).
			if (this.ctx.session.isStreaming) {
				const tag = this.ctx.session.enqueueCustomMessageDisplay(text, streamingBehavior);
				details.__pendingDisplayTag = tag;
			}
			await this.ctx.session.promptCustomMessage(
				{
					customType: SKILL_PROMPT_MESSAGE_TYPE,
					content: message,
					display: true,
					details,
					attribution: "user",
				},
				{ streamingBehavior },
			);
			if (this.ctx.session.isStreaming) {
				this.ctx.updatePendingMessagesDisplay();
				this.ctx.ui.requestRender();
			}
		} catch (err) {
			this.ctx.showError(`Failed to load skill: ${err instanceof Error ? err.message : String(err)}`);
		}
		return true;
	}

	/** Send editor text as a follow-up message (queued behind current stream). */
	async handleFollowUp(): Promise<void> {
		const text = this.ctx.editor.getText().trim();
		if (!text) return;

		// Compaction first: while compacting, free text gets queued via
		// `queueCompactionMessage`, and `/skill:*` rides the same queue so a
		// skill typed during compaction is not lost or short-circuited through
		// `promptCustomMessage`. The skill text is queued verbatim; whether
		// the queued entry is later re-parsed into a skill invocation is a
		// separate concern owned by the compaction-resume path.
		if (this.ctx.session.isCompacting) {
			this.ctx.queueCompactionMessage(text, "followUp");
			return;
		}

		// Skill commands invoke through the custom-message path regardless of
		// which keybinding submitted them. Enter routes them as `steer`;
		// Ctrl+Enter (this handler) routes them as `followUp`.
		if (await this.#invokeSkillCommand(text, "followUp")) {
			return;
		}

		if (this.ctx.session.isStreaming) {
			this.ctx.editor.addToHistory(text);
			this.ctx.editor.setText("");
			await this.ctx.withLocalSubmission(text, () =>
				this.ctx.session.prompt(text, { streamingBehavior: "followUp" }),
			);
			this.ctx.updatePendingMessagesDisplay();
			this.ctx.ui.requestRender();
			return;
		}

		// Not streaming — just submit normally
		this.ctx.editor.addToHistory(text);
		this.ctx.editor.setText("");
		await this.ctx.withLocalSubmission(text, () => this.ctx.session.prompt(text));
	}

	restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		this.ctx.locallySubmittedUserSignatures.clear();
		const { steering, followUp } = this.ctx.session.clearQueue();
		const allQueued = [...steering, ...followUp];
		if (allQueued.length === 0) {
			this.ctx.updatePendingMessagesDisplay();
			if (options?.abort) {
				this.ctx.session.abort({ reason: USER_INTERRUPT_LABEL });
			}
			return 0;
		}
		const queuedText = allQueued.join("\n\n");
		const currentText = options?.currentText ?? this.ctx.editor.getText();
		const combinedText = [queuedText, currentText].filter(t => t.trim()).join("\n\n");
		this.ctx.editor.setText(combinedText);
		this.ctx.updatePendingMessagesDisplay();
		if (options?.abort) {
			this.ctx.session.abort({ reason: USER_INTERRUPT_LABEL });
		}
		return allQueued.length;
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

				const imageLink = (
					await materializeImageReferenceLinks(
						[
							{
								type: "image",
								data: imageData.data,
								mimeType: imageData.mimeType,
							},
						],
						this.ctx.sessionManager.putBlob.bind(this.ctx.sessionManager),
					)
				)?.[0];
				this.ctx.pendingImages.push({
					type: "image",
					data: imageData.data,
					mimeType: imageData.mimeType,
				});
				this.ctx.pendingImageLinks.push(imageLink);
				this.ctx.editor.imageLinks = this.ctx.pendingImageLinks;
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

	async handleClipboardTextRawPaste(): Promise<void> {
		try {
			const text = await readTextFromClipboard();
			if (text) {
				this.ctx.editor.insertText(text);
				this.ctx.ui.requestRender();
				this.ctx.showStatus("No text in clipboard to paste raw");
			}
		} catch {
			this.ctx.showStatus("Failed to paste raw text from clipboard");
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

	async cycleRoleModel(direction: "forward" | "backward" = "forward"): Promise<void> {
		try {
			const cycleOrder = settings.get("cycleOrder");
			const result = await this.ctx.session.cycleRoleModels(cycleOrder, direction);
			if (!result) {
				this.ctx.showStatus("Only one role model available");
				return;
			}

			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
			// The status line already reports the resolved model + thinking level, so
			// the cycle status is just a status-line-style chip track (active role
			// filled), matching the plan-approval model slider.
			const track = renderSegmentTrack(
				cycleOrder.map(role => ({ label: role, color: getRoleInfo(role, settings).color })),
				cycleOrder.indexOf(result.role),
			);
			this.ctx.showStatus(track, { dim: false });
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
		// Toggling expansion mutates every block, but on ED3-risk terminals the
		// transcript freezes a snapshot of each block once it scrolls past the live
		// region (committed native scrollback is immutable there). A plain repaint
		// replays those stale snapshots, so the toggle appears to do nothing above
		// the live block. resetDisplay() invalidates the snapshots and forces a
		// full clear + replay — the keyboard-accessible resize-reset equivalent —
		// which is the only path that re-emits the whole transcript at its new
		// heights.
		this.ctx.ui.resetDisplay();
	}

	toggleThinkingBlockVisibility(): void {
		this.ctx.hideThinkingBlock = !this.ctx.hideThinkingBlock;
		settings.set("hideThinkingBlock", this.ctx.hideThinkingBlock);
		this.ctx.session.agent.hideThinkingSummary = this.ctx.hideThinkingBlock;

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

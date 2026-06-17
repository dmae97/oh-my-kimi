import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import { Container, Image, type ImageBudget, ImageProtocol, Markdown, Spacer, TERMINAL, Text } from "@oh-my-pi/pi-tui";
import type { AssistantThinkingRenderer } from "../../extensibility/extensions/types";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import { resolveAbortLabel, shouldRenderAbortReason } from "../../session/messages";
import { getPreviewLines, resolveImageOptions, TRUNCATE_LENGTHS } from "../../tools/render-utils";
import { canonicalizeMessage } from "../../utils/thinking-display";

/**
 * Max lines of a turn-ending provider error rendered inline in the transcript.
 * Bounds pathological error bodies — e.g. a proxy 502 whose body is a full HTML
 * page — so they can't flood the scrollback. Blank lines are dropped and each
 * line is width-truncated by {@link getPreviewLines}. Full text is still kept in
 * the persisted session.
 */
const MAX_TRANSCRIPT_ERROR_LINES = 8;

/**
 * Frames for the streaming "thinking" pulse rendered in place of a hidden
 * thinking block while the model is still producing it. A single fixed-width
 * glyph that rises ▁▃▄▃ so the indicator animates without shifting the line.
 * Advanced every {@link THINKING_DOTS_FRAME_MS}.
 */
const THINKING_DOTS_FRAMES = ["▁", "▃", "▄", "▃"] as const;
const THINKING_DOTS_FRAME_MS = 320;

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	#contentContainer: Container;
	#lastMessage?: AssistantMessage;
	#toolImagesByCallId = new Map<string, ImageContent[]>();
	#convertedKittyImages = new Map<string, ImageContent>();
	#kittyConversionsInFlight = new Set<string>();
	#transcriptBlockFinalized: boolean;
	/**
	 * When true, the turn-ending `Error: …` line for `stopReason === "error"` is
	 * suppressed because the same error is currently shown in the pinned banner
	 * above the editor (see `EventController` + `ErrorBannerComponent`). Avoids
	 * rendering the identical error twice (inline + banner) at the error moment.
	 * Restored to `false` when the banner is cleared at the next turn so the
	 * transcript keeps the error in history.
	 */
	#errorPinned = false;
	/**
	 * Monotonic content version reported to the transcript container via
	 * {@link getTranscriptBlockVersion}. Bumped by {@link updateContent} — the
	 * choke point every mutator funnels through, including post-finalize changes
	 * such as `setErrorPinned(false)` restoring the inline error at the next
	 * turn's `agent_start`, late tool-result images, and async Kitty conversions.
	 */
	#blockVersion = 0;
	/** Whether the last updateContent carried an in-flight streaming partial; such
	 *  renders bypass the markdown module LRU (see Markdown.transientRenderCache). */
	#lastUpdateTransient = false;
	// Fast-path state: reuse Markdown children when message shape is stable during streaming.
	#fastPathKey: string | undefined;
	#fastPathItems:
		| Array<{ md: Markdown; contentIndex: number; blockType: "text" | "thinking"; lastText: string }>
		| undefined;
	/** Live "thinking" pulse shown in place of a hidden thinking block while it
	 *  streams; undefined when not animating. Driven by {@link #thinkingDotsTimer}. */
	#thinkingDots: Text | undefined;
	#thinkingDotsTimer: NodeJS.Timeout | undefined;
	#thinkingDotsFrame = 0;

	constructor(
		message?: AssistantMessage,
		private hideThinkingBlock = false,
		private readonly onImageUpdate?: () => void,
		private readonly thinkingRenderers: readonly AssistantThinkingRenderer[] = [],
		private readonly imageBudget?: ImageBudget,
	) {
		super();
		this.#transcriptBlockFinalized = message !== undefined;

		// Container for text/thinking content
		this.#contentContainer = new Container();
		this.addChild(this.#contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		// Theme/symbol changes arrive via invalidate(). Fast-path children captured
		// getMarkdownTheme() at construction, so drop them and force the teardown
		// path to rebuild with the current theme. Streaming updates call
		// updateContent() directly and keep the fast path.
		this.#fastPathKey = undefined;
		this.#fastPathItems = undefined;
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
	}

	override dispose(): void {
		this.#stopThinkingAnimation();
		super.dispose();
	}

	/**
	 * Whether to render the animated "thinking" pulse in place of the suppressed
	 * reasoning: only while this block is still streaming (not yet finalized — the
	 * in-flight message always carries `stopReason: "stop"`, so finalization is the
	 * only reliable live signal), thinking is hidden, no tool call has started, and
	 * the active tail block is a thinking block (the model is reasoning right now).
	 * Once text starts, a tool call streams, or the block is sealed, the pulse ends.
	 */
	#shouldAnimateThinking(message: AssistantMessage): boolean {
		if (!this.hideThinkingBlock || this.#transcriptBlockFinalized) return false;
		let tail: "text" | "thinking" | undefined;
		for (const content of message.content) {
			if (content.type === "toolCall") return false;
			if (content.type === "text" && canonicalizeMessage(content.text)) tail = "text";
			else if (content.type === "thinking" && canonicalizeMessage(content.thinking)) tail = "thinking";
		}
		return tail === "thinking";
	}

	#thinkingDotsLabel(): string {
		const glyph = THINKING_DOTS_FRAMES[this.#thinkingDotsFrame % THINKING_DOTS_FRAMES.length] ?? "…";
		return theme.fg("thinkingText", glyph);
	}

	#startThinkingAnimation(): void {
		if (this.#thinkingDotsTimer) return;
		this.#thinkingDotsTimer = setInterval(() => this.#advanceThinkingDots(), THINKING_DOTS_FRAME_MS);
		this.#thinkingDotsTimer.unref?.();
	}

	#advanceThinkingDots(): void {
		if (!this.#thinkingDots) {
			this.#stopThinkingAnimation();
			return;
		}
		this.#thinkingDotsFrame = (this.#thinkingDotsFrame + 1) % THINKING_DOTS_FRAMES.length;
		if (this.#thinkingDots.setText(this.#thinkingDotsLabel())) {
			this.onImageUpdate?.();
		}
	}

	#stopThinkingAnimation(): void {
		if (this.#thinkingDotsTimer) {
			clearInterval(this.#thinkingDotsTimer);
			this.#thinkingDotsTimer = undefined;
		}
		this.#thinkingDotsFrame = 0;
	}

	/**
	 * Toggle suppression of the inline `Error: …` line while the same error is
	 * pinned in the banner above the editor. Re-renders so the change is visible.
	 */
	setErrorPinned(pinned: boolean): void {
		if (this.#errorPinned === pinned) return;
		this.#errorPinned = pinned;
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		}
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#transcriptBlockFinalized;
	}

	getTranscriptBlockVersion(): number {
		return this.#blockVersion;
	}

	markTranscriptBlockFinalized(): void {
		this.#transcriptBlockFinalized = true;
		this.#stopThinkingAnimation();
		// If the live pulse was on screen when the block sealed, drop the fast path
		// and rebuild so the placeholder is removed — finalized blocks never animate.
		if (this.#thinkingDots) {
			this.#fastPathKey = undefined;
			this.#fastPathItems = undefined;
			if (this.#lastMessage) this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		}
	}

	/**
	 * Render a turn-ending provider error inline. Drops blank lines, clamps the
	 * line count to {@link MAX_TRANSCRIPT_ERROR_LINES}, and width-truncates each
	 * line so a pathological body — e.g. the HTML page a proxy returns on a 502 —
	 * can't flood the transcript. Mirrors {@link ErrorBannerComponent}.
	 */
	#appendErrorBlock(message: string): void {
		const lines = getPreviewLines(message, MAX_TRANSCRIPT_ERROR_LINES, TRUNCATE_LENGTHS.LINE);
		if (lines.length === 0) lines.push("Unknown error");
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("error", `Error: ${lines[0]}`), 1, 0));
		for (const line of lines.slice(1)) {
			this.#contentContainer.addChild(new Text(theme.fg("error", `  ${line}`), 1, 0));
		}
	}

	setToolResultImages(toolCallId: string, images: ImageContent[]): void {
		if (!toolCallId) return;
		const validImages = images.filter(img => img.type === "image" && img.data && img.mimeType);
		for (const key of Array.from(this.#convertedKittyImages.keys())) {
			if (key.startsWith(`${toolCallId}:`)) {
				this.#convertedKittyImages.delete(key);
			}
		}
		for (const key of Array.from(this.#kittyConversionsInFlight)) {
			if (key.startsWith(`${toolCallId}:`)) {
				this.#kittyConversionsInFlight.delete(key);
			}
		}
		if (validImages.length === 0) {
			this.#toolImagesByCallId.delete(toolCallId);
		} else {
			this.#toolImagesByCallId.set(toolCallId, validImages);
			this.#convertToolImagesForKitty(toolCallId, validImages);
		}
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		}
	}

	#convertToolImagesForKitty(toolCallId: string, images: ImageContent[]): void {
		if (TERMINAL.imageProtocol !== ImageProtocol.Kitty) return;
		for (let index = 0; index < images.length; index++) {
			const image = images[index];
			if (!image || image.mimeType === "image/png") continue;
			const key = `${toolCallId}:${index}`;
			if (this.#convertedKittyImages.has(key) || this.#kittyConversionsInFlight.has(key)) continue;
			this.#kittyConversionsInFlight.add(key);
			new Bun.Image(Buffer.from(image.data, "base64"))
				.png()
				.toBase64()
				.then(data => {
					this.#kittyConversionsInFlight.delete(key);
					this.#convertedKittyImages.set(key, {
						type: "image",
						data,
						mimeType: "image/png",
					});
					if (this.#lastMessage) {
						this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
					}
					this.onImageUpdate?.();
				})
				.catch(() => {
					this.#kittyConversionsInFlight.delete(key);
				});
		}
	}

	#renderToolImages(): void {
		const imageEntries = Array.from(this.#toolImagesByCallId.entries()).flatMap(([toolCallId, images]) =>
			images.map((image, index) => ({ image, key: `${toolCallId}:${index}` })),
		);
		if (imageEntries.length === 0) return;

		this.#contentContainer.addChild(new Spacer(1));
		for (const { image, key } of imageEntries) {
			const displayImage =
				TERMINAL.imageProtocol === ImageProtocol.Kitty && image.mimeType !== "image/png"
					? this.#convertedKittyImages.get(key)
					: image;
			if (TERMINAL.imageProtocol && displayImage) {
				this.#contentContainer.addChild(
					new Image(
						displayImage.data,
						displayImage.mimeType,
						{ fallbackColor: (text: string) => theme.fg("toolOutput", text) },
						{ ...resolveImageOptions(), budget: this.imageBudget, imageKey: key },
					),
				);
				continue;
			}
			this.#contentContainer.addChild(new Text(theme.fg("toolOutput", `[Image: ${image.mimeType}]`), 1, 0));
		}
	}

	#appendThinkingExtensions(contentIndex: number, thinkingIndex: number, text: string): void {
		for (const renderer of this.thinkingRenderers) {
			try {
				const component = renderer(
					{
						contentIndex,
						thinkingIndex,
						text,
						requestRender: () => this.onImageUpdate?.(),
					},
					theme,
				);
				if (component) {
					this.#contentContainer.addChild(component);
				}
			} catch {
				// Ignore extension renderer failures and keep the original thinking block visible.
			}
		}
	}

	#computeShapeKey(message: AssistantMessage): string {
		const parts: string[] = [`htb:${this.hideThinkingBlock ? 1 : 0}`];
		for (const content of message.content) {
			if (content.type === "text") {
				parts.push(canonicalizeMessage(content.text) ? "T1" : "T0");
			} else if (content.type === "thinking") {
				const canon = canonicalizeMessage(content.thinking);
				if (!canon) parts.push("K0");
				else if (this.hideThinkingBlock) parts.push("KH");
				else parts.push("KV");
			} else {
				// Non-rendered blocks (toolCall, redactedThinking, …) still occupy a
				// content index. Encode their position so an inserted/removed one shifts
				// the key and forces the teardown path instead of mis-indexing children.
				parts.push(`O:${content.type}`);
			}
		}
		return parts.join("|");
	}

	#canFastPath(message: AssistantMessage): boolean {
		for (const content of message.content) {
			if (content.type === "toolCall") return false;
		}
		if (this.#toolImagesByCallId.size > 0) return false;
		if (message.stopReason === "aborted" && shouldRenderAbortReason(message.errorMessage)) return false;
		if (message.stopReason === "error" && !this.#errorPinned) return false;
		if (
			message.errorMessage &&
			shouldRenderAbortReason(message.errorMessage) &&
			message.stopReason !== "aborted" &&
			message.stopReason !== "error"
		)
			return false;
		// Extension stability: if thinking renderers exist and any tracked thinking
		// block's text changed, extensions may produce a different child count.
		if (this.thinkingRenderers.length > 0 && this.#fastPathItems) {
			for (const item of this.#fastPathItems) {
				if (item.blockType === "thinking") {
					const content = message.content[item.contentIndex];
					if (content?.type === "thinking" && canonicalizeMessage(content.thinking) !== item.lastText)
						return false;
				}
			}
		}
		return true;
	}

	#tryFastPathUpdate(message: AssistantMessage, opts?: { transient?: boolean }): boolean {
		if (!this.#fastPathKey || !this.#fastPathItems) return false;
		if (!this.#canFastPath(message)) {
			this.#fastPathKey = undefined;
			this.#fastPathItems = undefined;
			return false;
		}
		if (this.#computeShapeKey(message) !== this.#fastPathKey) {
			this.#fastPathKey = undefined;
			this.#fastPathItems = undefined;
			return false;
		}
		const transient = opts?.transient === true;
		// Shape is identical — setText only on Markdown children whose source changed.
		for (const item of this.#fastPathItems) {
			item.md.transientRenderCache = transient;
			const content = message.content[item.contentIndex];
			if (!content) {
				this.#fastPathKey = undefined;
				this.#fastPathItems = undefined;
				return false;
			}
			let newText: string;
			if (item.blockType === "text" && content.type === "text") {
				newText = content.text.trim();
			} else if (item.blockType === "thinking" && content.type === "thinking") {
				newText = canonicalizeMessage(content.thinking);
			} else {
				this.#fastPathKey = undefined;
				this.#fastPathItems = undefined;
				return false;
			}
			if (newText !== item.lastText) {
				item.md.setText(newText);
				item.lastText = newText;
			}
		}
		return true;
	}

	updateContent(message: AssistantMessage, opts?: { transient?: boolean }): void {
		this.#blockVersion++;
		this.#lastMessage = message;
		this.#lastUpdateTransient = opts?.transient === true;

		// Fast path: reuse Markdown children when shape is stable during streaming
		if (this.#tryFastPathUpdate(message)) return;

		// Clear content container
		this.#contentContainer.clear();
		this.#thinkingDots = undefined;

		// Determine if we should capture Markdown instances for next fast path
		const shouldCapture = this.#canFastPath(message);
		const captureItems:
			| Array<{ md: Markdown; contentIndex: number; blockType: "text" | "thinking"; lastText: string }>
			| undefined = shouldCapture ? [] : undefined;

		const hasVisibleContent = message.content.some(
			c =>
				(c.type === "text" && canonicalizeMessage(c.text)) ||
				(!this.hideThinkingBlock && c.type === "thinking" && canonicalizeMessage(c.thinking)),
		);

		// Render content in order
		let thinkingIndex = 0;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && canonicalizeMessage(content.text)) {
				// Set paddingY=0 to avoid extra spacing before tool executions
				const trimmed = content.text.trim();
				const md = new Markdown(trimmed, 1, 0, getMarkdownTheme());
				md.transientRenderCache = this.#lastUpdateTransient;
				this.#contentContainer.addChild(md);
				captureItems?.push({ md, contentIndex: i, blockType: "text", lastText: trimmed });
			} else if (content.type === "thinking" && canonicalizeMessage(content.thinking)) {
				const thinkingText = canonicalizeMessage(content.thinking);
				if (this.hideThinkingBlock) {
					thinkingIndex += 1;
					continue;
				}
				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some(
						c =>
							(c.type === "text" && canonicalizeMessage(c.text)) ||
							(c.type === "thinking" && canonicalizeMessage(c.thinking)),
					);

				// Thinking traces in thinkingText color, italic
				const md = new Markdown(thinkingText, 1, 0, getMarkdownTheme(), {
					color: (text: string) => theme.fg("thinkingText", text),
					italic: true,
				});
				md.transientRenderCache = this.#lastUpdateTransient;
				this.#contentContainer.addChild(md);
				captureItems?.push({ md, contentIndex: i, blockType: "thinking", lastText: thinkingText });
				this.#appendThinkingExtensions(i, thinkingIndex, thinkingText);
				thinkingIndex += 1;
				if (hasVisibleContentAfter) {
					this.#contentContainer.addChild(new Spacer(1));
				}
			}
		}

		if (this.#shouldAnimateThinking(message)) {
			if (hasVisibleContent) this.#contentContainer.addChild(new Spacer(1));
			this.#thinkingDots = new Text(this.#thinkingDotsLabel(), 1, 0);
			this.#contentContainer.addChild(this.#thinkingDots);
			this.#startThinkingAnimation();
		} else {
			this.#stopThinkingAnimation();
		}

		this.#renderToolImages();
		// Check if aborted - show after partial content
		// But only if there are no tool calls (tool execution components will show the error)
		const hasToolCalls = message.content.some(c => c.type === "toolCall");
		if (!hasToolCalls) {
			if (message.stopReason === "aborted" && shouldRenderAbortReason(message.errorMessage)) {
				const abortMessage = resolveAbortLabel(message.errorMessage);
				if (hasVisibleContent) {
					this.#contentContainer.addChild(new Spacer(1));
				} else {
					this.#contentContainer.addChild(new Spacer(1));
				}
				this.#contentContainer.addChild(new Text(theme.fg("error", abortMessage), 1, 0));
			} else if (message.stopReason === "error" && !this.#errorPinned) {
				this.#appendErrorBlock(message.errorMessage || "Unknown error");
			}
		}
		if (
			message.errorMessage &&
			shouldRenderAbortReason(message.errorMessage) &&
			message.stopReason !== "aborted" &&
			message.stopReason !== "error"
		) {
			this.#appendErrorBlock(message.errorMessage);
		}
		// Store fast-path state for next call
		if (shouldCapture) {
			this.#fastPathItems = captureItems;
			this.#fastPathKey = this.#computeShapeKey(message);
		} else {
			this.#fastPathKey = undefined;
			this.#fastPathItems = undefined;
		}
	}
}

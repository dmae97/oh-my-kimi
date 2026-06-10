import type { AssistantMessage, ImageContent, Usage } from "@oh-my-pi/pi-ai";
import { Container, Image, type ImageBudget, ImageProtocol, Markdown, Spacer, TERMINAL, Text } from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { settings } from "../../config/settings";
import type { AssistantThinkingRenderer } from "../../extensibility/extensions/types";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import { resolveAbortLabel, shouldRenderAbortReason } from "../../session/messages";
import { getPreviewLines, resolveImageOptions, TRUNCATE_LENGTHS } from "../../tools/render-utils";

/**
 * Max lines of a turn-ending provider error rendered inline in the transcript.
 * Bounds pathological error bodies — e.g. a proxy 502 whose body is a full HTML
 * page — so they can't flood the scrollback. Blank lines are dropped and each
 * line is width-truncated by {@link getPreviewLines}. Full text is still kept in
 * the persisted session.
 */
const MAX_TRANSCRIPT_ERROR_LINES = 8;

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	#contentContainer: Container;
	#lastMessage?: AssistantMessage;
	#toolImagesByCallId = new Map<string, ImageContent[]>();
	#usageInfo?: Usage;
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
	/** Whether the last updateContent carried an in-flight streaming partial; such
	 *  renders bypass the markdown module LRU (see Markdown.transientRenderCache). */
	#lastUpdateTransient = false;

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
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
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

	markTranscriptBlockFinalized(): void {
		this.#transcriptBlockFinalized = true;
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

	setUsageInfo(usage: Usage): void {
		this.#usageInfo = usage;
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
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

	updateContent(message: AssistantMessage, opts?: { transient?: boolean }): void {
		this.#lastMessage = message;
		this.#lastUpdateTransient = opts?.transient === true;

		// Clear content container
		this.#contentContainer.clear();

		const hasVisibleContent = message.content.some(
			c =>
				(c.type === "text" && c.text.trim()) ||
				(!this.hideThinkingBlock && c.type === "thinking" && c.thinking.trim()),
		);

		// Render content in order
		let thinkingIndex = 0;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				const markdown = new Markdown(content.text.trim(), 1, 0, getMarkdownTheme());
				markdown.transientRenderCache = this.#lastUpdateTransient;
				this.#contentContainer.addChild(markdown);
			} else if (content.type === "thinking" && content.thinking.trim()) {
				if (this.hideThinkingBlock) {
					thinkingIndex += 1;
					continue;
				}
				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some(c => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				const thinkingText = content.thinking.trim();
				// Thinking traces in thinkingText color, italic
				const thinkingMarkdown = new Markdown(thinkingText, 1, 0, getMarkdownTheme(), {
					color: (text: string) => theme.fg("thinkingText", text),
					italic: true,
				});
				thinkingMarkdown.transientRenderCache = this.#lastUpdateTransient;
				this.#contentContainer.addChild(thinkingMarkdown);
				this.#appendThinkingExtensions(i, thinkingIndex, thinkingText);
				thinkingIndex += 1;
				if (hasVisibleContentAfter) {
					this.#contentContainer.addChild(new Spacer(1));
				}
			}
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

		// Token usage metadata
		if (settings.get("display.showTokenUsage") && this.#usageInfo) {
			const usage = this.#usageInfo;
			const totalInput = usage.input + usage.cacheWrite;
			const parts: string[] = [];
			parts.push(`${theme.icon.input} ${formatNumber(totalInput)}`);
			parts.push(`${theme.icon.output} ${formatNumber(usage.output)}`);
			if (usage.cacheRead > 0) {
				parts.push(`cache: ${formatNumber(usage.cacheRead)}`);
			}
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(theme.fg("dim", parts.join("  ")), 1, 0));
		}
	}
}

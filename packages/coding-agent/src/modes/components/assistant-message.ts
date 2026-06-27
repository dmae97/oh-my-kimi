import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import { Container, Image, type ImageBudget, ImageProtocol, Markdown, Spacer, TERMINAL, Text } from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import type { AssistantThinkingRenderer } from "../../extensibility/extensions/types";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import { resolveAbortLabel, shouldRenderAbortReason } from "../../session/messages";
import { getPreviewLines, resolveImageOptions, TRUNCATE_LENGTHS } from "../../tools/render-utils";
import { canonicalizeMessage, formatThinkingForDisplay, hasDisplayableThinking } from "../../utils/thinking-display";
import { type CacheInvalidation, CacheInvalidationMarkerComponent } from "./cache-invalidation-marker";

/**
 * Max lines of a turn-ending provider error rendered inline in the transcript.
 * Bounds pathological error bodies — e.g. a proxy 502 whose body is a full HTML
 * page — so they can't flood the scrollback. Blank lines are dropped and each
 * line is width-truncated by {@link getPreviewLines}. Full text is still kept in
 * the persisted session.
 */
const MAX_TRANSCRIPT_ERROR_LINES = 8;

/**
 * A GFM table delimiter row (`| --- | :--: |`, with or without bounding pipes).
 * The header row alone does not render a table — this delimiter is what makes
 * Markdown lay one out, and a streaming table re-aligns its columns as rows
 * arrive. Requires at least one column pipe so a bare thematic break (`---`)
 * does not match.
 */
const MARKDOWN_TABLE_DELIMITER = /^ {0,3}\|?(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*:?-*:?[ \t]*$/;

/** Opening or closing fence of a code block: ≥3 backticks/tildes plus info string. */
const CODE_FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

type ThinkingContentBlock = Extract<AssistantMessage["content"][number], { type: "thinking" }>;
type DisplayThinkingContentBlock = ThinkingContentBlock & { rawThinking?: string };

function resolveThinkingDisplay(block: ThinkingContentBlock, proseOnly: boolean): { text: string; visible: boolean } {
	const rawThinking = (block as DisplayThinkingContentBlock).rawThinking ?? block.thinking;
	const formatted = formatThinkingForDisplay(block.thinking, proseOnly);
	return {
		text: formatted.trim(),
		visible: hasDisplayableThinking(rawThinking, formatted),
	};
}

/**
 * Whether `text` currently contains reflowing Markdown whose layout is not yet
 * permanent: an open ` ```mermaid ` fence (the diagram reshapes as source
 * arrives) or a GFM table (columns re-align as rows arrive). Used by
 * {@link AssistantMessageComponent.isTranscriptBlockCommitStable}.
 *
 * Fence-aware: a mermaid block is detected by its opener, and table delimiters
 * inside ordinary fenced code (shell pipes, ASCII separators, doc examples) are
 * ignored so a long streamed code block is never held out of native scrollback.
 * A delimiter counts only directly under a pipe-bearing header row, outside any
 * code fence.
 */
function detectLiveReflowingMarkdown(text: string): boolean {
	let fence: string | null = null;
	let prevLine = "";
	for (const line of text.split("\n")) {
		const fenceMatch = CODE_FENCE_LINE.exec(line);
		if (fence !== null) {
			// Inside a code block: only a bare matching closing fence ends it.
			if (
				fenceMatch &&
				fenceMatch[2]!.trim() === "" &&
				fenceMatch[1]![0] === fence[0] &&
				fenceMatch[1]!.length >= fence.length
			) {
				fence = null;
			}
			continue;
		}
		if (fenceMatch) {
			if (/^mermaid\b/.test(fenceMatch[2]!.trim())) return true;
			fence = fenceMatch[1]!;
			prevLine = "";
			continue;
		}
		if (prevLine.includes("|") && MARKDOWN_TABLE_DELIMITER.test(line)) return true;
		prevLine = line;
	}
	return false;
}

/**
 * Frames for the streaming "thinking" pulse rendered in place of a hidden
 * thinking block while the model is still producing it. A single fixed-width
 * starburst cycles through facets (✻ ✼ ❉ ❊ ✺ ✹ ✸ ✶) so the indicator animates
 * in place without shifting the line or the trailing speed badge. The dwell per
 * frame eases between {@link THINKING_DOTS_FRAME_MS_MIN} and
 * {@link THINKING_DOTS_FRAME_MS_MAX} across each revolution (see
 * {@link AssistantMessageComponent.thinkingDotsFrameDelay}).
 */
const THINKING_DOTS_FRAMES = ["✻", "✼", "❉", "❊", "✺", "✹", "✸", "✶"] as const;
/**
 * Pulse cadence bounds (ms). Each frame's dwell eases between these on a
 * raised-cosine "breath" — quickest at the cycle start, slowest at its midpoint —
 * so the starburst accelerates and slows instead of ticking at one fixed rate.
 * Mean ≈ 150ms, snappier than the previous flat 320ms.
 */
const THINKING_DOTS_FRAME_MS_MIN = 70;
const THINKING_DOTS_FRAME_MS_MAX = 230;

/** Rolling window (ms) over which streaming-rate observations are averaged. */
const SPEED_WINDOW_MS = 3000;
/** Color/clamp ceiling: a rate at or above this maps to the full accent color. */
const SPEED_MAX = 200;

/**
 * Session-wide streaming-speed gauge. Only one thinking indicator animates at a
 * time, so a single shared instance accumulates instantaneous tok/s observations
 * and reports their windowed average — smoothing the jumpy per-delta numbers.
 * Each thinking block resets the gauge on its first live sample (see
 * {@link AssistantMessageComponent.updateContent}) so the average reflects only
 * the active block, never a previous turn's trailing rate. Components feed it
 * deltas (not cumulative totals), so a fresh turn restarting its token count at
 * zero never produces a spike.
 */
class SpeedTracker {
	#observations: Array<{ time: number; rate: number }> = [];

	#prune(now: number): void {
		const threshold = now - SPEED_WINDOW_MS;
		while (this.#observations.length > 0 && this.#observations[0]!.time < threshold) {
			this.#observations.shift();
		}
	}

	/** Record one instantaneous tok/s reading, clamped to {@link SPEED_MAX} so a
	 *  single oversized delta (e.g. a buffered reflow tick) can't poison the
	 *  windowed average. Non-finite/negative rates ignored. */
	observe(rate: number, now = performance.now()): void {
		if (!Number.isFinite(rate) || rate < 0) return;
		this.#observations.push({ time: now, rate: Math.min(rate, SPEED_MAX) });
		this.#prune(now);
	}

	/** Windowed-average tok/s; 0 once observations age out of the window. */
	getSpeed(now = performance.now()): number {
		this.#prune(now);
		if (this.#observations.length === 0) return 0;
		let sum = 0;
		for (const o of this.#observations) sum += o.rate;
		return sum / this.#observations.length;
	}

	reset(): void {
		this.#observations = [];
	}
}

/** One gauge for the whole session — see {@link SpeedTracker}. */
const sharedSpeedTracker = new SpeedTracker();

/** Test-only: clear the shared gauge so observations don't leak across cases. */
export function resetThinkingSpeedTracker(): void {
	sharedSpeedTracker.reset();
}

/**
 * Linear-interpolate two `#rrggbb` colors in sRGB space. `t` clamps to [0,1]:
 * `t = 0` → `from`, `t = 1` → `to`. Drives the streaming speed badge, fading
 * from a dim gray toward the theme accent as tok/s rises.
 */
function lerpHex(from: string, to: string, t: number): string {
	const k = t < 0 ? 0 : t > 1 ? 1 : t;
	const fr = Number.parseInt(from.slice(1, 3), 16);
	const fg = Number.parseInt(from.slice(3, 5), 16);
	const fb = Number.parseInt(from.slice(5, 7), 16);
	const tr = Number.parseInt(to.slice(1, 3), 16);
	const tg = Number.parseInt(to.slice(3, 5), 16);
	const tb = Number.parseInt(to.slice(5, 7), 16);
	const r = Math.round(fr + (tr - fr) * k);
	const g = Math.round(fg + (tg - fg) * k);
	const b = Math.round(fb + (tb - fb) * k);
	return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	#contentContainer: Container;
	#markerSlot: Container;
	#lastMessage?: AssistantMessage;
	#toolImagesByCallId = new Map<string, ImageContent[]>();
	#convertedKittyImages = new Map<string, ImageContent>();
	#kittyConversionsInFlight = new Set<string>();
	#transcriptBlockFinalized: boolean;
	/**
	 * True while a non-finalized text item carries reflowing Markdown — a
	 * ` ```mermaid ` fence or a GFM table — whose layout re-flows every frame as
	 * source arrives (a diagram reshaping, a table re-aligning its columns), so
	 * no prefix is byte-stable until the message finalizes. See
	 * {@link isTranscriptBlockCommitStable}. Recomputed in {@link updateContent}
	 * ahead of the fast-path return, so it tracks every stream tick.
	 */
	#hasLiveReflowingMarkdown = false;
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
	/** Previous cumulative provider token count + timestamp, for deriving this
	 *  block's instantaneous streaming rate fed into {@link sharedSpeedTracker}.
	 *  Undefined until the first thinking update of this block. */
	#lastTokenCount: number | undefined;
	#lastTokenTime = 0;
	/** Provider-reported tokens in the live thinking block — reasoning tokens when
	 *  the provider streams them, else total output — shown dimmed beside the
	 *  speed badge. 0 when no thinking is streaming. */
	#thinkingTokens = 0;
	/** Whether this block has observed a positive provider-token delta — i.e. it is
	 *  genuinely streaming tokens right now. Gates the numeric speed badge so the
	 *  session-wide {@link sharedSpeedTracker} can't surface a previous turn's rate
	 *  on a fresh block that has no live token throughput of its own. */
	#thinkingRateLive = false;

	constructor(
		message?: AssistantMessage,
		private hideThinkingBlock = false,
		private readonly onImageUpdate?: () => void,
		private readonly thinkingRenderers: readonly AssistantThinkingRenderer[] = [],
		private readonly imageBudget?: ImageBudget,
		private proseOnlyThinking = true,
	) {
		super();
		this.#transcriptBlockFinalized = message !== undefined;

		// Slim cache-invalidation divider, populated above the content when this
		// turn's request lost the prompt cache (see setCacheInvalidation).
		this.#markerSlot = new Container();
		this.addChild(this.#markerSlot);

		// Container for text/thinking content
		this.#contentContainer = new Container();
		this.addChild(this.#contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	/**
	 * Show or clear the slim cache-invalidation divider above this turn. Set at
	 * `message_end` (live) or during rebuild, once the turn's usage is known and
	 * compared against the previous turn's cache footprint. Bumps the transcript
	 * block version so the change repaints even after content finalized.
	 */
	setCacheInvalidation(info: CacheInvalidation | undefined): void {
		this.#markerSlot.clear();
		if (info) {
			this.#markerSlot.addChild(new CacheInvalidationMarkerComponent(info));
		}
		this.#blockVersion++;
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

	setProseOnlyThinking(proseOnly: boolean): void {
		this.proseOnlyThinking = proseOnly;
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
		const coloredGlyph = theme.fg("thinkingText", glyph);
		const rate = Math.min(SPEED_MAX, sharedSpeedTracker.getSpeed());
		// The numeric badge ("<total> · <rate> toks/s") only renders while this block
		// is genuinely streaming provider tokens. A block that has observed no token
		// delta (e.g. a provider that reports usage only at turn end) or whose rate
		// has decayed to zero (a streaming lull) drops it entirely — the bare pulse
		// keeps signalling that the model is thinking. The liveness flag also stops
		// the session-wide gauge from leaking a previous turn's rate onto a fresh
		// token-less block.
		if (!this.#thinkingRateLive || rate < 0.05) return coloredGlyph;
		// Total provider tokens, dimmed, sit next to the pulse.
		const totalSpan = this.#thinkingTokens > 0 ? theme.fg("dim", ` ${formatNumber(this.#thinkingTokens)}`) : "";
		// Speed badge color: dim gray at rest, brightening toward the theme accent as
		// streaming speed climbs (gray → bright accent). Ease (sqrt) so typical
		// mid-stream rates already read as clearly accent-tinted instead of staying
		// gray until the rarely-hit SPEED_MAX ceiling.
		const ratio = Math.sqrt(rate / SPEED_MAX);
		const hex = lerpHex(theme.getColorHex("dim"), theme.getAccentColorHex(), ratio);
		const rateText = ` · ${rate.toFixed(1)} toks/s`;
		const rateSpan = theme.getColorMode() === "truecolor" ? chalk.hex(hex)(rateText) : theme.fg("muted", rateText);
		return coloredGlyph + totalSpan + rateSpan;
	}

	#startThinkingAnimation(): void {
		if (this.#thinkingDotsTimer) return;
		this.#scheduleThinkingFrame();
	}

	/** Eased dwell (ms) for the current pulse frame: a raised cosine over the
	 *  8-frame cycle, continuous across the wrap, so the rotation breathes rather
	 *  than advancing at a fixed interval. */
	#thinkingDotsFrameDelay(): number {
		const phase = (1 - Math.cos((2 * Math.PI * this.#thinkingDotsFrame) / THINKING_DOTS_FRAMES.length)) / 2;
		return THINKING_DOTS_FRAME_MS_MIN + (THINKING_DOTS_FRAME_MS_MAX - THINKING_DOTS_FRAME_MS_MIN) * phase;
	}

	/** Self-rescheduling timeout (not a fixed interval) so each frame can pick its
	 *  own eased dwell. */
	#scheduleThinkingFrame(): void {
		this.#thinkingDotsTimer = setTimeout(() => this.#advanceThinkingDots(), this.#thinkingDotsFrameDelay());
		this.#thinkingDotsTimer.unref?.();
	}

	#advanceThinkingDots(): void {
		this.#thinkingDotsTimer = undefined;
		if (!this.#thinkingDots) {
			this.#stopThinkingAnimation();
			return;
		}
		this.#thinkingDotsFrame = (this.#thinkingDotsFrame + 1) % THINKING_DOTS_FRAMES.length;
		if (this.#thinkingDots.setText(this.#thinkingDotsLabel())) {
			this.onImageUpdate?.();
		}
		this.#scheduleThinkingFrame();
	}

	#stopThinkingAnimation(): void {
		if (this.#thinkingDotsTimer) {
			clearTimeout(this.#thinkingDotsTimer);
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

	/**
	 * Whether this still-live block's scrolled-off rows may be committed to
	 * immutable native scrollback (the {@link TranscriptContainer} durable-
	 * snapshot path). Reflowing Markdown — a streaming mermaid diagram or a GFM
	 * table — re-lays-out its body as source arrives (the diagram reshapes, the
	 * table re-aligns its columns), so committing an intermediate layout strands
	 * a stale fragment in native scrollback that only a full repaint (Ctrl+L) can
	 * clear. While such content is still streaming the block therefore stays
	 * wholly in the repaintable live region and commits once, at its final
	 * layout, when the turn finalizes.
	 */
	isTranscriptBlockCommitStable(): boolean {
		return this.#transcriptBlockFinalized || !this.#hasLiveReflowingMarkdown;
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
		const parts: string[] = [`htb:${this.hideThinkingBlock ? 1 : 0}|pot:${this.proseOnlyThinking ? 1 : 0}`];
		for (const content of message.content) {
			if (content.type === "text") {
				parts.push(canonicalizeMessage(content.text) ? "T1" : "T0");
			} else if (content.type === "thinking") {
				const display = resolveThinkingDisplay(content, this.proseOnlyThinking);
				if (!display.visible) parts.push("K0");
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
		if (message.stopReason === "aborted" && shouldRenderAbortReason(message)) return false;
		if (message.stopReason === "error" && !this.#errorPinned) return false;
		if (
			message.errorMessage &&
			shouldRenderAbortReason(message) &&
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
					if (content?.type === "thinking") {
						const display = resolveThinkingDisplay(content, this.proseOnlyThinking);
						if (display.text !== item.lastText) return false;
					}
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
				newText = resolveThinkingDisplay(content, this.proseOnlyThinking).text;
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
		if (this.#thinkingDots) {
			if (this.#thinkingDots.setText(this.#thinkingDotsLabel())) {
				this.onImageUpdate?.();
			}
		}
		return true;
	}

	updateContent(message: AssistantMessage, opts?: { transient?: boolean }): void {
		this.#blockVersion++;
		this.#lastMessage = message;
		this.#lastUpdateTransient = opts?.transient === true;

		// Streaming-speed gauge: only a live, in-flight render of the single
		// animating hidden-thinking block feeds the shared session tracker. The
		// token count is the provider's own cumulative output — reasoning tokens when
		// reported (Gemini's thoughtsTokenCount, OpenAI's reasoning_tokens), else
		// total output tokens — never a character estimate, which undercounts when
		// the provider streams a summarized reasoning trace. An instantaneous tok/s
		// is derived from this block's delta and handed to the windowed averager.
		// Only transient renders count: the final non-transient render at
		// message_end carries the turn's end-of-stream usage, whose jump would spike
		// the gauge and pollute the next block. Providers that report usage only at
		// turn end leave the live count flat, so the rate stays 0 and the badge
		// self-suppresses (see #thinkingDotsLabel).
		const isThinkingNow = this.#lastUpdateTransient && this.#shouldAnimateThinking(message);
		if (isThinkingNow) {
			const currentTokens = message.usage.reasoningTokens ?? message.usage.output;
			this.#thinkingTokens = currentTokens;
			const now = performance.now();
			if (this.#lastTokenCount !== undefined) {
				const tokenDelta = currentTokens - this.#lastTokenCount;
				const elapsedMs = now - this.#lastTokenTime;
				if (tokenDelta > 0 && elapsedMs > 0) {
					// First live sample of this block: drop the session gauge's prior-turn
					// observations so the windowed average reflects only this block.
					if (!this.#thinkingRateLive) sharedSpeedTracker.reset();
					sharedSpeedTracker.observe((tokenDelta / elapsedMs) * 1000, now);
					this.#thinkingRateLive = true;
				}
			}
			this.#lastTokenCount = currentTokens;
			this.#lastTokenTime = now;
		} else {
			this.#lastTokenCount = undefined;
			this.#thinkingTokens = 0;
			this.#thinkingRateLive = false;
		}

		// Streaming reflowing Markdown (a mermaid diagram reshaping, a GFM table
		// re-aligning columns) re-lays-out its body each frame; see
		// isTranscriptBlockCommitStable. Detect it from raw text — a Markdown
		// parser only resolves these once the closing fence / delimiter row
		// arrives, but the stale native-scrollback commits happen mid-stream.
		this.#hasLiveReflowingMarkdown = message.content.some(
			content => content.type === "text" && detectLiveReflowingMarkdown(content.text),
		);

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
				(!this.hideThinkingBlock &&
					c.type === "thinking" &&
					resolveThinkingDisplay(c, this.proseOnlyThinking).visible),
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
			} else if (content.type === "thinking" && resolveThinkingDisplay(content, this.proseOnlyThinking).visible) {
				const thinkingText = resolveThinkingDisplay(content, this.proseOnlyThinking).text;
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
							(c.type === "thinking" && resolveThinkingDisplay(c, this.proseOnlyThinking).visible),
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
			if (message.stopReason === "aborted" && shouldRenderAbortReason(message)) {
				const abortMessage = resolveAbortLabel(message);
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
			shouldRenderAbortReason(message) &&
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

/**
 * Snapcompact inline imaging: per-request transform that swaps the system
 * prompt and/or large historical tool results for dense PNG frames on
 * vision-capable models.
 *
 * Runs inside the agent loop's `transformProviderContext` hook — after the
 * persisted history is converted to the outgoing `Context`, before the
 * provider stream call. It only ever builds NEW message objects/arrays; the
 * input context shares `content` array references with the persisted
 * `SessionMessageEntry` messages, so mutation would leak rendered images
 * into session.jsonl.
 */
import type { Context, ImageContent, Model, TextContent, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { countTokens } from "@oh-my-pi/pi-natives";
import * as snapcompact from "@oh-my-pi/snapcompact";
import systemFramesNote from "../prompts/system/snapcompact-system-frames-note.md" with { type: "text" };
import systemStub from "../prompts/system/snapcompact-system-stub.md" with { type: "text" };
import toolResultNote from "../prompts/system/snapcompact-toolresult-note.md" with { type: "text" };

export interface SnapcompactInlineOptions {
	renderSystemPrompt: boolean;
	renderToolResults: boolean;
}

/**
 * Image-count budget per provider. Snapcompact frames are 1568px (<2000px) so
 * dimension/size limits never bind; only COUNT does. Strictest mainstream is
 * Groq (~5), so unknown providers get the safe floor.
 */
const INLINE_IMAGE_BUDGET_BY_PROVIDER: Record<string, number> = {
	anthropic: 90,
	"amazon-bedrock": 90,
	openai: 200,
	google: 200,
	"google-vertex": 200,
	"google-gemini-cli": 200,
};
const DEFAULT_INLINE_IMAGE_BUDGET = 5;
const MAX_SYSTEM_PROMPT_FRAMES = 6;
/** Tool results under this many tokens are never rasterized — the swap can't
 *  save enough to justify trading crisp text for an image. */
const MIN_TOOL_RESULT_TOKENS = 3000;
/** Render only if imageTokens <= textTokens * SAVINGS_MARGIN. */
const SAVINGS_MARGIN = 0.9;

/** Count image blocks already present across all message contents. */
function countContextImages(context: Context): number {
	let count = 0;
	for (const message of context.messages) {
		const content = message.content;
		if (typeof content === "string") continue;
		for (const block of content) {
			if (block.type === "image") count++;
		}
	}
	return count;
}

function isTextContent(block: TextContent | ImageContent): block is TextContent {
	return block.type === "text";
}

/** Image tokens must undercut text tokens by the margin to be worth rendering. */
function passesSavingsGate(frames: number, shape: snapcompact.Shape, textTokens: number): boolean {
	return frames * shape.frameTokenEstimate <= textTokens * SAVINGS_MARGIN;
}

interface FrameCacheEntry {
	hash: number | bigint;
	frames: ImageContent[];
}

/**
 * Stateless with respect to the model (passed per call, so mid-session model
 * switches re-resolve shape and budget); stateful only for the render caches,
 * which live as long as the session's Agent.
 */
export class SnapcompactInlineTransformer {
	/** Rendered tool-result frames keyed by toolCallId. */
	#toolCache = new Map<string, FrameCacheEntry>();
	#systemCache?: FrameCacheEntry;

	constructor(private readonly options: SnapcompactInlineOptions) {}

	transform(context: Context, model: Model): Context {
		// Vision gate: providers silently DROP images on text-only models —
		// rendering would lose the content entirely.
		if (!model.input.includes("image")) return context;

		const shape = snapcompact.resolveShape(model.api);
		let budget =
			(INLINE_IMAGE_BUDGET_BY_PROVIDER[model.provider] ?? DEFAULT_INLINE_IMAGE_BUDGET) - countContextImages(context);
		if (budget <= 0) return context;

		const messages = [...context.messages];
		let changed = false;

		if (this.options.renderToolResults) {
			const toolResultIndices: number[] = [];
			const liveToolCallIds = new Set<string>();
			for (let i = 0; i < messages.length; i++) {
				const message = messages[i];
				if (message.role !== "toolResult") continue;
				toolResultIndices.push(i);
				liveToolCallIds.add(message.toolCallId);
			}
			// Oldest-first for cache-stable bytes; skip the LAST tool result so
			// the freshest output stays crisp text.
			for (let k = 0; k < toolResultIndices.length - 1 && budget > 0; k++) {
				const index = toolResultIndices[k];
				const message = messages[index] as ToolResultMessage;
				// Don't re-image results that already carry images (screenshots etc.).
				if (message.content.some(block => block.type === "image")) continue;
				const text = message.content
					.filter(isTextContent)
					.map(block => block.text)
					.join("\n");
				const textTokens = countTokens(text);
				if (textTokens < MIN_TOOL_RESULT_TOKENS) continue;
				const needed = snapcompact.frames(text, { shape });
				if (needed === 0 || needed > budget) continue;
				if (!passesSavingsGate(needed, shape, textTokens)) continue;
				const frames = this.#framesFor(this.#toolCache, message.toolCallId, text, shape);
				messages[index] = { ...message, content: [{ type: "text", text: toolResultNote }, ...frames] };
				budget -= frames.length;
				changed = true;
			}
			// Drop cache entries for tool calls no longer in the context
			// (compacted away) so the cache stays bounded by live history.
			for (const key of this.#toolCache.keys()) {
				if (!liveToolCallIds.has(key)) this.#toolCache.delete(key);
			}
		}

		let systemPrompt = context.systemPrompt;
		if (this.options.renderSystemPrompt && context.systemPrompt?.length && budget > 0) {
			const joined = context.systemPrompt.join("\n\n");
			const needed = snapcompact.frames(joined, { shape });
			const userIndex = messages.findIndex(message => message.role === "user");
			if (
				needed > 0 &&
				needed <= Math.min(budget, MAX_SYSTEM_PROMPT_FRAMES) &&
				passesSavingsGate(needed, shape, countTokens(joined)) &&
				// No user message to carry the frames → leave the prompt as text.
				userIndex >= 0
			) {
				const hash = Bun.hash(joined);
				let cached = this.#systemCache;
				if (!cached || cached.hash !== hash) {
					cached = {
						hash,
						frames: snapcompact.renderMany(joined, { shape, maxFrames: MAX_SYSTEM_PROMPT_FRAMES }),
					};
					this.#systemCache = cached;
				}
				const frames = cached.frames;
				const original = messages[userIndex] as UserMessage;
				const originalContent: (TextContent | ImageContent)[] =
					typeof original.content === "string" ? [{ type: "text", text: original.content }] : original.content;
				messages[userIndex] = {
					...original,
					content: [{ type: "text", text: systemFramesNote }, ...frames, ...originalContent],
				};
				systemPrompt = [systemStub];
				budget -= frames.length;
				changed = true;
			}
		}

		if (!changed) return context;
		return { ...context, systemPrompt, messages };
	}

	#framesFor(
		cache: Map<string, FrameCacheEntry>,
		key: string,
		text: string,
		shape: snapcompact.Shape,
	): ImageContent[] {
		const hash = Bun.hash(text);
		const cached = cache.get(key);
		if (cached && cached.hash === hash) return cached.frames;
		const frames = snapcompact.renderMany(text, { shape });
		cache.set(key, { hash, frames });
		return frames;
	}
}

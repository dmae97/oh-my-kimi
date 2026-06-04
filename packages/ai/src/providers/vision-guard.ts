import type { ImageContent, Model, TextContent } from "../types";

export const NON_VISION_IMAGE_PLACEHOLDER = "[image omitted: model does not support vision]";

export function partitionVisionContent(
	content: ReadonlyArray<TextContent | ImageContent>,
	supportsImages: boolean,
): {
	textBlocks: TextContent[];
	imageBlocks: ImageContent[];
	omittedImages: boolean;
} {
	const textBlocks = content.filter((block): block is TextContent => block.type === "text");
	const imageBlocks = content.filter((block): block is ImageContent => block.type === "image");
	return {
		textBlocks,
		imageBlocks: supportsImages ? imageBlocks : [],
		omittedImages: !supportsImages && imageBlocks.length > 0,
	};
}

export function joinTextWithImagePlaceholder(text: string, omittedImages: boolean): string {
	const parts: string[] = [];
	if (text.length > 0) {
		parts.push(text);
	}
	if (omittedImages) {
		parts.push(NON_VISION_IMAGE_PLACEHOLDER);
	}
	return parts.join("\n");
}

/**
 * Detect Qwen models served via Alibaba DashScope's consumer
 * `compatible-mode` endpoint that the upstream chat-completions API rejects
 * multimodal content arrays for. Vision support on that endpoint is gated by
 * id — only `-vl-` / `-omni-` / `-audio-` variants accept `image_url` parts;
 * everything else (text-only `qwen-max`, `qwen3.7-max`, `qwen3-coder-*`, …)
 * 400s with `Unexpected item type in content.` when sent an image.
 *
 * The check intentionally ignores the `coding-intl.dashscope.aliyuncs.com`
 * coding-plan endpoint — its SKUs (e.g. `qwen3.5-plus`, `qwen3.6-plus`) are
 * genuinely multimodal and rely on the catalog `input` field.
 *
 * Used as a defensive override in `convertMessages` so a misconfigured custom
 * provider (issue #1859) can't drive the request into an unrecoverable 400.
 */
export function isDashscopeCompatibleModeTextOnlyQwen(model: Model<"openai-completions">): boolean {
	const baseUrl = model.baseUrl.toLowerCase();
	if (!baseUrl.includes("dashscope") || !baseUrl.includes("aliyuncs.com") || !baseUrl.includes("/compatible-mode")) {
		return false;
	}
	const id = model.id.toLowerCase();
	if (!id.includes("qwen")) return false;
	return !/-(?:vl|omni|audio)\b/.test(id);
}

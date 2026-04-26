import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type Api, type AssistantMessage, completeSimple, type Model } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import { expandRoleAlias, resolveModelFromString } from "../config/model-resolver";
import inspectImageDescription from "../prompts/tools/inspect-image.md" with { type: "text" };
import inspectImageSystemPromptTemplate from "../prompts/tools/inspect-image-system.md" with { type: "text" };
import {
	ImageInputTooLargeError,
	type LoadedImageInput,
	loadImageInput,
	MAX_IMAGE_INPUT_BYTES,
} from "../utils/image-loading";
import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";

const inspectImageSchema = Type.Object(
	{
		path: Type.String({ description: "image path", examples: ["image.png"] }),
		question: Type.String({ description: "question about image", examples: ["What is in this image?"] }),
	},
	{ additionalProperties: false },
);

export type InspectImageParams = Static<typeof inspectImageSchema>;

export interface InspectImageToolDetails {
	model: string;
	imagePath: string;
	mimeType: string;
}

function extractResponseText(message: AssistantMessage): string {
	return message.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("")
		.trim();
}

export class InspectImageTool implements AgentTool<typeof inspectImageSchema, InspectImageToolDetails> {
	readonly name = "inspect_image";
	readonly label = "InspectImage";
	readonly description: string;
	readonly parameters = inspectImageSchema;
	readonly strict = false;

	constructor(
		private readonly session: ToolSession,
		private readonly completeImageRequest: typeof completeSimple = completeSimple,
	) {
		this.description = prompt.render(inspectImageDescription);
	}

	async execute(
		_toolCallId: string,
		params: InspectImageParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<InspectImageToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<InspectImageToolDetails>> {
		if (this.session.settings.get("images.blockImages")) {
			throw new ToolError(
				"Image submission is disabled by settings (images.blockImages=true). Disable it to use inspect_image.",
			);
		}

		const modelRegistry = this.session.modelRegistry;
		if (!modelRegistry) {
			throw new ToolError("Model registry is unavailable for inspect_image.");
		}

		const availableModels = modelRegistry.getAvailable();
		if (availableModels.length === 0) {
			throw new ToolError("No models available for inspect_image.");
		}

		const matchPreferences = { usageOrder: this.session.settings.getStorage()?.getModelUsageOrder() };
		const resolvePattern = (pattern: string | undefined): Model<Api> | undefined => {
			if (!pattern) return undefined;
			const expanded = expandRoleAlias(pattern, this.session.settings);
			return resolveModelFromString(expanded, availableModels, matchPreferences, modelRegistry);
		};

		const activeModelPattern = this.session.getActiveModelString?.() ?? this.session.getModelString?.();
		const model =
			resolvePattern("pi/vision") ??
			resolvePattern("pi/default") ??
			resolvePattern(activeModelPattern) ??
			availableModels[0];
		if (!model) {
			throw new ToolError("Unable to resolve a model for inspect_image.");
		}

		if (!model.input.includes("image")) {
			throw new ToolError(
				`Resolved model ${model.provider}/${model.id} does not support image input. Configure a vision-capable model for modelRoles.vision.`,
			);
		}

		const apiKey = await modelRegistry.getApiKey(model);
		if (!apiKey) {
			throw new ToolError(
				`No API key available for ${model.provider}/${model.id}. Configure credentials for this provider or choose another vision-capable model.`,
			);
		}

		let imageInput: LoadedImageInput | null;
		try {
			imageInput = await loadImageInput({
				path: params.path,
				cwd: this.session.cwd,
				autoResize: this.session.settings.get("images.autoResize"),
				maxBytes: MAX_IMAGE_INPUT_BYTES,
			});
		} catch (error) {
			if (error instanceof ImageInputTooLargeError) {
				throw new ToolError(error.message);
			}
			throw error;
		}

		if (!imageInput) {
			throw new ToolError("inspect_image only supports PNG, JPEG, GIF, and WEBP files detected by file content.");
		}

		const response = await this.completeImageRequest(
			model,
			{
				systemPrompt: prompt.render(inspectImageSystemPromptTemplate),
				messages: [
					{
						role: "user",
						content: [
							{ type: "image", data: imageInput.data, mimeType: imageInput.mimeType },
							{ type: "text", text: params.question },
						],
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey, signal },
		);

		if (response.stopReason === "error") {
			throw new ToolError(response.errorMessage ?? "inspect_image request failed.");
		}
		if (response.stopReason === "aborted") {
			throw new ToolError("inspect_image request aborted.");
		}

		const text = extractResponseText(response);
		if (!text) {
			throw new ToolError("inspect_image model returned no text output.");
		}

		return {
			content: [{ type: "text", text }],
			details: {
				model: `${model.provider}/${model.id}`,
				imagePath: imageInput.resolvedPath,
				mimeType: imageInput.mimeType,
			},
		};
	}
}

export { inspectImageToolRenderer } from "./inspect-image-renderer";

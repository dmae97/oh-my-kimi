/**
 * Zod schemas for the OpenAI chat-completions request shape we accept on the
 * gateway. Mirrors https://platform.openai.com/docs/api-reference/chat — only
 * the shapes the gateway translation layer understands. Unsupported fields
 * inside `stream_options` are rejected explicitly.
 */
import type {
	ChatCompletionContentPart,
	ChatCompletionCreateParams,
	ChatCompletionMessageParam,
	ChatCompletionMessageToolCall,
	ChatCompletionTool,
	ChatCompletionToolChoiceOption,
} from "openai/resources/chat/completions";
import * as z from "zod/v4";

// ─── User-message content parts ─────────────────────────────────────────────

export const textPartSchema = z.object({
	type: z.literal("text"),
	text: z.string(),
});

/**
 * OpenAI documents `image_url` as either `{ url: string }` or — older clients —
 * a bare string. Accept both shapes; downstream we extract a URL.
 */
export const imagePartSchema = z.object({
	type: z.literal("image_url"),
	image_url: z.union([z.string(), z.object({ url: z.string() })]),
});

export const userContentPartSchema = z.union([textPartSchema, imagePartSchema]);

// ─── Tool calls / tools ─────────────────────────────────────────────────────

export const toolCallSchema = z.object({
	id: z.string(),
	type: z.literal("function").optional(),
	function: z.object({
		name: z.string(),
		arguments: z.string(),
	}),
});

export const toolSchema = z.object({
	type: z.literal("function"),
	function: z.object({
		name: z.string().min(1),
		description: z.string().optional(),
		parameters: z.record(z.string(), z.unknown()).optional(),
	}),
});

// ─── Tool choice ────────────────────────────────────────────────────────────

export const toolChoiceSchema = z.union([
	z.literal("auto"),
	z.literal("none"),
	z.literal("required"),
	z.object({
		type: z.literal("function"),
		function: z.object({ name: z.string().min(1) }),
	}),
]);

// ─── Messages ───────────────────────────────────────────────────────────────

const baseContent = z.union([z.string(), z.array(userContentPartSchema)]);

export const systemMessageSchema = z.object({
	role: z.literal("system"),
	content: baseContent,
});

export const developerMessageSchema = z.object({
	role: z.literal("developer"),
	content: baseContent,
});

export const userMessageSchema = z.object({
	role: z.literal("user"),
	content: baseContent,
});

export const assistantMessageSchema = z.object({
	role: z.literal("assistant"),
	content: baseContent.optional(),
	tool_calls: z.array(toolCallSchema).optional(),
});

export const toolMessageSchema = z.object({
	role: z.literal("tool"),
	content: baseContent.optional(),
	tool_call_id: z.string().optional(),
});

export const messageSchema = z.discriminatedUnion("role", [
	systemMessageSchema,
	developerMessageSchema,
	userMessageSchema,
	assistantMessageSchema,
	toolMessageSchema,
]);

// ─── Stream options ─────────────────────────────────────────────────────────

export const streamOptionsSchema = z
	.object({
		include_usage: z.boolean().optional(),
	})
	.strict();

// ─── Stop sequences ─────────────────────────────────────────────────────────

export const stopSchema = z.union([z.string(), z.array(z.string())]);

// ─── Top-level request ──────────────────────────────────────────────────────

export const openaiChatRequestSchema = z.object({
	model: z.string().min(1),
	messages: z.array(messageSchema),
	tools: z.array(toolSchema).optional(),
	tool_choice: toolChoiceSchema.optional(),
	max_tokens: z.number().optional(),
	max_completion_tokens: z.number().optional(),
	temperature: z.number().optional(),
	top_p: z.number().optional(),
	stop: stopSchema.optional(),
	stream: z.boolean().optional(),
	stream_options: streamOptionsSchema.optional(),
	// Passthroughs surfaced to providers via options.extra. We accept any JSON
	// for them — the provider validates further if it cares.
	response_format: z.unknown().optional(),
	seed: z.number().optional(),
	presence_penalty: z.number().optional(),
	frequency_penalty: z.number().optional(),
	logit_bias: z.record(z.string(), z.number()).optional(),
	user: z.string().optional(),
});

/**
 * Public types are sourced from the OpenAI SDK so the gateway stays in
 * lock-step with the canonical API surface; the schemas above are runtime
 * validators for the subset we actually accept.
 */
export type OpenAIChatRequest = ChatCompletionCreateParams;
export type OpenAIChatMessage = ChatCompletionMessageParam;
export type OpenAIChatToolCall = ChatCompletionMessageToolCall;
export type OpenAIChatTool = ChatCompletionTool;
export type OpenAIChatToolChoice = ChatCompletionToolChoiceOption;
export type OpenAIChatContentPart = ChatCompletionContentPart;

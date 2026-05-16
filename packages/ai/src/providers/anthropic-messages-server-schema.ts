/**
 * Zod schemas for the Anthropic Messages API request shape we accept on the
 * gateway. Mirrors https://docs.anthropic.com/en/api/messages — only the
 * shapes the gateway actually understands; unsupported fields are caught with
 * `.refine(...)` so the error mentions them explicitly.
 *
 * Used by `anthropic-messages.ts:parseRequest` to validate the inbound JSON
 * before walking it into pi-ai's canonical `Context`.
 */
import type {
	ContentBlockParam,
	ImageBlockParam,
	MessageCreateParams,
	MessageParam,
	TextBlockParam,
	Tool,
	ToolChoice,
} from "@anthropic-ai/sdk/resources/messages";
import * as z from "zod/v4";

// `cache_control` is accepted and translated to pi-ai's per-request
// `cacheRetention` (any `ttl: "1h"` marker upgrades the request to "long";
// any other ephemeral marker maps to "short"). The walker doesn't try to
// preserve per-block breakpoints — pi-ai's anthropic provider re-applies them
// against the rebuilt outbound request anyway.
export const cacheControlSchema = z
	.object({
		type: z.literal("ephemeral"),
		ttl: z.union([z.literal("1h"), z.literal("5m")]).optional(),
	})
	.loose();

// ─── Sources / inner shapes ─────────────────────────────────────────────────

export const base64ImageSourceSchema = z.object({
	type: z.literal("base64"),
	data: z.string().min(1),
	media_type: z.string().min(1),
});

const textBlockSchema = z.object({
	type: z.literal("text"),
	text: z.string(),
	cache_control: cacheControlSchema.optional(),
});

const imageBlockSchema = z.object({
	type: z.literal("image"),
	source: base64ImageSourceSchema,
	cache_control: cacheControlSchema.optional(),
});

const thinkingBlockSchema = z.object({
	type: z.literal("thinking"),
	thinking: z.string(),
	signature: z.string().optional(),
});

const redactedThinkingBlockSchema = z.object({
	type: z.literal("redacted_thinking"),
	data: z.string(),
});

const toolUseBlockSchema = z.object({
	type: z.literal("tool_use"),
	id: z.string().min(1),
	name: z.string().min(1),
	input: z.record(z.string(), z.unknown()).optional(),
});

const toolResultContentBlockSchema = z.discriminatedUnion("type", [textBlockSchema, imageBlockSchema]);

const toolResultBlockSchema = z.object({
	type: z.literal("tool_result"),
	tool_use_id: z.string().min(1),
	content: z.union([z.string(), z.array(toolResultContentBlockSchema)]).optional(),
	is_error: z.boolean().optional(),
	cache_control: cacheControlSchema.optional(),
});

// ─── System ────────────────────────────────────────────────────────────────

const systemBlockSchema = z.object({
	type: z.literal("text"),
	text: z.string(),
	cache_control: cacheControlSchema.optional(),
});

export const systemSchema = z.union([z.string(), z.array(systemBlockSchema)]).optional();

// ─── Messages ──────────────────────────────────────────────────────────────

const userContentBlockSchema = z.discriminatedUnion("type", [textBlockSchema, imageBlockSchema, toolResultBlockSchema]);

const assistantContentBlockSchema = z.discriminatedUnion("type", [
	textBlockSchema,
	thinkingBlockSchema,
	redactedThinkingBlockSchema,
	toolUseBlockSchema,
]);

export const userMessageSchema = z.object({
	role: z.literal("user"),
	content: z.union([z.string(), z.array(userContentBlockSchema)]),
});

export const assistantMessageSchema = z.object({
	role: z.literal("assistant"),
	content: z.union([z.string(), z.array(assistantContentBlockSchema)]),
});

export const messageSchema = z.discriminatedUnion("role", [userMessageSchema, assistantMessageSchema]);

// ─── Tools ─────────────────────────────────────────────────────────────────

export const toolSchema = z.object({
	name: z.string().min(1),
	description: z.string().optional(),
	input_schema: z.record(z.string(), z.unknown()),
	cache_control: cacheControlSchema.optional(),
});

// ─── Tool choice ───────────────────────────────────────────────────────────

export const toolChoiceSchema = z
	.discriminatedUnion("type", [
		z.object({ type: z.literal("auto"), disable_parallel_tool_use: z.unknown().optional() }),
		z.object({ type: z.literal("any"), disable_parallel_tool_use: z.unknown().optional() }),
		z.object({ type: z.literal("none"), disable_parallel_tool_use: z.unknown().optional() }),
		z.object({
			type: z.literal("tool"),
			name: z.string().min(1),
			disable_parallel_tool_use: z.unknown().optional(),
		}),
	])
	.refine(value => value.disable_parallel_tool_use === undefined, {
		message: "tool_choice.disable_parallel_tool_use is not supported by this gateway",
	});

// ─── Thinking ──────────────────────────────────────────────────────────────

// Anthropic's three thinking shapes. `enabled` requires a budget; `disabled`
// suppresses reasoning even on models that default it on; `adaptive` lets the
// provider pick the budget on the fly. Extra hints (`display: "omitted"`, …)
// are accepted but ignored on the translate path.
export const thinkingConfigSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("enabled"),
		budget_tokens: z.number(),
		display: z.unknown().optional(),
	}),
	z.object({
		type: z.literal("disabled"),
		display: z.unknown().optional(),
	}),
	z.object({
		type: z.literal("adaptive"),
		budget_tokens: z.number().optional(),
		display: z.unknown().optional(),
	}),
]);

// ─── Top-level request ─────────────────────────────────────────────────────

export const anthropicMessagesRequestSchema = z.object({
	model: z.string().min(1),
	messages: z.array(messageSchema),
	max_tokens: z.number(),
	system: systemSchema,
	tools: z.array(toolSchema).optional(),
	tool_choice: toolChoiceSchema.optional(),
	temperature: z.number().optional(),
	top_p: z.number().optional(),
	top_k: z.number().optional(),
	stop_sequences: z.array(z.string()).optional(),
	stream: z.boolean().optional(),
	thinking: thinkingConfigSchema.optional(),
	// Spec fields that the gateway tolerates but doesn't translate. Anthropic
	// clients commonly send `metadata: { user_id }` — failing the request just
	// because we can't route it is hostile. They're accepted permissively and
	// silently dropped on the translate path.
	metadata: z.unknown().optional(),
	container: z.unknown().optional(),
	context_management: z.unknown().optional(),
	mcp_servers: z.unknown().optional(),
	service_tier: z.unknown().optional(),
});

/**
 * Public types are sourced from the upstream Anthropic SDK so the gateway
 * stays in lock-step with the canonical API surface; the schemas above are
 * runtime validators for the subset we actually accept.
 */
export type AnthropicMessagesRequest = MessageCreateParams;
export type AnthropicSystem = MessageCreateParams["system"];
export type AnthropicMessage = MessageParam;
export type AnthropicUserContentBlock = ContentBlockParam;
export type AnthropicAssistantContentBlock = ContentBlockParam;
export type AnthropicTool = Tool;
export type AnthropicToolChoice = ToolChoice;
export type AnthropicToolResultContent = TextBlockParam | ImageBlockParam;

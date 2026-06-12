/**
 * Zod schemas for the Anthropic Messages API request shape we accept on the
 * gateway. Mirrors https://docs.anthropic.com/en/api/messages — only the
 * shapes the gateway actually understands; unsupported fields are caught with
 * `.refine(...)` so the error mentions them explicitly.
 *
 * Used by `anthropic-messages.ts:parseRequest` to validate the inbound JSON
 * before walking it into pi-ai's canonical `Context`.
 */

import * as z from "zod/v4";
import type {
	ContentBlockParam,
	ImageBlockParam,
	MessageCreateParams,
	MessageParam,
	TextBlockParam,
	Tool,
	ToolChoice,
} from "./anthropic-wire";

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

export const urlImageSourceSchema = z.object({
	type: z.literal("url"),
	url: z.url(),
});

export const fileImageSourceSchema = z.object({
	type: z.literal("file"),
	file_id: z.string().min(1),
});

export const imageSourceSchema = z.discriminatedUnion("type", [
	base64ImageSourceSchema,
	urlImageSourceSchema,
	fileImageSourceSchema,
]);

const textBlockSchema = z.object({
	type: z.literal("text"),
	text: z.string(),
	cache_control: cacheControlSchema.optional(),
});

const imageBlockSchema = z.object({
	type: z.literal("image"),
	source: imageSourceSchema,
	cache_control: cacheControlSchema.optional(),
});

const thinkingBlockSchema = z.object({
	type: z.literal("thinking"),
	thinking: z.string(),
	signature: z.string().optional(),
	cache_control: cacheControlSchema.optional(),
});

const redactedThinkingBlockSchema = z.object({
	type: z.literal("redacted_thinking"),
	data: z.string(),
	cache_control: cacheControlSchema.optional(),
});

const toolUseBlockSchema = z.object({
	type: z.literal("tool_use"),
	id: z.string().min(1),
	name: z.string().min(1),
	input: z.record(z.string(), z.unknown()).optional(),
	cache_control: cacheControlSchema.optional(),
});

const toolResultContentBlockSchema = z.discriminatedUnion("type", [textBlockSchema, imageBlockSchema]);

const toolResultBlockSchema = z.object({
	type: z.literal("tool_result"),
	tool_use_id: z.string().min(1),
	content: z.union([z.string(), z.array(toolResultContentBlockSchema)]).optional(),
	is_error: z.boolean().optional(),
	cache_control: cacheControlSchema.optional(),
});

// Catch-all for content block variants Anthropic ships that the gateway doesn't
// natively understand (server_tool_use, web_search_tool_result, mcp_*,
// container_upload, code_execution_*, document, …). The walker flattens these
// to a text placeholder so legitimate Anthropic clients don't get rejected.
// Known `type` values are excluded so a malformed known block (e.g.
// `{type:"text", text: 123}`) fails validation with a clean 400 instead of
// slipping past the discriminated union and throwing a TypeError downstream.
function unknownContentBlockSchema(knownTypes: readonly string[]) {
	const known = new Set(knownTypes);
	return z
		.object({
			type: z.string().refine(t => !known.has(t), { message: "malformed known content block" }),
		})
		.loose();
}

// ─── System ────────────────────────────────────────────────────────────────

const systemBlockSchema = z.object({
	type: z.literal("text"),
	text: z.string(),
	cache_control: cacheControlSchema.optional(),
});

export const systemSchema = z.union([z.string(), z.array(systemBlockSchema)]).optional();

// ─── Messages ──────────────────────────────────────────────────────────────

const userContentBlockSchema = z.union([
	z.discriminatedUnion("type", [textBlockSchema, imageBlockSchema, toolResultBlockSchema]),
	unknownContentBlockSchema(["text", "image", "tool_result"]),
]);

const assistantContentBlockSchema = z.union([
	z.discriminatedUnion("type", [
		textBlockSchema,
		thinkingBlockSchema,
		redactedThinkingBlockSchema,
		toolUseBlockSchema,
	]),
	unknownContentBlockSchema(["text", "thinking", "redacted_thinking", "tool_use"]),
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

// `disable_parallel_tool_use` is accepted on every variant; the walker maps it
// onto `options.parallelToolCalls = !disable_parallel_tool_use`.
export const toolChoiceSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("auto"), disable_parallel_tool_use: z.boolean().optional() }),
	z.object({ type: z.literal("any"), disable_parallel_tool_use: z.boolean().optional() }),
	z.object({ type: z.literal("none"), disable_parallel_tool_use: z.boolean().optional() }),
	z.object({
		type: z.literal("tool"),
		name: z.string().min(1),
		disable_parallel_tool_use: z.boolean().optional(),
	}),
]);

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

const taskBudgetSchema = z.object({
	type: z.literal("tokens"),
	total: z.number(),
	remaining: z.number().optional(),
});

const outputConfigSchema = z.object({
	effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
	task_budget: taskBudgetSchema.optional(),
	format: z.unknown().optional(),
});

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
	output_config: outputConfigSchema.optional(),
	// Anthropic clients commonly send `metadata: { user_id }`; the walker
	// surfaces it on `options.metadata` for downstream provider forwarding.
	metadata: z.record(z.string(), z.unknown()).optional(),
	// Spec fields that the gateway tolerates but doesn't translate yet.
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

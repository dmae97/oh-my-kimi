/**
 * Zod schemas for the OpenAI Responses API request shape we accept on the
 * gateway. Mirrors https://platform.openai.com/docs/api-reference/responses —
 * only the item types the gateway translation layer understands. Unsupported
 * controls (background/include/metadata/prompt/…) are caught explicitly with
 * `.refine(...)` so the error message names them.
 */
import type {
	EasyInputMessage,
	ResponseCreateParams,
	ResponseFunctionToolCall,
	ResponseInputContent,
	ResponseInputItem,
	ResponseOutputMessage,
	ResponseReasoningItem,
	Tool as ResponsesTool,
} from "openai/resources/responses/responses";
import * as z from "zod/v4";

// ─── Input items ────────────────────────────────────────────────────────────

const inputTextSchema = z.object({
	type: z.literal("input_text"),
	text: z.string(),
});

const outputTextSchema = z.object({
	type: z.literal("output_text"),
	text: z.string(),
});

const summaryTextSchema = z.object({
	type: z.literal("summary_text"),
	text: z.string(),
});

const reasoningTextSchema = z.object({
	type: z.literal("reasoning_text"),
	text: z.string(),
});

const plainTextSchema = z.object({
	type: z.literal("text"),
	text: z.string(),
});

const inputContentBlockSchema = z.union([inputTextSchema, plainTextSchema]);
const outputContentBlockSchema = z.union([outputTextSchema, plainTextSchema]);

const userMessageItemSchema = z.object({
	type: z.literal("message").optional(),
	role: z.union([z.literal("user"), z.literal("developer")]),
	content: z.union([z.string(), z.array(inputContentBlockSchema)]).optional(),
});

const systemMessageItemSchema = z.object({
	type: z.literal("message").optional(),
	role: z.literal("system"),
	content: z.union([z.string(), z.array(inputContentBlockSchema)]).optional(),
});

const assistantMessageItemSchema = z.object({
	type: z.literal("message").optional(),
	role: z.literal("assistant"),
	content: z.union([z.string(), z.array(outputContentBlockSchema)]).optional(),
});

const reasoningItemSchema = z.object({
	type: z.literal("reasoning"),
	id: z.string().optional(),
	summary: z.array(summaryTextSchema).optional(),
	content: z.array(reasoningTextSchema).optional(),
});

const functionCallItemSchema = z.object({
	type: z.literal("function_call"),
	id: z.string().optional(),
	call_id: z.string().min(1),
	name: z.string().min(1),
	arguments: z.string().optional(),
});

const functionCallOutputItemSchema = z.object({
	type: z.literal("function_call_output"),
	call_id: z.string().min(1),
	output: z.string().optional(),
});

/**
 * An input item is one of the union members below. The convenience shape
 * `{role, content}` (no `type`) is mapped to "message" before validation in
 * the walker — schemas here only handle the canonical {type, ...} forms.
 */
export const inputItemSchema = z.union([
	userMessageItemSchema,
	systemMessageItemSchema,
	assistantMessageItemSchema,
	reasoningItemSchema,
	functionCallItemSchema,
	functionCallOutputItemSchema,
	// Tolerated but not bridged (file_search_call, web_search_call, …).
	z.object({ type: z.string() }),
]);

// Variant types alias the canonical SDK union members so the walker can
// narrow them cleanly. The convenience "message" shape (no `type` field) maps
// to EasyInputMessage; the explicit form maps to ResponseInputItem.Message.
export type OpenAIResponsesUserItem = EasyInputMessage | ResponseInputItem.Message;
export type OpenAIResponsesSystemItem = EasyInputMessage | ResponseInputItem.Message;
export type OpenAIResponsesAssistantItem = EasyInputMessage | ResponseOutputMessage;
export type OpenAIResponsesReasoningItem = ResponseReasoningItem;
export type OpenAIResponsesFunctionCallItem = ResponseFunctionToolCall;
export type OpenAIResponsesFunctionCallOutputItem = ResponseInputItem.FunctionCallOutput;

// ─── Tools ──────────────────────────────────────────────────────────────────

export const toolSchema = z.object({
	type: z.literal("function"),
	name: z.string().min(1),
	description: z.string().optional(),
	parameters: z.record(z.string(), z.unknown()).optional(),
	strict: z.boolean().optional(),
});

// Built-in tool entries (web_search, file_search, …) — accepted but skipped
// by the walker.
const builtinToolSchema = z.object({
	type: z.string(),
});

// ─── Tool choice ────────────────────────────────────────────────────────────

export const toolChoiceSchema = z.union([
	z.literal("auto"),
	z.literal("none"),
	z.literal("required"),
	z.object({
		type: z.literal("function"),
		name: z.string().min(1),
	}),
]);

// ─── Reasoning config ───────────────────────────────────────────────────────

export const reasoningConfigSchema = z.object({
	effort: z.string().optional(),
	summary: z.string().optional(),
});

// ─── Stop ───────────────────────────────────────────────────────────────────

export const stopSchema = z.union([z.string(), z.array(z.string()), z.null()]);

// ─── Top-level request ──────────────────────────────────────────────────────

const refuse = (field: string) =>
	z
		.unknown()
		.refine(v => v === undefined, { message: `openai-responses: unsupported option \`${field}\`` })
		.optional();

export const openaiResponsesRequestSchema = z.object({
	model: z.string().min(1),
	input: z.union([z.string(), z.array(inputItemSchema)]).optional(),
	instructions: z.union([z.string(), z.null()]).optional(),
	tools: z.array(z.union([toolSchema, builtinToolSchema])).optional(),
	tool_choice: toolChoiceSchema.optional(),
	max_output_tokens: z.number().optional(),
	temperature: z.number().optional(),
	top_p: z.number().optional(),
	stop: stopSchema.optional(),
	stream: z.boolean().optional(),
	reasoning: reasoningConfigSchema.optional(),
	store: z.boolean().optional(),
	previous_response_id: z.string().optional(),
	parallel_tool_calls: z.boolean().optional(),
	service_tier: z.string().optional(),
	presence_penalty: z.number().optional(),
	// Explicitly rejected.
	background: refuse("background"),
	include: refuse("include"),
	metadata: refuse("metadata"),
	prompt: refuse("prompt"),
	safety_identifier: refuse("safety_identifier"),
	text: refuse("text"),
	top_logprobs: refuse("top_logprobs"),
	truncation: refuse("truncation"),
	user: refuse("user"),
});

/**
 * Public types are sourced from the OpenAI SDK so the gateway stays in
 * lock-step with the canonical API surface; the schemas above are runtime
 * validators for the subset we actually accept.
 */
export type OpenAIResponsesRequest = ResponseCreateParams;
export type OpenAIResponsesInputItem = ResponseInputItem;
export type OpenAIResponsesTool = ResponsesTool;
export type OpenAIResponsesToolChoice = NonNullable<ResponseCreateParams["tool_choice"]>;
export type OpenAIResponsesInputContent = ResponseInputContent;
export type OpenAIResponsesOutputContent = ResponseOutputMessage["content"][number];

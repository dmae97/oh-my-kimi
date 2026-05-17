/**
 * Zod schemas for the OpenAI Responses API request shape we accept on the
 * gateway. Mirrors https://platform.openai.com/docs/api-reference/responses.
 *
 * Unsupported / opaque controls (background/include/metadata/prompt/…) are
 * accepted as `z.unknown().optional()` so we silently ignore rather than 400.
 * Real clients (codex, openai-python, llm-git) routinely send these and a 400
 * is a worse outcome than dropping them on the floor.
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

// ─── Input content blocks ───────────────────────────────────────────────────

const inputTextSchema = z.object({
	type: z.literal("input_text"),
	text: z.string(),
});

const plainTextSchema = z.object({
	type: z.literal("text"),
	text: z.string(),
});

const inputImageBlockSchema = z
	.object({
		type: z.literal("input_image"),
		detail: z.enum(["auto", "low", "high"]).optional(),
		image_url: z.string().optional(),
		file_id: z.string().optional(),
	})
	.refine(v => typeof v.image_url === "string" || typeof v.file_id === "string", {
		message: "input_image requires at least one of `image_url` or `file_id`",
	});

const inputFileBlockSchema = z.object({
	type: z.literal("input_file"),
	file_id: z.string().optional(),
	filename: z.string().optional(),
	file_data: z.string().optional(),
});

const outputTextSchema = z.object({
	type: z.literal("output_text"),
	text: z.string(),
});

const outputRefusalSchema = z.object({
	type: z.literal("refusal"),
	refusal: z.string(),
});

const summaryTextSchema = z.object({
	type: z.literal("summary_text"),
	text: z.string(),
});

const reasoningTextSchema = z.object({
	type: z.literal("reasoning_text"),
	text: z.string(),
});

const inputContentBlockSchema = z.union([
	inputTextSchema,
	plainTextSchema,
	inputImageBlockSchema,
	inputFileBlockSchema,
]);
const outputContentBlockSchema = z.union([outputTextSchema, plainTextSchema, outputRefusalSchema]);

// ─── Input items ────────────────────────────────────────────────────────────

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
	// Codex CLI replays multimodal tool results in array form (text + refusal).
	output: z.union([z.string(), z.array(outputContentBlockSchema)]).optional(),
});

const customToolCallItemSchema = z.object({
	type: z.literal("custom_tool_call"),
	id: z.string().optional(),
	call_id: z.string().min(1),
	name: z.string().min(1),
	// Raw input string — NOT JSON.stringified. apply_patch flow streams a
	// freeform body and reading it as JSON would corrupt it.
	input: z.string(),
});

const customToolCallOutputItemSchema = z.object({
	type: z.literal("custom_tool_call_output"),
	call_id: z.string().min(1),
	output: z.string(),
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
	customToolCallItemSchema,
	customToolCallOutputItemSchema,
	// Tolerated but not bridged (file_search_call, web_search_call, …).
	z.object({ type: z.string() }).loose(),
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

/** Inferred shape of the custom tool call input item (no canonical SDK alias). */
export type OpenAIResponsesCustomToolCallItem = z.infer<typeof customToolCallItemSchema>;
export type OpenAIResponsesCustomToolCallOutputItem = z.infer<typeof customToolCallOutputItemSchema>;
export type OpenAIResponsesInputImageBlock = z.infer<typeof inputImageBlockSchema>;
export type OpenAIResponsesInputFileBlock = z.infer<typeof inputFileBlockSchema>;
export type OpenAIResponsesOutputRefusalBlock = z.infer<typeof outputRefusalSchema>;

// ─── Tools ──────────────────────────────────────────────────────────────────

export const toolSchema = z.object({
	type: z.literal("function"),
	name: z.string().min(1),
	description: z.string().optional(),
	parameters: z.record(z.string(), z.unknown()).optional(),
	strict: z.boolean().optional(),
});

// Built-in / hosted tool entries (web_search_preview, file_search, …) — accepted
// but skipped by the walker.
const builtinToolSchema = z
	.object({
		type: z.string(),
	})
	.loose();

// ─── Tool choice ────────────────────────────────────────────────────────────

const hostedToolType = z.enum([
	"web_search_preview",
	"file_search",
	"computer_use_preview",
	"code_interpreter",
	"image_generation",
	"mcp",
]);

const allowedToolEntrySchema = z.object({
	type: z.string(),
	name: z.string().optional(),
});

export const toolChoiceSchema = z.union([
	z.literal("auto"),
	z.literal("none"),
	z.literal("required"),
	z.object({
		type: z.literal("function"),
		name: z.string().min(1),
	}),
	// Codex apply_patch flow.
	z.object({
		type: z.literal("custom"),
		name: z.string().min(1),
	}),
	// Hosted-tool selection (no extra fields).
	z.object({
		type: hostedToolType,
	}),
	// `allowed_tools` — walker treats as auto.
	z.object({
		type: z.literal("allowed_tools"),
		mode: z.enum(["auto", "required"]),
		tools: z.array(allowedToolEntrySchema),
	}),
]);

// ─── Reasoning config ───────────────────────────────────────────────────────

export const reasoningConfigSchema = z.object({
	effort: z.string().optional(),
	// `none` maps to hideThinkingSummary; auto/concise/detailed mean "show
	// summary". pi-ai has no per-level plumbing for the latter — walker logs
	// once and treats them as default.
	summary: z.enum(["auto", "concise", "detailed", "none"]).optional(),
});

// ─── Stop ───────────────────────────────────────────────────────────────────

export const stopSchema = z.union([z.string(), z.array(z.string()), z.null()]);

// ─── Top-level request ──────────────────────────────────────────────────────

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
	prompt_cache_key: z.string().optional(),
	metadata: z.unknown().optional(),
	user: z.string().optional(),
	service_tier: z.string().optional(),
	presence_penalty: z.number().optional(),
	frequency_penalty: z.number().optional(),
	// Accepted-but-ignored: include `reasoning.encrypted_content` is the canonical
	// way to request reasoning replay — silently accept and drop.
	background: z.unknown().optional(),
	include: z.unknown().optional(),
	prompt: z.unknown().optional(),
	safety_identifier: z.unknown().optional(),
	text: z.unknown().optional(),
	top_logprobs: z.unknown().optional(),
	truncation: z.unknown().optional(),
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

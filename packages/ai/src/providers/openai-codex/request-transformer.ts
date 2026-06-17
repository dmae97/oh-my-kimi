import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { requireSupportedEffort } from "@oh-my-pi/pi-catalog/model-thinking";
import type { Api, Model } from "../../types";

/** Reasoning replay scope for the Codex Responses API (`reasoning.context`). */
export type CodexReasoningContext = "auto" | "current_turn" | "all_turns";

export interface ReasoningConfig {
	effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
	summary?: "auto" | "concise" | "detailed";
	context?: CodexReasoningContext;
}

export interface CodexRequestOptions {
	reasoningEffort?: ReasoningConfig["effort"];
	reasoningSummary?: ReasoningConfig["summary"] | null;
	/** Explicit `reasoning.context` override. Defaults to `all_turns` under {@link CodexRequestOptions.responsesLite}, otherwise omitted (server default is `current_turn`). */
	reasoningContext?: CodexReasoningContext;
	textVerbosity?: "low" | "medium" | "high";
	include?: string[];
	/** Responses Lite transport contract: strips image detail and defaults `reasoning.context` to `all_turns`, mirroring codex-rs. */
	responsesLite?: boolean;
}

export interface InputItem {
	id?: string | null;
	type?: string | null;
	role?: string;
	content?: unknown;
	call_id?: string | null;
	name?: string;
	output?: unknown;
	arguments?: unknown;
}

export interface RequestBody {
	model: string;
	store?: boolean;
	stream?: boolean;
	instructions?: string;
	input?: InputItem[];
	tools?: unknown;
	tool_choice?: unknown;
	temperature?: number;
	top_p?: number;
	top_k?: number;
	min_p?: number;
	presence_penalty?: number;
	repetition_penalty?: number;
	reasoning?: Partial<ReasoningConfig>;
	text?: {
		verbosity?: "low" | "medium" | "high";
	};
	include?: string[];
	prompt_cache_key?: string;
	prompt_cache_retention?: "in_memory" | "24h";
	client_metadata?: Record<string, string>;
	max_output_tokens?: number;
	max_completion_tokens?: number;
	service_tier?: "auto" | "default" | "flex" | "scale" | "priority" | null;
	[key: string]: unknown;
}

function getReasoningConfig(model: Model<Api>, options: CodexRequestOptions): ReasoningConfig {
	const config: ReasoningConfig = {
		effort:
			options.reasoningEffort === "none" ? "none" : requireSupportedEffort(model, options.reasoningEffort as Effort),
	};
	if (options.reasoningSummary !== null) {
		config.summary = options.reasoningSummary ?? "detailed";
	}
	return config;
}

function filterInput(input: InputItem[] | undefined): InputItem[] | undefined {
	if (!Array.isArray(input)) return input;

	return input
		.filter(item => item.type !== "item_reference")
		.map(item => {
			if (item.id != null) {
				const { id: _id, ...rest } = item;
				return rest as InputItem;
			}
			return item;
		});
}

const CODEX_ORPHAN_OUTPUT_LIMIT = 16_000;
/** Placeholder output for a tool call whose result never landed in the input. */
const CODEX_INTERRUPTED_TOOL_OUTPUT =
	"[No tool output recorded: the tool call was interrupted before it produced a result.]";

function orphanFunctionOutputToMessage(item: InputItem, callId: string): InputItem {
	const itemRecord = item as unknown as Record<string, unknown>;
	const toolName = typeof itemRecord.name === "string" ? itemRecord.name : "tool";
	let text = "";
	try {
		const output = itemRecord.output;
		text = typeof output === "string" ? output : JSON.stringify(output);
	} catch {
		text = String(itemRecord.output ?? "");
	}
	if (text.length > CODEX_ORPHAN_OUTPUT_LIMIT) {
		text = `${text.slice(0, CODEX_ORPHAN_OUTPUT_LIMIT)}\n...[truncated]`;
	}
	return {
		type: "message",
		role: "assistant",
		content: `[Previous ${toolName} result; call_id=${callId}]: ${text}`,
	} as InputItem;
}

/**
 * Repair both halves of unpaired tool exchanges so the Responses input grammar
 * stays valid — the API rejects either orphan with a 400:
 *
 * - `function_call_output` / `custom_tool_call_output` with no matching call →
 *   folded into an assistant message (`400 No tool call found for … output`).
 *   Regression of #472 / #1351.
 * - `function_call` / `custom_tool_call` with no matching `*_output` → a
 *   placeholder output is synthesized immediately after the call
 *   (`400 No tool output found for function call …`). Hit when the user
 *   branches/navigates the session tree to a node that ends on a tool call (the
 *   tool-result child is dropped from the reconstructed history) or when a turn
 *   is aborted/crashes after the call streamed but before its result persisted.
 */
function repairToolCallPairs(input: InputItem[]): InputItem[] {
	const callIds = new Set<string>();
	const outputCallIds = new Set<string>();
	for (const item of input) {
		const callId = typeof item.call_id === "string" ? item.call_id : undefined;
		if (callId === undefined) continue;
		if (item.type === "function_call" || item.type === "custom_tool_call") callIds.add(callId);
		else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
			outputCallIds.add(callId);
		}
	}

	const repaired: InputItem[] = [];
	for (const item of input) {
		const callId = typeof item.call_id === "string" ? item.call_id : undefined;

		if (
			(item.type === "function_call_output" || item.type === "custom_tool_call_output") &&
			callId !== undefined &&
			!callIds.has(callId)
		) {
			repaired.push(orphanFunctionOutputToMessage(item, callId));
			continue;
		}

		repaired.push(item);

		if (
			(item.type === "function_call" || item.type === "custom_tool_call") &&
			callId !== undefined &&
			!outputCallIds.has(callId)
		) {
			repaired.push({
				type: item.type === "custom_tool_call" ? "custom_tool_call_output" : "function_call_output",
				call_id: callId,
				output: CODEX_INTERRUPTED_TOOL_OUTPUT,
			} as InputItem);
		}
	}
	return repaired;
}

/**
 * Responses Lite requests must not pin image detail levels: codex-rs strips
 * `detail` from every input image (message content and tool outputs) before
 * sending, letting the server choose.
 */
function stripImageDetails(input: InputItem[]): void {
	for (const item of input) {
		for (const collection of [item.content, item.output]) {
			if (!Array.isArray(collection)) continue;
			for (const part of collection) {
				if (part && typeof part === "object" && (part as { type?: unknown }).type === "input_image") {
					delete (part as { detail?: unknown }).detail;
				}
			}
		}
	}
}

export async function transformRequestBody(
	body: RequestBody,
	model: Model<Api>,
	options: CodexRequestOptions = {},
	prompt?: { developerMessages: string[] },
): Promise<RequestBody> {
	body.store = false;
	body.stream = true;

	if (body.input && Array.isArray(body.input)) {
		body.input = filterInput(body.input);
		if (body.input) {
			body.input = repairToolCallPairs(body.input);
		}
	}

	if (prompt?.developerMessages && prompt.developerMessages.length > 0 && Array.isArray(body.input)) {
		const developerMessages = prompt.developerMessages.map(
			text =>
				({
					type: "message",
					role: "developer",
					content: [{ type: "input_text", text }],
				}) as InputItem,
		);
		body.input = [...developerMessages, ...body.input];
	}

	if (options.responsesLite) {
		if (Array.isArray(body.input)) {
			stripImageDetails(body.input);
		}
		// Responses Lite does not support parallel tool calling; codex-rs forces
		// it off (`prompt.parallel_tool_calls && !use_responses_lite`).
		if (body.tools !== undefined) {
			body.parallel_tool_calls = false;
		}
	}

	if (options.reasoningEffort !== undefined) {
		const reasoningConfig = getReasoningConfig(model, options);
		body.reasoning = {
			...body.reasoning,
			...reasoningConfig,
		};
		// Responses Lite keeps reasoning replay server-side; codex-rs requests
		// `all_turns` there and otherwise omits context so the server default
		// (currently `current_turn`) applies.
		const reasoningContext = options.reasoningContext ?? (options.responsesLite ? "all_turns" : undefined);
		if (reasoningContext !== undefined) {
			body.reasoning.context = reasoningContext;
		}
	} else {
		delete body.reasoning;
	}

	body.text = {
		...body.text,
		verbosity: options.textVerbosity || "low",
	};

	const include = Array.isArray(options.include) ? [...options.include] : [];
	include.push("reasoning.encrypted_content");
	body.include = Array.from(new Set(include));

	delete body.max_output_tokens;
	delete body.max_completion_tokens;

	return body;
}
